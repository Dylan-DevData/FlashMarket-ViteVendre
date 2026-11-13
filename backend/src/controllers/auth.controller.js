const bcrypt = require('bcryptjs');
const userModel = require('../models/user.model');
const { createToken } = require('../services/token.service');
const { httpError } = require('../utils/httpError');
const { isValidPhone, parseOptionalId } = require('../utils/validation');

// Crée un compte après validation des champs et renvoie un profil public accompagné d'un JWT.
async function register(req, res, next) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
    const password = body.password;
    const cityId = parseOptionalId(body.cityId);

    if (!isValidPhone(phone)) {
      throw httpError(400, 'Le téléphone doit contenir 8 à 15 chiffres, avec + facultatif.');
    }
    if (fullName.length < 2 || fullName.length > 80) {
      throw httpError(400, 'Le nom doit contenir entre 2 et 80 caractères.');
    }
    if (typeof password !== 'string'
      || Buffer.byteLength(password, 'utf8') < 8
      || Buffer.byteLength(password, 'utf8') > 72) {
      throw httpError(400, 'Le mot de passe doit contenir au moins 8 caractères et au plus 72 octets.');
    }
    if (cityId === null || cityId === undefined) throw httpError(400, 'Choisissez une ville.');
    if (!(await userModel.cityExists(cityId))) {
      throw httpError(400, 'La ville indiquée n’existe pas.');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await userModel.createUser({ phone, passwordHash, fullName, cityId });
    return res.status(201).json({ user: publicUser(user), token: createToken(user) });
  } catch (error) {
    if (error.code === '23505') {
      return next(httpError(409, 'Un compte utilise déjà ce numéro de téléphone.'));
    }
    if (error.code === '23503') {
      return next(httpError(400, 'La ville indiquée n’existe pas.'));
    }
    return next(error);
  }
}

async function login(req, res, next) {
  // Vérifie le téléphone et le mot de passe sans révéler lequel des deux est incorrect.
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    const password = body.password;
    if (!isValidPhone(phone) || typeof password !== 'string'
      || Buffer.byteLength(password, 'utf8') > 72) {
      throw httpError(400, 'Téléphone ou mot de passe invalide.');
    }

    const user = await userModel.findByPhone(phone);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      throw httpError(401, 'Téléphone ou mot de passe incorrect.');
    }
    if (user.status !== 'active') throw httpError(403, 'Ce compte est suspendu.');

    return res.json({ user: publicUser(user), token: createToken(user) });
  } catch (error) {
    return next(error);
  }
}

function publicUser(user) {
  // Filtre les colonnes privées avant d'inclure l'utilisateur dans la réponse HTTP.
  return {
    id: user.id,
    phone: user.phone,
    fullName: user.full_name,
    cityId: user.city_id,
    role: user.role,
    createdAt: user.created_at,
  };
}

module.exports = { register, login };
