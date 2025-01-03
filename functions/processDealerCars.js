const functions = require('firebase-functions');
const admin = require('firebase-admin');
const BiltorvetScraper = require('./scrapers/biltorvet');
const pLimit = (...args) => import('p-limit').then(({default: limit}) => limit(...args));
const { PubSub } = require('@google-cloud/pubsub');

if (!admin.apps.length) {
  admin.initializeApp();
}

exports.processDealerCars = functions
  .runWith({
    timeoutSeconds: 540,
    memory: '4GB',
    maxInstances: 1
  })
  .pubsub
  .topic('biltorvet-scraping')
  .onPublish(async (message, context) => {
    const db = admin.firestore();
    const limit = await pLimit(2);
    const BATCH_SIZE = 10;
    const pubSubClient = new PubSub();
    const NEXT_TOPIC = 'biltorvet-logic';

    try {
      // Sæt status til at scraping er i gang
      await db.collection('system').doc('biltorvetStatus').set({
        scrapingInProgress: true,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      });

      const usersSnapshot = await db.collection('users')
        .where('client', '==', 'biltorvet')
        .where('dealerId', '!=', null)
        .where('companyType', '==', 'auto')
        .get();

      for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;
        const dealerCarsRef = db.collection('users').doc(userId).collection('dealerCars');
        
        console.log(`Processor biler for dealer ${userId}`);

        let lastDoc = null;
        while (true) {
          let query = dealerCarsRef.limit(BATCH_SIZE);
          if (lastDoc) {
            query = query.startAfter(lastDoc);
          }
          
          const batch = await query.get();
          if (batch.empty) break;
          
          const scraper = new BiltorvetScraper();
          try {
            const promises = batch.docs.map(doc => 
              limit(async () => {
                const car = doc.data();
                try {
                  scraper.currentDocRef = doc.ref;
                  const carUrl = car.url.startsWith('http') ? car.url : `https://www.biltorvet.dk${car.url}`;
                  const scrapedData = await scraper.scrapeCarPage(carUrl);
                  
                  if (scrapedData) {
                    const { id, url } = car;
                    
                    await doc.ref.set({
                      id,
                      url,
                      ...scrapedData,
                      lastScraped: admin.firestore.FieldValue.serverTimestamp()
                    });
                    
                    console.log(`Bil ${car.id} opdateret med scrapet data`);
                  }
                } catch (error) {
                  console.error(`Fejl ved bil ${car.id}:`, error);
                } finally {
                  scraper.currentDocRef = null;
                }
              })
            );

            await Promise.all(promises);
            lastDoc = batch.docs[batch.docs.length - 1];
            
            await new Promise(resolve => setTimeout(resolve, 2000));
          } finally {
            await scraper.close();
          }
        }
      }

      // Når alle biler er behandlet, publicer besked til næste topic
      await pubSubClient.topic(NEXT_TOPIC).publishMessage({
        data: Buffer.from(JSON.stringify({
          timestamp: Date.now()
        }))
      });

      // Opdater status
      await db.collection('system').doc('biltorvetStatus').set({
        scrapingInProgress: false,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      });

      return null;
    } catch (error) {
      console.error('Kritisk fejl:', error);
      throw error;
    }
  });