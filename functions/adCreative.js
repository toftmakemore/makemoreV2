const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const config = require('./config');
const { uploadVideoToAdAccount, uploadImageToAdAccount } = require('./uploadProcessor');

// Initialize Firebase Admin if not initialized
if (!admin.apps.length) {
  admin.initializeApp();
}

// Helper function for logging
const logInfo = (message, data = null) => {
  console.log(`[INFO] ${message}`, data ? JSON.stringify(data) : '');
};

const logError = (message, error) => {
  console.error(`[ERROR] ${message}`, error);
};

// Function to fetch metadata from Firestore
const getMetaData = async (userId) => {
  logInfo(`Henter metadata for userId (id): ${userId}`);
  try {
    const db = admin.firestore();
    const doc = await db.collection('posts').doc(userId).get();
    if (doc.exists) {
      const data = doc.data();
      logInfo(`Metadata fundet for userId (id): ${userId}`, data);
      if (!data.pageAccessToken) {
        throw new Error(`Manglende pageAccessToken for userId (id): ${userId}`);
      }
      return {
        facebook_id: data.facebook_id,
        instagram_id: data.instagram_id,
        pageAccessToken: data.pageAccessToken,
      };
    } else {
      throw new Error(`Ingen metadata fundet for userId (id): ${userId}`);
    }
  } catch (error) {
    logError(`Fejl ved hentning af metadata for userId (id) ${userId}:`, error);
    throw new Error(`Kunne ikke hente metadata: ${error.message}`);
  }
};

// Function to get video thumbnail from Facebook API
const getVideoThumbnail = async (video_id, access_token, maxRetries = 5, initialWaitTime = 5) => {
  logInfo(`Henter video thumbnail for videoId: ${video_id}`);
  const api_url = `https://graph.facebook.com/${config.meta.version}/${video_id}/thumbnails`;
  const headers = { Authorization: `Bearer ${access_token}` };

  let waitTime = initialWaitTime;
  let thumbnailUrl = null;
  let attempts = 0;

  while (attempts < maxRetries && !thumbnailUrl) {
    attempts++;
    
    // Eksponentiel backoff på ventetiden
    const currentWaitTime = waitTime * attempts;
    logInfo(`Venter ${currentWaitTime} sekunder før forsøg ${attempts}`);
    await new Promise(resolve => setTimeout(resolve, currentWaitTime * 1000));

    try {
      logInfo(`Attempt ${attempts}/${maxRetries} to fetch thumbnail`);
      const response = await axios.get(api_url, { headers });
      
      if (response.status === 200 && response.data.data && response.data.data.length > 0) {
        thumbnailUrl = response.data.data[0].uri;
        logInfo(`Thumbnail fundet for videoId: ${video_id}`, { thumbnailUrl });
        return thumbnailUrl;
      }
      
      logInfo(`Attempt ${attempts}: Ingen thumbnails tilgængelige endnu. Prøver igen...`, {
        responseStatus: response.status,
        dataLength: response.data.data?.length || 0
      });
    } catch (error) {
      logError(`Attempt ${attempts}: Fejl ved hentning af thumbnails`, {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message
      });
    }
  }

  if (!thumbnailUrl) {
    logError(`Kunne ikke hente thumbnail efter ${maxRetries} forsøg for videoId: ${video_id}`);
    throw new Error(`Kunne ikke hente thumbnail for video ${video_id} efter ${maxRetries} forsøg`);
  }

  return thumbnailUrl;
};

// Function to create ad creative for single posts (video or image)
const createAdCreative = async (data) => {
  logInfo('Opretter ad creative', { data });
  
  if (!data.facebook) {
    throw new Error('facebook ID mangler i data');
  }

  if (!data.id) {
    throw new Error('id (userId) mangler i data');
  }

  if (!data.pageAccessToken) {
    throw new Error('pageAccessToken mangler i data');
  }

  const isTokenValid = await verifyToken(data.pageAccessToken);
  if (!isTokenValid) {
    throw new Error('Ugyldig eller udløbet pageAccessToken');
  }

  const api_url = `https://graph.facebook.com/${config.meta.version}/act_${config.meta.adAccountId}/adcreatives`;
  
  logInfo('pageAccessToken før anmodning:', data.pageAccessToken);

  const headers = { Authorization: `Bearer ${data.pageAccessToken}` };

  let objectStorySpec = {
    page_id: data.facebook,
    link_data: {
      link: data.caseUrl || 'https://example.com',
      message: data.text,
      image_hash: data.imageHash,
      name: data.children && data.children[0] ? data.children[0].headline : '',
      call_to_action: {
        type: 'LEARN_MORE',
        value: { link: data.caseUrl || 'https://example.com' }
      }
    }
  };

  if (data.videoId) {
    objectStorySpec = {
      page_id: data.facebook,
      video_data: {
        video_id: data.videoId,
        title: data.subject,
        message: data.text,
        image_url: data.image_url,
        call_to_action: {
          type: 'LEARN_MORE',
          value: { link: data.caseUrl || 'https://example.com' }
        }
      }
    };
  }

  const payload = {
    name: `Ad Creative for ${data.CaseId || 'Unknown'}`,
    object_story_spec: objectStorySpec,
    degrees_of_freedom_spec: {
      creative_features_spec: {
        standard_enhancements: {
          enroll_status: "OPT_IN"
        }
      }
    }
  };

  try {
    logInfo('Sender anmodning om at oprette ad creative', payload);
    const response = await axios.post(api_url, payload, { headers });
    if (response.status === 200 && response.data.id) {
      logInfo(`Ad creative oprettet med succes med id: ${response.data.id}`);
      return response.data.id;
    } else {
      throw new Error('Kunne ikke oprette ad creative: Uventet svar fra API');
    }
  } catch (error) {
    logError('Fejl ved oprettelse af ad creative:', error);
    if (error.response) {
      logError('Fejlrespons data:', error.response.data);
      if (error.response.status === 401) {
        logError('Uautoriseret adgang. Token kan være udløbet eller ugyldig.');
        // Her kunne du implementere logik til at forny token
      }
    }
    throw new Error(`Kunne ikke oprette ad creative: ${error.message}`);
  }
};

// Function to handle carousel images
const handleCarouselImages = async (postData, metaData, access_token) => {
  if (!postData.id) {
    throw new Error('Manglende bruger ID i post data');
  }

  logInfo('Håndterer karruselbilleder', { 
    userId: postData.id,
    hasMediaUrl: !!postData.mediaUrl,
    hasChildren: !!postData.children,
    numberOfMediaUrls: postData.mediaUrl?.length,
    numberOfChildren: postData.children?.length
  });
  
  const childImageHashes = [];
  let imagesToProcess = [];

  // Bestem hvilke billeder der skal bruges
  if (postData.children && postData.children.length > 0) {
    // Brug children array hvis det findes
    imagesToProcess = postData.children.map(child => ({
      url: child.images[0],
      headline: child.headline,
      link: child.caseUrl,
      userId: postData.id
    }));
  } else if (postData.mediaUrl && postData.mediaUrl.length > 0) {
    // Ellers brug mediaUrl array
    imagesToProcess = postData.mediaUrl.map((url, index) => ({
      url: url,
      headline: postData.children?.[index]?.headline || `Billede ${index + 1}`,
      link: postData.children?.[index]?.caseUrl || postData.caseUrl,
      userId: postData.id
    }));
  }

  // Tjek om vi har billeder at behandle
  if (imagesToProcess.length === 0) {
    throw new Error('Ingen billeder fundet til karrusel');
  }

  // Upload hvert billede og gem hash
  for (let i = 0; i < imagesToProcess.length; i++) {
    try {
      const image = imagesToProcess[i];
      const imageData = {
        image_url: image.url,
        name: image.headline,
        userId: image.userId
      };
      
      logInfo('Uploader billede', {
        ...imageData,
        userId: image.userId
      });
      
      const uploadResult = await uploadImageToAdAccount(imageData, image.userId);
      
      if (uploadResult.error) {
        throw new Error(`Fejl ved upload af billede: ${uploadResult.error}`);
      }
      
      childImageHashes.push({
        image_hash: uploadResult.data.image_hash,
        name: image.headline,
        link: image.link,
        description: image.headline
      });
      
      logInfo('Billede uploadet og hash gemt', {
        imageHash: uploadResult.data.image_hash,
        headline: image.headline,
        userId: image.userId
      });
    } catch (error) {
      logError(`Fejl ved håndtering af karruselbillede ${i + 1}:`, error);
      throw error;
    }
  }
  
  return childImageHashes;
};

// Function to create carousel ad creative
const createCarouselAdCreative = async (postData, metaData, access_token) => {
  logInfo('Opretter carousel ad creative', { postId: postData.id });

  try {
    // Håndter billeder og få image hashes
    const childImageHashes = await handleCarouselImages(postData, metaData, access_token);
    
    if (!childImageHashes.length) {
      throw new Error('Ingen billeder blev uploadet til karrusellen');
    }
    
    const adAccountId = config.meta.adAccountId;
    const api_url = `https://graph.facebook.com/${config.meta.version}/act_${adAccountId}/adcreatives`;

    const headers = { 
      Authorization: `Bearer ${access_token}`,
      'Content-Type': 'application/json'
    };

    const child_attachments = childImageHashes.map(item => ({
      link: item.link,
      image_hash: item.image_hash,
      name: item.name,
      description: item.description
    }));

    const objectStorySpec = {
      page_id: metaData.facebook_id,
      link_data: {
        multi_share_end_card: false,
        multi_share_optimized: false,
        child_attachments: child_attachments,
        message: postData.text || ''
      }
    };

    const payload = {
      name: `Carousel Ad Creative for ${postData.dealerId || 'Unknown'}`,
      object_story_spec: objectStorySpec,
      degrees_of_freedom_spec: {
        creative_features_spec: {
          standard_enhancements: {
            enroll_status: "OPT_IN"
          }
        }
      }
    };

    logInfo('Sender anmodning om at oprette carousel ad creative', payload);

    const response = await axios.post(api_url, payload, { headers });
    const creative_id = response.data.id;

    logInfo(`Carousel ad creative oprettet med succes. ID: ${creative_id}`);
    
    return creative_id;

  } catch (error) {
    logError('Fejl ved oprettelse af carousel ad creative:', error);
    throw error;
  }
};

// Modify the processAdCreative function
const processAdCreative = async (change, context) => {
  const postId = context.params.postId;
  
  // Tilføj logging for at verificere postId
  logInfo('processAdCreative started with postId:', postId);
  
  const newData = change.after.exists ? change.after.data() : null;
  const previousData = change.before.exists ? change.before.data() : null;

  logInfo('processAdCreative function triggered - ENTRY POINT', { postId, newData, previousData });

  if (!newData) {
    logInfo('Document was deleted, skipping processing');
    return null;
  }

  const hasVideo = newData.images && newData.images.length > 0 && newData.images[0].endsWith('.mp4');
  const hasNewVideoId = newData.videoId && (!previousData || newData.videoId !== previousData.videoId);
  const hasNewImageHash = newData.childImageHashes && newData.childImageHashes.length > 0 && (!previousData || !previousData.childImageHashes || JSON.stringify(newData.childImageHashes) !== JSON.stringify(previousData.childImageHashes));
  const hasMoreThanOneChild = newData.children && newData.children.length > 1;

  if (!previousData || hasVideo || hasNewVideoId || hasNewImageHash || hasMoreThanOneChild) {
    logInfo('New document or updated video/imageHash/children detected');

    if (!newData.id) {
      throw new Error('Manglende id (userId) i newData');
    }
    if (!newData.facebook) {
      throw new Error('Manglende facebook ID i newData');
    }
    
    try {
      const metaData = await getMetaData(newData.id);
      const pageAccessToken = metaData.pageAccessToken;

      if (!pageAccessToken) {
        throw new Error(`Manglende pageAccessToken for userId: ${newData.id}`);
      }

      let creative_id;

      if (hasVideo || newData.videoId) {
        logInfo('Processing video post');
        const videoId = newData.videoId;
        const thumbnail_url = await getVideoThumbnail(videoId, pageAccessToken);
        if (!thumbnail_url) {
          throw new Error(`Failed to retrieve thumbnail for videoId ${videoId}`);
        }
        creative_id = await createAdCreative({...newData, videoId, pageAccessToken}, thumbnail_url);
      } else if (hasMoreThanOneChild) {
        logInfo('Processing carousel post');
        const carouselData = {
          ...newData,
          pageAccessToken,
          postId
        };
        
        creative_id = await createCarouselAdCreative(
          carouselData,
          metaData, 
          pageAccessToken
        );
        
        // Verificer at vi har både postId og creative_id før opdatering
        if (postId && creative_id) {
          try {
            const postRef = admin.firestore().collection('posts').doc(postId);
            
            // Tjek om dokumentet eksisterer først
            const doc = await postRef.get();
            if (!doc.exists) {
              throw new Error(`Document ${postId} does not exist`);
            }
            
            await postRef.update({
              creative_id,
              adCreativeStatus: 'success',
              lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            });
            
            logInfo(`Successfully updated Firestore document ${postId} with creative_id: ${creative_id}`);
          } catch (updateError) {
            logError(`Failed to update Firestore for post ${postId}:`, updateError);
            // Kast fejlen videre så vi kan håndtere den i den overordnede funktion
            throw updateError;
          }
        } else {
          logError('Missing postId or creative_id:', { postId, creative_id });
          throw new Error('Missing required data for Firestore update');
        }
      } else {
        logInfo('Processing single image post', { newData });
        const singleImageData = {
          ...newData,
          imageHash: newData.childImageHashes[0].image_hash,
          caseUrl: newData.childImageHashes[0].link,
          children: [{ headline: newData.childImageHashes[0].name }],
          pageAccessToken
        };
        creative_id = await createAdCreative(singleImageData, null);
      }

      return creative_id;

    } catch (error) {
      logError(`Error processing ad creative for post ${postId}:`, error);
      try {
        await admin.firestore().collection('posts').doc(postId).update({
          adCreativeError: error.message,
          adCreativeStatus: 'failed',
          lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (updateError) {
        logError(`Failed to update error status in Firestore:`, updateError);
      }
      throw error;
    }
  } else {
    logInfo('No relevant changes detected, skipping processing');
  }

  return null;
};

const updateTokenInFirestore = async (userId, newToken) => {
  await admin.firestore().collection('posts').doc(userId).update({
    pageAccessToken: newToken
  });
};

const verifyToken = async (accessToken) => {
  try {
    const response = await axios.get(`https://graph.facebook.com/${config.meta.version}/me?access_token=${accessToken}`);
    logInfo('Token verification successful:', response.data);
    return true;
  } catch (error) {
    logError('Token verification failed:', error.response ? error.response.data : error.message);
    return false;
  }
};

module.exports = {
  processAdCreative,
  createCarouselAdCreative,
  createAdCreative,
  getMetaData,
  getVideoThumbnail,
  updateTokenInFirestore,
  verifyToken,
  handleCarouselImages
};