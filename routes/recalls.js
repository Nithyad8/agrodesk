const express = require('express');
const pool = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

class BadRequest extends Error {}

const fail = (res, err) => {
  console.error(err);
  res.status(500).json({ message: 'Server error: ' + (err.code || '') + ' ' + err.message });
};

const SELECT = `SELECT r.recall_id, r.reason, r.recall_date, r.status,
                       b.batch_id, b.batch_no, b.quantity AS stock_left, b.expiry_date,
                       p.name AS product_name, p.unit, s.name AS supplier_name,
                       (SELECT COUNT(DISTINCT sa.farmer_id) FROM sale_items si
                         JOIN sales sa ON sa.sale_id = si.sale_id
                         WHERE si.batch_id = b.batch_id) AS farmers_affected,
                       (SELECT COALESCE(SUM(si.quantity), 0) FROM sale_items si
                         WHERE si.batch_id = b.batch_id) AS qty_sold
                FROM batch_recalls r
                JOIN batches b ON b.batch_id = r.batch_id
                JOIN products p ON p.product_id = b.product_id
                JOIN suppliers s ON s.supplier_id = b.supplier_id`;

router.get('/', async (req, res) => {
  try {
    let sql = SELECT;
    const params = [];
    if (req.query.status === 'open' || req.query.status === 'closed') {
      sql += ' WHERE r.status = ?';
      params.push(req.query.status);
    }
    sql += " ORDER BY (r.status = 'open') DESC, r.recall_id DESC";
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(SELECT + ' WHERE r.recall_id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ message: 'Recall not found' });
    const [affected] = await pool.query(
      `SELECT sa.sale_id, sa.sale_date, f.farmer_id, f.name AS farmer_name, f.phone, f.village,
              si.quantity, si.crop, si.application_date
       FROM sale_items si
       JOIN sales sa ON sa.sale_id = si.sale_id
       JOIN farmers f ON f.farmer_id = sa.farmer_id
       WHERE si.batch_id = ?
       ORDER BY sa.sale_date DESC, sa.sale_id DESC`, [rows[0].batch_id]);
    res.json({ ...rows[0], affected });
  } catch (err) { fail(res, err); }
});

router.post('/', authorize('owner'), async (req, res) => {
  const batchId = Number(req.body.batch_id);
  const reason = (req.body.reason || '').trim();
  if (!Number.isInteger(batchId) || batchId < 1) return res.status(400).json({ message: 'Choose a batch' });
  if (!reason) return res.status(400).json({ message: 'Enter the reason for the recall' });
  if (reason.length > 255) return res.status(400).json({ message: 'Reason is too long (255 characters at most)' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [b] = await conn.query('SELECT batch_id FROM batches WHERE batch_id = ? FOR UPDATE', [batchId]);
    if (!b[0]) throw new BadRequest('Batch not found');
    const [open] = await conn.query(
      "SELECT recall_id FROM batch_recalls WHERE batch_id = ? AND status = 'open' LIMIT 1", [batchId]);
    if (open.length) throw new BadRequest('This batch already has an open recall');
    const [r] = await conn.query(
      "INSERT INTO batch_recalls (batch_id, reason, recall_date, status) VALUES (?,?,CURDATE(),'open')",
      [batchId, reason]);
    await conn.commit();
    res.status(201).json({ recall_id: r.insertId, message: 'Batch flagged for recall' });
  } catch (err) {
    await conn.rollback();
    if (err instanceof BadRequest) return res.status(400).json({ message: err.message });
    fail(res, err);
  } finally { conn.release(); }
});

router.put('/:id/close', authorize('owner'), async (req, res) => {
  try {
    const [r] = await pool.query(
      "UPDATE batch_recalls SET status = 'closed' WHERE recall_id = ? AND status = 'open'", [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Open recall not found' });
    res.json({ message: 'Recall closed' });
  } catch (err) { fail(res, err); }
});

module.exports = router;