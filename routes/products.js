const express = require('express');
const pool = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const CATEGORIES = ['seed', 'fertilizer', 'pesticide'];

function validate(body) {
  const { name, category, unit, tax_rate, waiting_period_days } = body;
  if (!name || !name.trim()) return 'Product name is required';
  if (!CATEGORIES.includes(category)) return 'Choose seed, fertilizer or pesticide';
  if (!unit || !unit.trim()) return 'Unit is required (for example kg, litre, packet)';
  if (tax_rate !== '' && tax_rate != null && (isNaN(tax_rate) || tax_rate < 0 || tax_rate > 100)) {
    return 'Tax rate must be between 0 and 100';
  }
  if (waiting_period_days !== '' && waiting_period_days != null &&
      (!Number.isInteger(Number(waiting_period_days)) || waiting_period_days < 0)) {
    return 'Waiting period must be a whole number of days';
  }
  return null;
}

function clean(body) {
  return [
    body.name.trim(),
    body.category,
    body.unit.trim(),
    (body.manufacturer || '').trim() || null,
    (body.hsn_code || '').trim() || null,
    body.tax_rate === '' || body.tax_rate == null ? 0 : body.tax_rate,
    body.category === 'pesticide' && body.waiting_period_days !== '' && body.waiting_period_days != null
      ? body.waiting_period_days : null,
  ];
}

router.get('/', async (req, res) => {
  try {
    const { search, category } = req.query;
    let sql = 'SELECT * FROM products WHERE 1=1';
    const params = [];
    if (search) {
      sql += ' AND (name LIKE ? OR manufacturer LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    if (category && CATEGORIES.includes(category)) {
      sql += ' AND category = ?';
      params.push(category);
    }
    sql += ' ORDER BY name';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM products WHERE product_id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ message: 'Product not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', authorize('owner'), async (req, res) => {
  const error = validate(req.body);
  if (error) return res.status(400).json({ message: error });
  try {
    const [result] = await pool.query(
      `INSERT INTO products (name, category, unit, manufacturer, hsn_code, tax_rate, waiting_period_days)
       VALUES (?,?,?,?,?,?,?)`, clean(req.body));
    res.status(201).json({ product_id: result.insertId, message: 'Product added' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/:id', authorize('owner'), async (req, res) => {
  const error = validate(req.body);
  if (error) return res.status(400).json({ message: error });
  try {
    const [result] = await pool.query(
      `UPDATE products SET name=?, category=?, unit=?, manufacturer=?, hsn_code=?,
       tax_rate=?, waiting_period_days=? WHERE product_id=?`,
      [...clean(req.body), req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ message: 'Product not found' });
    res.json({ message: 'Product updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id', authorize('owner'), async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM products WHERE product_id = ?', [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ message: 'Product not found' });
    res.json({ message: 'Product deleted' });
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ message: 'This product has batches, so it cannot be deleted' });
    }
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;