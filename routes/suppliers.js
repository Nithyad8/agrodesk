const express = require('express');
const pool = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

function validate(b) {
  if (!b.name || !b.name.trim()) return 'Supplier name is required';
  return null;
}
const clean = (b) => [b.name.trim(), (b.contact || '').trim() || null, (b.address || '').trim() || null];
const fail = (res, err) => {
  console.error(err);
  res.status(500).json({ message: 'Server error: ' + (err.code || '') + ' ' + err.message });
};

router.get('/', authorize('owner', 'staff'), async (req, res) => {
  try {
    const search = req.query.search ? `%${req.query.search}%` : '%';
    const [rows] = await pool.query(
      'SELECT * FROM suppliers WHERE name LIKE ? ORDER BY name', [search]);
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.post('/', authorize('owner'), async (req, res) => {
  const error = validate(req.body);
  if (error) return res.status(400).json({ message: error });
  try {
    const [r] = await pool.query(
      'INSERT INTO suppliers (name, contact, address) VALUES (?,?,?)', clean(req.body));
    res.status(201).json({ supplier_id: r.insertId, message: 'Supplier added' });
  } catch (err) { fail(res, err); }
});

router.put('/:id', authorize('owner'), async (req, res) => {
  const error = validate(req.body);
  if (error) return res.status(400).json({ message: error });
  try {
    const [r] = await pool.query(
      'UPDATE suppliers SET name=?, contact=?, address=? WHERE supplier_id=?',
      [...clean(req.body), req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Supplier not found' });
    res.json({ message: 'Supplier updated' });
  } catch (err) { fail(res, err); }
});

router.delete('/:id', authorize('owner'), async (req, res) => {
  try {
    const [r] = await pool.query('DELETE FROM suppliers WHERE supplier_id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Supplier not found' });
    res.json({ message: 'Supplier deleted' });
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ message: 'This supplier has batches or licenses, so it cannot be deleted' });
    }
    fail(res, err);
  }
});

module.exports = router;