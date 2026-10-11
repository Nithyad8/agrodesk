const bcrypt = require('bcrypt');
const pool = require('./db');

async function seed() {
  const users = [
    ['Shop Owner', 'owner', 'owner123', 'owner'],
    ['Shop Staff', 'staff', 'staff123', 'staff'],
    ['Inspector', 'inspector', 'inspect123', 'inspector'],
  ];
  for (const [name, username, password, role] of users) {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT IGNORE INTO users (name, username, password_hash, role) VALUES (?,?,?,?)',
      [name, username, hash, role]
    );
  }
  console.log('Users created');
  process.exit();
}
seed();