const express = require('express');
const { getCities, getCategories } = require('../controllers/catalog.controller');

const router = express.Router();

router.get('/cities', getCities);
router.get('/categories', getCategories);

module.exports = router;
