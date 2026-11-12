const { query } = require('../config/db');

async function findByPhone(phone) {
  const { rows } = await query(
    `SELECT id, phone, password_hash, full_name, city_id, role, status
     FROM users
     WHERE phone = $1`,
    [phone]
  );
  return rows[0] || null;
}

async function findActiveById(id) {
  const { rows } = await query(
    `SELECT id, phone, full_name, city_id, role, status
     FROM users
     WHERE id = $1 AND status = 'active'`,
    [id]
  );
  return rows[0] || null;
}

async function cityExists(cityId) {
  const { rows } = await query('SELECT 1 FROM cities WHERE id = $1', [cityId]);
  return rows.length > 0;
}

async function createUser({ phone, passwordHash, fullName, cityId }) {
  const { rows } = await query(
    `INSERT INTO users (phone, password_hash, full_name, city_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, phone, full_name, city_id, role, created_at`,
    [phone, passwordHash, fullName, cityId]
  );
  return rows[0];
}

module.exports = { findByPhone, findActiveById, cityExists, createUser };
