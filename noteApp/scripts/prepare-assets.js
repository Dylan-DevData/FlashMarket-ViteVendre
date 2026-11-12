'use strict';

const fs = require('node:fs');
const path = require('node:path');

const source = path.join(__dirname, '..', 'node_modules', 'hls.js', 'dist', 'hls.min.js');
const license = path.join(__dirname, '..', 'node_modules', 'hls.js', 'LICENSE');
const destination = path.join(__dirname, '..', 'www', 'lib', 'hls.min.js');
const licenseDestination = path.join(__dirname, '..', 'www', 'lib', 'hls.LICENSE');

if (!fs.existsSync(source) || !fs.existsSync(license)) {
  throw new Error('hls.js is missing. Run npm install before preparing the Cordova app.');
}

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(source, destination);
fs.copyFileSync(license, licenseDestination);
