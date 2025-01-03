const admin = require('firebase-admin');

let app;
if (!admin.apps.length) {
  app = admin.initializeApp();
} else {
  app = admin.app();
}

module.exports = admin;