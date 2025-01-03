const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { getSignedRenderLink, formatCarData } = require('./utils/robollyGenerator');
const { generateSocialMediaText } = require('./utils/socialMediaGenerator');
const config = require('./config');
const fetch = require('node-fetch');
const { v4: uuid } = require('uuid');

const ROBOLY_API_KEY = config.robolly.apiKey;

if (!admin.apps.length) {
  admin.initializeApp();
}

const subjectMapping = {
  newVehicles: ['Nyheder', 'Nye biler på lager'],
  newPriceVehicles: ['Nye priser', 'Prisændringer'],
  daysForSaleVehicles: ['Lagerbiler'],
  soldVehicles: ['Solgte biler', 'Netop solgte']
};

const childrenSubjectMapping = {
  newVehicles: ['Nyhed', 'Ny bil på lager'],
  newPriceVehicles: ['Ny pris', 'Prisændring'],
  daysForSaleVehicles: ['Lagerbil'],
  soldVehicles: ['Solgt', 'Netop solgt']
};

// Tilføj en kø til at styre anmodningerne
const requestQueue = [];
let isProcessingQueue = false;

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (requestQueue.length > 0) {
    const { car, designUuid, userId, resolve, reject } = requestQueue.shift();
    try {
      const result = await generateRobollyImage(car, designUuid);
      const firebaseUrl = await convertRobollyToFirebaseUrl(result, userId, car.id, designUuid);
      resolve(firebaseUrl);
    } catch (error) {
      reject(error);
    }
    // Vent 333ms mellem hver anmodning for at overholde 3 anmodninger pr. sekund
    await new Promise(resolve => setTimeout(resolve, 333));
  }

  isProcessingQueue = false;
}

function rateLimitedRobollyRequest(car, designUuid, userId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Request timeout'));
    }, 30000); // 30 sekunder timeout

    requestQueue.push({
      car,
      designUuid,
      userId,
      resolve: (url) => {
        clearTimeout(timeout);
        resolve(url);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    });

    processQueue();
  });
}

// Helper function to generate Robolly image
async function generateRobollyImage(car, designUuid) {
  try {
    const modifications = {
      scale: 1,
      ...formatCarData(car)
    };

    const signedRenderLink = getSignedRenderLink({
      apiKey: ROBOLY_API_KEY,
      format: "jpg", 
      templateId: designUuid,
      modifications: modifications,
    });

    return signedRenderLink;
  } catch (error) {
    console.error('Fejl ved generering af Robolly billede:', error);
    return null;
  }
}

// Konstanter øverst i filen
const MIN_CARS_FOR_CAROUSEL = 3; // Minimum antal biler for karrusel
const MAX_CARS_PER_CAROUSEL = 10; // Maximum antal biler per karrusel
const BATCH_DELAY = 1000; // Pause mellem batches

// Tilføj øverst i filen sammen med andre konstanter
const VALID_COLLECTIONS = {
  newVehicles: 'newVehicles',
  newPriceVehicles: 'newPriceVehicles',
  soldVehicles: 'soldVehicles',
  daysForSaleVehicles: 'daysForSaleVehicles',
};

// Hovedfunktion der kører hver morgen
exports.scheduledFunction = functions.pubsub
  .schedule('30 6 * * *')
  .timeZone('Europe/Copenhagen')
  .onRun(async (context) => {
    console.log('processAutoPosts scheduled function started at:', new Date().toISOString());
    const db = admin.firestore();
    
    try {
      const autoPostsSnapshot = await db.collectionGroup('autoPosts')
        .where('active', '==', true)
        .orderBy('createdAt', 'desc')
        .get();

      for (const autoPostDoc of autoPostsSnapshot.docs) {
        const autoPost = {
          id: autoPostDoc.id,
          ...autoPostDoc.data()
        };

        try {
          // Brug den nye getCollectionCars funktion
          const cars = await getCollectionCars(db, autoPost.userId, autoPost.collectionName);
          
          if (!cars) {
            console.log(`Springer over autoPost ${autoPost.id} - ingen biler fundet`);
            continue;
          }

          // Generer posts baseret på antal biler
          const posts = await generatePosts(cars, autoPost);
          
          // Gem de planlagte posts
          await saveScheduledPosts(db, posts, autoPost.userId, autoPost);
          
          // Opdater timeline
          await updateTimeline(db, posts, autoPost.userId, autoPost);

        } catch (error) {
          console.error(`Fejl ved behandling af autoPost ${autoPost.id}:`, error);
          await logError(db, autoPost.userId, error, 'processAutoPost');
          continue;
        }
      }

      return null;
    } catch (error) {
      console.error('Kritisk fejl i processAutoPosts:', error);
      throw error;
    }
  });

// Funktion til at generere posts baseret på antal biler
async function generatePosts(cars, autoPost) {
  if (!cars?.length || !autoPost?.collectionName) {
    console.error('Ugyldige input parametre:', { 
      carsLength: cars?.length,
      collectionName: autoPost?.collectionName 
    });
    return [];
  }

  const posts = [];
  const shuffledCars = shuffleArray([...cars]);
  const shuffledDesigns = shuffleArray(autoPost.designUuids);
  const totalCars = shuffledCars.length;
  
  // Beregn antal karruseller og resterende biler
  const fullCarousels = Math.floor(totalCars / MAX_CARS_PER_CAROUSEL);
  const remainingCars = totalCars % MAX_CARS_PER_CAROUSEL;
  
  console.log(`
Behandler biler:
- Totalt antal biler: ${totalCars}
- Antal fulde karruseller (${MAX_CARS_PER_CAROUSEL} biler): ${fullCarousels}
- Resterende biler: ${remainingCars}
----------------------------------------`);

  let processedCars = 0;
  
  // Opret fulde karruseller (10 biler hver)
  for (let i = 0; i < fullCarousels; i++) {
    const startIndex = i * MAX_CARS_PER_CAROUSEL;
    const carouselCars = shuffledCars.slice(startIndex, startIndex + MAX_CARS_PER_CAROUSEL);
    processedCars += carouselCars.length;
    
    console.log(`Opretter karrusel ${i + 1} med ${carouselCars.length} biler`);
    
    const post = {
      type: 'karruselPost',
      cars: carouselCars,
      designUuid: shuffledDesigns[0],
      subject: getRandomSubject(autoPost.collectionName),
      channels: autoPost.channels,
      collectionName: autoPost.collectionName
    };
    
    posts.push(post);
  }

  // Håndter resterende biler
  if (remainingCars > 0) {
    const remainingCarouselCars = shuffledCars.slice(processedCars);
    console.log(`Håndterer ${remainingCarouselCars.length} resterende biler`);

    if (remainingCars >= MIN_CARS_FOR_CAROUSEL) {
      // Hvis der er nok til en karrusel (3 eller flere)
      console.log(`Opretter karrusel med ${remainingCarouselCars.length} resterende biler`);
      posts.push({
        type: 'karruselPost',
        cars: remainingCarouselCars,
        designUuid: shuffledDesigns[0],
        subject: getRandomSubject(autoPost.collectionName),
        channels: autoPost.channels,
        collectionName: autoPost.collectionName
      });
    } else {
      // Lav enkelte posts for de sidste biler (1-2 biler)
      console.log(`Opretter ${remainingCarouselCars.length} enkelte posts for resterende biler`);
      for (const car of remainingCarouselCars) {
        posts.push({
          type: 'singlePost',
          cars: [car],
          designUuid: shuffledDesigns[0],
          subject: getRandomSubject(autoPost.collectionName),
          channels: autoPost.channels,
          collectionName: autoPost.collectionName
        });
      }
    }
  }

  console.log(`
Opsummering af genererede posts:
- Antal posts genereret: ${posts.length}
- Totalt antal biler behandlet: ${totalCars}
----------------------------------------`);

  return assignScheduling(posts);
}

// Funktion til at tildele tidspunkter og datoer
function assignScheduling(posts) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  
  let currentDate = new Date(now);
  let postsForCurrentDate = 0;
  
  return posts.map(post => {
    // Hvis vi har nået max posts for dagen (2), gå til næste dag
    if (postsForCurrentDate >= 2) {
      currentDate = new Date(currentDate.setDate(currentDate.getDate() + 1));
      postsForCurrentDate = 0;
    }
    
    // Generer random tidspunkt mellem 9:00 og 22:30
    const hours = Math.floor(Math.random() * (22 - 9 + 1)) + 9;
    const minutes = Math.floor(Math.random() * 60);
    const scheduledDate = new Date(currentDate);
    scheduledDate.setHours(hours, minutes, 0, 0);
    
    postsForCurrentDate++;
    
    return {
      ...post,
      scheduledDate,
      status: 'pending'
    };
  });
}

// Ny hjælpefunktion til at formatere datetime
function formatDateTime(timestamp) {
  const date = new Date(timestamp);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} at ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

// Ny funktion til at konvertere Robolly URL til Firebase Storage URL
async function convertRobollyToFirebaseUrl(robollyUrl, userId, carId, designUuid) {
  if (!robollyUrl) return null;
  
  try {
    console.log('Konverterer Robolly URL til Firebase Storage URL:', robollyUrl);
    
    // Hent billedet fra Robolly
    const response = await fetch(robollyUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    // Konverter response til buffer
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Generer et unikt filnavn
    const fileName = `${carId}_${designUuid}_${Date.now()}.jpg`;
    const filePath = `makemoreimages/${userId}/${fileName}`;

    // Upload til Firebase Storage
    const bucket = admin.storage().bucket();
    const file = bucket.file(filePath);
    
    await file.save(buffer, {
      metadata: {
        contentType: 'image/jpeg',
        metadata: {
          firebaseStorageDownloadTokens: uuid()
        }
      }
    });

    // Generer public URL med token
    const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(filePath)}?alt=media`;
    
    console.log('Firebase Storage URL genereret:', publicUrl);
    return publicUrl;
  } catch (error) {
    console.error('Fejl ved konvertering til Firebase URL:', error);
    return robollyUrl;
  }
}

// Opdater buildChildStructure funktionen
async function buildChildStructure(car, postSubject, collectionName, designUuid, userId) {
  if (!car?.id || !designUuid || !userId) {
    console.error('Manglende påkrævede felter i buildChildStructure:', {
      carId: car?.id,
      designUuid,
      userId
    });
    return null;
  }

  try {
    const designType = designUuid.includes('video') ? 'video' : 'image';
    const robollyImage = designType === 'image' 
      ? await rateLimitedRobollyRequest(car, designUuid, userId)
      : null;

    return {
      caseId: car.id,
      headline: car.headline || `${car.fields?.Mærke || ''} ${car.fields?.Model || ''}`.trim(),
      emne: getRandomChildSubject(collectionName) || 'Se bilen',
      price: car.price || '',
      images: robollyImage ? [robollyImage] : [],
      caseUrl: car.url || '',
      designUuid,
      designType
    };
  } catch (error) {
    console.error('Fejl i buildChildStructure:', error);
    await logError(db, userId, error, 'buildChildStructure');
    return null;
  }
}

// Opdateret sendToLoadDataToFirestore funktion
async function sendToLoadDataToFirestore(postData) {
  const url = "https://us-central1-toft-d4f39.cloudfunctions.net/loadDataToFirestore";
  
  try {
    // Verificer at publishDate er korrekt
    if (!postData.publishDate || typeof postData.publishDate !== 'string') {
      console.error('Invalid publishDate:', postData.publishDate);
      throw new Error('Invalid publishDate');
    }

    // Opret mediaUrl array fra children's første billeder
    const mediaUrl = postData.children.map(child => 
      child.images && child.images.length > 0 ? child.images[0] : null
    ).filter(url => url !== null);

    // Opret dataToSend uden at bruge "items"
    const dataToSend = {
      [postData.publishDate]: [{
        facebook: postData.facebook,
        pageAccessToken: postData.pageAccessToken,
        subject: postData.subject,
        images: postData.images,
        text: postData.text,
        caseId: postData.caseId,
        emne: postData.emne,
        dealerId: postData.dealerId,
        id: postData.id,
        postInst: postData.postInst,
        postFB: postData.postFB,
        caseUrl: postData.caseUrl,
        adDays: postData.adDays,
        adSpend: postData.adSpend,
        plannedPost: postData.plannedPost,
        postingType: postData.postingType,
        isActive: postData.isActive,
        run: postData.run,
        publishDate: postData.publishDate,
        publishTime: postData.publishTime,
        children: postData.children,
        mediaUrl,
        type: postData.type,
        status: postData.status,
        createdAt: postData.createdAt,
        autoPostId: postData.autoPostId,
        collectionName: postData.collectionName,
        collection: "posts"
      }]
    };

    // Log den endelige data struktur før afsendelse
    console.log('Final data structure:', JSON.stringify(dataToSend, null, 2));

    // Fortsæt med fetch-anmodningen
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(dataToSend)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Server response:', errorText);
      throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
    }

    const responseData = await response.json();
    console.log('Response from server:', responseData);

    return true;

  } catch (error) {
    console.error('Fejl ved afsendelse til loadDataToFirestore:', {
      error: error.message,
      stack: error.stack,
      publishDate: postData.publishDate
    });
    return false;
  }
}

// Ny funktion til at behandle alle billeder først
async function processAllImages(cars, designUuid, userId) {
  console.log(`
Starter billedbehandling:
- Antal biler: ${cars.length}
- User ID: ${userId}
----------------------------------------`);
  
  const imageResults = new Map();
  const BATCH_SIZE = 3;
  const batches = [];
  let processedCount = 0;

  // Del biler op i batches
  for (let i = 0; i < cars.length; i += BATCH_SIZE) {
    batches.push(cars.slice(i, i + BATCH_SIZE));
  }

  for (const [index, batch] of batches.entries()) {
    console.log(`
Behandler batch ${index + 1}/${batches.length}:
- Biler i denne batch: ${batch.length}
- Behandlet indtil nu: ${processedCount}/${cars.length}
----------------------------------------`);
    
    try {
      const batchResults = await Promise.all(
        batch.map(async car => {
          try {
            const robollyUrl = await generateRobollyImage(car, designUuid);
            const firebaseUrl = await convertRobollyToFirebaseUrl(
              robollyUrl, 
              userId, 
              car.id, 
              designUuid
            );
            processedCount++;
            return { carId: car.id, url: firebaseUrl, success: true };
          } catch (error) {
            console.error(`Fejl ved behandling af bil ${car.id}:`, error);
            processedCount++;
            return { carId: car.id, error, success: false };
          }
        })
      );

      batchResults.forEach(result => {
        imageResults.set(result.carId, result);
      });

      // Vent mellem batches og log status
      if (index < batches.length - 1) {
        console.log(`Venter 2 sekunder før næste batch...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch (error) {
      console.error(`Fejl i batch ${index + 1}:`, error);
    }
  }

  console.log(`
Billedbehandling færdig:
- Succesfyldte: ${[...imageResults.values()].filter(r => r.success).length}
- Fejlede: ${[...imageResults.values()].filter(r => !r.success).length}
----------------------------------------`);

  return imageResults;
}

// Opdateret saveScheduledPosts funktion
async function saveScheduledPosts(db, posts, userId, autoPost) {
  if (!posts?.length || !userId || !autoPost?.id) {
    console.error('Ugyldige input parametre');
    return;
  }

  try {
    // Hent brugerdata først
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      throw new Error(`Bruger findes ikke: ${userId}`);
    }

    const userData = userDoc.data();
    if (!userData?.MetaSettings?.facebookPageId || !userData?.dealerId) {
      throw new Error('Manglende MetaSettings eller dealerId');
    }

    // Behandl alle billeder først
    const allCars = posts.flatMap(post => post.cars);
    const imageResults = await processAllImages(allCars, posts[0].designUuid, userId);

    // Nu hvor vi har alle billeder, kan vi bygge posts
    const BATCH_SIZE = 3;
    const batches = [];
    for (let i = 0; i < posts.length; i += BATCH_SIZE) {
      batches.push(posts.slice(i, i + BATCH_SIZE));
    }

    for (const [index, batchPosts] of batches.entries()) {
      const batch = db.batch();

      for (const post of batchPosts) {
        const postRef = db.collection('users')
          .doc(userId)
          .collection('scheduledPosts')
          .doc();

        // Byg children baseret på de behandlede billeder
        const validChildren = post.cars
          .map(car => {
            const imageResult = imageResults.get(car.id);
            if (!imageResult?.success) return null;

            return {
              caseId: car.id,
              headline: car.headline || `${car.fields?.Mærke || ''} ${car.fields?.Model || ''}`.trim(),
              images: [imageResult.url],
              caseUrl: car.url || ''
            };
          })
          .filter(child => child !== null);

        if (validChildren.length === 0) {
          console.error('Ingen gyldige children for post');
          continue;
        }

        const scheduledDate = new Date(post.scheduledDate);
        const transformedData = {
          facebook: userData.MetaSettings.facebookPageId,
          pageAccessToken: userData.MetaSettings.page_access_token || '',
          subject: post.subject,
          images: validChildren[0].images,
          text: generateSocialMediaText(
            post.type === 'singlePost' ? post.cars[0] : post.cars,
            {
              platform: post.channels.includes('facebook') ? 'facebook' : 'instagram',
              theme: post.subject,
              type: post.type
            }
          ).text,
          dealerId: userData.dealerId,
          id: userId,
          postInst: post.channels.includes('instagram'),
          postFB: post.channels.includes('facebook'),
          caseUrl: validChildren[0].caseUrl,
          plannedPost: true,
          postingType: determinePostingType(
            post.channels.includes('facebook'),
            post.channels.includes('instagram')
          ),
          isActive: true,
          run: false,
          publishDate: scheduledDate.toISOString().split('T')[0],
          publishTime: {
            HH: String(scheduledDate.getHours()).padStart(2, '0'),
            MM: String(scheduledDate.getMinutes()).padStart(2, '0')
          },
          children: validChildren,
          type: post.type,
          status: 'pending',
          createdAt: formatDateTime(new Date()),
          autoPostId: autoPost.id,
          collectionName: autoPost.collectionName,
          collection: 'posts'
        };

        batch.set(postRef, transformedData);
        
        try {
          await sendToLoadDataToFirestore(transformedData);
        } catch (error) {
          console.error('Fejl ved sending til loadDataToFirestore:', error);
        }
      }

      await batch.commit();
      
      if (index < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    return true;
  } catch (error) {
    console.error('Fejl i saveScheduledPosts:', error);
    throw error;
  }
}

// Funktion til at opdatere timeline
async function updateTimeline(db, posts, userId, autoPost) {
  const batch = db.batch();
  
  // Sikr at vi kun behandler det yderste niveau af posts
  if (!Array.isArray(posts)) {
    console.error('Posts skal være et array');
    return;
  }

  posts.forEach(post => {
    if (!Array.isArray(post.cars)) {
      console.error('post.cars skal være et array');
      return;
    }

    post.cars.forEach(car => {
      const timelineRef = db.collection('users')
        .doc(userId)
        .collection('timeline')
        .doc();
        
      // Sikr at vi har en valid collectionName
      const collectionName = post.collectionName || autoPost.collectionName || 'unknown';
      
      batch.set(timelineRef, {
        carId: car.id,
        headline: `${car.fields?.Mærke} ${car.fields?.Model}`,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: 'pending',
        postType: post.type,
        collectionName: collectionName,
        userId: userId,
        scheduledDate: post.scheduledDate
      });
    });
  });

  return batch.commit();
}

// Hjælpefunktion til at shuffle array
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Hjælpefunktion til at vælge random emne
function getRandomSubject(collectionName) {
  const subjects = subjectMapping[collectionName] || [];
  if (subjects.length === 0) return '';
  return subjects[Math.floor(Math.random() * subjects.length)];
}

// Opdateret hjælpefunktion til at vælge random emne for children
function getRandomChildSubject(collectionName) {
  const subjects = childrenSubjectMapping[collectionName] || [];
  if (subjects.length === 0) return '';
  return subjects[Math.floor(Math.random() * subjects.length)];
}

// Tilføj error logging
function logError(db, userId, error, context) {
  return db.collection('users')
    .doc(userId)
    .collection('errors')
    .add({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      error: error.message,
      context,
      stack: error.stack
    });
}

// Eksporter også hjælpefunktioner for testing
exports.helpers = {
  generatePosts,
  assignScheduling,
  saveScheduledPosts,
  updateTimeline,
  shuffleArray,
  getRandomSubject,
  getRandomChildSubject
};

function determinePostingType(postFB, postInst) {
  if (postFB && !postInst) return 'facebookLinkImage';
  if (postInst && !postFB) return 'InstagramPost';
  if (postFB && postInst) return 'facebookLinkImage,InstagramPost';
  return ''; // Hvis ingen platforme er valgt
}

// Tilføj denne nye hjælpefunktion
async function getCollectionCars(db, userId, collectionName) {
  try {
    if (!VALID_COLLECTIONS[collectionName]) {
      console.log(`
Collection Status:
- Ugyldig collection: ${collectionName}
- Tilladte collections: ${Object.keys(VALID_COLLECTIONS).join(', ')}
----------------------------------------`);
      return null;
    }

    const carsRef = db.collection('users')
      .doc(userId)
      .collection(collectionName);

    // Tjek først om collection eksisterer
    const collectionExists = await carsRef.limit(1).get();
    if (collectionExists.empty) {
      console.log(`
Collection Status:
- Collection: ${collectionName}
- Status: Tom eller eksisterer ikke
----------------------------------------`);
      return null;
    }

    // Hent alle biler fra collectionen
    const carsSnapshot = await carsRef.get();
    const cars = carsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    console.log(`
Collection Status:
- Collection: ${collectionName}
- Antal biler fundet: ${cars.length}
----------------------------------------`);

    return cars;

  } catch (error) {
    console.error(`Fejl ved hentning af biler fra ${collectionName}:`, error);
    return null;
  }
}

// Tilføj denne hjælpefunktion til logging
function logAutoPostStatus(totalCars, fullCarousels, remainingCars) {
  console.log(`
Auto Post Status:
- Totalt antal biler: ${totalCars}
- Antal fulde karruseller (${MAX_CARS_PER_CAROUSEL} biler): ${fullCarousels}
- Resterende biler: ${remainingCars}
----------------------------------------`);
}
