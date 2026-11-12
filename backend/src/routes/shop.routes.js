const express = require('express');
const { create, getMine, getPublic } = require('../controllers/shop.controller');
const { authenticate } = require('../middlewares/authenticate');

const router = express.Router();

router.post('/', authenticate, create);
router.get('/me', authenticate, getMine);
router.get('/:slug', getPublic);

module.exports = router;
