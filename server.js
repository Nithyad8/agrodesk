require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./db');
const { authenticate, authorize } = require('./middleware/auth');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.redirect('/login.html'));

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/suppliers', require('./routes/suppliers'));
app.use('/api/batches', require('./routes/batches'));
app.use('/api/farmers', require('./routes/farmers'));
app.use('/api/public', require('./routes/public'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/licenses', require('./routes/licenses'));
app.use('/api/alerts', require('./routes/alerts'));
app.use('/api/recalls', require('./routes/recalls'));
app.use('/api/users', require('./routes/users'));
app.use('/api/reports', require('./routes/reports'));

app.get('/api/test/owner-only', authenticate, authorize('owner'), (req, res) => {
  res.json({ message: 'Hello owner, you have access' });
});

app.use('/api', (req, res) => {
  res.status(404).json({ message: 'API route not found: ' + req.method + ' ' + req.originalUrl });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AgroDesk running on http://localhost:${PORT}`));