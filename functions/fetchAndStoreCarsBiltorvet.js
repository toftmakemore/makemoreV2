const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');
const { PubSub } = require('@google-cloud/pubsub');

if (!admin.apps.length) {
  admin.initializeApp();
}

async function createTopicIfNotExists(pubSubClient, topicName) {
  try {
    const [exists] = await pubSubClient.topic(topicName).exists();
    if (!exists) {
      console.log(`Opretter nyt PubSub topic: ${topicName}`);
      await pubSubClient.createTopic(topicName);
    }
    return true;
  } catch (error) {
    console.error(`Fejl ved oprettelse/tjek af topic ${topicName}:`, error);
    return false;
  }
}

exports.fetchAndStoreCarsBiltorvet = functions.pubsub
  .schedule('30 2 * * *')
  .timeZone('Europe/Copenhagen')
  .onRun(async (context) => {
    const db = admin.firestore();
    const pubSubClient = new PubSub();
    const TOPIC_NAME = 'biltorvet-scraping';

    try {
      // Sæt en status flag når processen starter
      await db.collection('system').doc('biltorvetStatus').set({
        fetchInProgress: true,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      });

      // Henter ALLE Biltorvet brugere
      const usersSnapshot = await db.collection('users')
        .where('client', '==', 'biltorvet')
        .where('dealerId', '!=', null)
        .where('companyType', '==', 'auto')
        .get();

      // Kører processen for hver bruger
      for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;
        const dealerId = userDoc.data().dealerId;

        try {
          // 1. Hent alle biler fra Biltorvet API
          const allCars = await fetchBiltorvetCarsWithRetry(dealerId);
          
          // 2. Tjek om brugeren har eksisterende biler
          const existingDealerCarsSnapshot = await db.collection('users')
            .doc(userId)
            .collection('dealerCars')
            .get();
            
          const isNewUser = existingDealerCarsSnapshot.empty;
          const existingCars = new Map(
            existingDealerCarsSnapshot.docs.map(doc => [doc.id, doc.data()])
          );

          // 3. Opdater dealerCars collection
          const dealerCarsBatch = db.batch();
          
          // Slet eksisterende biler
          existingDealerCarsSnapshot.forEach(doc => {
            dealerCarsBatch.delete(doc.ref);
          });

          // Tilføj biler med korrekt createdDate
          allCars.forEach(car => {
            const carRef = db.collection('users')
              .doc(userId)
              .collection('dealerCars')
              .doc(car.id);

            let createdDate;
            if (isNewUser) {
              // For nye brugere, fordel bilerne over de sidste 30 dage
              createdDate = generateRandomPastDate(89);
            } else {
              // For eksisterende brugere, behold eller opret createdDate
              const existingCar = existingCars.get(car.id);
              createdDate = existingCar?.createdDate || new Date().toISOString();
            }

            dealerCarsBatch.set(carRef, {
              ...car,
              createdDate
            });
          });

          await dealerCarsBatch.commit();
          
          // 4. Valider og rens data
          await validateAndCleanDealerCars(db, userId);

          console.log(`Opdateret dealerCars for bruger ${userId} med ${allCars.length} biler`);

        } catch (error) {
          console.error(`Fejl ved behandling af forhandler ${dealerId}:`, error);
          continue;
        }
      }

      // Når alle biler er hentet, opret topic hvis det ikke findes og trigger scraping funktionen
      const topicExists = await createTopicIfNotExists(pubSubClient, TOPIC_NAME);
      
      if (topicExists) {
        await pubSubClient.topic(TOPIC_NAME).publishMessage({
          data: Buffer.from(JSON.stringify({
            timestamp: Date.now()
          })),
        });
        console.log('Besked publiceret til PubSub topic:', TOPIC_NAME);
      } else {
        console.error('Kunne ikke publicere besked - topic eksisterer ikke');
      }

      // Opdater status når processen er færdig
      await db.collection('system').doc('biltorvetStatus').set({
        fetchInProgress: false,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        lastSuccessful: admin.firestore.FieldValue.serverTimestamp()
      });

      return null;
    } catch (error) {
      // Opdater status ved fejl
      await db.collection('system').doc('biltorvetStatus').set({
        fetchInProgress: false,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        lastError: error.message
      });
      
      console.error('Kritisk fejl i fetchAndStoreCarsBiltorvet:', error);
      throw error;
    }
  });

async function fetchBiltorvetCarsWithRetry(dealerId, maxRetries = 3) {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      let allCars = [];
      let pageNumber = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        const response = await axios.post(
          'https://www.biltorvet.dk/Api/Search/Page',
          {
            pageNumber,
            searchOrigin: 6,
            searchValue: dealerId,
            sort: "CreatedDesc"
          },
          {
            timeout: 10000
          }
        );
        
        const cars = response.data;
        if (!cars || cars.length === 0) {
          hasMorePages = false;
        } else {
          const processedCars = cars
            .filter(car => {
              const isValid = car && car.makeModel && typeof car.makeModel === 'string';
              if (!isValid) {
                console.warn(`Ignorerer ugyldig bil fra Biltorvet:`, {
                  id: car?.id,
                  makeModel: car?.makeModel,
                  url: car?.url
                });
              }
              return isValid;
            })
            .map(car => ({
              ...car,
              id: car.id.toString(),
              makeModel: car.makeModel?.trim() || 'Ukendt model',
              variant: car.variant?.trim() || '-',
              year: car.year || 'Ukendt årgang',
              kilometers: car.kilometers || '-',
              url: car.url || `https://www.biltorvet.dk/bil/${car.id}`,
              priceInt: parseInt((car.priceText || '0').replace(/[^0-9]/g, ''), 10) || 0
            }));
          
          allCars = [...allCars, ...processedCars];
          pageNumber++;
        }
      }
      
      console.log(`Hentet ${allCars.length} gyldige biler for forhandler ${dealerId}`);
      return allCars;
      
    } catch (error) {
      retries++;
      console.error(`Fejl ved hentning af biler (forsøg ${retries}/${maxRetries}):`, error);
      if (retries === maxRetries) {
        throw new Error(`Kunne ikke hente biler efter ${maxRetries} forsøg`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * retries));
    }
  }
}

async function validateAndCleanDealerCars(db, userId) {
  const dealerCarsRef = db.collection('users').doc(userId).collection('dealerCars');
  const snapshot = await dealerCarsRef.get();
  
  const batch = db.batch();
  let deletedCount = 0;
  
  for (const doc of snapshot.docs) {
    const car = doc.data();
    
    // Valider bil-data
    if (!isValidCarData(car)) {
      batch.delete(doc.ref);
      deletedCount++;
      
      // Log information om slettet bil
      console.log(`[${new Date().toISOString()}] Sletter ugyldig bil for bruger ${userId}:`, {
        id: car.id,
        makeModel: car.makeModel,
        reason: 'Mangler påkrævet data (imageUrl)'
      });
    }
  }

  if (batch._ops.length > 0) {
    await batch.commit();
    console.log(`[${new Date().toISOString()}] Oprydning færdig for bruger ${userId}. Slettede ${deletedCount} ugyldige biler.`);
  }
}

function isValidCarData(car) {
  // Tjek for påkrævede felter
  const requiredFields = {
    id: (val) => typeof val === 'string' && val.length > 0,
    imageUrl: (val) => typeof val === 'string' && val.startsWith('http'),
    makeModel: (val) => typeof val === 'string' && val.length > 0,
    url: (val) => typeof val === 'string' && val.length > 0
  };

  return Object.entries(requiredFields).every(([field, validator]) => {
    const isValid = validator(car[field]);
    if (!isValid) {
      console.log(`Validation failed for field: ${field}`, car[field]);
    }
    return isValid;
  });
}

// Hjælpefunktion til at generere tilfældig dato inden for X dage
function generateRandomPastDate(days) {
  const now = new Date();
  const pastDate = new Date(now.getTime() - Math.random() * days * 24 * 60 * 60 * 1000);
  return pastDate.toISOString();
}
exports.processBiltorvetCarsForUser = async (userId) => {
  if (!userId) {
    throw new Error('userId er påkrævet');
  }

  const db = admin.firestore();
  const pubSubClient = new PubSub();
  const TOPIC_NAME = 'biltorvet-scraping';

  try {
    // Sæt status flag når processen starter
    await db.collection('system').doc('biltorvetStatus').set({
      fetchInProgress: true,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    });

    const userDoc = await db.collection('users').doc(userId).get();
    
    if (!userDoc.exists) {
      throw new Error(`Bruger ${userId} findes ikke`);
    }

    const userData = userDoc.data();
    
    if (userData.client?.toLowerCase() !== 'biltorvet') {
      throw new Error('Denne funktion er kun til Biltorvet brugere');
    }

    const dealerId = userData.dealerId;
    if (!dealerId) {
      throw new Error('Bruger har ikke et gyldigt dealerId');
    }

    // Hent og gem biler
    const allCars = await fetchBiltorvetCarsWithRetry(dealerId);
    
    const dealerCarsRef = db.collection('users').doc(userId).collection('dealerCars');
    const existingDealerCarsSnapshot = await dealerCarsRef.get();
    const isNewUser = existingDealerCarsSnapshot.empty;
    
    const batch = db.batch();
    
    existingDealerCarsSnapshot.forEach(doc => {
      batch.delete(doc.ref);
    });

    allCars.forEach(car => {
      const carRef = dealerCarsRef.doc(car.id);
      const createdDate = isNewUser ? 
        generateRandomPastDate(89) : 
        existingDealerCarsSnapshot.docs.find(doc => doc.id === car.id)?.data()?.createdDate || 
        new Date().toISOString();

      batch.set(carRef, {
        ...car,
        createdDate
      });
    });

    await batch.commit();
    await validateAndCleanDealerCars(db, userId);

    // Opret topic hvis det ikke findes
    const [exists] = await pubSubClient.topic(TOPIC_NAME).exists();
    if (!exists) {
      console.log(`Opretter nyt PubSub topic: ${TOPIC_NAME}`);
      await pubSubClient.createTopic(TOPIC_NAME);
    }

    // Trigger scraping processen via PubSub
    await pubSubClient.topic(TOPIC_NAME).publishMessage({
      data: Buffer.from(JSON.stringify({
        timestamp: Date.now(),
        userId: userId  // Send userId med så vi kun scraper for denne bruger
      })),
    });

    console.log(`Besked publiceret til PubSub topic: ${TOPIC_NAME} for bruger ${userId}`);

    // Opdater status når processen er færdig
    await db.collection('system').doc('biltorvetStatus').set({
      fetchInProgress: false,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      lastSuccessful: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      totalCars: allCars.length
    };

  } catch (error) {
    console.error(`Fejl ved processering af Biltorvet biler for bruger ${userId}:`, error);
    
    // Opdater status ved fejl
    await db.collection('system').doc('biltorvetStatus').set({
      fetchInProgress: false,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      lastError: error.message
    });
    
    throw error;
  }
};
