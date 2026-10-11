const express = require('express');
const pool = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const LOW_STOCK = 10;
const NEAR_DAYS = 30;

function validate(b) {
  if (!Number.isInteger(Number(b.product_id)) || !b.product_id) return 'Choose a product';
  if (!Number.isInteger(Number(b.supplier_id)) || !b.supplier_id) return 'Choose a supplier';
  if (!b.batch_no || !b.batch_no.trim()) return 'Batch number is required';
  if (!b.expiry_date) return 'Expiry date is required';
  if (b.mfg_date && b.mfg_date > b.expiry_date) return 'Manufacture date must be before expiry date';
  if (b.quantity === '' || b.quantity == null || !Number.isInteger(Number(b.quantity)) || Number(b.quantity) < 0) {
    return 'Quantity must be a whole number, 0 or more';
  }
  for (const f of ['purchase_price', 'selling_price']) {
    if (b[f] !== '' && b[f] != null && (isNaN(b[f]) || Number(b[f]) < 0)) {
      return 'Prices must be 0 or more';
    }
  }
  return null;
}

const clean = (b) => [
  b.product_id, b.supplier_id, b.batch_no.trim(), b.mfg_date || null, b.expiry_date,
  b.quantity, b.purchase_price === '' ? null : b.purchase_price ?? null,
  b.selling_price === '' ? null : b.selling_price ?? null,
];

router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.*, p.name AS product_name, p.unit, s.name AS supplier_name,
              DATEDIFF(b.expiry_date, CURDATE()) AS days_to_expiry
       FROM batches b
       JOIN products p ON p.product_id = b.product_id
       JOIN suppliers s ON s.supplier_id = b.supplier_id
       ORDER BY b.expiry_date`);
    let list = rows.map(r => {
      const flags = [];
      if (r.days_to_expiry < 0) flags.push('expired');
      else if (r.days_to_expiry <= NEAR_DAYS) flags.push('near_expiry');
      if (r.quantity <= LOW_STOCK) flags.push('low_stock');
      return { ...r, flags };
    });
    const { search, status } = req.query;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(r => r.product_name.toLowerCase().includes(q) ||
                              r.batch_no.toLowerCase().includes(q));
    }
    if (status) list = list.filter(r => r.flags.includes(status));
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', authorize('owner', 'staff'), async (req, res) => {
  const error = validate(req.body);
  if (error) return res.status(400).json({ message: error });
  try {
    const [dup] = await pool.query(
      'SELECT batch_id FROM batches WHERE product_id = ? AND batch_no = ?',
      [req.body.product_id, req.body.batch_no.trim()]);
    if (dup.length) return res.status(409).json({ message: 'This batch number already exists for this product' });
    const [r] = await pool.query(
      `INSERT INTO batches (product_id, supplier_id, batch_no, mfg_date, expiry_date,
                            quantity, purchase_price, selling_price) VALUES (?,?,?,?,?,?,?,?)`,
      clean(req.body));
    res.status(201).json({ batch_id: r.insertId, message: 'Batch added' });
  } catch (err) {
    if (err.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({ message: 'Choose a valid product and supplier' });
    }
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/:id', authorize('owner', 'staff'), async (req, res) => {
  const error = validate(req.body);
  if (error) return res.status(400).json({ message: error });
  try {
    const [dup] = await pool.query(
      'SELECT batch_id FROM batches WHERE product_id = ? AND batch_no = ? AND batch_id <> ?',
      [req.body.product_id, req.body.batch_no.trim(), req.params.id]);
    if (dup.length) return res.status(409).json({ message: 'This batch number already exists for this product' });
    const [r] = await pool.query(
      `UPDATE batches SET product_id=?, supplier_id=?, batch_no=?, mfg_date=?, expiry_date=?,
              quantity=?, purchase_price=?, selling_price=? WHERE batch_id=?`,
      [...clean(req.body), req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Batch not found' });
    res.json({ message: 'Batch updated' });
  } catch (err) {
    if (err.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({ message: 'Choose a valid product and supplier' });
    }
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id', authorize('owner'), async (req, res) => {
  try {
    const [r] = await pool.query('DELETE FROM batches WHERE batch_id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Batch not found' });
    res.json({ message: 'Batch deleted' });
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ message: 'This batch has sales or recalls, so it cannot be deleted' });
    }
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;