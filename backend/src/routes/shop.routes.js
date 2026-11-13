const express = require('express');
const { create, getMine, getPublic } = require('../controllers/shop.controller');
const { authenticate } = require('../middlewares/authenticate');

const router = express.Router();

// La vitrine est publique; créer ou consulter sa propre boutique exige une authentification.
router.post('/', authenticate, create);
router.get('/me', authenticate, getMine);
router.get('/:slug', getPublic);

module.exports = router;
