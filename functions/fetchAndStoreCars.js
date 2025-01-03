const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');

// I stedet, tjek om appen allerede er initialiseret:
if (!admin.apps.length) {
  admin.initializeApp();
}

// Konstanter der matcher processAutoPosts.js
const VALID_COLLECTIONS = {
  newVehicles: 'newVehicles',
  newPriceVehicles: 'newPriceVehicles',
  soldVehicles: 'soldVehicles',
  daysForSaleVehicles: 'daysForSaleVehicles',
  dealerCars: 'dealerCars' // Denne skal altid opdateres
};

async function getExcludedCarIds(userId) {
  const db = admin.firestore();
  const excludeSnapshot = await db.collection('users').doc(userId).collection('excludeCars').get();
  return new Set(excludeSnapshot.docs.map(doc => doc.id));
}

exports.fetchAndStoreCars = functions.pubsub
  .schedule('0 6 * * *')
  .timeZone('Europe/Copenhagen')
  .onRun(async (context) => {
    const db = admin.firestore();
    const apiKey = 'V8rBcNWikMxz01j1u27EXJedj2Uj7ZHQcU3VI9G08/Qhcqv23EZnBnP7IcRc3zjLYcQjQ9Uoo7jpGsNdScLlhQ==';
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayKey = today.toISOString().split('T')[0];

    try {
      // Filtrer Biltorvet brugere ud i JavaScript
      const relevantUsers = usersSnapshot.docs.filter(doc => 
        doc.data().client !== 'biltorvet'
      );

      for (const userDoc of relevantUsers) {
        const userId = userDoc.id;
        const dealerId = userDoc.data().dealerId;
        const changes = {
          newCount: 0,
          priceCount: 0,
          soldCount: 0,
          repostCount: 0,
          daysForSaleCount: 0,
          errors: []
        };

        try {
          const excludedCarIds = await getExcludedCarIds(userId);
          const allCars = await fetchCarsWithRetry(dealerId, apiKey);
          
          // Filtrer biler der er i excludeCars
          const filteredCars = allCars.filter(car => !excludedCarIds.has(car.id));

          // Brug filteredCars i stedet for allCars
          const existingDealerCarsSnapshot = await db.collection('users').doc(userId).collection('dealerCars').get();
          const existingCars = existingDealerCarsSnapshot.docs.map(doc => doc.data());

          // Log den bil vi specifikt leder efter
          const specificCar = existingCars.find(car => car.id === '1675708');
          if (specificCar) {
            console.log('Fandt specifik bil:', {
              id: specificCar.id,
              createdDate: specificCar.createdDate,
              fields: specificCar.fields
            });
          }

          // Opret fingerprint maps
          const existingCarsMap = new Map(
            existingCars.map(car => [createVehicleFingerprint(car), {
              id: car.id,
              price: car.priceInt,
              data: car
            }])
          );

          const newCarsMap = new Map(
            filteredCars.map(car => [createVehicleFingerprint(car), {
              id: car.id,
              price: car.priceInt,
              data: car
            }])
          );

          console.log(`Antal biler i existingCarsMap: ${existingCarsMap.size}`);
          console.log(`Antal biler i newCarsMap: ${newCarsMap.size}`);

          // Identificer reelle ændringer
          const newVehicles = [];
          const newPriceVehicles = [];
          const soldVehicles = [];

          // Opdater altid dealerCars collection
          const dealerCarsRef = db.collection('users').doc(userId).collection(VALID_COLLECTIONS.dealerCars);
          const dealerCarsBatch = db.batch();
          
          existingDealerCarsSnapshot.forEach(doc => {
            dealerCarsBatch.delete(doc.ref);
          });

          filteredCars.forEach(car => {
            const carRef = dealerCarsRef.doc(car.id.toString());
            dealerCarsBatch.set(carRef, car);
          });

          await dealerCarsBatch.commit();

          // Hent brugerens aktive autoPosts
          const autoPostsRef = db.collection('users').doc(userId).collection('autoPosts');
          const activeAutoPostsSnapshot = await autoPostsRef
            .where('active', '==', true)
            .where('collectionName', 'in', Object.values(VALID_COLLECTIONS))
            .get();

          if (!activeAutoPostsSnapshot.empty) {
            const collectionsToUpdate = new Set();
            
            activeAutoPostsSnapshot.forEach(doc => {
              const autoPost = doc.data();
              if (VALID_COLLECTIONS[autoPost.collectionName]) {
                collectionsToUpdate.add(autoPost.collectionName);
              }
            });

            // Identificer ændringer kun hvis den relevante collection skal opdateres
            if (collectionsToUpdate.has(VALID_COLLECTIONS.newVehicles)) {
              filteredCars.forEach(newCar => {
                const fingerprint = createVehicleFingerprint(newCar);
                if (!existingCarsMap.has(fingerprint)) {
                  newVehicles.push(newCar);
                  changes.newCount++;
                }
              });
            }

            if (collectionsToUpdate.has(VALID_COLLECTIONS.newPriceVehicles)) {
              filteredCars.forEach(newCar => {
                const fingerprint = createVehicleFingerprint(newCar);
                const existingCar = existingCarsMap.get(fingerprint);
                if (existingCar && newCar.priceInt !== existingCar.price) {
                  newPriceVehicles.push({
                    ...newCar,
                    previousPrice: existingCar.price
                  });
                  changes.priceCount++;
                }
              });
            }

            if (collectionsToUpdate.has(VALID_COLLECTIONS.soldVehicles)) {
              existingCars.forEach(existingCar => {
                const fingerprint = createVehicleFingerprint(existingCar);
                if (!newCarsMap.has(fingerprint)) {
                  soldVehicles.push(existingCar);
                  changes.soldCount++;
                }
              });
            }

            if (collectionsToUpdate.has(VALID_COLLECTIONS.daysForSaleVehicles)) {
              // Håndter daysForSaleVehicles særskilt da det er et objekt
              const daysForSaleAutoPost = activeAutoPostsSnapshot.docs
                .find(doc => doc.data().collectionName === VALID_COLLECTIONS.daysForSaleVehicles);
              
              if (daysForSaleAutoPost) {
                const settings = daysForSaleAutoPost.data().settings;
                daysForSaleVehicles = calculateDaysForSaleVehicles(
                  filteredCars,
                  settings?.futurePosts ?? false,
                  existingCars,
                  settings
                );
              }
            }

            // Opdater collections
            for (const collectionName of collectionsToUpdate) {
              if (!VALID_COLLECTIONS[collectionName]) continue; // Skip ugyldige collections
              
              const collectionRef = db.collection('users').doc(userId).collection(collectionName);
              const existingDocs = await collectionRef.get();
              const batch = db.batch();
              
              // Slet eksisterende dokumenter
              existingDocs.forEach(doc => {
                batch.delete(doc.ref);
              });

              // Tilføj nye dokumenter baseret på collection type
              switch (collectionName) {
                case VALID_COLLECTIONS.newVehicles:
                  newVehicles.forEach(item => {
                    batch.set(collectionRef.doc(item.id.toString()), item);
                  });
                  break;
                case VALID_COLLECTIONS.newPriceVehicles:
                  newPriceVehicles.forEach(item => {
                    batch.set(collectionRef.doc(item.id.toString()), item);
                  });
                  break;
                case VALID_COLLECTIONS.soldVehicles:
                  soldVehicles.forEach(item => {
                    batch.set(collectionRef.doc(item.id.toString()), item);
                  });
                  break;
                case VALID_COLLECTIONS.daysForSaleVehicles:
                  if (daysForSaleVehicles[todayKey]) {
                    daysForSaleVehicles[todayKey].forEach(car => {
                      batch.set(collectionRef.doc(car.id.toString()), car);
                    });
                  }
                  break;
              }

              await batch.commit();
            }

            // Opdater carsCount på alle aktive autoPosts
            const autoPostsUpdateBatch = db.batch();
            for (const autoPostDoc of activeAutoPostsSnapshot.docs) {
              const autoPost = autoPostDoc.data();
              if (!VALID_COLLECTIONS[autoPost.collectionName]) continue;
              
              const collectionRef = db.collection('users').doc(userId).collection(autoPost.collectionName);
              const carsSnapshot = await collectionRef.get();
              
              autoPostsUpdateBatch.update(autoPostDoc.ref, {
                carsCount: carsSnapshot.size,
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
              });
            }
            await autoPostsUpdateBatch.commit();
          }

          // Log ændringer for denne forhandler
          logChanges(userId, dealerId, changes);

        } catch (error) {
          changes.errors.push(error.message);
          console.error(`Fejl ved behandling af forhandler ${dealerId}:`, error);
          // Fortsæt til næste forhandler
          continue;
        }
      }

      return null;
    } catch (error) {
      console.error('Kritisk fejl i fetchAndStoreCars:', error);
      throw error; // Lad Cloud Functions håndtere den kritiske fejl
    }
  });

function calculateDaysForSaleVehicles(newVehicles, futurePosts, existingCars, userSettings) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysForSaleVehicles = {};
  const todayKey = today.toISOString().split('T')[0];
  
  // Bestem interval baseret på settings
  let rotationInterval;
  if (userSettings?.useAutoInterval) {
    const totalCars = newVehicles.length;
    rotationInterval = calculateOptimalInterval(totalCars);
  } else {
    rotationInterval = userSettings?.manualInterval || 17;
  }

  for (const car of newVehicles) {
    const createdDate = new Date(car.createdDate);
    createdDate.setHours(0, 0, 0, 0);
    
    let rotationDate = new Date(createdDate);
    let shouldShow = false;

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

      // Tilføj bil direkte som objekt, ligesom i andre collections
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

// Hjælpefunktion til at skabe unikt fingerprint for en bil
function createVehicleFingerprint(car) {
  try {
    // Brug kun URL som fingerprint, da det er unikt og stabilt
    return car.url;
  } catch (error) {
    console.error('Fejl ved oprettelse af fingerprint:', error, 'Bil data:', car);
    throw new Error('Kunne ikke oprette fingerprint for bil');
  }
}

// Hjælpefunktion til at hente biler med retry logik
async function fetchCarsWithRetry(dealerId, apiKey, maxRetries = 3) {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      let allCars = [];
      let page = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        const response = await axios.get(
          `https://api.bilhandel.dk/api/Postmaster/vehicles/${dealerId}?page=${page}&pageSize=100`,
          {
            headers: {
              'accept': 'application/json',
              'X-ApiKey': apiKey
            },
            timeout: 10000 // 10 sekunder timeout
          }
        );
        
        const cars = response.data;
        if (cars.length === 0) {
          hasMorePages = false;
        } else {
          allCars = [...allCars, ...cars];
          page++;
        }
      }
      
      return allCars;
    } catch (error) {
      retries++;
      console.error(`Fejl ved hentning af biler (forsøg ${retries}/${maxRetries}):`, error);
      if (retries === maxRetries) {
        throw new Error(`Kunne ikke hente biler efter ${maxRetries} forsøg`);
      }
      // Vent progressivt længere mellem hver retry
      await new Promise(resolve => setTimeout(resolve, 1000 * retries));
    }
  }
}
// Hjælpefunktion til at logge ændringer
function logChanges(userId, dealerId, changes) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Ændringer for bruger ${userId} (forhandler ${dealerId}):`);
  console.log(`- Nye biler: ${changes.newCount}`);
  console.log(`- Prisændringer: ${changes.priceCount}`);
  console.log(`- Solgte biler: ${changes.soldCount}`);
  console.log(`- Genposteringer identificeret: ${changes.repostCount}`);
  console.log(`- Dags dato biler: ${changes.daysForSaleCount || 0}`);
  
  if (changes.errors.length > 0) {
    console.error(`- Fejl under behandling:`, changes.errors);
  }
}

// Tilføj denne hjælpefunktion
function calculateOptimalInterval(carCount) {
  const intervals = [
    { min: 5, max: 20, days: 9 },
    { min: 21, max: 60, days: 21 },
    { min: 61, max: 120, days: 22 },
    { min: 121, max: 200, days: 30 },
    { min: 201, max: 400, days: 35 }
  ];

  const defaultInterval = 17; // Default hvis antal biler er uden for ranges
  const interval = intervals.find(i => carCount >= i.min && carCount <= i.max);
  return interval ? interval.days : defaultInterval;
}
exports.processCarsForUser = async (userId) => {
  if (!userId) {
    throw new Error('userId er påkrævet');
  }

  const db = admin.firestore();
  const userDoc = await db.collection('users').doc(userId).get();
  
  if (!userDoc.exists) {
    throw new Error(`Bruger ${userId} findes ikke`);
  }

  const userData = userDoc.data();
  
  // Tjek om det er en Biltorvet bruger
  if (userData.client === 'biltorvet') {
    throw new Error('Denne funktion er ikke til Biltorvet brugere');
  }

  const dealerId = userData.dealerId;
  if (!dealerId) {
    throw new Error('Bruger har ikke et gyldigt dealerId');
  }

  const apiKey = 'V8rBcNWikMxz01j1u27EXJedj2Uj7ZHQcU3VI9G08/Qhcqv23EZnBnP7IcRc3zjLYcQjQ9Uoo7jpGsNdScLlhQ==';

  try {
    const excludedCarIds = await getExcludedCarIds(userId);
    const allCars = await fetchCarsWithRetry(dealerId, apiKey);
    const filteredCars = allCars.filter(car => !excludedCarIds.has(car.id));

    // Opdater dealerCars collection
    const dealerCarsRef = db.collection('users').doc(userId).collection('dealerCars');
    const batch = db.batch();

    const existingDealerCarsSnapshot = await dealerCarsRef.get();
    existingDealerCarsSnapshot.forEach(doc => {
      batch.delete(doc.ref);
    });

    filteredCars.forEach(car => {
      const carRef = dealerCarsRef.doc(car.id.toString());
      batch.set(carRef, car);
    });

    await batch.commit();

    return {
      success: true,
      totalCars: filteredCars.length
    };

  } catch (error) {
    console.error(`Fejl ved processering af biler for bruger ${userId}:`, error);
    throw error;
  }
};

