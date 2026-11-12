# FlashMarket backend

API Node.js / Express / PostgreSQL (CommonJS) pour la marketplace locale.
Elle comprend l'authentification JWT, les boutiques, le feed local, les annonces,
les contacts, le traitement photo et le transcodage vidéo HLS.

## Installation et démarrage

1. Crée la base PostgreSQL `flashmarket`.
2. Copie `.env.example` vers `.env`, puis configure `DATABASE_URL` et une clé
   `JWT_SECRET` privée et aléatoire d'au moins 32 caractères.
3. Vérifie que FFmpeg et FFprobe sont installés et accessibles avec les variables
   `FFMPEG_PATH` et `FFPROBE_PATH` (par défaut `ffmpeg` et `ffprobe` sur PATH).
   Sous Windows, télécharge une distribution FFmpeg fiable, puis renseigne les
   chemins absolus vers `ffmpeg.exe` et `ffprobe.exe` dans `.env` si leur dossier
   n'est pas déjà présent dans le `PATH`.
4. Depuis le dossier `backend` :

```powershell
npm install
npm run db:init
npm test
npm run dev
```

Le serveur utilise le port défini par `PORT` dans `.env`. Vérifie
`http://localhost:<PORT>/api/health`.
`npm run db:init` est relançable et ne supprime pas les données.
`npm run db:reset` détruit le schéma `public` : ne l'utilise pas sur une base
contenant des données à conserver.

## API

Les corps JSON emploient les noms de champs ci-dessous. Les routes protégées
attendent `Authorization: Bearer <JWT>`.

- `GET /api/health` — disponibilité de l'API et de PostgreSQL.
- `GET /api/cities` — villes sélectionnables à l'inscription et dans le feed.
- `GET /api/categories` — catégories actives et leurs règles de prix, stock et
  critères autorisés.
- `POST /api/auth/register` — `phone`, `password`, `fullName`, `cityId`
  obligatoires ; renvoie le compte public et un JWT de 7 jours.
- `POST /api/auth/login` — `phone`, `password`.
- `POST /api/shops` — protégé ; `name`, `description`, `cityId`, `whatsapp`
  facultatifs. Une seule boutique par compte.
- `GET /api/shops/me` — boutique du compte connecté.
- `GET /api/shops/:slug` — boutique publique et annonces publiées.
- `GET /api/posts?city_id=1&page=1&limit=10` — feed public, filtré par ville ;
  si `city_id` est omis, le profil connecté fournit la ville. Un visiteur doit
  choisir une ville. `city_id=all` élargit la recherche à toutes les villes du
  Cameroun. `category_id` et `q` sont facultatifs.
- `GET /api/posts/:id` — annonce publiée ; le propriétaire peut aussi consulter
  l'état de traitement de ses annonces.
- `POST /api/posts` — protégé, `multipart/form-data` avec les champs
  `title`, `category_id`, `price_fcfa`, et les champs facultatifs
  `description`, `price_unit`, `city_id`, `neighborhood`, `stock`, `attributes`
  (tableau JSON), `sale_price_fcfa`, `sale_starts_at` et `sale_ends_at`
  (promotion facultative, dates ISO 8601 avec fuseau horaire). Le prix flash
  doit être inférieur au prix normal. Le ou les fichiers sont envoyés sous le champ `media` :
  une vidéo seule ou 1 à 8 photos. La réponse `202` indique que le traitement
  média est lancé ; consulter ensuite `GET /api/posts/:id`.
- `POST /api/posts/:id/contact` — protégé ; JSON `{ "channel": "call" }` ou
  `{ "channel": "whatsapp" }`. Enregistre l'événement et renvoie le numéro du
  vendeur seulement après authentification.
- `GET /api/media/:id` — informations publiques d'un média prêt.

### Upload vidéo reprenable

L'upload en morceaux est distinct du découpage HLS de lecture. Pour les vidéos
sur réseau instable, utiliser ces routes plutôt que l'upload multipart direct :

1. `POST /api/media/uploads` (protégé), JSON avec les champs de l'annonce,
   `mime_type` (`video/mp4`, `video/quicktime`, `video/webm` ou `video/3gpp`),
   `total_size`, `chunk_size` (64 Ko à 4 Mo, défaut 256 Ko) et éventuellement
   `sha256` du fichier complet. La réponse fournit `uploadId` et `totalChunks`.
2. Envoyer chaque morceau manquant avec
   `PUT /api/media/uploads/:uploadId/chunks/:index`,
   `Content-Type: application/octet-stream`. Les indices commencent à zéro.
3. En cas de coupure ou de redémarrage, appeler `GET /api/media/uploads/:uploadId`
   et renvoyer uniquement les indices absents de `receivedChunks`.
4. Appeler `POST /api/media/uploads/:uploadId/complete`. Le serveur assemble le
   fichier, vérifie la taille, le type et SHA-256, puis lance le traitement.
5. `DELETE /api/media/uploads/:uploadId` annule un envoi encore incomplet.
   Les sessions inactives sont nettoyées au démarrage après
   `UPLOAD_SESSION_TTL_HOURS` heures (168 heures par défaut) ; leur activité
   est actualisée à chaque morceau reçu.

Les limites applicatives historiques de 250 Mo et 180 secondes sont retirées.
`MAX_VIDEO_BYTES=0` (valeur par défaut) désactive le plafond global de taille ;
aucune limite de durée n'est configurée. Un plafond facultatif peut être fixé
en octets avec `MAX_VIDEO_BYTES`. Les capacités de stockage, le réseau et les
ressources FFmpeg restent des limites opérationnelles, à dimensionner selon le
volume et la durée des vidéos.

Les données vidéo ne sont pas envoyées dans une seule requête : chaque corps
`PUT` est limité à `UPLOAD_CHUNK_MAX_BYTES` (4 Mio par défaut), tandis que
`express.json` conserve sa limite de 1 Mio pour les métadonnées. Configure un
reverse proxy Nginx avec une taille légèrement supérieure au plus gros morceau
et des timeouts compatibles avec les connexions mobiles :

```nginx
location ^~ /api/media/uploads {
    client_max_body_size 5m;
    client_body_timeout 300s;
    proxy_connect_timeout 60s;
    proxy_send_timeout 900s;
    proxy_read_timeout 900s;
    proxy_request_buffering off;
    proxy_pass http://127.0.0.1:3000;
}
```

Applique ces directives à la location qui relaie les routes d'upload, sans
remplacer le routage existant des autres routes API. Ne configure pas Nginx à
5 Mo pour `POST /api/posts` si ce point d'entrée multipart doit aussi recevoir
des fichiers ; pour les vidéos lourdes, utilise toujours les routes chunkées.

Le backend configure par défaut `REQUEST_TIMEOUT_MS=900000` et
`HEADERS_TIMEOUT_MS=60000`. Toute modification de `UPLOAD_CHUNK_MAX_BYTES`
doit être répercutée dans la limite de corps du proxy. Prévoir suffisamment
d'espace temporaire pour les morceaux et le fichier assemblé (l'assemblage
requiert momentanément une copie supplémentaire), ainsi que du temps CPU et
disque pour le transcodage HLS.

### Traitement des médias

- Les photos sont vérifiées, converties en WebP et redimensionnées en image
  principale et miniature.
- Les vidéos sont contrôlées par FFprobe, puis encodées par FFmpeg en variantes
  HLS 240p et 480p avec des segments ciblés à 2 secondes et un `master.m3u8`.
- SHA-256 détecte les copies binaires exactes et vérifie l'intégrité de l'upload.
  Le pHash est calculé et stocké pour une modération future ; il ne prouve ni la
  propriété du média ni l'identité d'un vendeur.
- Les sorties publiques ne sont servies que lorsque l'annonce est publiée et
  non expirée. Les originaux temporaires sont supprimés après traitement.

Les fichiers sont stockés sur disque local dans `UPLOAD_DIR` et `MEDIA_DIR`.
Pour un déploiement multi-instance, configure un stockage partagé/objet et un
worker durable partagé ; le traitement intégré convient au développement et à
une première instance, mais une file en mémoire seule ne remplace pas une
infrastructure de production distribuée.

## Limites fonctionnelles explicites

La vérification du téléphone par SMS, les paiements, le renouvellement des
annonces et la comparaison automatique des pHash ne sont pas inclus. Les annonces
expirées sont exclues des réponses publiques. Le seed de catégories/villes est
dans `database/seed.sql`.
