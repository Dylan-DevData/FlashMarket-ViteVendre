# ViteVendre mobile

Application Cordova Android pour le commerce local. Le dossier `www/` est
empaqueté directement par Cordova ; `hls.js` est copié localement dans
`www/lib/` par `npm run vendor`.

## Prérequis Windows

- Node.js LTS et npm.
- JDK 17, Android Studio avec Android SDK Platform 35 ou plus récent, et Gradle
  (Cordova Android utilise Gradle Wrapper).
- Un émulateur Android ou un téléphone Android et un câble USB.

## Installer et lancer

Depuis PowerShell :

```powershell
Set-Location "C:\Users\Further Market\Desktop\new_app\noteApp"
npm install
npm run vendor
cordova prepare android
```

Démarrer le backend dans un terminal séparé, depuis le dossier `backend` :

```powershell
Set-Location "C:\Users\Further Market\Desktop\new_app\backend"
npm run dev
```

Le backend écoute sur le port `3000` (toutes les interfaces réseau). Vérifie
qu’il reste démarré et que le pare-feu Windows autorise les connexions entrantes
sur ce port. Depuis le terminal frontend, lance ensuite l’émulateur :

```powershell
Set-Location "C:\Users\Further Market\Desktop\new_app\noteApp"
npm run emulator
```

Pour ouvrir la version Android sur un appareil détecté par ADB :

```powershell
npm run android
```

Construire un APK de débogage :

```powershell
cordova build android
```

L’APK est créé sous `platforms\android\app\build\outputs\apk\debug\app-debug.apk`.
Pour déboguer une application Android avec Chrome, active le débogage USB puis
ouvre `chrome://inspect`.

## Configurer l’URL de l’API en développement

L’adresse du serveur est une configuration développeur, pas un réglage visible
par les utilisateurs. Elle se trouve dans `www/js/config.js`, dans la constante
`API_BASE_URL`. Après l’avoir modifiée, reconstruis la plateforme Cordova
(`cordova prepare android` ou `cordova build android`).

- **Émulateur Android** : utilise `http://10.0.2.2:3000/api`. `10.0.2.2`
  désigne l’ordinateur hôte depuis l’émulateur Android.
- **Navigateur Cordova sur l’ordinateur** : utilise
  `http://localhost:3000/api`. Le code remplace automatiquement l’hôte
  `10.0.2.2` par `localhost` pour cette plateforme.
- **Téléphone Android réel** : remplace `API_BASE_URL` par
  `http://192.168.1.15:3000/api` (remplace `192.168.1.15` par l’adresse IPv4
  locale réelle du PC). Le téléphone et l’ordinateur doivent être sur le même
  Wi-Fi ; autorise le port 3000 dans le pare-feu Windows. Ajoute aussi cette
  origine IP aux directives `connect-src`, `img-src` et `media-src` de la CSP
  dans `www/index.html`, puis reconstruis l’application Android.
- Si le serveur des villes est indisponible, l’application affiche les villes
  en cache ou propose Bafoussam, Yaoundé et Douala comme choix de secours.
  Leurs identifiants supposent la base initialisée avec `backend/database/seed.sql`.
  Le bouton **Réessayer** recharge le catalogue depuis l’API dès que le serveur
  est de nouveau accessible ; un bandeau **Hors connexion** apparaît quand
  l’API ne répond pas, même si le téléphone indique qu’il a du réseau.
- **Production** : configure l’URL HTTPS publique de l’API (par exemple
  `https://api.votre-domaine.cm/api`) et retire l’autorisation HTTP clair.

L’autorisation HTTP clair de `config.xml` est réservée au développement local ;
utilise HTTPS et retire cette autorisation avant une publication.

## Réseau et sécurité

La CSP est limitée à l’origine API de l’émulateur et à localhost pour le
développement. Utiliser une origine HTTPS explicite en production. La règle
`android:usesCleartextTraffic="true"` dans `config.xml` sert uniquement aux
tests HTTP locaux et doit être supprimée avant une publication de production.
Le manifeste généré déclare l'accès réseau. La sélection et la capture de
médias ne sont pas encore reliées à l'interface et aucune permission média n'est
actuellement déclarée ni demandée.

Lors de leur intégration, préférer le sélecteur système Android pour les photos
et vidéos : il accorde un accès temporaire aux fichiers choisis sans demander
`READ_MEDIA_IMAGES`/`READ_MEDIA_VIDEO`. Si un parcours nécessite un accès direct
à la médiathèque, déclarer et demander ces permissions à l'exécution sur Android
13+, ainsi que `READ_MEDIA_VISUAL_USER_SELECTED` pour le mode d'accès partiel
d'Android 14. Pour une capture effectuée directement par l'application,
déclarer `CAMERA` et, pour enregistrer le son, `RECORD_AUDIO`, puis demander le
consentement au moment de la première utilisation et traiter le refus. Les
intents qui délèguent la capture à l'application caméra système peuvent ne pas
nécessiter ces permissions pour ViteVendre. Valider chaque parcours sur Android
13 et 14 et expliquer à l'utilisateur comment réactiver une permission refusée
dans Paramètres Android.

## État réel des fonctionnalités et limites API

L’application s’appelle **ViteVendre**. Son logo SVG représente une boutique
reliée à un client par une flèche d’échange. Il est utilisé dans l’en-tête,
l’onboarding et l’écran de démarrage ; les icônes Android sont générées en
plusieurs densités depuis ce logo.

Le socle visuel comprend des tokens CSS, des utilitaires sans dépendance, des
icônes SVG, une navigation à cinq actions, un onboarding illustré de quatre
diapositives et des favoris locaux utilisables hors connexion. Le profil affiche
les informations du compte, l’accès à la boutique, la déconnexion et un choix
clair/sombre mémorisé sur l’appareil. Les favoris sont également locaux et ne
sont pas synchronisés avec un compte.

L'OTP, le feed vidéo plein écran, le signalement et le studio en plusieurs
étapes restent à implémenter.

L'upload vidéo est envoyé par morceaux à partir de `Blob.slice()` ; le fichier
entier n'est jamais chargé en RAM. Sur Android, le fichier source et l'état de
la session sont conservés dans le stockage privé via `cordova-plugin-file`.
Après un redémarrage, l'application interroge `GET /api/media/uploads/:id` et
ne renvoie que les morceaux manquants. L'aperçu navigateur utilise IndexedDB.
Le backend conserve les sessions inactives pendant 7 jours par défaut
(`UPLOAD_SESSION_TTL_HOURS`). La copie native préalable nécessite un espace
libre sur le téléphone au moins égal à la taille de la vidéo ; sa copie est
elle-même découpée en blocs de 1 Mio.

Les limites applicatives historiques de 250 Mo et 180 secondes sont retirées.
Par défaut, `MAX_VIDEO_BYTES=0` signifie qu'aucun plafond de taille applicatif
n'est imposé et aucune limite de durée n'est configurée. Le stockage disponible,
le réseau et le temps de transcodage restent des contraintes physiques du
serveur. Un plafond facultatif peut être fixé avec `MAX_VIDEO_BYTES` en octets.

Chaque requête d'upload porte un seul bloc (taille adaptative côté client,
jusqu'à 4 Mo autorisés côté serveur), pas le fichier entier. Configure le proxy
inverse avec une taille de corps supérieure au bloc maximal et des délais
compatibles avec le réseau mobile et l'assemblage. Les exemples Nginx et les
variables Express/Node.js figurent dans le README du backend.

## Vérification

```powershell
npm test
cordova build browser
cordova build android
```

Scénarios manuels déjà exercés : chargement du catalogue, choix de ville,
affichage du feed, ouverture des formulaires d'inscription, build Cordova
navigateur et APK Android. Les plugins installés doivent encore être intégrés
aux commandes de sélection/capture de médias dans les phases suivantes.
