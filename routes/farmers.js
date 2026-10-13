const express = require('express');
const pool = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, authorize('owner', 'staff'));

function validate(b) {
  if (!b.name || !b.name.trim()) return 'Farmer name is required';
  if (b.phone && b.phone.trim() && !/^[0-9]{10}$/.test(b.phone.trim())) return 'Phone must be 10 digits';
  return null;
}

const clean = (b) => [
  b.name.trim(),
  (b.phone || '').trim() || null,
  (b.village || '').trim() || null,
  (b.land_details || '').trim() || null,
];

const fail = (res, err) => {
  console.error(err);
  res.status(500).json({ message: 'Server error: ' + (err.code || '') + ' ' + err.message });
};

router.get('/', async (req, res) => {
  try {
    const q = req.query.search ? `%${req.query.search}%` : '%';
    const [rows] = await pool.query(
      'SELECT * FROM farmers WHERE name LIKE ? OR phone LIKE ? OR village LIKE ? ORDER BY name',
      [q, q, q]);
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.get('/:id', async (req, res) => {
  try {
    const [f] = await pool.query('SELECT * FROM farmers WHERE farmer_id = ?', [req.params.id]);
    if (!f[0]) return res.status(404).json({ message: 'Farmer not found' });
    const [history] = await pool.query(
      `SELECT s.sale_id, s.sale_date, s.payment_mode, p.name AS product_name, p.unit,
              si.quantity, si.price, si.crop
       FROM sales s
       JOIN sale_items si ON si.sale_id = s.sale_id
       JOIN batches b ON b.batch_id = si.batch_id
       JOIN products p ON p.product_id = b.product_id
       WHERE s.farmer_id = ?
       ORDER BY s.sale_date DESC, s.sale_id DESC`, [req.params.id]);
    res.json({ ...f[0], history });
  } catch (err) { fail(res, err); }
});

router.post('/', async (req, res) => {
  const error = validate(req.body);
  if (error) return res.status(400).json({ message: error });
  try {
    const [r] = await pool.query(
      'INSERT INTO farmers (name, phone, village, land_details) VALUES (?,?,?,?)',
      clean(req.body));
    res.status(201).json({ farmer_id: r.insertId, message: 'Farmer added' });
  } catch (err) { fail(res, err); }
});

router.put('/:id', async (req, res) => {
  const error = validate(req.body);
  if (error) return res.status(400).json({ message: error });
  try {
    const [r] = await pool.query(
      'UPDATE farmers SET name=?, phone=?, village=?, land_details=? WHERE farmer_id=?',
      [...clean(req.body), req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Farmer not found' });
    res.json({ message: 'Farmer updated' });
  } catch (err) { fail(res, err); }
});

router.post('/:id/payment', async (req, res) => {
  const amount = Number(req.body.amount);
  if (!(amount > 0)) return res.status(400).json({ message: 'Enter an amount greater than 0' });
  try {
    const [r] = await pool.query(
      'UPDATE farmers SET credit_balance = credit_balance - ? WHERE farmer_id = ? AND credit_balance >= ?',
      [amount, req.params.id, amount]);
    if (!r.affectedRows) {
      return res.status(400).json({ message: 'Payment is more than the amount owed, or the farmer was not found' });
    }
    res.json({ message: 'Payment recorded' });
  } catch (err) { fail(res, err); }
});

router.delete('/:id', authorize('owner'), async (req, res) => {
  try {
    const [r] = await pool.query('DELETE FROM farmers WHERE farmer_id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Farmer not found' });
    res.json({ message: 'Farmer deleted' });
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ message: 'This farmer has purchases, so cannot be deleted' });
    }
    fail(res, err);
  }
});

module.exports = router;