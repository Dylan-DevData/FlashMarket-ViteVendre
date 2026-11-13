const express = require('express');
const postController = require('../controllers/post.controller');
const { authenticate, optionalAuthenticate } = require('../middlewares/authenticate');
const { uploadPostMedia } = require('../middlewares/upload.middleware');

const router = express.Router();

// Le feed est public; publier une annonce et contacter un vendeur exigent une session.
router.get('/', optionalAuthenticate, postController.getFeed);
router.post('/', authenticate, uploadPostMedia, postController.create);
router.get('/:id', optionalAuthenticate, postController.getPost);
router.post('/:id/contact', authenticate, postController.recordContact);

module.exports = router;
