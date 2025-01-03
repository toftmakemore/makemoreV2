/**
 * @firestore;
 * Indexes needed:
 * - Collection: users/{userId}/filteredCars, Fields: lastUpdated DESC
 * - Collection: users/{userId}/excludeCars, Fields: lastUpdated DESC
 * - Collection: dealerCars, Fields: createdAt DESC
 */
const functions = require("firebase-functions");
const admin = require('firebase-admin');
const axios = require("axios");
const moment = require("moment-timezone");
const processText = require("./textProcessor");
const { uploadVideoToAdAccount, uploadImageToAdAccount } = require("./uploadProcessor");
const { createCarouselAdCreative, createAdCreative, getVideoThumbnail, handleCarouselImages } = require('./adCreative');
const { processFacebookReels } = require('./facebookReels');
const { processFacebookStory } = require('./facebookStory');
const { processInstagramReels } = require('./instagramReels');
const { prepareInstagramStoryVideo } = require('./instagramStoryVideo');
const { handleFacebookPageVideo } = require('./facebookPageVideo');
const { handleFacebookPageImage } = require('./facebookPageImage');
const { processPostText } = require('./openAi');
const cors = require('cors')({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
});
const Busboy = require('@fastify/busboy');
const { dagligOpdateringAfPageAccessTokens } = require('./FacebookPageAccessToken');
const { fetchAndStoreCars } = require('./fetchAndStoreCars');
const { simulateFetchAndStoreCars } = require('./simulateFetchAndStoreCars');
const { getValgtPaintId } = require('./googleVision');
const { getTemplate } = require('./getTemplateEditor'); // Importer getTemplate funktionen
const { scheduledFunction: processAutoPostsScheduled, helpers: autoPostHelpers } = require('./processAutoPosts');
const { 
  getDubAnalytics, 
  scheduledDubAnalytics, 
  triggerDubAnalytics,
  getStoredAnalytics 
} = require('./dubAnalytics');
const { generateVideo, checkVideoStatus } = require('./utils/videoGenerator');
const { fetchAndStoreCarsBiltorvet } = require('./fetchAndStoreCarsBiltorvet');
const { processDealerCars } = require('./processDealerCars');
const { processBiltorvetCollectionsOnTopic } = require('./carsLogicBiltorvet');
const { publishFacebookPost } = require('./publishFacebook');
const { publishInstagramPost } = require('./publishInstagram');
const { fetchAndStoreSocialAnalytics } = require('./socialAnalytics');
const { checkAndMoveDeletedCarPosts } = require('./postToDelete');
const { searchCarDealer } = require('./searchCarDealer');
const config = require('./config');
const { setupFirebaseHosting } = require('./domains/customDomain');
const CI_TOKEN = functions.config().ci?.token;
console.log('CI Token status ved opstart:', CI_TOKEN ? 'Sat' : 'Ikke sat');

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
  admin.initializeApp();
}

// Helper function for CORS and method check
const corsAndMethodCheck = (req, res, allowedMethod) => {
  res.set("Access-Control-Allow-Origin", "*");

  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", allowedMethod);
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Max-Age", "3600");
    res.status(204).send("");
    return true;
  }

  if (req.method !== allowedMethod) {
    res.status(405).send("Method Not Allowed");
    return true;
  }

  return false;
};

// Helper functions for file type checking
const getFileTypeFromUrl = (url) => {
  const urlPathMatch = url.match(/\.([^.?]+)($|\?)/);
  if (urlPathMatch && urlPathMatch[1]) {
    return urlPathMatch[1].toLowerCase();
  }
  const firebaseMatch = url.match(/o\/(.+?)\?/);
  if (firebaseMatch && firebaseMatch[1]) {
    const fileName = decodeURIComponent(firebaseMatch[1]);
    const fileExtension = fileName.split('.').pop().toLowerCase();
    return fileExtension;
  }
  return null;
};

const isImage = (url) => {
  const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];
  const fileType = getFileTypeFromUrl(url);
  return fileType && imageExtensions.includes(fileType);
};

const isVideo = (url) => {
  const videoExtensions = ['mp4', 'mov', 'avi', 'mkv', 'webm'];
  const fileType = getFileTypeFromUrl(url);
  return fileType && videoExtensions.includes(fileType);
};

// Function to create Instagram image container
const createImageContainerForInstagram = async (data, metaUserData) => {
  try {
    const { image_url, caption } = data;
    console.log(`Creating image container for Instagram from URL: ${image_url}`);

    // Validate metaUserData
    if (!metaUserData || !metaUserData.data) {
      throw new Error('Invalid metaUserData');
    }

    const instagram_id = metaUserData.data.instagram_id;
    const access_token = metaUserData.data.pageAccessToken;

    if (!instagram_id) {
      throw new Error('No Instagram Business Account ID found in metaUserData');
    }

    const containerUrl = `https://graph.facebook.com/${config.meta.version}/${instagram_id}/media`;
    const containerPayload = {
      image_url: image_url,
      caption: caption,
      access_token: access_token
    };
    
    const containerResponse = await axios.post(containerUrl, containerPayload);
    if (!containerResponse.data || !containerResponse.data.id) {
      throw new Error('Failed to create media container');
    }
    
    const containerId = containerResponse.data.id;
    console.log(`Instagram image container created with ID: ${containerId}`);
    return { data: { instagram_container_id: containerId } };
  } catch (error) {
    console.error(`Error creating image container for Instagram:`, error);
    return { error: `Failed to create image container for Instagram: ${error.message}` };
  }
};

// HTTP-funktion til at korrigere tekst
exports.correctText = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Metode ikke tilladt' });
    }

    try {
      const { text, emne, platform, messages } = req.body;

      const correctedText = await processPostText(
        text,
        emne,
        platform,
        [], // Vi bruger ikke længere files direkte her
        messages
      );

      res.status(200).json({ correctedText });
    } catch (error) {
      console.error('Fejl under tekstbehandling:', error);
      res.status(500).json({ error: 'En fejl opstod under tekstbehandling', details: error.message });
    }
  });
});

// Updated loadDataToFirestore function
exports.loadDataToFirestore = functions.https.onRequest(async (req, res) => {
  if (corsAndMethodCheck(req, res, "POST")) return;

  try {
    // Hvis vi leder efter et scheduled post
    if (req.body.type === "scheduledPost") {
      const userId = req.body.userId;
      const documentId = req.body.documentId;

      if (!userId || !documentId) {
        return res.status(400).json({ 
          error: "Both userId and documentId are required for scheduled posts" 
        });
      }

      // Hent dokumentet fra den specifikke brugers scheduledPosts collection
      const docRef = admin.firestore()
        .collection('users')
        .doc(userId)
        .collection('scheduledPosts')
        .doc(documentId);

      const docSnapshot = await docRef.get();

      if (docSnapshot.exists) {
        return res.status(200).json({
          id: docSnapshot.id,
          path: `users/${userId}/scheduledPosts/${documentId}`,
          data: docSnapshot.data()
        });
      } else {
        return res.status(404).json({ 
          error: "Scheduled post not found",
          path: `users/${userId}/scheduledPosts/${documentId}`
        });
      }
    }

    const documentId = req.body.documentId;
    
    if (documentId) {
      // Liste over collections vi vil søge i
      const collections = [
        'posts',
        'users',
        'scheduledPosts',
        'autoPosts',
        'dealerCars',
        // Tilføj andre collections efter behov
      ];

      // Søg gennem alle collections
      for (const collectionName of collections) {
        const docRef = admin.firestore().collection(collectionName).doc(documentId);
        const docSnapshot = await docRef.get();

        if (docSnapshot.exists) {
          return res.status(200).json({
            collection: collectionName,
            id: docSnapshot.id,
            data: docSnapshot.data()
          });
        }
      }

      // Hvis dokumentet ikke blev fundet i nogen collections
      return res.status(404).json({ 
        error: "Document not found in any collection",
        searchedCollections: collections
      });
    }

    // Hvis fetchAll er true, hent fra alle collections
    if (req.body.fetchAll) {
      const allData = {};
      const collections = [
        'posts',
        'users',
        'scheduledPosts',
        'autoPosts',
        'dealerCars'
      ];

      for (const collectionName of collections) {
        const snapshot = await admin.firestore().collection(collectionName).get();
        allData[collectionName] = [];
        
        snapshot.forEach(doc => {
          allData[collectionName].push({
            id: doc.id,
            ...doc.data()
          });
        });
      }

      return res.status(200).json({
        message: "Successfully fetched all documents",
        data: allData
      });
    }

    // Original upload logic
    const data = req.body;
    if (!data || Object.keys(data).length === 0) {
      return res.status(400).json({ error: "No data provided" });
    }

    const db = admin.firestore();
    const batch = db.batch();
    const formattedPosts = [];

    for (const [date, items] of Object.entries(data)) {
      console.log(`Processing items for date: ${date}`);
      for (const item of items) {
        console.log("Processing item:", JSON.stringify(item));
        const docRef = db.collection("posts").doc();
        
        // Create the post object with same defaults as processPostOnWrite
        const postObject = {
          ...item,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          publishDate: date,
          sent: false,
          postType: item.postInst ? 'instagram' : 'facebook',
          postStatus: 'pending',
          processingStatus: 'pending'
        };

        batch.set(docRef, postObject);
        formattedPosts.push({
          id: docRef.id,
          ...postObject
        });
      }
    }

    await batch.commit();
    console.log("Batch committed successfully");

    // Return the formatted posts data in the response
    return res.status(200).json({
      message: "Posts data successfully loaded into Firestore",
      posts: formattedPosts
    });

  } catch (error) {
    console.error("Error in loadDataToFirestore:", error);
    return res.status(500).json({
      error: "Operation failed",
      details: error.message
    });
  }
});

// Function to fetch and store MetaUserData
const fetchAndStoreMetaUserData = async (userId) => {
  console.log(`Henter metaUserData for bruger ${userId}`);
  try {
    const db = admin.firestore();
    const metaUserDataRef = db.collection('metaUserData').doc(userId);
    
    // Tjek om vi har data i metaUserData collection
    const metaUserDoc = await metaUserDataRef.get();
    
    if (metaUserDoc.exists) {
      console.log(`Eksisterende metaUserData fundet for bruger ${userId}`);
      return metaUserDoc.data();
    }
    
    throw new Error(`Ingen metaUserData fundet for bruger ${userId}`);
  } catch (error) {
    console.error(`Fejl ved hentning af metaUserData for bruger ${userId}:`, error);
    throw error;
  }
};

// Function to load Meta User Data into Firestore
exports.loadMetaUserDataToFirestore = functions.https.onRequest(async (req, res) => {
  if (corsAndMethodCheck(req, res, "POST")) return;

  try {
    const data = req.body;

    if (!data || !data.key || !data.data) {
      return res.status(400).json({ error: "Invalid metaUserData format" });
    }

    const db = admin.firestore();
    await db.collection("metaUserData").doc(data.key).set({
      key: data.key,
      data: {
        facebook_id: data.data.facebook_id,
        instagram_id: data.data.instagram_id,
        pageAccessToken: data.data.pageAccessToken
      },
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.status(200).json({ message: "MetaUserData successfully loaded into Firestore" });

  } catch (error) {
    console.error("Error loading metaUserData to Firestore:", error);
    return res.status(500).json({ error: "Failed to load metaUserData to Firestore" });
  }
});

// Process posts when a document is written in Firestore
exports.processPostOnWrite = functions.firestore
  .document('posts/{postId}')
  .onWrite(async (change, context) => {
    const postId = context.params.postId;
    const newData = change.after.exists ? change.after.data() : null;
    const oldData = change.before.exists ? change.before.data() : null;

    console.log(`Processing started for post ${postId}`);

    if (!newData) {
      console.log(`Post ${postId} was deleted. No processing needed.`);
      return null;
    }

    // Check if the data has actually changed to avoid unnecessary processing
    if (oldData && JSON.stringify(oldData) === JSON.stringify(newData)) {
      console.log(`No changes detected for post ${postId}. Skipping processing.`);
      return null;
    }

    // Hvis dokumentet er nyt (fra addDoc) eller mangler processingStatus, sæt det til 'pending'
    if (!newData.processingStatus) {
      console.log(`New document detected. Setting initial processing status for ${postId}`);
      await change.after.ref.update({
        processingStatus: 'pending',
        postStatus: 'pending',
        postType: newData.postInst ? 'instagram' : 'facebook',
        sent: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return null; // Returnér her for at lade den næste trigger håndtere processingen
    }

    // Check if the post has already been processed or is currently being processed
    if (newData.processingStatus === 'completed' || newData.processingStatus === 'processing' || newData.creative_id) {
      console.log(`Post ${postId} has already been processed or is currently being processed. Skipping.`);
      return null;
    }

    // Only process if the status is 'pending'
    if (newData.processingStatus === 'pending') {
      console.log(`Processing post ${postId}`);

      try {
        // Set status to 'processing' to prevent concurrent processing
        await change.after.ref.update({ 
          processingStatus: 'processing',
          processingStartTime: admin.firestore.FieldValue.serverTimestamp()
        });

        const { postFB, postInst, postingType, id } = newData;
        console.log(`Post ${postId} configuration: postFB=${postFB}, postInst=${postInst}, postingType=${postingType}`);

        // Hent MetaUserData baseret på id
        const metaUserData = await fetchAndStoreMetaUserData(id);
        if (!metaUserData || !metaUserData.data.pageAccessToken) {
          throw new Error(`MetaUserData eller pageAccessToken ikke fundet for id: ${id}`);
        }

        let result;
        if (postFB && !postInst) {
          // Facebook post typer
          if (newData.type === 'karruselPost') {
            console.log(`Håndterer Facebook karruselpost for ${postId}`);
            try {
              // Først process teksten
              const processedText = await processText({
                text: newData.text,
                longUrl: newData.caseUrl,
                userId: newData.id
              });

              // Opdater teksten i newData
              newData.text = processedText.newText;

              // Opret karrusel creative direkte med post data
              const creativeId = await createCarouselAdCreative(
                newData,
                metaUserData.data,
                metaUserData.data.pageAccessToken
              );

              // Opdater dokumentet med creative_id
              await admin.firestore().collection('posts').doc(postId).update({
                creative_id: creativeId,
                adCreativeStatus: 'success',
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
              });

              return { creativeId };
            } catch (error) {
              console.error(`Fejl ved håndtering af karrusel-opslag:`, error);
              
              // Opdater dokumentet med fejl
              await admin.firestore().collection('posts').doc(postId).update({
                adCreativeError: error.message,
                adCreativeStatus: 'failed',
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
              });
              
              throw error;
            }
          } else if (['facebookLinkImage', 'facebookVideoLink', 'facebookCarousel', 'imageLink', 'videoLink'].includes(postingType)) {
            result = await handleFacebookPost(newData, postId, metaUserData, false);
          } else if (postingType === 'FacebookReels') {
            result = await handleFacebookReels(newData, postId, metaUserData.data);
          } else if (postingType === 'FacebookStory') {
            result = await handleFacebookStory(newData, postId, metaUserData.data);
          } else if (postingType === 'facebookPageVideo') {
            await processFacebookPageVideoPost(newData, postId, metaUserData.data);
          } else if (postingType === 'facebookPageImage') {
            await processFacebookPageImagePost(newData, postId, metaUserData.data);
          } else {
            throw new Error(`Unsupported Facebook posting type: ${postingType}`);
          }
        } else if (!postFB && postInst) {
          // Instagram post typer
          const videoFormats = ['mp4', 'mov', 'avi', 'mkv', 'webm'];
          const isVideoFile = newData.images && newData.images[0] && 
            videoFormats.some(format => newData.images[0].toLowerCase().includes(format));

          // Ret denne del for at håndtere InstagramPost korrekt
          if (postingType === 'InstagramPost') {
            result = await handleInstagramPost(newData, postId, metaUserData);
          } else if (isVideoFile || ['instagramVideo', 'instagramReels'].includes(postingType)) {
            result = await handleInstagramReels(newData, postId, metaUserData.data);
          } else if (['instagramCarousel'].includes(postingType)) {
            result = await handleInstagramPost(newData, postId, metaUserData.data);
          } else if (postingType === 'instagramStoryVideo') {
            result = await handleInstagramStoryVideo(newData, postId, metaUserData.data);
          } else {
            throw new Error(`Unsupported Instagram posting type: ${postingType}`);
          }
        } else {
          throw new Error(`Invalid post configuration: postFB=${postFB}, postInst=${postInst}, postingType=${postingType}`);
        }

        // Mark post as completed
        await change.after.ref.update({
          processingStatus: 'completed',
          postStatus: postInst ? 'mediaContainersCreated' : 'adCreativePrepared',
          processingEndTime: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`Successfully processed post ${postId}`);
      } catch (error) {
        console.error(`Error processing post ${postId}:`, error);
        
        // Update the document with the error status, but don't try to process again
        await change.after.ref.update({
          processingStatus: 'error',
          processingError: error.message,
          processingEndTime: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    } else {
      console.log(`No processing needed for post ${postId}`);
    }

    return null;
  });

// Function to handleFacebookPost
async function handleFacebookPost(postData, postId, metaUserData) {
  console.log(`Processing Facebook post ${postId}`);

  try {
    // Process text and create shortlink
    const processedText = await processText({
      text: postData.text,
      longUrl: postData.caseUrl,
      userId: postData.id
    });

    // Update the post with processed text
    await admin.firestore().collection('posts').doc(postId).update({
      text: processedText.newText,
      shortUrl: processedText.newShortUrl
    });

    const access_token = metaUserData.data.pageAccessToken;
    if (!access_token) {
      throw new Error('Page access token not found in metaUserData');
    }

    let creativeId;
    let thumbnailUrl;
    let videoId;

    // Håndter forskellige post typer
    switch (postData.postingType) {
      case 'facebookVideoLink':
      case 'videoLink':
        // Upload video hvis der ikke allerede er et videoId
        videoId = postData.videoId;
        
        if (!videoId) {
          const videoUrl = postData.images && postData.images[0];
          if (!videoUrl || !videoUrl.endsWith('.mp4')) {
            throw new Error('Invalid video URL or format');
          }

          const uploadResult = await uploadVideoToAdAccount({
            name: postData.subject,
            title: postData.subject,
            file_url: videoUrl
          }, postData.id);

          if (uploadResult.error) {
            throw new Error(uploadResult.error);
          }

          videoId = uploadResult.data;
          
          // Opdater dokument med nyt videoId
          await admin.firestore().collection('posts').doc(postId).update({
            videoId: videoId
          });
        }

        if (videoId) {
          const thumbnailUrl = await getVideoThumbnail(videoId, access_token);
          
          const adCreativeData = {
            ...postData,
            videoId,
            facebook_id: metaUserData.data.facebook_id,
            message: processedText.newText,
            pageAccessToken: metaUserData.data.pageAccessToken,
            image_url: thumbnailUrl
          };

          console.log('[INFO] Opretter ad creative', { data: adCreativeData });
          const creativeResult = await createAdCreative(adCreativeData);
          
          // Log det fulde response for debugging
          console.log('[DEBUG] Creative Result:', creativeResult);
          
          // Håndter forskellige response formater
          let finalCreativeId;
          if (typeof creativeResult === 'string' || typeof creativeResult === 'number') {
            finalCreativeId = creativeResult.toString();
          } else if (creativeResult?.id) {
            finalCreativeId = creativeResult.id;
          } else if (creativeResult?.data?.id) {
            finalCreativeId = creativeResult.data.id;
          }
          
          if (finalCreativeId) {
            try {
              await updatePostWithCreativeId(postId, finalCreativeId);
              await admin.firestore().collection('posts').doc(postId).update({
                adCreativeStatus: 'success',
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
              });
              console.log(`[SUCCESS] Creative ID ${finalCreativeId} gemt for post ${postId}`);
            } catch (error) {
              console.error('[ERROR] Fejl ved opdatering af post med creative_id:', error);
              throw error;
            }
          } else {
            console.error('[ERROR] Intet creative_id modtaget fra createAdCreative', creativeResult);
            throw new Error('Intet creative_id modtaget fra createAdCreative');
          }
        }
        break;

      case 'facebookLinkImage':
      case 'imageLink':
        // Tjek om det er et karrusel-opslag
        if (postData.mediaUrl && postData.mediaUrl.length > 1) {
          console.log('Håndterer Facebook karruselpost for', postId);
          const childImageHashes = await handleCarouselImages(postData, postId);
          
          creativeId = await createCarouselAdCreative({
            ...postData,
            childImageHashes,
            message: processedText.newText,
            facebook_id: metaUserData.data.facebook_id,
            pageAccessToken: access_token
          }, metaUserData.data, access_token);
        } else {
          // Eksisterende logik for enkelte billeder
          const imageResult = await uploadImageToAdAccount({
            image_url: postData.images[0]
          }, postData.id);

          if (imageResult.error) {
            throw new Error(imageResult.error);
          }

          creativeId = await createAdCreative({
            ...postData,
            imageHash: imageResult.data.image_hash,
            facebook_id: metaUserData.data.facebook_id,
            message: processedText.newText,
            pageAccessToken: access_token
          });
        }

        await admin.firestore().collection('posts').doc(postId).update({
          creative_id: creativeId,
          adCreativeStatus: 'success',
          lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        });
        break;

      // ... andre cases forbliver uændrede ...
    }

    return { creativeId };

  } catch (error) {
    console.error(`Error processing Facebook post ${postId}:`, error);
    
    await admin.firestore().collection('posts').doc(postId).update({
      adCreativeError: error.message,
      adCreativeStatus: 'failed',
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    });
    
    throw error;
  }
}

async function handleFacebookImagePost(postData, postId, access_token) {
  console.log('Processing Facebook image post');

  const mediaUrl = postData.images[0];
  if (!isImage(mediaUrl)) {
    throw new Error(`Invalid image URL: ${mediaUrl}`);
  }

  const imageResult = await uploadImageToAdAccount({
    image_url: mediaUrl,
    pageAccessToken: access_token
  }, postData.id);

  if (imageResult.error) {
    throw new Error(`Failed to upload image: ${imageResult.error}`);
  }

  const creativeId = await createAdCreative({
    ...postData,
    imageHash: imageResult.data.image_hash,
    facebook_id: postData.facebook,
    message: postData.text
  }, postData, access_token);

  await updatePostWithCreativeId(postId, creativeId);
  return { creativeId };
}

// New handleInstagramPost
async function handleInstagramPost(postData, postId, metaUserData) {
  console.log(`Processing Instagram post ${postId}`);

  try {
    // Sikrer at vi har et userId og metaUserData
    if (!postData.id) {
      throw new Error('User ID (id) mangler i postData');
    }

    if (!metaUserData) {
      throw new Error('metaUserData mangler');
    }

    // Process text with userId
    const processedText = await processText({
      text: postData.text,
      longUrl: postData.caseUrl,
      userId: postData.id
    });

    const instagramContainerIds = [];
    
    if (postData.children && postData.children.length > 0) {
      for (const child of postData.children) {
        if (child.images && child.images.length > 0) {
          for (let i = 0; i < child.images.length; i++) {
            const imageUrl = child.images[i];
            console.log(`Processing image ${i + 1}: ${imageUrl}`);

            // Send metaUserData direkte til createImageContainerForInstagram
            const result = await createImageContainerForInstagram({
              image_url: imageUrl,
              caption: i === 0 ? processedText.newText : ''
            }, metaUserData); // Ændret fra postData.id til metaUserData

            if (result.error) {
              console.error(`Error processing image ${imageUrl}:`, result.error);
              continue;
            }

            instagramContainerIds.push(result.data.instagram_container_id);

            if (instagramContainerIds.length >= 10) {
              console.log('Reached maximum of 10 media items for Instagram post. Stopping processing.');
              break;
            }

            await new Promise(resolve => setTimeout(resolve, 2000));
          }
          
          if (instagramContainerIds.length >= 10) {
            break;
          }
        }
      }

      // Opdater dokumentet med behandlet tekst og container IDs
      await admin.firestore().collection('posts').doc(postId).update({
        text: processedText.newText,
        instagramContainerIds: instagramContainerIds,
        postStatus: 'mediaContainersCreated',
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log(`All images processed and document updated. Container IDs: ${instagramContainerIds.join(', ')}`);
    } else {
      throw new Error('No children found with images for Instagram post');
    }

    return { instagramContainerIds };

  } catch (error) {
    console.error(`Error processing Instagram post ${postId}:`, error);
    await admin.firestore().collection('posts').doc(postId).update({
      postStatus: 'containerCreationFailed',
      containerCreationError: error.message,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    });
    throw error;
  }
}

// Function to handle Facebook Reels
async function handleFacebookReels(postData, postId, metaSettings) {
  console.log(`Handling Facebook Reels post ${postId}`);
  await processFacebookReels(postData, postId, metaSettings);
  console.log(`Facebook Reels post ${postId} processed successfully`);
}

// Function to handle Facebook Story
async function handleFacebookStory(postData, postId, metaSettings) {
  console.log(`Handling Facebook Story post ${postId}`);
  await processFacebookStory(postData, postId, metaSettings);
  console.log(`Facebook Story post ${postId} processed successfully`);
}

// Function to handle Instagram Reels/Video
async function handleInstagramReels(postData, postId, metaSettings) {
  console.log(`Handling Instagram Reels/Video post ${postId}`);
  await processInstagramReels(postData, postId, metaSettings);
  console.log(`Instagram Reels/Video post ${postId} processed successfully`);
}

// Function to handle Instagram Story Video
async function handleInstagramStoryVideo(postData, postId, metaSettings) {
  console.log(`Handling Instagram Story Video post ${postId}`);
  await prepareInstagramStoryVideo(postData, postId, metaSettings);
  console.log(`Instagram Story Video post ${postId} processed successfully`);
}

// Function to handle Facebook Page Video Post
async function processFacebookPageVideoPost(postData, postId, metaSettings) {
  console.log(`Handling Facebook Page Video post ${postId}`);
  await handleFacebookPageVideo(postData, postId, metaSettings);
  console.log(`Facebook Page Video post ${postId} processed successfully`);
}

// Function to handle Facebook Page Image Post
async function processFacebookPageImagePost(postData, postId, metaSettings) {
  console.log(`Handling Facebook Page Image post ${postId}`);
  await handleFacebookPageImage(postData, postId, metaSettings);
  console.log(`Facebook Page Image post ${postId} processed successfully`);
}

// Process posts when a document is written in Firestore
exports.checkAndPublishPosts = functions.pubsub
  .schedule('every 1 minutes')
  .timeZone('Europe/Copenhagen')
  .onRun(async () => {
    const db = admin.firestore();
    const now = moment().tz("Europe/Copenhagen");
    const currentDate = now.format("YYYY-MM-DD");
    const currentHour = now.format("HH");
    const currentMinute = now.format("mm");

    console.log(`Checking posts for publication at ${currentDate} ${currentHour}:${currentMinute}`);

    try {
      const postsToPublish = await db.collection("posts")
        .where("publishDate", "==", currentDate)
        .where("publishTime.HH", "==", currentHour)
        .where("publishTime.MM", "==", currentMinute)
        .where("sent", "==", false)
        .get();

      if (postsToPublish.empty) {
        console.log("No posts to publish at this time");
        return null;
      }

      for (const doc of postsToPublish.docs) {
        const postData = doc.data();
        const postId = doc.id;

        try {
          let publishResult = null;

          // Facebook Post
          if (postData.postFB === true) {
            console.log(`Attempting to publish Facebook post ${postId}`);
            if (!postData.creative_id) {
              throw new Error('Facebook post mangler creative_id');
            }

            publishResult = await publishFacebookPost({
              pageAccessToken: postData.pageAccessToken,
              creative_id: postData.creative_id,
              videoId: postData.videoId
            });
          }

          // Instagram Post
          if (postData.postInst === true) {
            console.log(`Attempting to publish Instagram post ${postId}`);
            
            const mediaIdToPublish = postData.instagramMediaId || 
              (postData.instagramContainerIds && postData.instagramContainerIds[0]);

            if (!mediaIdToPublish) {
              throw new Error('Instagram post mangler instagramMediaId');
            }

            publishResult = await publishInstagramPost({
              instagram_id: postData.instagram,
              pageAccessToken: postData.pageAccessToken,
              instagramMediaId: mediaIdToPublish
            });
          }

          if (publishResult) {
            // Gem i postSend collection
            await db.collection("postSend").add({
              ...postData,
              publishedAt: admin.firestore.FieldValue.serverTimestamp(),
              originalPostId: postId,
              publishStatus: 'success',
              // Platform-specifik data
              ...(postData.postFB && {
                facebookPostId: publishResult.postId,
                facebookLink: `https://www.facebook.com/${publishResult.pageId}_${publishResult.storyId}`,
                isVideo: publishResult.isVideo
              }),
              ...(postData.postInst && {
                instagramPostId: publishResult.result.published_id,
                instagramLink: publishResult.result.permalink,
                instagramMediaUrl: publishResult.result.media_url,
                isVideo: publishResult.result.isVideo
              })
            });

            // Slet det oprindelige dokument fra posts collection
            await db.collection("posts").doc(postId).delete();
            console.log(`Successfully deleted original post ${postId} after moving to postSend`);
          }

        } catch (error) {
          console.error(`Error publishing post ${postId}:`, error);
          
          await db.collection("posts").doc(postId).update({
            publishError: error.message,
            publishErrorTimestamp: admin.firestore.FieldValue.serverTimestamp(),
            publishStatus: 'error'
          });
        }
      }

      return null;
    } catch (error) {
      console.error("Error in checkAndPublishPosts:", error);
      return null;
    }
  });

// Function to clean up the postSend collection every 14 days
exports.cleanupPostSend = functions.pubsub
  .schedule("every 24 hours")
  .timeZone("Europe/Copenhagen")
  .onRun(async () => {
    const db = admin.firestore();
    const fourteenDaysAgo = admin.firestore.Timestamp.fromDate(
      moment().tz("Europe/Copenhagen").subtract(14, "days").toDate()
    );

    try {
      const snapshot = await db.collection("postSend")
        .where("sentAt", "<", fourteenDaysAgo)
        .get();

      if (snapshot.empty) {
        console.log("No sent posts older than 14 days to delete.");
        return null;
      }

      const batch = db.batch();
      snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });

      await batch.commit();
      console.log(`Deleted ${snapshot.size} sent posts older than 14 days.`);

      return null;

    } catch (error) {
      console.error("Error cleaning up postSend collection:", error);
      return null;
    }
  });

// Function to add user data to Firestore (Create User)
exports.addUserDataToFirestore = functions.https.onRequest(async (req, res) => {
  if (corsAndMethodCheck(req, res, "POST")) return;

  try {
    const { email, password } = req.body;

    if (!email || !password) {
      throw new Error("Email and Password Required");
    }

    const userRecord = await admin.auth().createUser({
      email: email,
      password: password
    });

    return res.status(200).json({
      message: "User successfully created",
      data: userRecord
    });

  } catch (error) {
    console.error("Error creating user:", error);
    return res.status(500).json({
      error: "Failed to create user",
      details: error.message
    });
  }
});

// Helper function to update post with creative ID
async function updatePostWithCreativeId(postId, creativeId) {
  try {
    await admin.firestore().collection('posts').doc(postId).update({
      creative_id: creativeId,
      postStatus: 'adCreativePrepared'
    });
    console.log(`Post ${postId} updated with creative ID: ${creativeId}`);
  } catch (error) {
    console.error(`Error updating post ${postId} with creative ID:`, error);
    throw error;
  }
}

// Helper function to check if a car matches filter criteria
const carMatchesFilter = (car, filterCriteria) => {
  if (!filterCriteria) return false;

  // Brand check
  if (filterCriteria.brands?.length && !filterCriteria.brands.includes(car.fields?.Mærke)) {
    return false;
  }

  // Fuel type check
  if (filterCriteria.fuelTypes?.length && !filterCriteria.fuelTypes.includes(car.fields?.Brændstoftype)) {
    return false;
  }

  // Category check
  if (filterCriteria.categories?.length && !filterCriteria.categories.includes(car.categoryName)) {
    return false;
  }

  // Year range check
  const carYear = parseInt(car.fields?.Årgang);
  if (filterCriteria.yearRange?.from && carYear < filterCriteria.yearRange.from) {
    return false;
  }
  if (filterCriteria.yearRange?.to && carYear > filterCriteria.yearRange.to) {
    return false;
  }

  // Price range check
  const carPrice = car.priceInt;
  if (filterCriteria.priceRange?.from && carPrice < filterCriteria.priceRange.from) {
    return false;
  }
  if (filterCriteria.priceRange?.to && carPrice > filterCriteria.priceRange.to) {
    return false;
  }

  return true;
};

// Helper function to update filters with new car
const updateFiltersWithNewCar = async (db, dealerId, newCar) => {
  try {
    const usersSnapshot = await db.collection('users')
      .where('client', '!=', 'biltorvet') // Ignorer Biltorvet brugere
      .get();
    
    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      
      // Tjek filteredCars collection
      const filteredCarsSnapshot = await db.collection('users').doc(userId)
        .collection('filteredCars').get();
      
      // Tjek excludeCars collection
      const excludeCarsSnapshot = await db.collection('users').doc(userId)
        .collection('excludeCars').get();
      
      // Opdater filtre
      for (const filterDoc of filteredCarsSnapshot.docs) {
        const filter = filterDoc.data();
        if (carMatchesFilter(newCar, filter.criteria)) {
          const carData = {
            id: newCar.id,
            fields: newCar.fields,
            headline: newCar.headline,
            description: newCar.description,
            attachments: newCar.attachments,
            priceInt: newCar.priceInt,
            categoryName: newCar.categoryName,
            dealerId: dealerId,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          };
          
          await db.collection('users').doc(userId)
            .collection('filteredCars').doc(filterDoc.id)
            .update({
              cars: admin.firestore.FieldValue.arrayUnion(carData)
            });
          
          console.log(`Bil ${newCar.id} tilføjet til filter ${filterDoc.id} for bruger ${userId}`);
        }
      }
      
      // Opdater eksklusioner
      for (const excludeDoc of excludeCarsSnapshot.docs) {
        const exclude = excludeDoc.data();
        if (carMatchesFilter(newCar, exclude.criteria)) {
          const carData = {
            id: newCar.id,
            fields: newCar.fields,
            headline: newCar.headline,
            description: newCar.description,
            attachments: newCar.attachments,
            priceInt: newCar.priceInt,
            categoryName: newCar.categoryName,
            dealerId: dealerId,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          };
          
          await db.collection('users').doc(userId)
            .collection('excludeCars').doc(excludeDoc.id)
            .update({
              cars: admin.firestore.FieldValue.arrayUnion(carData)
            });
          
          console.log(`Bil ${newCar.id} tilføjet til eksklusion ${excludeDoc.id} for bruger ${userId}`);
        }
      }
    }
  } catch (error) {
    console.error('Fejl i updateFiltersWithNewCar:', error);
    throw error;
  }
};

// Definer getPaintId funktionen direkte som en export
exports.getPaintId = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Metode ikke tilladt' });
    }

    try {
      const carData = req.body;

      if (!carData || !carData.fields || !carData.attachments) {
        return res.status(400).json({
          error: "Ugyldig bil data. Skal indeholde fields og attachments objekter"
        });
      }

      const paintId = await getValgtPaintId(carData);

      if (paintId) {
        return res.status(200).json({
          success: true,
          paintId: paintId,
          message: "PaintId fundet succesfuldt"
        });
      } else {
        return res.status(404).json({
          success: false,
          message: "Kunne ikke finde et passende paintId"
        });
      }

    } catch (error) {
      console.error("Fejl ved behandling af paintId anmodning:", error);
      return res.status(500).json({
        success: false,
        error: "Intern serverfejl ved behandling af paintId",
        details: error.message
      });
    }
  });
});

// HTTP-funktion til at hente template
exports.getTemplateEditor = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Metode ikke tilladt' });
    }

    const templateId = req.query.id; // Forvent at templateId kommer som en query parameter

    try {
      const templateData = await getTemplate(templateId);
      res.status(200).json(templateData);
    } catch (error) {
      console.error('Fejl ved hentning af template:', error);
      res.status(500).json({ error: 'En fejl opstod ved hentning af template', details: error.message });
    }
  });
});
// Tilføj denne funktion før module.exports
function matchesFilterCriteria(car, filterCriteria) {
  if (!filterCriteria) return false;

  // Brand check
  if (filterCriteria.brands?.length && !filterCriteria.brands.includes(car.fields?.Mærke)) {
    return false;
  }

  // Fuel type check
  if (filterCriteria.fuelTypes?.length && !filterCriteria.fuelTypes.includes(car.fields?.Brændstoftype)) {
    return false;
  }

  // Category check
  if (filterCriteria.categories?.length && !filterCriteria.categories.includes(car.categoryName)) {
    return false;
  }

  // Year range check
  const carYear = parseInt(car.fields?.Årgang);
  if (filterCriteria.yearRange?.from && carYear < filterCriteria.yearRange.from) {
    return false;
  }
  if (filterCriteria.yearRange?.to && carYear > filterCriteria.yearRange.to) {
    return false;
  }

  // Price range check
  const carPrice = car.priceInt;
  if (filterCriteria.priceRange?.from && carPrice < filterCriteria.priceRange.from) {
    return false;
  }
  if (filterCriteria.priceRange?.to && carPrice > filterCriteria.priceRange.to) {
    return false;
  }

  return true;
}

// Definerer Cloud Function
exports.generateVideo = functions.https.onCall(async (data, context) => {
  try {
    // Tilføj validering af input data
    if (!data.car || !data.car.attachments) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Ugyldig bil data: Mangler påkrævede felter'
      );
    }

    const result = await generateVideo(data.car, data.designConfig);
    return result;
  } catch (error) {
    console.error('Fejl i generateVideo function:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// Tilføj generateVideoApi endpoint
exports.generateVideoApi = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      // Validér HTTP metode
      if (req.method !== 'POST') {
        return res.status(405).json({
          success: false,
          error: 'Metode ikke tilladt'
        });
      }

      // Log request data
      console.log('Modtaget request:', {
        body: req.body,
        headers: req.headers
      });

      const { car, designConfig } = req.body;

      // Validér input
      if (!car || !car.attachments) {
        return res.status(400).json({
          success: false,
          error: 'Mangler påkrævede bil data'
        });
      }

      const result = await generateVideo(car, designConfig);
      
      return res.status(200).json({
        success: true,
        data: result
      });

    } catch (error) {
      console.error('Fejl i generateVideoApi:', {
        error: error.message,
        stack: error.stack,
        body: req.body
      });

      return res.status(500).json({
        success: false,
        error: {
          message: error.message,
          type: error.constructor.name,
          details: error.stack
        }
      });
    }
  });
});

// Tilføj checkVideoStatus endpoint
exports.checkVideoStatus = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== 'GET') {
        return res.status(405).json({ 
          success: false, 
          error: 'Metode ikke tilladt' 
        });
      }

      const { renderId } = req.query;
      if (!renderId) {
        return res.status(400).json({
          success: false,
          error: 'Mangler render ID'
        });
      }

      const result = await checkVideoStatus(renderId);
      
      return res.status(200).json({
        success: true,
        data: result
      });

    } catch (error) {
      console.error('Fejl i checkVideoStatus:', error);
      return res.status(500).json({
        success: false,
        error: {
          message: error.message,
          type: error.constructor.name,
          details: error.stack
        }
      });
    }
  });
});

// Tilføj toggleUserStatus Cloud Function
exports.toggleUserStatus = functions.https.onRequest(async (req, res) => {
  // Tilføj CORS headers
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  // Håndter OPTIONS request for CORS preflight
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  try {
    const { uid, disabled } = req.body;
    
    if (!uid) {
      throw new Error('Bruger ID mangler');
    }

    // Opdater bruger i Authentication
    await admin.auth().updateUser(uid, {
      disabled: disabled
    });

    // Opdater bruger i Firestore
    const userRef = admin.firestore().collection('users').doc(uid);
    await userRef.update({
      disabled: disabled,
      active: !disabled,
      lastModified: admin.firestore.FieldValue.serverTimestamp()
    });

    // Log handlingen
    await admin.firestore().collection('userStatusLogs').add({
      userId: uid,
      action: disabled ? 'disabled' : 'enabled',
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(200).json({
      success: true,
      message: `Bruger ${disabled ? 'deaktiveret' : 'aktiveret'} succesfuldt`
    });

  } catch (error) {
    console.error('Fejl ved ændring af brugerstatus:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Tilføj HTTP endpoint for getSocialAnalytics
exports.getSocialAnalytics = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Metode ikke tilladt' });
    }

    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ error: 'userId er påkrævet' });
    }

    try {
      const analytics = await fetchAndStoreSocialAnalytics(userId);
      res.status(200).json({ 
        success: true, 
        data: analytics 
      });
    } catch (error) {
      console.error('Fejl ved hentning af analytics:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
});

// Planlagt funktion til at køre getSocialAnalytics hver morgen kl. 06.00
exports.scheduledGetSocialAnalytics = functions.pubsub
  .schedule('0 6 * * *') // Cron job for hver dag kl. 06.00
  .timeZone('Europe/Copenhagen') // Sæt tidszonen til København
  .onRun(async (context) => {
    console.log('Kører scheduledGetSocialAnalytics');

    try {
      // Her kan du definere logikken for at hente bruger-ID'er
      const userIds = await getAllUserIds(); // Antag en funktion, der henter alle bruger-ID'er

      for (const userId of userIds) {
        try {
          const analytics = await fetchAndStoreSocialAnalytics(userId);
          console.log(`Analytics hentet for bruger ${userId}:`, analytics);
        } catch (error) {
          console.error(`Fejl ved hentning af analytics for bruger ${userId}:`, error);
        }
      }
    } catch (error) {
      console.error('Fejl i scheduledGetSocialAnalytics:', error);
    }
  });

// HTTP-funktion til at hente specifik bil data
exports.getSpecificCarData = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    // Valider HTTP metode
    if (req.method !== 'GET') {
      return res.status(405).json({
        success: false,
        error: 'Metode ikke tilladt'
      });
    }

    try {
      // Hent userId og carId fra query parameters
      const { userId, carId } = req.query;

      // Valider input parametre
      if (!userId || !carId) {
        return res.status(400).json({
          success: false,
          error: 'Både userId og carId er påkrævede parametre'
        });
      }

      // Hent bil data fra Firestore
      const carDoc = await admin.firestore()
        .collection('users')
        .doc(userId)
        .collection('userCars')
        .doc(carId)
        .get();

      // Tjek om bilen blev fundet
      if (!carDoc.exists) {
        return res.status(404).json({
          success: false,
          error: 'Bilen blev ikke fundet'
        });
      }

      // Return bil data
      return res.status(200).json({
        success: true,
        data: {
          id: carDoc.id,
          ...carDoc.data()
        }
      });

    } catch (error) {
      console.error('Fejl ved hentning af bil data:', error);
      return res.status(500).json({
        success: false,
        error: 'Der opstod en fejl ved hentning af bil data',
        details: error.message
      });
    }
  });
});

// Cloud Function til at slette bruger
exports.deleteUser = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    // Valider HTTP metode
    if (req.method !== 'POST') {
      return res.status(405).json({
        success: false,
        error: 'Metode ikke tilladt'
      });
    }

    try {
      const { uid } = req.body;

      // Valider input
      if (!uid) {
        return res.status(400).json({
          success: false,
          error: 'Bruger ID er påkrævet'
        });
      }

      // Slet bruger fra Authentication
      await admin.auth().deleteUser(uid);

      return res.status(200).json({
        success: true,
        message: 'Bruger slettet succesfuldt'
      });

    } catch (error) {
      console.error('Fejl ved sletning af bruger:', error);
      return res.status(500).json({
        success: false,
        error: 'Der opstod en fejl ved sletning af bruger',
        details: error.message
      });
    }
  });
});

// Forenklet HTTP endpoint
exports.searchDealers = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    // Tillad både GET og POST metoder
    if (req.method !== 'GET' && req.method !== 'POST') {
      return res.status(405).json({
        success: false,
        error: 'Metode ikke tilladt'
      });
    }

    try {
      // Hent value fra enten query parameter (GET) eller request body (POST)
      const value = req.method === 'GET' ? req.query.value : req.body.value;

      if (!value) {
        return res.status(400).json({
          success: false,
          error: 'value parameter er påkrævet'
        });
      }

      const result = await searchCarDealer(value);
      return res.status(result.success ? 200 : 500).json(result);

    } catch (error) {
      console.error('Fejl i searchDealers endpoint:', error);
      return res.status(500).json({
        success: false,
        error: 'Der opstod en fejl ved søgning efter forhandlere',
        details: error.message
      });
    }
  });
});

// Ny HTTP-funktion til at trigger bil-opdatering for specifik bruger
exports.triggerCarUpdate = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      return res.status(405).json({
        success: false,
        error: 'Metode ikke tilladt'
      });
    }

    try {
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({
          success: false,
          error: 'userId er påkrævet'
        });
      }

      const db = admin.firestore();
      const userDoc = await db.collection('users').doc(userId).get();
      
      if (!userDoc.exists) {
        return res.status(404).json({
          success: false,
          error: 'Bruger ikke fundet'
        });
      }

      const userData = userDoc.data();
      
      if (!userData.dealerId) {
        return res.status(400).json({
          success: false,
          error: 'Bruger har ikke en gyldig dealerId'
        });
      }

      // Ret sammenligningen til at være case-insensitive
      if (userData.client?.toLowerCase() === 'biltorvet') {
        console.log(`Starter Biltorvet opdatering for bruger ${userId}`);
        // Importer direkte i stedet for dynamisk
        const { processBiltorvetCarsForUser } = require('./fetchAndStoreCarsBiltorvet');
        
        // Kør funktionen og vent på resultatet
        try {
          const result = await processBiltorvetCarsForUser(userId);
          console.log(`Biltorvet opdatering fuldført for bruger ${userId}:`, result);
        } catch (error) {
          console.error(`Fejl i Biltorvet opdatering for bruger ${userId}:`, error);
          // Fortsæt med at returnere success, da processen er startet
        }
      } else {
        console.log(`Starter normal bil-opdatering for bruger ${userId}`);
        const { processCarsForUser } = require('./fetchAndStoreCars');
        
        try {
          const result = await processCarsForUser(userId);
          console.log(`Normal bil-opdatering fuldført for bruger ${userId}:`, result);
        } catch (error) {
          console.error(`Fejl i normal bil-opdatering for bruger ${userId}:`, error);
          // Fortsæt med at returnere success, da processen er startet
        }
      }

      return res.status(200).json({
        success: true,
        message: `Bil-opdatering startet for bruger ${userId}`,
        client: userData.client,
        dealerId: userData.dealerId
      });

    } catch (error) {
      console.error('Fejl i triggerCarUpdate:', error);
      return res.status(500).json({
        success: false,
        error: 'Der opstod en fejl ved start af opdatering',
        details: error.message
      });
    }
  });
});

// Tilføj disse nye exports til den eksisterende exports sektion
module.exports = {
  // Data loading og bruger-relaterede funktioner
  loadDataToFirestore: exports.loadDataToFirestore,
  loadMetaUserDataToFirestore: exports.loadMetaUserDataToFirestore,
  addUserDataToFirestore: exports.addUserDataToFirestore,
  toggleUserStatus: exports.toggleUserStatus,
  fetchAndStoreMetaUserData,
  
  // Post processing og håndtering
  processPostOnWrite: exports.processPostOnWrite,
  checkAndPublishPosts: exports.checkAndPublishPosts,
  cleanupPostSend: exports.cleanupPostSend,
  processAutoPosts: exports.processAutoPosts,
  processAutoPostsScheduled,
  processText,
  correctText: exports.correctText,
  checkAndMoveDeletedCarPosts,
  
  // Meta/Facebook/Instagram integration
  uploadVideoToAdAccount,
  uploadImageToAdAccount,
  createAdCreative,
  createCarouselAdCreative,
  createImageContainerForInstagram,
  handleInstagramPost,
  handleFacebookPost,
  handleFacebookReels,
  handleFacebookStory,
  handleInstagramReels,
  handleInstagramStoryVideo,
  dagligOpdateringAfPageAccessTokens,
  
  // Biltorvet flow (i korrekt rækkefølge)
  fetchAndStoreCarsBiltorvet,         // Kører 02:30
  processDealerCars,                  // Tilføj denne
  processBiltorvetCollectionsOnTopic, // Tilføj denne
  
  // Andre bil-relaterede funktioner
  fetchAndStoreCars,
  simulateFetchAndStoreCars,
  updateFiltersWithNewCar,
  matchesFilterCriteria,
  getPaintId: exports.getPaintId,
  
  // Template og auto-post funktioner
  getTemplateEditor: exports.getTemplateEditor,
  autoPostHelpers,
  
  // Analytics og video funktioner
  getDubAnalytics,
  scheduledDubAnalytics,
  triggerDubAnalytics,
  getStoredAnalytics,
  generateVideo,
  generateVideoApi: exports.generateVideoApi,
  checkVideoStatus: exports.checkVideoStatus,
  
  // Social analytics
  fetchAndStoreSocialAnalytics,
  getSocialAnalytics: exports.getSocialAnalytics,
  scheduledGetSocialAnalytics: exports.scheduledGetSocialAnalytics,
  getSpecificCarData: exports.getSpecificCarData,
  deleteUser: exports.deleteUser,
  searchDealers: exports.searchDealers,
  triggerCarUpdate: exports.triggerCarUpdate,
  
  // Tilføj disse nye exports til den eksisterende exports sektion
  processCarsForUser: async (userId) => {
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
  },

  processBiltorvetCarsForUser: async (userId) => {
    if (!userId) {
      throw new Error('userId er påkrævet');
    }

    const db = admin.firestore();
    const userDoc = await db.collection('users').doc(userId).get();
    
    if (!userDoc.exists) {
      throw new Error(`Bruger ${userId} findes ikke`);
    }

    const userData = userDoc.data();
    
    // Verificer at det er en Biltorvet bruger
    if (userData.client !== 'biltorvet') {
      throw new Error('Denne funktion er kun til Biltorvet brugere');
    }

    const dealerId = userData.dealerId;
    if (!dealerId) {
      throw new Error('Bruger har ikke et gyldigt dealerId');
    }

    try {
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

      return {
        success: true,
        totalCars: allCars.length
      };

    } catch (error) {
      console.error(`Fejl ved processering af Biltorvet biler for bruger ${userId}:`, error);
      throw error;
    }
  },

  // Domain management
  setupFirebaseHosting: functions
    .runWith({
      timeoutSeconds: 300,
      memory: '1GB'
    })
    .region('us-central1')
    .https.onRequest((req, res) => {
      // Tilføj CORS headers manuelt
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.set('Access-Control-Max-Age', '3600');

      // Håndter OPTIONS request
      if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
      }

      return cors(req, res, async () => {
        const CI_TOKEN = functions.config().ci?.token || process.env.FIREBASE_TOKEN;
        
        if (!CI_TOKEN) {
          console.error('CI Token mangler i config');
          return res.status(500).json({
            success: false,
            error: 'Firebase CI token er ikke konfigureret på serveren'
          });
        }

        try {
          await require('./domains/customDomain').setupFirebaseHosting(req, res, CI_TOKEN);
        } catch (error) {
          console.error('Fejl i setupFirebaseHosting:', error);
          return res.status(500).json({
            success: false,
            error: error.message,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
          });
        }
      });
    }),
};

// Tilføj denne hjælpefunktion
async function getExcludedCarIds(userId) {
  const excludedCarsSnapshot = await admin.firestore()
    .collection('users')
    .doc(userId)
    .collection('excludedCars')
    .get();

  const excludedIds = new Set();
  excludedCarsSnapshot.forEach(doc => {
    const carData = doc.data();
    if (carData.id) {
      excludedIds.add(carData.id.toString());
    }
  });

  return excludedIds;
}

exports.simulateFetchAndStoreCars = functions
  .runWith({
    timeoutSeconds: 540,
    memory: '1GB'
  })
  .https.onRequest((req, res) => {
    cors(req, res, async () => {
      try {
        if (req.method !== 'POST') {
          return res.status(405).json({ error: 'Method not allowed' });
        }

        const result = await simulateFetchAndStoreCars();
        return res.status(200).json(result);
      } catch (error) {
        console.error('Error in simulateFetchAndStoreCars:', error);
        return res.status(500).json({
          error: error.message,
          stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
      }
    });
  });