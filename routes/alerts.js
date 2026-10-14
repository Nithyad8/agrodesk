const express = require('express');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const LOW_STOCK = 10;
const NEAR_DAYS = 30;
const ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

router.get('/', async (req, res) => {
  try {
    const alerts = [];

    const [expired] = await pool.query(
      `SELECT b.batch_id, b.batch_no, b.quantity, p.name, p.unit,
              DATEDIFF(CURDATE(), b.expiry_date) AS days_over
       FROM batches b JOIN products p ON p.product_id = b.product_id
       WHERE b.expiry_date < CURDATE() AND b.quantity > 0`);
    expired.forEach(r => alerts.push({
      type: 'expired', level: 'critical', days: -r.days_over,
      title: `${r.name} - batch ${r.batch_no}`,
      message: `Expired ${days(r.days_over)} ago. ${r.quantity} ${r.unit} still in stock. Remove it from sale.`,
      link: '/batch.html?id=' + r.batch_id,
    }));

    const [near] = await pool.query(
      `SELECT b.batch_id, b.batch_no, b.quantity, p.name, p.unit,
              DATEDIFF(b.expiry_date, CURDATE()) AS days_left
       FROM batches b JOIN products p ON p.product_id = b.product_id
       WHERE b.expiry_date >= CURDATE() AND b.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
         AND b.quantity > 0`, [NEAR_DAYS]);
    near.forEach(r => alerts.push({
      type: 'near_expiry', level: r.days_left <= 7 ? 'high' : 'medium', days: r.days_left,
      title: `${r.name} - batch ${r.batch_no}`,
      message: (r.days_left === 0 ? 'Expires today' : `Expires in ${days(r.days_left)}`) +
               `. ${r.quantity} ${r.unit} in stock.`,
      link: '/batch.html?id=' + r.batch_id,
    }));

    const [low] = await pool.query(
      `SELECT p.product_id, p.name, p.unit,
              COALESCE(SUM(CASE WHEN b.expiry_date >= CURDATE() THEN b.quantity ELSE 0 END), 0) AS usable
       FROM products p JOIN batches b ON b.product_id = p.product_id
       GROUP BY p.product_id, p.name, p.unit
       HAVING usable <= ?`, [LOW_STOCK]);
    low.forEach(r => {
      const usable = Number(r.usable);
      alerts.push({
        type: 'low_stock', level: usable === 0 ? 'high' : 'medium', days: usable,
        title: r.name,
        message: usable === 0
          ? 'Out of stock. No usable batches left.'
          : `Low stock. Only ${usable} ${r.unit} left in usable batches.`,
        link: '/batches.html',
      });
    });

    const [recalls] = await pool.query(
      `SELECT r.recall_id, r.reason, r.recall_date, b.batch_id, b.batch_no, b.quantity, p.name, p.unit
       FROM batch_recalls r
       JOIN batches b ON b.batch_id = r.batch_id
       JOIN products p ON p.product_id = b.product_id
       WHERE r.status = 'open'`);
    recalls.forEach(r => alerts.push({
      type: 'recall', level: 'critical', days: -9999,
      title: `${r.name} - batch ${r.batch_no}`,
      message: `Recalled on ${r.recall_date}. Reason: ${r.reason}. ${r.quantity} ${r.unit} still in stock.`,
      link: '/batch.html?id=' + r.batch_id,
    }));

    if (req.user.role !== 'staff') {
      const [lic] = await pool.query(
        `SELECT l.license_id, l.type, l.license_no, l.renewal_status, s.name AS supplier_name,
                DATEDIFF(l.expiry_date, CURDATE()) AS days_left
         FROM licenses l LEFT JOIN suppliers s ON s.supplier_id = l.supplier_id
         HAVING days_left <= 60`);
      lic.forEach(l => {
        let level, message;
        if (l.days_left < 0) { level = 'critical'; message = 'License has expired. Please update the renewal status.'; }
        else if (l.days_left <= 7) {
          level = 'high';
          message = l.days_left === 0 ? 'Urgent: license expires today' : `Urgent: license expires in ${days(l.days_left)}`;
        }
        else if (l.days_left <= 30) { level = 'medium'; message = 'Renewal required within 30 days'; }
        else { level = 'low'; message = 'License renewal is approaching'; }
        if (l.renewal_status === 'submitted') message += '. Renewal submitted, waiting for approval.';
        else if (l.renewal_status === 'in_progress') message += '. Renewal is in progress.';
        alerts.push({
          type: 'license', level, days: l.days_left,
          title: `${l.type} - ${l.license_no} (${l.supplier_name || 'Shop'})`,
          message, link: '/licenses.html',
        });
      });
    }

    alerts.sort((a, b) => ORDER[a.level] - ORDER[b.level] || a.days - b.days);
    const summary = { critical: 0, high: 0, medium: 0, low: 0, total: alerts.length };
    alerts.forEach(a => { summary[a.level]++; });
    res.json({ summary, alerts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error: ' + (err.code || '') + ' ' + err.message });
  }
});

module.exports = router;