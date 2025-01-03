const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');
const FormData = require('form-data');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');

// Initialize Firebase if it hasn't been initialized yet
if (!admin.apps.length) {
  admin.initializeApp();
}

// Function to fetch metadata from Firestore
const getMetaData = async (userId) => {
  try {
    const db = admin.firestore();
    const doc = await db.collection("users").doc(userId).get();
    if (doc.exists) {
      return doc.data();
    } else {
      throw new Error(`Ingen metadata fundet for userId: ${userId}`);
    }
  } catch (error) {
    console.error(`Fejl ved hentning af metadata for userId ${userId}:`, error);
    throw new Error(`Kunne ikke hente metadata: ${error.message}`);
  }
};

// Function to upload video to Meta Ad account
const uploadVideoToAdAccount = async (data, userId) => {
  const maxRetries = 3;
  let retries = 0;

  const attempt = async () => {
    try {
      const { name, title, file_url } = data;
      console.log(`Starter video upload for userId: ${userId}`);

      // Use only the userToken from config.js
      const access_token = config.meta.userToken;
      const adAccountId = config.meta.adAccountId;

      if (!adAccountId) {
        throw new Error('No adAccountId found in config');
      }

      const api_url = `https://graph-video.facebook.com/${config.meta.version}/act_${adAccountId}/advideos`;

      const videoResponse = await axios.get(file_url, { responseType: 'stream' });

      if (videoResponse.status !== 200) {
        throw new Error(`Failed to download video: ${videoResponse.status}, ${videoResponse.statusText}`);
      }

      const formData = new FormData();
      formData.append('title', title);
      formData.append('name', name);
      formData.append('source', videoResponse.data, {
        filename: `${uuidv4()}.mp4`,
        contentType: 'video/mp4',
      });

      const response = await axios.post(api_url, formData, {
        headers: {
          ...formData.getHeaders(),
          'Authorization': `Bearer ${access_token}`,
        },
      });

      console.log('Facebook API Response:', response.data);

      if (response.status === 200) {
        const result = response.data;
        const video_id = result.id;
        if (video_id) {
          console.log(`Video uploaded successfully. Video ID: ${video_id}`);
          return { data: video_id };
        } else {
          throw new Error('Video ID not found in response');
        }
      } else {
        throw new Error(`Failed to upload video: ${response.status}, ${response.statusText}`);
      }
    } catch (error) {
      console.error('Error uploading video:', error.message);
      if (error.response) {
        console.error('Error response:', error.response.data);
      }
      throw error;
    }
  };

  while (retries < maxRetries) {
    try {
      return await attempt();
    } catch (error) {
      retries++;
      if (retries === maxRetries) {
        return { error: `Failed to upload video after ${maxRetries} attempts: ${error.message}` };
      }
      console.log(`Retry attempt ${retries} of ${maxRetries}`);
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retrying
    }
  }
};

// Function to upload image to Meta Ad account
const uploadImageToAdAccount = async (data, userId) => {
  try {
    const { image_url } = data;
    console.log(`Uploader billede fra URL: ${image_url} for userId: ${userId}`);

    const metaData = await getMetaData(userId);
    const access_token = metaData.pageAccessToken || config.meta.userToken;
    const adAccountId = config.meta.adAccountId;

    if (!adAccountId) {
      throw new Error('No adAccountId found in config');
    }

    console.log(`Using adAccountId: ${adAccountId}`);

    const api_url = `https://graph.facebook.com/${config.meta.version}/act_${adAccountId}/adimages`;

    const imageResponse = await axios.get(image_url, { responseType: 'arraybuffer' });

    const unique_filename = `${uuidv4()}.jpg`;

    const formData = new FormData();
    formData.append('file', Buffer.from(imageResponse.data), { filename: unique_filename });
    formData.append('access_token', access_token);

    const response = await axios.post(api_url, formData, {
      headers: formData.getHeaders(),
    });

    if (response.data && response.data.images) {
      const imageData = response.data.images;
      const firstImageKey = Object.keys(imageData)[0];
      const imageHash = imageData[firstImageKey].hash;
      console.log(`Image uploaded successfully. Hash: ${imageHash}`);
      return { data: { image_hash: imageHash } };
    } else {
      console.error("Failed to retrieve image hash", response.data);
      return { error: "Failed to retrieve image hash" };
    }
  } catch (error) {
    console.error(`Error uploading image for userId ${userId}:`, error);
    return { error: `Failed to upload image: ${error.message}` };
  }
};

// Function to create image container for Instagram
const createImageContainerForInstagram = async (data, userId, instagramAccountId) => {
  try {
    const { image_url, caption } = data;
    console.log(`Opretter billedcontainer for Instagram, userId: ${userId}`);

    const metaData = await getMetaData(userId);
    const access_token = metaData.pageAccessToken || config.meta.userToken;

    const api_url = `https://graph.facebook.com/${config.meta.version}/${instagramAccountId}/media`;

    const params = new URLSearchParams();
    params.append('image_url', image_url);
    params.append('caption', caption);
    params.append('access_token', access_token);

    const response = await axios.post(api_url, params);

    if (response.data && response.data.id) {
      console.log(`Instagram image container created successfully. ID: ${response.data.id}`);
      return { data: { instagram_container_id: response.data.id } };
    } else {
      console.error("Failed to create Instagram image container", response.data);
      return { error: "Failed to create Instagram image container" };
    }
  } catch (error) {
    console.error(`Error creating Instagram image container for userId ${userId}:`, error);
    return { error: `Failed to create Instagram image container: ${error.message}` };
  }
};

// Function to create video container for Instagram
const createVideoContainerForInstagram = async (data, userId, instagramAccountId) => {
  try {
    const { video_url, caption } = data;
    console.log(`Opretter videocontainer for Instagram, userId: ${userId}`);

    const metaData = await getMetaData(userId);
    const access_token = metaData.pageAccessToken || config.meta.userToken;

    const api_url = `https://graph.facebook.com/${config.meta.version}/${instagramAccountId}/media`;

    const params = new URLSearchParams();
    params.append('media_type', 'VIDEO');
    params.append('video_url', video_url);
    params.append('caption', caption);
    params.append('access_token', access_token);

    const response = await axios.post(api_url, params);

    if (response.data && response.data.id) {
      console.log(`Instagram video container created successfully. ID: ${response.data.id}`);
      return { data: { instagram_container_id: response.data.id } };
    } else {
      console.error("Failed to create Instagram video container", response.data);
      return { error: "Failed to create Instagram video container" };
    }
  } catch (error) {
    console.error(`Error creating Instagram video container for userId ${userId}:`, error);
    return { error: `Failed to create Instagram video container: ${error.message}` };
  }
};

// Function to publish Instagram container
const publishInstagramContainer = async (containerId, userId, instagramAccountId) => {
  try {
    console.log(`Publicerer Instagram container ${containerId} for userId: ${userId}`);

    const metaData = await getMetaData(userId);
    const access_token = metaData.pageAccessToken || config.meta.userToken;

    const api_url = `https://graph.facebook.com/${config.meta.version}/${instagramAccountId}/media_publish`;

    const params = new URLSearchParams();
    params.append('creation_id', containerId);
    params.append('access_token', access_token);

    const response = await axios.post(api_url, params);

    if (response.data && response.data.id) {
      console.log(`Instagram container published successfully. Post ID: ${response.data.id}`);
      return { data: { instagram_post_id: response.data.id } };
    } else {
      console.error("Failed to publish Instagram container", response.data);
      return { error: "Failed to publish Instagram container" };
    }
  } catch (error) {
    console.error(`Error publishing Instagram container for userId ${userId}:`, error);
    return { error: `Failed to publish Instagram container: ${error.message}` };
  }
};

// Export all functions
module.exports = {
  uploadImageToAdAccount,
  uploadVideoToAdAccount,
  createImageContainerForInstagram,
  createVideoContainerForInstagram,
  publishInstagramContainer
};
