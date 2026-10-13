const express = require('express');
const pool = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const MODES = ['cash', 'upi', 'credit'];
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

class BadRequest extends Error {}

const fail = (res, err) => {
  console.error(err);
  res.status(500).json({ message: 'Server error: ' + (err.code || '') + ' ' + err.message });
};

router.post('/', authorize('owner', 'staff'), async (req, res) => {
  const { farmer_id, payment_mode, items } = req.body;
  if (!farmer_id || !Number.isInteger(Number(farmer_id))) {
    return res.status(400).json({ message: 'Choose a farmer' });
  }
  if (!MODES.includes(payment_mode)) {
    return res.status(400).json({ message: 'Choose cash, UPI or credit' });
  }
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ message: 'Add at least one item' });
  }
  if (items.length > 50) {
    return res.status(400).json({ message: 'A bill can have at most 50 items' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[day]] = await conn.query('SELECT CURDATE() AS today');
    const today = day.today;

    const [fr] = await conn.query('SELECT farmer_id FROM farmers WHERE farmer_id = ? FOR UPDATE', [farmer_id]);
    if (!fr[0]) throw new BadRequest('Farmer not found');

    const [sr] = await conn.query(
      'INSERT INTO sales (farmer_id, user_id, sale_date, total_amount, payment_mode) VALUES (?,?,?,0,?)',
      [farmer_id, req.user.user_id, today, payment_mode]);
    const saleId = sr.insertId;

    let total = 0;
    for (const it of items) {
      const qty = Number(it.quantity);
      if (!Number.isInteger(qty) || qty < 1) throw new BadRequest('Quantity must be a whole number, 1 or more');

      const [br] = await conn.query(
        `SELECT b.batch_id, b.batch_no, b.quantity, b.selling_price,
                DATEDIFF(b.expiry_date, CURDATE()) AS days_left,
                p.name, p.category, p.tax_rate
         FROM batches b JOIN products p ON p.product_id = b.product_id
         WHERE b.batch_id = ? FOR UPDATE`, [it.batch_id]);
      const b = br[0];
      if (!b) throw new BadRequest('Batch not found');
      const label = `${b.name} (batch ${b.batch_no})`;

      if (b.days_left < 0) throw new BadRequest(`${label} has expired and cannot be sold`);
      const [rec] = await conn.query(
        "SELECT 1 FROM batch_recalls WHERE batch_id = ? AND status = 'open' LIMIT 1", [b.batch_id]);
      if (rec.length) throw new BadRequest(`${label} is under recall and cannot be sold`);
      if (b.selling_price == null) throw new BadRequest(`${label} has no selling price. Set it on the Batches page`);
      if (b.quantity < qty) throw new BadRequest(`Only ${b.quantity} left of ${label}`);

      const isPesticide = b.category === 'pesticide';
      const crop = (it.crop || '').trim() || null;
      let appDate = null;
      if (isPesticide) {
        if (!crop) throw new BadRequest(`Enter the crop for ${label}`);
        appDate = it.application_date || today;
        if (!isDate(appDate)) throw new BadRequest('Application date is not valid');
      }

      const price = Number(b.selling_price);
      const taxRate = Number(b.tax_rate);

      const codes = Array.isArray(it.pack_codes)
        ? it.pack_codes.map(c => String(c).trim()).filter(Boolean) : [];
      let packs = [];
      if (codes.length) {
        if (new Set(codes).size !== codes.length) throw new BadRequest('Pack codes must all be different');
        if (codes.length !== qty) throw new BadRequest(`Enter ${qty} pack codes for ${label}, or leave them empty`);
        const [pk] = await conn.query(
          'SELECT pack_id, pack_code, batch_id, status FROM packs WHERE pack_code IN (?) FOR UPDATE', [codes]);
        if (pk.length !== codes.length) throw new BadRequest('One or more pack codes were not found');
        for (const p of pk) {
          if (p.batch_id !== b.batch_id) throw new BadRequest(`Pack ${p.pack_code} belongs to a different batch`);
          if (p.status !== 'in_stock') throw new BadRequest(`Pack ${p.pack_code} is already sold`);
        }
        packs = pk;
      }

      const [ir] = await conn.query(
        `INSERT INTO sale_items (sale_id, batch_id, quantity, price, tax_rate, crop, application_date)
         VALUES (?,?,?,?,?,?,?)`,
        [saleId, b.batch_id, qty, price, taxRate, crop, appDate]);

      if (packs.length) {
        await conn.query(
          "UPDATE packs SET status = 'sold', sale_item_id = ?, sold_date = ? WHERE pack_id IN (?)",
          [ir.insertId, today, packs.map(p => p.pack_id)]);
      }

      const [u] = await conn.query(
        'UPDATE batches SET quantity = quantity - ? WHERE batch_id = ? AND quantity >= ?',
        [qty, b.batch_id, qty]);
      if (!u.affectedRows) throw new BadRequest(`Stock changed for ${label}. Try again`);

      const line = round2(price * qty);
      total += line + round2(line * taxRate / 100);
    }

    total = round2(total);
    await conn.query('UPDATE sales SET total_amount = ? WHERE sale_id = ?', [total, saleId]);
    if (payment_mode === 'credit') {
      await conn.query('UPDATE farmers SET credit_balance = credit_balance + ? WHERE farmer_id = ?',
        [total, farmer_id]);
    }

    await conn.commit();
    res.status(201).json({ sale_id: saleId, total_amount: total, message: 'Bill saved' });
  } catch (err) {
    await conn.rollback();
    if (err instanceof BadRequest) return res.status(400).json({ message: err.message });
    fail(res, err);
  } finally {
    conn.release();
  }
});

router.get('/', async (req, res) => {
  try {
    const { from, to, search } = req.query;
    let sql = `SELECT s.sale_id, s.sale_date, s.total_amount, s.payment_mode,
                      f.name AS farmer_name, u.name AS user_name
               FROM sales s
               JOIN farmers f ON f.farmer_id = s.farmer_id
               JOIN users u ON u.user_id = s.user_id
               WHERE 1=1`;
    const params = [];
    if (from && isDate(from)) { sql += ' AND s.sale_date >= ?'; params.push(from); }
    if (to && isDate(to)) { sql += ' AND s.sale_date <= ?'; params.push(to); }
    if (search) { sql += ' AND f.name LIKE ?'; params.push(`%${search}%`); }
    sql += ' ORDER BY s.sale_id DESC LIMIT 200';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.get('/:id', async (req, res) => {
  try {
    const [h] = await pool.query(
      `SELECT s.sale_id, s.sale_date, s.total_amount, s.payment_mode,
              f.name AS farmer_name, f.phone, f.village, u.name AS user_name
       FROM sales s
       JOIN farmers f ON f.farmer_id = s.farmer_id
       JOIN users u ON u.user_id = s.user_id
       WHERE s.sale_id = ?`, [req.params.id]);
    if (!h[0]) return res.status(404).json({ message: 'Bill not found' });

    const [rows] = await pool.query(
      `SELECT si.quantity, si.price, si.tax_rate, si.crop, si.application_date,
              p.name AS product_name, p.unit, b.batch_no
       FROM sale_items si
       JOIN batches b ON b.batch_id = si.batch_id
       JOIN products p ON p.product_id = b.product_id
       WHERE si.sale_id = ? ORDER BY si.sale_item_id`, [req.params.id]);

    let subtotal = 0, taxTotal = 0;
    const items = rows.map(r => {
      const line = round2(Number(r.price) * r.quantity);
      const tax = round2(line * Number(r.tax_rate) / 100);
      subtotal += line; taxTotal += tax;
      return { ...r, line_total: line, tax_amount: tax };
    });
    res.json({ ...h[0], items, subtotal: round2(subtotal), tax_total: round2(taxTotal) });
  } catch (err) { fail(res, err); }
});

module.exports = router;