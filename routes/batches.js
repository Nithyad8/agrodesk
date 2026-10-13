const express = require('express');
const QRCode = require('qrcode');
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
function baseUrl(req) {
  return (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

router.get('/:id/qr', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.batch_id, b.batch_no, p.name AS product_name
       FROM batches b JOIN products p ON p.product_id = b.product_id
       WHERE b.batch_id = ?`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ message: 'Batch not found' });
    const url = `${baseUrl(req)}/batch.html?id=${rows[0].batch_id}`;
    const dataUrl = await QRCode.toDataURL(url, { width: 300, margin: 2 });
    res.json({ url, dataUrl, product_name: rows[0].product_name, batch_no: rows[0].batch_no });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id/details', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.*, p.name AS product_name, p.category, p.unit, s.name AS supplier_name,
              DATEDIFF(b.expiry_date, CURDATE()) AS days_to_expiry
       FROM batches b
       JOIN products p ON p.product_id = b.product_id
       JOIN suppliers s ON s.supplier_id = b.supplier_id
       WHERE b.batch_id = ?`, [req.params.id]);
    const batch = rows[0];
    if (!batch) return res.status(404).json({ message: 'Batch not found' });

    const flags = [];
    if (batch.days_to_expiry < 0) flags.push('expired');
    else if (batch.days_to_expiry <= NEAR_DAYS) flags.push('near_expiry');
    if (batch.quantity <= LOW_STOCK) flags.push('low_stock');

    const [sales] = await pool.query(
      `SELECT s.sale_id, s.sale_date, f.name AS farmer_name, f.village,
              si.quantity, si.price, si.crop
       FROM sale_items si
       JOIN sales s ON s.sale_id = si.sale_id
       JOIN farmers f ON f.farmer_id = s.farmer_id
       WHERE si.batch_id = ?
       ORDER BY s.sale_date DESC`, [req.params.id]);

    res.json({ ...batch, flags, sales });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});
router.post('/:id/packs/generate', authorize('owner', 'staff'), async (req, res) => {
  try {
    const [b] = await pool.query('SELECT batch_id, quantity FROM batches WHERE batch_id = ?', [req.params.id]);
    if (!b[0]) return res.status(404).json({ message: 'Batch not found' });

    const [[total]] = await pool.query('SELECT COUNT(*) AS n FROM packs WHERE batch_id = ?', [req.params.id]);
    const [[stock]] = await pool.query(
      "SELECT COUNT(*) AS n FROM packs WHERE batch_id = ? AND status = 'in_stock'", [req.params.id]);
    const allowed = b[0].quantity - stock.n;
    if (allowed <= 0) return res.status(400).json({ message: 'Every unit in this batch already has a pack code' });

    const count = req.body.count === '' || req.body.count == null ? allowed : Number(req.body.count);
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
      return res.status(400).json({ message: 'Enter a whole number from 1 to 1000' });
    }
    if (count > allowed) {
      return res.status(400).json({ message: `Only ${allowed} more pack codes can be created for this batch` });
    }

    const values = [];
    for (let i = 1; i <= count; i++) {
      values.push([req.params.id, `B${req.params.id}-${String(total.n + i).padStart(4, '0')}`]);
    }
    await pool.query('INSERT INTO packs (batch_id, pack_code) VALUES ?', [values]);
    res.status(201).json({ message: count + ' pack codes created' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error: ' + (err.code || '') + ' ' + err.message });
  }
});

router.get('/:id/packs', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.batch_id, b.batch_no, b.expiry_date, b.quantity, p.name AS product_name
       FROM batches b JOIN products p ON p.product_id = b.product_id WHERE b.batch_id = ?`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ message: 'Batch not found' });

    const [packs] = await pool.query(
      'SELECT pack_code, status FROM packs WHERE batch_id = ? ORDER BY pack_id', [req.params.id]);
    const withQr = await Promise.all(packs.map(async (pk) => ({
      ...pk,
      dataUrl: await QRCode.toDataURL(`${baseUrl(req)}/pack.html?code=${pk.pack_code}`, { width: 200, margin: 1 }),
    })));
    const inStock = packs.filter(pk => pk.status === 'in_stock').length;
    res.json({ batch: rows[0], in_stock: inStock, allowed: Math.max(0, rows[0].quantity - inStock), packs: withQr });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error: ' + (err.code || '') + ' ' + err.message });
  }
});
module.exports = router;