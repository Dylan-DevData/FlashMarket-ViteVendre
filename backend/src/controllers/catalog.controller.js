const catalogModel = require('../models/catalog.model');

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
