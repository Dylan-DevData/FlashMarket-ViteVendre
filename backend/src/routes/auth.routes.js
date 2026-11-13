const express = require('express');
const { register, login } = require('../controllers/auth.controller');

const router = express.Router();

// Ces endpoints créent le jeton de session utilisé ensuite par les routes protégées.
router.post('/register', register);
router.post('/login', login);

module.exports = router;
