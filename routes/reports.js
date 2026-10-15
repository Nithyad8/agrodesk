const express = require('express');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const LOW_STOCK = 10;
const NEAR_DAYS = 30;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MODE = { cash: 'Cash', upi: 'UPI', credit: 'Credit' };
const RENEWAL = { not_started: 'Not started', in_progress: 'In progress', submitted: 'Submitted', approved: 'Approved' };
const LEVEL_TEXT = { valid: 'Valid', approaching: 'Renewal approaching', soon: 'Renewal required', urgent: 'Urgent', expired: 'Expired' };
const CATEGORIES = ['seed', 'fertilizer', 'pesticide'];

const REPORTS = {
  sales:    { label: 'Sales report', roles: ['owner', 'inspector'], dates: true },
  stock:    { label: 'Stock report', roles: ['owner', 'staff', 'inspector'] },
  expiry:   { label: 'Expiry report', roles: ['owner', 'staff', 'inspector'], days: true },
  licenses: { label: 'License report', roles: ['owner', 'inspector'] },
  farmers:  { label: 'Farmer purchase report', roles: ['owner'], dates: true },
  trend:    { label: 'Sales trend analysis', roles: ['owner'], dates: true, trend: true },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => Number(v) || 0;

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

async function getRange(q, defaultDays) {
  const [[d]] = await pool.query(
    `SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today,
            DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL ? DAY), '%Y-%m-%d') AS def_from`, [defaultDays]);
  const from = q.from || d.def_from;
  const to = q.to || d.today;
  if (!validDate(from) || !validDate(to)) throw new HttpError(400, 'Enter valid dates');
  if (from > to) throw new HttpError(400, 'The "from" date must be on or before the "to" date');
  return { from, to };
}

function licenseLevel(days) {
  if (days < 0) return 'expired';
  if (days <= 7) return 'urgent';
  if (days <= 30) return 'soon';
  if (days <= 60) return 'approaching';
  return 'valid';
}

function monthList(from, to) {
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ey, em] = to.slice(0, 7).split('-').map(Number);
  const out = [];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (out.length > 36) throw new HttpError(400, 'Choose a range of 3 years or less for the trend analysis');
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
const monthLabel = (ym) => MONTH_NAMES[Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(0, 4);

const BUILDERS = {
  async sales(q) {
    const { from, to } = await getRange(q, 30);
    const [rows] = await pool.query(
      `SELECT s.sale_id, s.sale_date, f.name AS farmer, s.payment_mode, u.name AS billed_by, s.total_amount
       FROM sales s JOIN farmers f ON f.farmer_id = s.farmer_id JOIN users u ON u.user_id = s.user_id
       WHERE s.sale_date BETWEEN ? AND ?
       ORDER BY s.sale_date DESC, s.sale_id DESC LIMIT 2001`, [from, to]);
    const [modes] = await pool.query(
      `SELECT payment_mode, COUNT(*) AS bills, COALESCE(SUM(total_amount), 0) AS total
       FROM sales WHERE sale_date BETWEEN ? AND ? GROUP BY payment_mode`, [from, to]);
    const bills = modes.reduce((s, m) => s + num(m.bills), 0);
    const total = modes.reduce((s, m) => s + num(m.total), 0);
    const summary = [
      { label: 'Bills', value: bills, type: 'number' },
      { label: 'Total sales', value: round2(total), type: 'money' },
    ];
    ['cash', 'upi', 'credit'].forEach(k => {
      const m = modes.find(x => x.payment_mode === k);
      summary.push({ label: MODE[k], value: round2(m ? m.total : 0), type: 'money' });
    });
    return {
      title: 'Sales report', period: { from, to },
      note: rows.length > 2000 ? 'Showing the latest 2000 bills. Narrow the dates to see the rest. Totals above include all bills.' : null,
      columns: [
        { key: 'bill', label: 'Bill', type: 'text' }, { key: 'date', label: 'Date', type: 'text' },
        { key: 'farmer', label: 'Farmer', type: 'text' }, { key: 'payment', label: 'Payment', type: 'text' },
        { key: 'billed_by', label: 'Billed by', type: 'text' }, { key: 'amount', label: 'Amount', type: 'money' },
      ],
      rows: rows.slice(0, 2000).map(r => ({
        bill: '#' + r.sale_id, date: r.sale_date, farmer: r.farmer, payment: MODE[r.payment_mode],
        billed_by: r.billed_by, amount: round2(r.total_amount),
      })),
      summary,
    };
  },

  async stock() {
    const [rows] = await pool.query(
      `SELECT p.name AS product, p.category, b.batch_no, s.name AS supplier, b.expiry_date,
              DATEDIFF(b.expiry_date, CURDATE()) AS days_left, b.quantity, p.unit,
              b.selling_price, COALESCE(b.selling_price, 0) * b.quantity AS stock_value
       FROM batches b JOIN products p ON p.product_id = b.product_id JOIN suppliers s ON s.supplier_id = b.supplier_id
       WHERE b.quantity > 0 ORDER BY p.name, b.expiry_date`);
    let expired = 0, near = 0, low = 0, noPrice = 0, value = 0;
    const out = rows.map(r => {
      const status = [];
      if (r.days_left < 0) { status.push('Expired'); expired++; }
      else if (r.days_left <= NEAR_DAYS) { status.push('Near expiry'); near++; }
      if (r.quantity <= LOW_STOCK) { status.push('Low stock'); low++; }
      if (r.selling_price == null) noPrice++;
      value += num(r.stock_value);
      return {
        product: r.product, category: r.category, batch_no: r.batch_no, supplier: r.supplier,
        expiry_date: r.expiry_date, days_left: r.days_left, quantity: r.quantity, unit: r.unit,
        stock_value: round2(r.stock_value), status: status.length ? status.join(', ') : 'OK',
        _level: r.days_left < 0 ? 'bad' : (status.length ? 'warn' : undefined),
      };
    });
    return {
      title: 'Stock report', period: null,
      note: noPrice ? `${noPrice} batch(es) have no selling price, so their value counts as 0.` : null,
      columns: [
        { key: 'product', label: 'Product', type: 'text' }, { key: 'category', label: 'Category', type: 'text' },
        { key: 'batch_no', label: 'Batch', type: 'text' }, { key: 'supplier', label: 'Supplier', type: 'text' },
        { key: 'expiry_date', label: 'Expiry', type: 'text' }, { key: 'days_left', label: 'Days left', type: 'number' },
        { key: 'quantity', label: 'Quantity', type: 'number' }, { key: 'unit', label: 'Unit', type: 'text' },
        { key: 'stock_value', label: 'Value at selling price', type: 'money' }, { key: 'status', label: 'Status', type: 'text' },
      ],
      rows: out,
      summary: [
        { label: 'Batches in stock', value: out.length, type: 'number' },
        { label: 'Stock value', value: round2(value), type: 'money' },
        { label: 'Expired batches', value: expired, type: 'number' },
        { label: 'Near expiry', value: near, type: 'number' },
        { label: 'Low stock', value: low, type: 'number' },
      ],
    };
  },

  async expiry(q) {
    const days = q.days === undefined || q.days === '' ? 90 : Number(q.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, 'Days must be a whole number from 1 to 365');
    const [rows] = await pool.query(
      `SELECT p.name AS product, b.batch_no, s.name AS supplier, b.expiry_date,
              DATEDIFF(b.expiry_date, CURDATE()) AS days_left, b.quantity, p.unit,
              COALESCE(b.selling_price, 0) * b.quantity AS value_at_risk
       FROM batches b JOIN products p ON p.product_id = b.product_id JOIN suppliers s ON s.supplier_id = b.supplier_id
       WHERE b.quantity > 0 AND b.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
       ORDER BY b.expiry_date`, [days]);
    let expired = 0, soon = 0, risk = 0;
    const out = rows.map(r => {
      let status, level;
      if (r.days_left < 0) { status = 'Expired'; level = 'bad'; expired++; }
      else if (r.days_left <= 7) { status = 'Expires within 7 days'; level = 'bad'; soon++; }
      else { status = 'Expiring soon'; level = 'warn'; soon++; }
      risk += num(r.value_at_risk);
      return {
        product: r.product, batch_no: r.batch_no, supplier: r.supplier, expiry_date: r.expiry_date,
        days_left: r.days_left, quantity: r.quantity, unit: r.unit, value: round2(r.value_at_risk),
        status, _level: level,
      };
    });
    return {
      title: `Expiry report (expired and expiring within ${days} days)`, period: null, note: null,
      columns: [
        { key: 'product', label: 'Product', type: 'text' }, { key: 'batch_no', label: 'Batch', type: 'text' },
        { key: 'supplier', label: 'Supplier', type: 'text' }, { key: 'expiry_date', label: 'Expiry', type: 'text' },
        { key: 'days_left', label: 'Days left', type: 'number' }, { key: 'quantity', label: 'Quantity', type: 'number' },
        { key: 'unit', label: 'Unit', type: 'text' }, { key: 'value', label: 'Value at selling price', type: 'money' },
        { key: 'status', label: 'Status', type: 'text' },
      ],
      rows: out,
      summary: [
        { label: 'Expired batches', value: expired, type: 'number' },
        { label: 'Expiring batches', value: soon, type: 'number' },
        { label: 'Value at risk', value: round2(risk), type: 'money' },
      ],
    };
  },

  async licenses() {
    const [rows] = await pool.query(
      `SELECT l.type, l.license_no, COALESCE(s.name, 'Shop') AS held_by, l.issue_date, l.expiry_date,
              DATEDIFF(l.expiry_date, CURDATE()) AS days_left, l.renewal_status,
              l.renewal_submitted_date, l.renewal_approved_date
       FROM licenses l LEFT JOIN suppliers s ON s.supplier_id = l.supplier_id ORDER BY l.expiry_date`);
    const counts = { expired: 0, urgent: 0, soon: 0, approaching: 0, valid: 0 };
    const out = rows.map(r => {
      const level = licenseLevel(r.days_left);
      counts[level]++;
      return {
        type: r.type, license_no: r.license_no, held_by: r.held_by, issue_date: r.issue_date, expiry_date: r.expiry_date,
        days_left: r.days_left, status: LEVEL_TEXT[level], renewal: RENEWAL[r.renewal_status],
        submitted: r.renewal_submitted_date, approved: r.renewal_approved_date,
        _level: (level === 'expired' || level === 'urgent') ? 'bad' : (level === 'valid' ? undefined : 'warn'),
      };
    });
    return {
      title: 'License report', period: null, note: null,
      columns: [
        { key: 'type', label: 'Type', type: 'text' }, { key: 'license_no', label: 'Number', type: 'text' },
        { key: 'held_by', label: 'Held by', type: 'text' }, { key: 'issue_date', label: 'Issued', type: 'text' },
        { key: 'expiry_date', label: 'Expiry', type: 'text' }, { key: 'days_left', label: 'Days left', type: 'number' },
        { key: 'status', label: 'Status', type: 'text' }, { key: 'renewal', label: 'Renewal', type: 'text' },
        { key: 'submitted', label: 'Renewal submitted', type: 'text' }, { key: 'approved', label: 'Renewal approved', type: 'text' },
      ],
      rows: out,
      summary: [
        { label: 'Licenses', value: out.length, type: 'number' },
        { label: 'Expired', value: counts.expired, type: 'number' },
        { label: 'Urgent (7 days or less)', value: counts.urgent, type: 'number' },
        { label: 'Renewal required (30 days or less)', value: counts.soon, type: 'number' },
        { label: 'Renewal approaching (60 days or less)', value: counts.approaching, type: 'number' },
        { label: 'Valid', value: counts.valid, type: 'number' },
      ],
    };
  },

  async farmers(q) {
    const { from, to } = await getRange(q, 30);
    const [rows] = await pool.query(
      `SELECT f.name, f.village, f.phone, COUNT(s.sale_id) AS bills,
              COALESCE(SUM(s.total_amount), 0) AS total_purchased, f.credit_balance
       FROM farmers f LEFT JOIN sales s ON s.farmer_id = f.farmer_id AND s.sale_date BETWEEN ? AND ?
       GROUP BY f.farmer_id, f.name, f.village, f.phone, f.credit_balance
       ORDER BY total_purchased DESC, f.name`, [from, to]);
    let buyers = 0, total = 0, owed = 0;
    const out = rows.map(r => {
      if (num(r.bills) > 0) buyers++;
      total += num(r.total_purchased); owed += num(r.credit_balance);
      return {
        farmer: r.name, village: r.village, phone: r.phone, bills: num(r.bills),
        total_purchased: round2(r.total_purchased), credit_owed: round2(r.credit_balance),
        _level: num(r.credit_balance) > 0 ? 'warn' : undefined,
      };
    });
    return {
      title: 'Farmer purchase report', period: { from, to },
      note: 'Credit owed is the farmer\'s current balance, not limited to the dates chosen.',
      columns: [
        { key: 'farmer', label: 'Farmer', type: 'text' }, { key: 'village', label: 'Village', type: 'text' },
        { key: 'phone', label: 'Phone', type: 'text' }, { key: 'bills', label: 'Bills', type: 'number' },
        { key: 'total_purchased', label: 'Total purchased', type: 'money' }, { key: 'credit_owed', label: 'Credit owed', type: 'money' },
      ],
      rows: out,
      summary: [
        { label: 'Farmers who bought', value: buyers, type: 'number' },
        { label: 'Total purchased', value: round2(total), type: 'money' },
        { label: 'Credit owed (all farmers)', value: round2(owed), type: 'money' },
      ],
    };
  },

  async trend(q) {
    const { from, to } = await getRange(q, 365);
    const months = monthList(from, to);
    const category = CATEGORIES.includes(q.category) ? q.category : '';

    const catSql = category ? 'WHERE p.category = ?' : '';
    const [prods] = await pool.query(
      `SELECT p.product_id, p.name, p.category, p.unit,
              COALESCE(SUM(x.quantity), 0) AS qty_sold, COALESCE(SUM(x.quantity * x.price), 0) AS revenue
       FROM products p
       LEFT JOIN batches b ON b.product_id = p.product_id
       LEFT JOIN (SELECT si.batch_id, si.quantity, si.price FROM sale_items si
                  JOIN sales s ON s.sale_id = si.sale_id WHERE s.sale_date BETWEEN ? AND ?) x ON x.batch_id = b.batch_id
       ${catSql}
       GROUP BY p.product_id, p.name, p.category, p.unit
       ORDER BY qty_sold DESC, p.name`, category ? [from, to, category] : [from, to]);

    const [monthly] = await pool.query(
      `SELECT DATE_FORMAT(s.sale_date, '%Y-%m') AS ym, p.product_id, SUM(si.quantity) AS qty
       FROM sale_items si JOIN sales s ON s.sale_id = si.sale_id
       JOIN batches b ON b.batch_id = si.batch_id JOIN products p ON p.product_id = b.product_id
       WHERE s.sale_date BETWEEN ? AND ? ${category ? 'AND p.category = ?' : ''}
       GROUP BY DATE_FORMAT(s.sale_date, '%Y-%m'), p.product_id`, category ? [from, to, category] : [from, to]);

    const byProduct = {};
    monthly.forEach(m => { (byProduct[m.product_id] = byProduct[m.product_id] || {})[m.ym] = num(m.qty); });

    const n = prods.length;
    const sold = prods.filter(p => num(p.qty_sold) > 0);
    const fastN = Math.max(1, Math.round(n * 0.2));
    const slowN = Math.max(1, Math.round(n * 0.2));
    sold.forEach((p, i) => {
      p.movement = n < 5 ? '-' : (i < fastN ? 'Fast' : (i >= sold.length - slowN ? 'Slow' : 'Normal'));
    });

    const rows = prods.map((p, i) => {
      const per = byProduct[p.product_id] || {};
      let best = null, bestQty = 0;
      months.forEach(m => { if ((per[m] || 0) > bestQty) { bestQty = per[m]; best = m; } });
      return {
        rank: i + 1, product: p.name, category: p.category, unit: p.unit,
        qty_sold: num(p.qty_sold), revenue: round2(p.revenue),
        best_month: best ? monthLabel(best) : '-', movement: num(p.qty_sold) > 0 ? p.movement : 'No sales',
        _level: num(p.qty_sold) === 0 ? 'warn' : undefined,
      };
    });

    const wanted = Number(q.product_id);
    const chosen = Number.isInteger(wanted) && prods.some(p => p.product_id === wanted)
      ? prods.filter(p => p.product_id === wanted)
      : sold.slice(0, 5);
    const series = chosen.map(p => ({
      name: p.name, values: months.map(m => (byProduct[p.product_id] || {})[m] || 0),
    }));

    return {
      title: 'Sales trend analysis', period: { from, to },
      note: 'Products are ranked by quantity sold. Quantities use each product\'s own unit, so use the category filter to compare similar products. Revenue excludes tax. Fast and slow labels need at least 5 products.',
      columns: [
        { key: 'rank', label: '#', type: 'number' }, { key: 'product', label: 'Product', type: 'text' },
        { key: 'category', label: 'Category', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' },
        { key: 'qty_sold', label: 'Quantity sold', type: 'number' }, { key: 'revenue', label: 'Revenue', type: 'money' },
        { key: 'best_month', label: 'Best month', type: 'text' }, { key: 'movement', label: 'Movement', type: 'text' },
      ],
      rows,
      summary: [
        { label: 'Products', value: n, type: 'number' },
        { label: 'Products sold', value: sold.length, type: 'number' },
        { label: 'No sales', value: n - sold.length, type: 'number' },
        { label: 'Revenue (before tax)', value: round2(prods.reduce((s, p) => s + num(p.revenue), 0)), type: 'money' },
        { label: 'Top seller', value: sold.length ? sold[0].name : '-', type: 'text' },
      ],
      chart: { labels: months.map(monthLabel), series },
    };
  },
};

router.get('/', (req, res) => {
  res.json(Object.entries(REPORTS)
    .filter(([, r]) => r.roles.includes(req.user.role))
    .map(([id, r]) => ({ id, label: r.label, dates: !!r.dates, days: !!r.days, trend: !!r.trend })));
});

router.get('/:type', async (req, res) => {
  const type = req.params.type;
  if (!Object.prototype.hasOwnProperty.call(REPORTS, type)) return res.status(404).json({ message: 'Report not found' });
  if (!REPORTS[type].roles.includes(req.user.role)) {
    return res.status(403).json({ message: 'You do not have permission for this' });
  }
  try {
    res.json(await BUILDERS[type](req.query));
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ message: err.message });
    console.error(err);
    res.status(500).json({ message: 'Server error: ' + (err.code || '') + ' ' + err.message });
  }
});

module.exports = router;