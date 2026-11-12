// Crée les tables puis insère les données de départ.
//   npm run db:init     -> sans rien effacer (relançable)
//   npm run db:reset    -> EFFACE tout puis recrée (développement uniquement)
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/config/db');
const { nodeEnv } = require('../src/config/env');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'database', file), 'utf8');

async function main() {
  const reset = process.argv.includes('--reset');

  if (reset) {
    if (nodeEnv === 'production') {
      throw new Error('Reset interdit en production.');
    }
    console.log('Suppression de toutes les tables…');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  }

  console.log('Création des tables…');
  await pool.query(read('schema.sql'));

  console.log('Insertion des données de départ…');
  await pool.query(read('seed.sql'));

  const { rows } = await pool.query(
    `SELECT (SELECT count(*) FROM cities) AS villes,
            (SELECT count(*) FROM categories) AS categories`
  );
  console.log(`Terminé : ${rows[0].villes} villes, ${rows[0].categories} catégories.`);
}

main()
  .catch((err) => {
    console.error('Échec :', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
