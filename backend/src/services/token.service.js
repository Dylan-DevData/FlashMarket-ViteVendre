const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/env');

function createToken(user) {
  return jwt.sign(
    { role: user.role },
    jwtSecret,
    { subject: String(user.id), expiresIn: '7d', algorithm: 'HS256' }
  );
}

module.exports = { createToken };
