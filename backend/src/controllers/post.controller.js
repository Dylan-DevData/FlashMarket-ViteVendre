const fs = require('fs/promises');
const postModel = require('../models/post.model');
const mediaModel = require('../models/media.model');
const mediaQueue = require('../services/media-queue.service');
const { sha256File } = require('../services/hash.service');
const { maxImageBytes, maxVideoBytes } = require('../config/env');
const { removeTemporaryFiles } = require('../middlewares/upload.middleware');
const { httpError } = require('../utils/httpError');
const { parseOptionalId } = require('../utils/validation');

const PRICE_UNITS = new Set(['unit', 'kg', 'bag', 'carton', 'day', 'month']);

// Valide les filtres HTTP du feed, puis délègue la recherche paginée au modèle SQL.
async function getFeed(req, res, next) {
  try {
    const nationwide = req.query.city_id === 'all';
    const requestedCityId = req.query.city_id === undefined || nationwide
      ? null
      : parseOptionalId(req.query.city_id);
    if (requestedCityId === undefined) throw httpError(400, 'La ville est invalide.');
    const cityId = nationwide ? null : (requestedCityId ?? req.user?.cityId);
    if (!nationwide && (!cityId || !Number.isSafeInteger(Number(cityId)) || Number(cityId) < 1)) {
      throw httpError(400, 'Indiquez city_id ou connectez-vous avec une ville de profil.');
    }
    if (cityId && !(await postModel.cityExists(Number(cityId)))) {
      throw httpError(400, 'La ville indiquée n’existe pas.');
    }

    const categoryId = parseOptionalId(req.query.category_id);
    if (categoryId === undefined) throw httpError(400, 'La catégorie est invalide.');
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    const limit = req.query.limit === undefined ? 10 : Number(req.query.limit);
    if (!Number.isInteger(page) || page < 1 || page > 100000) {
      throw httpError(400, 'Le numéro de page est invalide.');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw httpError(400, 'La limite doit être comprise entre 1 et 20.');
    }
    if (req.query.q !== undefined && typeof req.query.q !== 'string') {
      throw httpError(400, 'Le terme de recherche est invalide.');
    }
    const search = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (search.length > 100) throw httpError(400, 'La recherche ne peut pas dépasser 100 caractères.');

    const posts = await postModel.getFeed({
      cityId: cityId === null ? null : Number(cityId),
      categoryId,
      search,
      limit,
      offset: (page - 1) * limit,
    });
    return res.json({ cityId: cityId === null ? null : Number(cityId), page, limit, posts });
  } catch (error) {
    return next(error);
  }
}

async function create(req, res, next) {
  // Vérifie les fichiers, crée l'annonce en traitement puis met ses médias en file.
  const files = req.files || [];
  let persisted = false;
  try {
    if (files.length < 1) throw httpError(400, 'Ajoutez une vidéo ou entre 1 et 8 photos.');
    const { post } = await buildPostData(req.body, req.user);

    const kinds = files.map((file) => file.mimetype.startsWith('image/') ? 'image' : 'video');
    if (new Set(kinds).size !== 1 || (kinds[0] === 'video' && files.length !== 1)) {
      throw httpError(400, 'Une annonce contient une vidéo seule ou 1 à 8 photos, sans mélange.');
    }

    const mediaItems = [];
    const requestHashes = new Set();
    for (const [position, file] of files.entries()) {
      const maxBytes = kinds[position] === 'image' ? maxImageBytes : maxVideoBytes;
      if (file.size < 1 || (maxBytes > 0 && file.size > maxBytes)) {
        throw httpError(413, `Le fichier ${file.originalname} est vide ou dépasse la taille maximale.`);
      }
      await verifyMediaSignature(file.path, file.mimetype);
      const sha256 = await sha256File(file.path);
      if (requestHashes.has(sha256) || await mediaModel.findDuplicateSha256(sha256)) {
        throw httpError(409, 'Ce média a déjà été publié ou figure plusieurs fois dans cette annonce.');
      }
      requestHashes.add(sha256);
      mediaItems.push({
        kind: kinds[position],
        position,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        sha256,
        filename: file.filename,
      });
    }

    const result = await postModel.createPostWithMedia(post, mediaItems);
    persisted = true;
    result.mediaIds.forEach((id) => mediaQueue.enqueue(id));
    return res.status(202).json({
      postId: result.id,
      status: 'processing',
      message: 'Annonce reçue. Le traitement des médias est en cours.',
    });
  } catch (error) {
    if (error.code === '23503') error = httpError(400, 'La ville ou la catégorie indiquée est invalide.');
    return next(error);
  } finally {
    if (!persisted) await removeTemporaryFiles(files);
  }
}

async function getPost(req, res, next) {
  try {
    const postId = parsePostId(req.params.id);
    const post = await postModel.getPostForViewer(postId, req.user?.id || null);
    if (!post) throw httpError(404, 'Annonce introuvable.');
    if (post.status !== 'published') {
      return res.json({
        post: {
          id: post.id,
          title: post.title,
          status: post.status,
          price_fcfa: post.price_fcfa,
          sale_price_fcfa: post.sale_price_fcfa,
          sale_starts_at: post.sale_starts_at,
          sale_ends_at: post.sale_ends_at,
          current_price_fcfa: post.current_price_fcfa,
          flash_sale_active: post.flash_sale_active,
          media: post.media,
        },
      });
    }
    return res.json({ post });
  } catch (error) {
    return next(error);
  }
}

async function recordContact(req, res, next) {
  try {
    const postId = parsePostId(req.params.id);
    const channel = req.body && req.body.channel;
    if (!['call', 'whatsapp'].includes(channel)) {
      throw httpError(400, 'Le canal doit être "call" ou "whatsapp".');
    }
    const result = await mediaModel.recordContact(postId, req.user.id, channel);
    if (result.kind === 'not_found') throw httpError(404, 'Annonce introuvable ou expirée.');
    if (result.kind === 'own_post') throw httpError(403, 'Vous ne pouvez pas contacter votre propre annonce.');
    return res.json({
      channel,
      phone: result.phone,
      whatsapp: result.whatsapp,
    });
  } catch (error) {
    return next(error);
  }
}

function parsePostId(value) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw httpError(400, 'Identifiant d’annonce invalide.');
  }
  return Number(value);
}

async function verifyMediaSignature(filePath, mimeType) {
  // Contrôle le contenu réel du fichier : le type MIME fourni par le navigateur n'est pas fiable.
  const handle = await fs.open(filePath, 'r');
  const buffer = Buffer.alloc(16);
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);
    const image = mimeType.startsWith('image/');
    const valid = mimeType === 'image/jpeg'
      ? head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
      : mimeType === 'image/png'
        ? head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mimeType === 'image/webp'
          ? head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP'
          : image
            ? false
            : mimeType === 'video/webm'
              ? head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
              : ['video/mp4', 'video/quicktime', 'video/3gpp'].includes(mimeType)
                && head.toString('ascii', 4, 8) === 'ftyp';
    if (!valid) throw httpError(415, 'Le contenu du fichier ne correspond pas au type déclaré.');
  } finally {
    await handle.close();
  }
}

async function buildPostData(body = {}, user) {
  // Nettoie et valide ville, catégorie, prix et informations du formulaire avant insertion.
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'Les informations de l’annonce sont invalides.');
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (body.description !== undefined && body.description !== '' && typeof body.description !== 'string') {
    throw httpError(400, 'La description doit être du texte.');
  }
  if (body.neighborhood !== undefined && body.neighborhood !== '' && typeof body.neighborhood !== 'string') {
    throw httpError(400, 'Le quartier doit être du texte.');
  }
  if (body.price_unit !== undefined && body.price_unit !== '' && typeof body.price_unit !== 'string') {
    throw httpError(400, 'L’unité de prix est invalide.');
  }
  const description = typeof body.description === 'string' ? body.description.trim() : null;
  const categoryId = parseOptionalId(body.category_id);
  const cityInput = body.city_id;
  const cityId = cityInput === undefined || cityInput === ''
    ? user.cityId
    : parseOptionalId(cityInput);
  const priceFcfa = Number(body.price_fcfa);
  const requestedPriceUnit = body.price_unit || null;
  const neighborhood = typeof body.neighborhood === 'string' ? body.neighborhood.trim() : null;
  const stock = body.stock === undefined || body.stock === '' ? null : Number(body.stock);
  const salePriceInput = body.sale_price_fcfa;
  const saleStartsInput = body.sale_starts_at;
  const saleEndsInput = body.sale_ends_at;

  if (title.length < 3 || title.length > 120) throw httpError(400, 'Le titre doit contenir 3 à 120 caractères.');
  if (description && description.length > 5000) throw httpError(400, 'La description est trop longue.');
  if (categoryId === undefined || !categoryId) throw httpError(400, 'Indiquez une catégorie valide.');
  if (cityId === undefined || cityId === null || !Number.isSafeInteger(Number(cityId)) || Number(cityId) < 1) {
    throw httpError(400, 'Indiquez une ville valide.');
  }
  if (body.price_fcfa === undefined || body.price_fcfa === ''
    || !Number.isSafeInteger(priceFcfa) || priceFcfa < 0 || priceFcfa > 2_000_000_000) {
    throw httpError(400, 'Le prix en FCFA est invalide.');
  }
  if (requestedPriceUnit && !PRICE_UNITS.has(requestedPriceUnit)) {
    throw httpError(400, 'L’unité de prix est invalide.');
  }
  if (neighborhood && neighborhood.length > 120) throw httpError(400, 'Le quartier est trop long.');
  if (stock !== null && (!Number.isSafeInteger(stock) || stock < 0)) {
    throw httpError(400, 'Le stock doit être un entier positif.');
  }
  const category = await postModel.findCategory(categoryId);
  if (!category) throw httpError(400, 'La catégorie n’existe pas ou est inactive.');
  const priceUnit = requestedPriceUnit || category.default_price_unit;
  if (!PRICE_UNITS.has(priceUnit)) throw httpError(400, 'L’unité de prix configurée pour cette catégorie est invalide.');
  if (category.uses_stock && stock === null) throw httpError(400, 'Indiquez le stock pour cette catégorie.');
  if (!(await postModel.cityExists(Number(cityId)))) throw httpError(400, 'La ville indiquée n’existe pas.');

  const hasSaleFields = [salePriceInput, saleStartsInput, saleEndsInput]
    .some((value) => value !== undefined && value !== '');
  let salePriceFcfa = null;
  let saleStartsAt = null;
  let saleEndsAt = null;
  if (hasSaleFields) {
    salePriceFcfa = Number(salePriceInput);
    if (salePriceInput === undefined || salePriceInput === ''
      || !Number.isSafeInteger(salePriceFcfa) || salePriceFcfa < 0 || salePriceFcfa >= priceFcfa) {
      throw httpError(400, 'Le prix promotionnel doit être inférieur au prix normal.');
    }
    const parseSaleDate = (value) => {
      if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) ? new Date(timestamp) : null;
    };
    saleStartsAt = parseSaleDate(saleStartsInput);
    saleEndsAt = parseSaleDate(saleEndsInput);
    if (!saleStartsAt || !saleEndsAt || saleEndsAt <= saleStartsAt) {
      throw httpError(400, 'Indiquez une période promotionnelle valide avec fuseau horaire.');
    }
  }

  let attributes = [];
  if (body.attributes !== undefined && body.attributes !== '') {
    try {
      attributes = Array.isArray(body.attributes) ? body.attributes : JSON.parse(body.attributes);
    } catch {
      throw httpError(400, 'Les critères doivent être fournis sous forme de tableau JSON.');
    }
  }
  if (!Array.isArray(attributes) || attributes.some((value) => typeof value !== 'string')) {
    throw httpError(400, 'Les critères doivent être une liste de valeurs.');
  }
  const allowed = new Set(category.allowed_attributes);
  if (attributes.some((attribute) => !allowed.has(attribute))) {
    throw httpError(400, 'Un ou plusieurs critères ne sont pas autorisés pour cette catégorie.');
  }

  return {
    category,
    post: {
      ownerId: user.id,
      categoryId,
      title,
      description,
      priceFcfa,
      priceUnit,
      cityId: Number(cityId),
      neighborhood,
      stock,
      attributes: [...new Set(attributes)],
      salePriceFcfa,
      saleStartsAt,
      saleEndsAt,
    },
  };
}

module.exports = { getFeed, create, getPost, recordContact, buildPostData, verifyMediaSignature };
