const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, authorize('owner'));

const ROLES = ['owner', 'staff', 'inspector'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function handle(res, err) {
  if (err instanceof HttpError) return res.status(err.status).json({ message: err.message });
  if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'That username is already taken' });
  if (err.code === 'ER_ROW_IS_REFERENCED_2') {
    return res.status(409).json({ message: 'This user has created bills, so cannot be deleted. Change their role or password instead.' });
  }
  console.error(err);
  res.status(500).json({ message: 'Server error: ' + (err.code || '') + ' ' + err.message });
}

function parse(b, passwordRequired) {
  const name = (b.name || '').trim();
  const username = (b.username || '').trim();
  const password = b.password == null ? '' : String(b.password);
  if (!name) throw new HttpError(400, 'Name is required');
  if (name.length > 100) throw new HttpError(400, 'Name is too long');
  if (!/^[A-Za-z0-9_]{3,30}$/.test(username)) {
    throw new HttpError(400, 'Username must be 3 to 30 letters, numbers or underscores');
  }
  if (!ROLES.includes(b.role)) throw new HttpError(400, 'Choose a role');
  if (password || passwordRequired) {
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    if (Buffer.byteLength(password) > 72) throw new HttpError(400, 'Password is too long');
  }
  return { name, username, role: b.role, password };
}

router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.user_id, u.name, u.username, u.role,
              (SELECT COUNT(*) FROM sales s WHERE s.user_id = u.user_id) AS bills
       FROM users u ORDER BY u.name`);
    res.json(rows.map(r => ({ ...r, is_you: r.user_id === req.user.user_id })));
  } catch (err) { handle(res, err); }
});

router.post('/', async (req, res) => {
  try {
    const p = parse(req.body, true);
    const hash = await bcrypt.hash(p.password, 10);
    const [r] = await pool.query(
      'INSERT INTO users (name, username, password_hash, role) VALUES (?,?,?,?)',
      [p.name, p.username, hash, p.role]);
    res.status(201).json({ user_id: r.insertId, message: 'User added' });
  } catch (err) { handle(res, err); }
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid user' });
  const conn = await pool.getConnection();
  try {
    const p = parse(req.body, false);
    await conn.beginTransaction();
    const [cur] = await conn.query('SELECT user_id, role FROM users WHERE user_id = ? FOR UPDATE', [id]);
    if (!cur[0]) throw new HttpError(404, 'User not found');

    if (cur[0].role === 'owner' && p.role !== 'owner') {
      if (id === req.user.user_id) throw new HttpError(400, 'You cannot remove your own owner role');
      const [owners] = await conn.query("SELECT user_id FROM users WHERE role = 'owner' FOR UPDATE");
      if (owners.length < 2) throw new HttpError(400, 'At least one owner is required');
    }

    if (p.password) {
      const hash = await bcrypt.hash(p.password, 10);
      await conn.query('UPDATE users SET name=?, username=?, role=?, password_hash=? WHERE user_id=?',
        [p.name, p.username, p.role, hash, id]);
    } else {
      await conn.query('UPDATE users SET name=?, username=?, role=? WHERE user_id=?',
        [p.name, p.username, p.role, id]);
    }
    await conn.commit();
    res.json({ message: 'User updated' });
  } catch (err) {
    await conn.rollback();
    handle(res, err);
  } finally { conn.release(); }
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid user' });
  if (id === req.user.user_id) return res.status(400).json({ message: 'You cannot delete your own account' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [cur] = await conn.query('SELECT role FROM users WHERE user_id = ? FOR UPDATE', [id]);
    if (!cur[0]) throw new HttpError(404, 'User not found');
    if (cur[0].role === 'owner') {
      const [owners] = await conn.query("SELECT user_id FROM users WHERE role = 'owner' FOR UPDATE");
      if (owners.length < 2) throw new HttpError(400, 'At least one owner is required');
    }
    await conn.query('DELETE FROM users WHERE user_id = ?', [id]);
    await conn.commit();
    res.json({ message: 'User deleted' });
  } catch (err) {
    await conn.rollback();
    handle(res, err);
  } finally { conn.release(); }
});

module.exports = router;