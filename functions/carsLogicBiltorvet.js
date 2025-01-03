const functions = require('firebase-functions');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

const VALID_COLLECTIONS = {
  newVehicles: 'newVehicles',
  newPriceVehicles: 'newPriceVehicles',
  soldVehicles: 'soldVehicles',
  daysForSaleVehicles: 'daysForSaleVehicles'
};

async function getExcludedCarIds(userId) {
  const db = admin.firestore();
  const excludeSnapshot = await db.collection('users').doc(userId).collection('excludeCars').get();
  return new Set(excludeSnapshot.docs.map(doc => doc.id));
}

exports.processBiltorvetCollectionsOnTopic = functions
  .runWith({
    timeoutSeconds: 540,
    memory: '4GB'
  })
  .pubsub
  .topic('biltorvet-logic')
  .onPublish(async (message, context) => {
    const db = admin.firestore();

    try {
      // Dobbelttjek at scraping er helt færdig
      const statusDoc = await db.collection('system').doc('biltorvetStatus').get();
      const status = statusDoc.data() || {};

      if (status.scrapingInProgress) {
        console.log('Venter på at scraping bliver færdig...');
        throw new Error('Scraping er stadig i gang - prøv igen senere');
      }

      const usersSnapshot = await db.collection('users')
        .where('client', '==', 'biltorvet')
        .where('dealerId', '!=', null)
        .where('companyType', '==', 'auto')
        .get();

      for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;
        const changes = {
          newCount: 0,
          priceCount: 0,
          soldCount: 0,
          repostCount: 0,
          errors: []
        };

        try {
          const excludedCarIds = await getExcludedCarIds(userId);
          const currentDealerCarsSnapshot = await db.collection('users')
            .doc(userId)
            .collection('dealerCars')
            .get();
          
          const currentCars = currentDealerCarsSnapshot.docs.map(doc => doc.data());
          const filteredCurrentCars = currentCars.filter(car => !excludedCarIds.has(car.id));

          const yesterdayDealerCarsSnapshot = await db.collection('users')
            .doc(userId)
            .collection('dealerCarsHistory')
            .doc(getYesterdayDate())
            .get();

          const yesterdayCars = yesterdayDealerCarsSnapshot.exists 
            ? yesterdayDealerCarsSnapshot.data().cars || []
            : [];

          // 3. Sammenlign og kategoriser ændringer
          const {
            newVehicles,
            newPriceVehicles,
            soldVehicles,
            daysForSaleVehicles
          } = await processCarChanges(
            filteredCurrentCars,
            yesterdayCars,
            userDoc.data().settings?.futurePosts ?? false,
            userDoc.data().settings
          );

          // 4. Opdater collections
          await updateCollections(db, userId, {
            newVehicles,
            newPriceVehicles,
            soldVehicles,
            daysForSaleVehicles
          });

          // 5. Gem dagens biler i historik
          await db.collection('users')
            .doc(userId)
            .collection('dealerCarsHistory')
            .doc(getTodayDate())
            .set({ 
              cars: filteredCurrentCars,
              timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

          // 6. Opdater autoPosts
          await updateAutoPosts(db, userId);

          // Log ændringer
          logChanges(userId, userDoc.data().dealerId, changes);

        } catch (error) {
          changes.errors.push(error.message);
          console.error(`Fejl ved behandling af bruger ${userId}:`, error);
          continue;
        }
      }

      return null;
    } catch (error) {
      console.error('Kritisk fejl i processBiltorvetCollections:', error);
      throw error;
    }
  });

// Hjælpefunktioner
async function processCarChanges(currentCars, yesterdayCars, futurePosts, userSettings) {
  const newVehicles = [];
  const newPriceVehicles = [];
  const soldVehicles = [];
  let daysForSaleVehicles = {};

  // Opret fingerprint maps
  const yesterdayCarsMap = new Map(
    yesterdayCars.map(car => [createVehicleFingerprint(car), {
      id: car.id,
      price: car.priceInt,
      data: car
    }])
  );

  const currentCarsMap = new Map(
    currentCars.map(car => [createVehicleFingerprint(car), {
      id: car.id,
      price: car.priceInt,
      data: car
    }])
  );

  // Find nye biler
  currentCars.forEach(car => {
    const fingerprint = createVehicleFingerprint(car);
    if (!yesterdayCarsMap.has(fingerprint)) {
      newVehicles.push(car);
    } else {
      const yesterdayCar = yesterdayCarsMap.get(fingerprint);
      if (car.priceInt !== yesterdayCar.price) {
        newPriceVehicles.push({
          ...car,
          previousPrice: yesterdayCar.price
        });
      }
    }
  });

  // Find solgte biler
  yesterdayCars.forEach(car => {
    const fingerprint = createVehicleFingerprint(car);
    if (!currentCarsMap.has(fingerprint)) {
      soldVehicles.push(car);
    }
  });

  // Beregn daysForSale uden at bruge futurePosts
  daysForSaleVehicles = calculateDaysForSaleVehicles(currentCars, null, userSettings);

  return {
    newVehicles,
    newPriceVehicles,
    soldVehicles,
    daysForSaleVehicles
  };
}

async function updateCollections(db, userId, collections) {
  for (const [collectionName, data] of Object.entries(collections)) {
    const collectionRef = db.collection('users').doc(userId).collection(collectionName);
    const batch = db.batch();

    // Slet eksisterende dokumenter
    const existingDocs = await collectionRef.get();
    existingDocs.forEach(doc => {
      batch.delete(doc.ref);
    });

    // Tilføj nye dokumenter baseret på collection type
    switch (collectionName) {
      case VALID_COLLECTIONS.daysForSaleVehicles:
        // For daysForSaleVehicles, gem hver bil som et separat dokument
        if (data[getTodayDate()]) {
          data[getTodayDate()].forEach(car => {
            batch.set(collectionRef.doc(car.id.toString()), car);
          });
        }
        break;

      case VALID_COLLECTIONS.newVehicles:
      case VALID_COLLECTIONS.newPriceVehicles:
      case VALID_COLLECTIONS.soldVehicles:
        // For alle andre collections, gem hver bil som et separat dokument
        data.forEach(car => {
          batch.set(collectionRef.doc(car.id.toString()), car);
        });
        break;
    }

    await batch.commit();
  }
}

async function updateAutoPosts(db, userId) {
  const autoPostsRef = db.collection('users').doc(userId).collection('autoPosts');
  const activeAutoPostsSnapshot = await autoPostsRef
    .where('active', '==', true)
    .where('collectionName', 'in', Object.values(VALID_COLLECTIONS))
    .get();

  if (!activeAutoPostsSnapshot.empty) {
    const batch = db.batch();
    
    for (const doc of activeAutoPostsSnapshot.docs) {
      const collectionRef = db.collection('users')
        .doc(userId)
        .collection(doc.data().collectionName);
      
      const carsCount = (await collectionRef.get()).size;
      
      batch.update(doc.ref, {
        carsCount,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    await batch.commit();
  }
}

function createVehicleFingerprint(car) {
  try {
    // Brug kun URL som fingerprint, da det er unikt og stabilt
    return car.url;
  } catch (error) {
    console.error('Fejl ved oprettelse af fingerprint:', error, 'Bil data:', JSON.stringify(car, null, 2));
    throw new Error('Kunne ikke oprette fingerprint for bil');
  }
}

function calculateDaysForSaleVehicles(cars, futurePosts, userSettings) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysForSaleVehicles = {};
  const todayKey = today.toISOString().split('T')[0];
  
  // Bestem interval baseret på settings
  const rotationInterval = userSettings?.useAutoInterval 
    ? calculateOptimalInterval(cars.length)
    : (userSettings?.manualInterval || 17);

  for (const car of cars) {
    const createdDate = new Date(car.createdDate);
    createdDate.setHours(0, 0, 0, 0);
    
    let rotationDate = new Date(createdDate);
    let shouldShow = false;

    // Tjek om bilen skal vises i dag baseret på rotationsinterval
    while (rotationDate <= today) {
      if (rotationDate.getTime() === today.getTime()) {
        shouldShow = true;
        break;
      }
      rotationDate.setDate(rotationDate.getDate() + rotationInterval);
    }

    if (shouldShow) {
      if (!daysForSaleVehicles[todayKey]) {
        daysForSaleVehicles[todayKey] = [];
      }

      const daysSinceCreated = Math.floor((today - createdDate) / (1000 * 60 * 60 * 24));
      const rotationNumber = Math.floor(daysSinceCreated / rotationInterval) + 1;

      daysForSaleVehicles[todayKey].push({
        ...car,
        daysForSale: daysSinceCreated,
        originalCreatedDate: createdDate.toISOString(),
        rotationDate: today.toISOString(),
        rotationNumber: rotationNumber,
        usedInterval: rotationInterval
      });
    }
  }

  return daysForSaleVehicles;
}

function calculateOptimalInterval(carCount) {
  const intervals = [
    { min: 5, max: 20, days: 9 },
    { min: 21, max: 60, days: 21 },
    { min: 61, max: 120, days: 22 },
    { min: 121, max: 200, days: 30 },
    { min: 201, max: 400, days: 35 }
  ];

  const defaultInterval = 17;
  const interval = intervals.find(i => carCount >= i.min && carCount <= i.max);
  return interval ? interval.days : defaultInterval;
}

function getYesterdayDate() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return date.toISOString().split('T')[0];
}

function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

function logChanges(userId, dealerId, changes) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Ændringer for bruger ${userId} (forhandler ${dealerId}):`);
  console.log(`- Nye biler: ${changes.newCount}`);
  console.log(`- Prisændringer: ${changes.priceCount}`);
  console.log(`- Solgte biler: ${changes.soldCount}`);
  console.log(`- Genposteringer: ${changes.repostCount}`);
  
  if (changes.errors.length > 0) {
    console.error(`- Fejl under behandling:`, changes.errors);
  }
}