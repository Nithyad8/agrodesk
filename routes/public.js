const express = require('express');
const pool = require('../db');

const router = express.Router();
const NEAR_DAYS = 30;

function expiryStatus(days) {
  if (days < 0) return 'expired';
  if (days <= NEAR_DAYS) return 'near_expiry';
  return 'ok';
}

router.get('/batch/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.batch_no, b.mfg_date, b.expiry_date, p.name AS product_name,
              p.category, p.manufacturer,
              DATEDIFF(b.expiry_date, CURDATE()) AS days_to_expiry
       FROM batches b
       JOIN products p ON p.product_id = b.product_id
       WHERE b.batch_id = ?`, [req.params.id]);
    const b = rows[0];
    if (!b) return res.status(404).json({ message: 'Batch not found' });

    const [rec] = await pool.query(
      "SELECT reason FROM batch_recalls WHERE batch_id = ? AND status = 'open' LIMIT 1",
      [req.params.id]);

    res.json({ ...b, status: expiryStatus(b.days_to_expiry),
               recalled: rec.length > 0, recall_reason: rec[0]?.reason || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/product/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT product_id, name, category, unit, manufacturer, hsn_code, waiting_period_days
       FROM products WHERE product_id = ?`, [req.params.id]);
    const p = rows[0];
    if (!p) return res.status(404).json({ message: 'Product not found' });

    const [batches] = await pool.query(
      `SELECT b.batch_id, b.batch_no, b.mfg_date, b.expiry_date,
              DATEDIFF(b.expiry_date, CURDATE()) AS days_to_expiry,
              EXISTS(SELECT 1 FROM batch_recalls r
                     WHERE r.batch_id = b.batch_id AND r.status = 'open') AS recalled
       FROM batches b WHERE b.product_id = ? ORDER BY b.expiry_date`, [req.params.id]);

    res.json({
      ...p,
      batches: batches.map(b => ({ ...b, recalled: !!b.recalled, status: expiryStatus(b.days_to_expiry) })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/pack/:code', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT pk.pack_code, pk.status AS pack_status, b.batch_id, b.batch_no, b.mfg_date, b.expiry_date,
              p.name AS product_name, p.category, p.manufacturer,
              DATEDIFF(b.expiry_date, CURDATE()) AS days_to_expiry
       FROM packs pk
       JOIN batches b ON b.batch_id = pk.batch_id
       JOIN products p ON p.product_id = b.product_id
       WHERE pk.pack_code = ?`, [req.params.code]);
    const r = rows[0];
    if (!r) return res.status(404).json({ message: 'Pack not found' });

    const [rec] = await pool.query(
      "SELECT reason FROM batch_recalls WHERE batch_id = ? AND status = 'open' LIMIT 1", [r.batch_id]);

    res.json({ ...r, status: expiryStatus(r.days_to_expiry),
               recalled: rec.length > 0, recall_reason: rec[0]?.reason || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;