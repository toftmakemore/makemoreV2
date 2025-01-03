const axios = require('axios');
const admin = require('firebase-admin');
const functions = require('firebase-functions');
const config = require('./config');

// Initialiser Firebase Admin SDK, hvis det ikke allerede er gjort
if (!admin.apps.length) {
  admin.initializeApp();
}

async function hentFacebookPageAccessToken(facebookId, userAccessToken) {
  const url = `https://graph.facebook.com/${facebookId}?fields=access_token&access_token=${userAccessToken}`;
  try {
    const response = await axios.get(url);
    if (response.status === 200 && response.data.access_token) {
      return response.data.access_token;
    }
    console.error('Fejl ved hentning af page access token:', response.data);
    return null;
  } catch (error) {
    console.error('Fejl ved API-kald:', error);
    return null;
  }
}

async function opdaterPageAccessToken(userId, userData) {
  const db = admin.firestore();
  const userRef = db.collection('users').doc(userId);
  const metaUserDataRef = db.collection('metaUserData').doc(userId);

  try {
    const facebookPageId = userData.MetaSettings?.facebookPageId;
    const instagramBusinessAccountId = userData.MetaSettings?.instagramBusinessAccountId;
    
    if (!facebookPageId) {
      console.log('Manglende Facebook Page ID for bruger:', userId);
      return;
    }

    // Find alle brugere med samme facebookPageId i users collection
    const usersWithSamePageIdSnapshot = await db.collection('users')
      .where('MetaSettings.facebookPageId', '==', facebookPageId)
      .get();

    let existingPageAccessToken = null;
    const now = admin.firestore.Timestamp.now();

    // Tjek om der findes et eksisterende token i MetaSettings
    for (const doc of usersWithSamePageIdSnapshot.docs) {
      const metaSettings = doc.data().MetaSettings;
      if (metaSettings?.page_access_token) {
        existingPageAccessToken = metaSettings.page_access_token;
        console.log('Fandt eksisterende token i MetaSettings fra bruger:', doc.id);
        break;
      }
    }

    // Hvis ingen eksisterende token blev fundet, hent en ny
    if (!existingPageAccessToken) {
      const userAccessToken = config.meta.userToken;
      existingPageAccessToken = await hentFacebookPageAccessToken(facebookPageId, userAccessToken);
      
      if (!existingPageAccessToken) {
        console.error('Kunne ikke hente nyt page access token for bruger:', userId);
        return;
      }
    }

    // Opdater alle brugere med samme facebookPageId i users collection
    const batchUpdate = db.batch();
    usersWithSamePageIdSnapshot.docs.forEach(doc => {
      batchUpdate.update(db.collection('users').doc(doc.id), {
        'MetaSettings.page_access_token': existingPageAccessToken,
        'MetaSettings.lastFacebookConnection': now
      });
    });
    await batchUpdate.commit();

    // Opret data objekt med facebook_id og pageAccessToken
    const data = {
      facebook_id: facebookPageId,
      pageAccessToken: existingPageAccessToken
    };

    // Tilføj instagram_id hvis instagramBusinessAccountId findes
    if (instagramBusinessAccountId) {
      data.instagram_id = instagramBusinessAccountId;
    }

    // Opdater metaUserData som backup med korrekt datastruktur
    await metaUserDataRef.set({
      key: userId,
      lastUpdated: now,
      data: data
    }, { merge: true });

    console.log('Page access token opdateret for alle brugere med facebookPageId:', facebookPageId);
  } catch (error) {
    console.error('Fejl ved opdatering af page access token:', error, 'for bruger:', userId);
  }
}

async function opdaterAllePageAccessTokens() {
  const db = admin.firestore();
  
  try {
    // Hent alle unikke facebookPageIds først
    const usersSnapshot = await db.collection('users')
      .where('MetaSettings.facebookPageId', '!=', null)
      .get();

    console.log(`Fandt ${usersSnapshot.size} brugere med Facebook Page ID`);

    // Opret et Map med facebookPageId som nøgle og array af bruger-data som værdi
    const pageIdMap = new Map();
    
    usersSnapshot.docs.forEach(doc => {
      const facebookPageId = doc.data().MetaSettings?.facebookPageId;
      if (!pageIdMap.has(facebookPageId)) {
        pageIdMap.set(facebookPageId, []);
      }
      pageIdMap.get(facebookPageId).push({
        userId: doc.id,
        userData: doc.data()
      });
    });

    // Opdater hver unik facebookPageId én gang
    for (const [pageId, users] of pageIdMap) {
      console.log(`Opdaterer token for facebookPageId: ${pageId} (${users.length} brugere)`);
      // Brug den første bruger til at opdatere token
      await opdaterPageAccessToken(users[0].userId, users[0].userData);
    }

    console.log('Daglig opdatering af page access tokens fuldført');
  } catch (error) {
    console.error('Fejl ved masseopdatering af tokens:', error);
  }
}

// Cloud Function til at køre opdateringen dagligt
exports.dagligOpdateringAfPageAccessTokens = functions.pubsub
  .schedule('every 24 hours')
  .onRun(async (context) => {
    console.log('Starter daglig opdatering af page access tokens');
    await opdaterAllePageAccessTokens();
    console.log('Daglig opdatering af page access tokens fuldført');
    return null;
  });

module.exports = {
  hentFacebookPageAccessToken,
  opdaterPageAccessToken,
  opdaterAllePageAccessTokens,
  dagligOpdateringAfPageAccessTokens: exports.dagligOpdateringAfPageAccessTokens
};

