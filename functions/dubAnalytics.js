const functions = require("firebase-functions");
const admin = require('firebase-admin');
const axios = require("axios");

const API_KEY = "dub_uuPK2diVwXw4oVtWZVvGOQgE";
const ANALYTICS_API_URL = "https://api.dub.co/analytics";

// Hovedfunktion til at hente og gemme analytics data
async function fetchAndStoreAnalytics(userId, tagId) {
  try {
    // Hent analytics data fra Dub.co med lifetime interval
    const response = await axios.get(ANALYTICS_API_URL, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      params: {
        tagId: tagId,
        groupBy: 'top_links',
        interval: 'all'
      }
    });

    const analyticsData = response.data;
    const db = admin.firestore();
    
    // Start en batch skrivning
    const batch = db.batch();
    
    // Reference til brugerens analytics collection
    const userAnalyticsRef = db.collection('users').doc(userId).collection('linkAnalytics');
    
    // Beregn total clicks
    const totalClicks = analyticsData.reduce((sum, link) => sum + (link.clicks || 0), 0);
    
    // Gem den aggregerede data
    const statsRef = db.collection('users').doc(userId).collection('analytics').doc('stats');
    batch.set(statsRef, {
      totalClicks,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      tagId: tagId,
      linkCount: analyticsData.length
    }, { merge: true });
    
    // Gem individuelle link data
    analyticsData.forEach(linkData => {
      const docRef = userAnalyticsRef.doc(linkData.id);
      batch.set(docRef, {
        ...linkData,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        userId: userId
      }, { merge: true });
    });

    await batch.commit();
    
    return {
      success: true,
      message: 'Analytics data hentet og gemt',
      data: {
        links: analyticsData,
        stats: {
          totalClicks,
          linkCount: analyticsData.length
        }
      }
    };

  } catch (error) {
    console.error('Fejl ved hentning af analytics:', error);
    throw new Error(`Fejl ved hentning af analytics data: ${error.message}`);
  }
}

// HTTP endpoint til manuel kørsel
exports.getDubAnalytics = functions.https.onRequest((req, res) => {
  const cors = require('cors')({origin: true});
  
  cors(req, res, async () => {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Metode ikke tilladt' });
    }

    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ error: 'userId er påkrævet' });
    }

    try {
      // Hent brugerens tagId fra deres profil
      const db = admin.firestore();
      const userDoc = await db.collection('users').doc(userId).get();
      
      if (!userDoc.exists) {
        throw new Error('Bruger ikke fundet');
      }
      
      const userData = userDoc.data();
      const tagId = userData.dubTagId;
      
      if (!tagId) {
        throw new Error('Ingen dubTagId fundet for brugeren');
      }

      const result = await fetchAndStoreAnalytics(userId, tagId);
      return res.status(200).json(result);
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
});

// Callable funktion til brug fra klienten
exports.triggerDubAnalytics = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Bruger skal være logget ind');
  }

  const userId = context.auth.uid;
  
  try {
    const db = admin.firestore();
    const userDoc = await db.collection('users').doc(userId).get();
    
    if (!userDoc.exists) {
      throw new Error('Bruger ikke fundet');
    }
    
    const userData = userDoc.data();
    const tagId = userData.dubTagId;
    
    if (!tagId) {
      throw new Error('Ingen dubTagId fundet for brugeren');
    }

    const result = await fetchAndStoreAnalytics(userId, tagId);
    return result;
  } catch (error) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// Helper funktion til at hente gemt analytics data
exports.getStoredAnalytics = async (userId) => {
  try {
    const db = admin.firestore();
    
    // Hent statistik
    const statsDoc = await db.collection('users').doc(userId)
      .collection('analytics').doc('stats').get();
    
    // Hent alle links
    const linksSnapshot = await db.collection('users').doc(userId)
      .collection('linkAnalytics')
      .orderBy('lastUpdated', 'desc')
      .get();

    const links = linksSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    return {
      success: true,
      data: {
        stats: statsDoc.exists ? statsDoc.data() : null,
        links: links
      }
    };
  } catch (error) {
    console.error('Fejl ved hentning af gemt analytics:', error);
    throw error;
  }
};
