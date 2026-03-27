const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      sub_key     TEXT PRIMARY KEY,
      user_id     BIGINT NOT NULL,
      username    TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function createUser(subKey, userId, username) {
  await pool.query(
    'INSERT INTO users (sub_key, user_id, username) VALUES ($1, $2, $3)',
    [subKey, userId, username]
  );
}

async function subKeyExists(subKey) {
  const res = await pool.query('SELECT 1 FROM users WHERE sub_key = $1', [subKey]);
  return res.rowCount > 0;
}

async function getUserSubs(userId) {
  const res = await pool.query(
    'SELECT sub_key, created_at FROM users WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return res.rows;
}

async function deleteSub(subKey, userId) {
  const res = await pool.query(
    'DELETE FROM users WHERE sub_key = $1 AND user_id = $2',
    [subKey, userId]
  );
  return res.rowCount > 0;
}

module.exports = { init, createUser, subKeyExists, getUserSubs, deleteSub };
