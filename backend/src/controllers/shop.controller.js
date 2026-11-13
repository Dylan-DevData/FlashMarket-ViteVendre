const shopModel = require('../models/shop.model');
const { httpError } = require('../utils/httpError');
const { isValidPhone, parseOptionalId, slugify } = require('../utils/validation');

// Les contrôleurs valident la requête HTTP; le modèle gère les lectures et écritures SQL.
async function create(req, res, next) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (body.description !== undefined && body.description !== '' && typeof body.description !== 'string') {
      throw httpError(400, 'La description doit être du texte.');
    }
    const description = typeof body.description === 'string'
      ? body.description.trim()
      : null;
    const cityId = parseOptionalId(body.cityId);
    const whatsapp = body.whatsapp === undefined || body.whatsapp === ''
      ? null
      : body.whatsapp;

    if (name.length < 2 || name.length > 80) {
      throw httpError(400, 'Le nom de la boutique doit contenir entre 2 et 80 caractères.');
    }
    if (description !== null && description.length > 1000) {
      throw httpError(400, 'La description ne peut pas dépasser 1 000 caractères.');
    }
    if (cityId === undefined) throw httpError(400, 'La ville est invalide.');
    if (whatsapp !== null && !isValidPhone(whatsapp)) {
      throw httpError(400, 'Le numéro WhatsApp est invalide.');
    }

    const shop = await shopModel.createShop({
      ownerId: req.user.id,
      name,
      slug: slugify(name, req.user.id),
      description,
      cityId,
      whatsapp,
    });
    return res.status(201).json({ shop });
  } catch (error) {
    if (error.code === '23505') {
      return next(httpError(409, 'Ce compte possède déjà une boutique.'));
    }
    if (error.code === '23503') {
      return next(httpError(400, 'La ville indiquée n’existe pas.'));
    }
    return next(error);
  }
}

async function getMine(req, res, next) {
  try {
    const shop = await shopModel.findByOwnerId(req.user.id);
    if (!shop) throw httpError(404, 'Aucune boutique n’a été créée pour ce compte.');
    return res.json({ shop });
  } catch (error) {
    return next(error);
  }
}

async function getPublic(req, res, next) {
  try {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(req.params.slug)) {
      throw httpError(400, 'Identifiant de boutique invalide.');
    }
    const shop = await shopModel.findPublicBySlug(req.params.slug);
    if (!shop) throw httpError(404, 'Boutique introuvable.');
    return res.json({ shop });
  } catch (error) {
    return next(error);
  }
}

module.exports = { create, getMine, getPublic };
