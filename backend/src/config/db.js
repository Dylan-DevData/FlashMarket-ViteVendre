const { Pool } = require('pg');
const { databaseUrl } = require('./env');

const pool = new Pool({ connectionString: databaseUrl, max: 10 });

pool.on('error', (err) => {
  console.error('[pg] erreur inattendue sur une connexion inactive :', err.message);
});

// Requête simple : query('SELECT ... WHERE id = $1', [id])
const query = (text, params) => pool.query(text, params);

// Transaction : tout réussit ou tout est annulé.
//   await withTransaction(async (client) => {
//     await client.query('INSERT ...');
//     await client.query('UPDATE ...');
//   });
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackError) => {
      console.error('[pg] échec de l’annulation de transaction :', rollbackError.message);
    });
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
