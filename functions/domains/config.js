const functions = require('firebase-functions');

// Hent Firebase config fra environment
const config = {
  projectId: process.env.FIREBASE_PROJECT_ID || functions.config().project?.id || 'toft-d4f39',
  token: process.env.FIREBASE_TOKEN || functions.config().ci?.token,
  region: process.env.FIREBASE_REGION || 'us-central1'
};

// Valider config
if (!config.token) {
  console.error('ADVARSEL: Firebase CI token er ikke konfigureret');
}

if (!config.projectId) {
  console.error('ADVARSEL: Firebase Project ID er ikke konfigureret');
}

module.exports = config; 