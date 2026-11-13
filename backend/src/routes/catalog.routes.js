const express = require('express');
const { getCities, getCategories } = require('../controllers/catalog.controller');

const router = express.Router();

// Données de référence chargées par l'application pour ses filtres et formulaires.
router.get('/cities', getCities);
router.get('/categories', getCategories);

module.exports = router;
