const admin = require('firebase-admin');
const { applicationDefault } = require('firebase-admin/app');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: applicationDefault(),
    projectId: 'toft-d4f39'
  });
}

async function addDomain() {
  try {
    const domain = {
      domain: 'fir-demo-m4xdqnup-bt81.web.app',
      subdomain: 'fir-demo-m4xdqnup-bt81',
      createdAt: admin.firestore.Timestamp.now(),
      status: 'active',
      userId: 'system' // Dette vil blive opdateret når en bruger opretter et nyt domæne
    };

    const docRef = await admin.firestore().collection('domains').add(domain);
    console.log('Domæne tilføjet med ID:', docRef.id);
  } catch (error) {
    console.error('Fejl ved tilføjelse af domæne:', error);
  } finally {
    process.exit();
  }
}

addDomain(); 