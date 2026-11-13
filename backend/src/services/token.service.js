const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/env');

// Signe un jeton de session contenant l'identifiant utilisateur et sa date d'expiration.
function createToken(user) {
  return jwt.sign(
    { role: user.role },
    jwtSecret,
    { subject: String(user.id), expiresIn: '7d', algorithm: 'HS256' }
  );
}

module.exports = { createToken };
