const catalogModel = require('../models/catalog.model');

// Expose les listes de référence utilisées par les formulaires et filtres du frontend.
async function getCities(req, res, next) {
  try {
    return res.json({ cities: await catalogModel.listCities() });
  } catch (error) {
    return next(error);
  }
}

async function getCategories(req, res, next) {
  try {
    return res.json({ categories: await catalogModel.listCategories() });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getCities, getCategories };
