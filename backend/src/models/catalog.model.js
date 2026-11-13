const { query } = require('../config/db');

// Requêtes de lecture des villes et catégories actives, partagées par les contrôleurs.
async function listCities() {
  const { rows } = await query(
    `SELECT id, name, region
     FROM cities
     ORDER BY region NULLS LAST, name`
  );
  return rows;
}

async function listCategories() {
  const { rows } = await query(
    `SELECT id, slug, name, default_price_unit, uses_stock, expiry_days, allowed_attributes
     FROM categories
     WHERE is_active = TRUE
     ORDER BY name`
  );
  return rows;
}

module.exports = { listCities, listCategories };
