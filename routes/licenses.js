const express = require('express');
const pool = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const STATUSES = ['not_started', 'in_progress', 'submitted', 'approved'];
const DEFAULT_ITEMS = [
  'License copy',
  'Business registration document',
  'Identification document',
  'Previous license details',
  'Renewal application',
  'Renewal receipt',
];

class BadRequest extends Error {}

const fail = (res, err) => {
  console.error(err);
  res.status(500).json({ message: 'Server error: ' + (err.code || '') + ' ' + err.message });
};

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

function info(days) {
  let level = 'valid';
  if (days < 0) level = 'expired';
  else if (days <= 7) level = 'urgent';
  else if (days <= 30) level = 'soon';
  else if (days <= 60) level = 'approaching';
  const message = {
    valid: 'License is valid',
    approaching: 'License renewal is approaching',
    soon: 'Renewal required within 30 days',
    urgent: days === 0 ? 'Urgent: license expires today'
                       : `Urgent: license expires in ${days} day${days === 1 ? '' : 's'}`,
    expired: 'License has expired. Please update the renewal status.',
  }[level];
  return { level, message };
}

function parse(b) {
  const type = (b.type || '').trim();
  const license_no = (b.license_no || '').trim();
  if (!type) throw new BadRequest('License type is required');
  if (type.length > 100) throw new BadRequest('License type is too long');
  if (!license_no) throw new BadRequest('License number is required');
  if (license_no.length > 50) throw new BadRequest('License number is too long');
  if (!validDate(b.expiry_date)) throw new BadRequest('Enter a valid expiry date');
  const issue = b.issue_date ? b.issue_date : null;
  if (issue && !validDate(issue)) throw new BadRequest('Enter a valid issue date');
  if (issue && issue > b.expiry_date) throw new BadRequest('Issue date must be before the expiry date');
  const supplier = b.supplier_id === '' || b.supplier_id == null ? null : Number(b.supplier_id);
  if (supplier !== null && !Number.isInteger(supplier)) throw new BadRequest('Choose a valid holder');
  return { type, license_no, issue, expiry: b.expiry_date, supplier };
}

const SELECT = `SELECT l.*, s.name AS supplier_name,
                       DATEDIFF(l.expiry_date, CURDATE()) AS days_left,
                       (SELECT COUNT(*) FROM license_checklist c WHERE c.license_id = l.license_id) AS items_total,
                       (SELECT COUNT(*) FROM license_checklist c WHERE c.license_id = l.license_id AND c.is_done = 1) AS items_done
                FROM licenses l LEFT JOIN suppliers s ON s.supplier_id = l.supplier_id`;

router.get('/', authorize('owner', 'inspector'), async (req, res) => {
  try {
    const [rows] = await pool.query(SELECT + ' ORDER BY l.expiry_date');
    let list = rows.map(r => ({ ...r, ...info(r.days_left) }));
    const { search, level } = req.query;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(r => r.type.toLowerCase().includes(q) || r.license_no.toLowerCase().includes(q) ||
                              (r.supplier_name || 'shop').toLowerCase().includes(q));
    }
    if (level) list = list.filter(r => r.level === level);
    res.json(list);
  } catch (err) { fail(res, err); }
});

router.get('/:id', authorize('owner', 'inspector'), async (req, res) => {
  try {
    const [rows] = await pool.query(SELECT + ' WHERE l.license_id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ message: 'License not found' });
    const [items] = await pool.query(
      'SELECT checklist_id, item_name, is_done FROM license_checklist WHERE license_id = ? ORDER BY checklist_id',
      [req.params.id]);
    res.json({ ...rows[0], ...info(rows[0].days_left), checklist: items });
  } catch (err) { fail(res, err); }
});

router.post('/', authorize('owner'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const p = parse(req.body);
    await conn.beginTransaction();
    const [dup] = await conn.query('SELECT license_id FROM licenses WHERE type = ? AND license_no = ?',
      [p.type, p.license_no]);
    if (dup.length) throw new BadRequest('This license number already exists for this type');
    const [r] = await conn.query(
      'INSERT INTO licenses (supplier_id, type, license_no, issue_date, expiry_date) VALUES (?,?,?,?,?)',
      [p.supplier, p.type, p.license_no, p.issue, p.expiry]);
    await conn.query('INSERT INTO license_checklist (license_id, item_name) VALUES ?',
      [DEFAULT_ITEMS.map(n => [r.insertId, n])]);
    await conn.commit();
    res.status(201).json({ license_id: r.insertId, message: 'License added' });
  } catch (err) {
    await conn.rollback();
    if (err instanceof BadRequest) return res.status(400).json({ message: err.message });
    if (err.code === 'ER_NO_REFERENCED_ROW_2') return res.status(400).json({ message: 'Choose a valid holder' });
    fail(res, err);
  } finally { conn.release(); }
});

router.put('/:id', authorize('owner'), async (req, res) => {
  try {
    const p = parse(req.body);
    const [dup] = await pool.query(
      'SELECT license_id FROM licenses WHERE type = ? AND license_no = ? AND license_id <> ?',
      [p.type, p.license_no, req.params.id]);
    if (dup.length) return res.status(409).json({ message: 'This license number already exists for this type' });
    const [r] = await pool.query(
      'UPDATE licenses SET supplier_id=?, type=?, license_no=?, issue_date=?, expiry_date=? WHERE license_id=?',
      [p.supplier, p.type, p.license_no, p.issue, p.expiry, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'License not found' });
    res.json({ message: 'License updated' });
  } catch (err) {
    if (err instanceof BadRequest) return res.status(400).json({ message: err.message });
    if (err.code === 'ER_NO_REFERENCED_ROW_2') return res.status(400).json({ message: 'Choose a valid holder' });
    fail(res, err);
  }
});

router.delete('/:id', authorize('owner'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM license_checklist WHERE license_id = ?', [req.params.id]);
    const [r] = await conn.query('DELETE FROM licenses WHERE license_id = ?', [req.params.id]);
    if (!r.affectedRows) throw new BadRequest('License not found');
    await conn.commit();
    res.json({ message: 'License deleted' });
  } catch (err) {
    await conn.rollback();
    if (err instanceof BadRequest) return res.status(404).json({ message: err.message });
    fail(res, err);
  } finally { conn.release(); }
});

router.put('/:id/renewal', authorize('owner'), async (req, res) => {
  try {
    const { status, date, new_expiry_date } = req.body;
    if (!STATUSES.includes(status)) return res.status(400).json({ message: 'Choose a renewal status' });

    const [rows] = await pool.query(
      `SELECT expiry_date, renewal_submitted_date,
              DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today
       FROM licenses WHERE license_id = ?`, [req.params.id]);
    const l = rows[0];
    if (!l) return res.status(404).json({ message: 'License not found' });

    const when = date || l.today;
    if (!validDate(when)) return res.status(400).json({ message: 'Enter a valid date' });

    if (status === 'not_started' || status === 'in_progress') {
      await pool.query(
        'UPDATE licenses SET renewal_status = ?, renewal_submitted_date = NULL, renewal_approved_date = NULL WHERE license_id = ?',
        [status, req.params.id]);
      if (status === 'not_started') {
        await pool.query('UPDATE license_checklist SET is_done = 0 WHERE license_id = ?', [req.params.id]);
      }
    } else if (status === 'submitted') {
      await pool.query(
        'UPDATE licenses SET renewal_status = ?, renewal_submitted_date = ?, renewal_approved_date = NULL WHERE license_id = ?',
        [status, when, req.params.id]);
    } else {
      if (!l.renewal_submitted_date) {
        return res.status(400).json({ message: 'Mark the renewal as submitted before approving it' });
      }
      if (when < l.renewal_submitted_date) {
        return res.status(400).json({ message: 'Approval date cannot be before the submitted date' });
      }
      if (!validDate(new_expiry_date)) {
        return res.status(400).json({ message: 'Enter the new expiry date from the renewed license' });
      }
      if (new_expiry_date <= l.expiry_date) {
        return res.status(400).json({ message: 'The new expiry date must be after the current expiry date' });
      }
      await pool.query(
        'UPDATE licenses SET renewal_status = ?, renewal_approved_date = ?, expiry_date = ? WHERE license_id = ?',
        [status, when, new_expiry_date, req.params.id]);
    }
    res.json({ message: 'Renewal status updated' });
  } catch (err) { fail(res, err); }
});

router.put('/:id/checklist/:itemId', authorize('owner'), async (req, res) => {
  try {
    const [r] = await pool.query(
      'UPDATE license_checklist SET is_done = ? WHERE checklist_id = ? AND license_id = ?',
      [req.body.is_done ? 1 : 0, req.params.itemId, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Checklist item not found' });
    res.json({ message: 'Checklist updated' });
  } catch (err) { fail(res, err); }
});

router.post('/:id/checklist', authorize('owner'), async (req, res) => {
  const name = (req.body.item_name || '').trim();
  if (!name) return res.status(400).json({ message: 'Enter the document name' });
  if (name.length > 100) return res.status(400).json({ message: 'Document name is too long' });
  try {
    const [l] = await pool.query('SELECT license_id FROM licenses WHERE license_id = ?', [req.params.id]);
    if (!l[0]) return res.status(404).json({ message: 'License not found' });
    await pool.query('INSERT INTO license_checklist (license_id, item_name) VALUES (?,?)', [req.params.id, name]);
    res.status(201).json({ message: 'Item added' });
  } catch (err) { fail(res, err); }
});

router.delete('/:id/checklist/:itemId', authorize('owner'), async (req, res) => {
  try {
    const [r] = await pool.query('DELETE FROM license_checklist WHERE checklist_id = ? AND license_id = ?',
      [req.params.itemId, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Checklist item not found' });
    res.json({ message: 'Item removed' });
  } catch (err) { fail(res, err); }
});

module.exports = router;