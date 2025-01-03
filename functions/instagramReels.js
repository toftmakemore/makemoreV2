const admin = require('firebase-admin');
const axios = require('axios');
const config = require('./config');

// Helper function to make requests with retry logic
const makeRequestWithRetry = async (url, method = 'get', data = null, headers = null, maxAttempts = 5, delay = 20) => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await axios({
        method: method.toLowerCase(),
        url,
        data,
        headers
      });
      if (response.status === 200) {
        return response;
      } else {
        console.log(`Attempt ${attempt + 1} of ${maxAttempts}: Response returned with status code ${response.status}, retrying in ${delay} seconds...`);
      }
    } catch (error) {
      console.error(`Attempt ${attempt + 1} of ${maxAttempts}: An error occurred: ${error.message}, retrying in ${delay} seconds...`);
    }
    await new Promise(resolve => setTimeout(resolve, delay * 1000 * (2 ** attempt)));
  }
  console.log("Failed to complete request after maximum number of attempts.");
  return null;
};

// Function to upload video to Instagram
const uploadVideoToInstagram = async (instagram_id, page_access_token, video_url, caption) => {
  const url = `https://graph.facebook.com/${config.meta.version}/${instagram_id}/media`;
  const payload = {
    video_url: video_url,
    caption: caption,
    access_token: page_access_token,
    media_type: 'REELS'
  };
  
  const response = await makeRequestWithRetry(url, 'post', payload);
  if (response && response.data && response.data.id) {
    const media_id = response.data.id;
    console.log(`Video uploaded successfully with Media ID: ${media_id}`);
    return { data: media_id };
  } else {
    console.log("Failed to upload video.");
    return { error: "Failed to upload video" };
  }
};

// Function to check Instagram media status
const checkInstagramMediaStatus = async (media_id, access_token) => {
  const url = `https://graph.facebook.com/${config.meta.version}/${media_id}?fields=status_code&access_token=${access_token}`;
  const response = await makeRequestWithRetry(url, 'get');
  return response ? response.data : null;
};

// Main function to process Instagram Reels
const processInstagramReels = async (postData, postId, metaUserData) => {
  console.log(`Processing Instagram Reels post ${postId}`);

  try {
    const instagram_id = metaUserData.instagram_id;
    const page_access_token = metaUserData.pageAccessToken;

    if (!instagram_id) {
      throw new Error('No Instagram ID found in metadata');
    }

    // Assuming the first image in the array is the video for Reels
    const video_url = postData.images[0];
    const caption = postData.text;

    const uploadResult = await uploadVideoToInstagram(instagram_id, page_access_token, video_url, caption);
    if (uploadResult.error) {
      throw new Error(`Error uploading video: ${uploadResult.error}`);
    }

    const media_id = uploadResult.data;

    // Check video processing status
    let statusCheckAttempts = 0;
    const maxStatusCheckAttempts = 20;
    while (statusCheckAttempts < maxStatusCheckAttempts) {
      const statusResponse = await checkInstagramMediaStatus(media_id, page_access_token);
      if (statusResponse && statusResponse.status_code) {
        const status_code = statusResponse.status_code;
        console.log(`Status code for Instagram Reels (${media_id}): ${status_code}`);
        if (status_code === 'FINISHED') {
          console.log("Reels processing is complete.");
          break;
        } else if (status_code !== 'IN_PROGRESS') {
          throw new Error(`Reels processing failed with status: ${status_code}`);
        }
      } else {
        throw new Error("Failed to fetch Reels status");
      }
      await new Promise(resolve => setTimeout(resolve, 15000)); // 15 seconds delay between status checks
      statusCheckAttempts++;
    }

    if (statusCheckAttempts >= maxStatusCheckAttempts) {
      throw new Error(`Reels processing timed out after ${maxStatusCheckAttempts} attempts`);
    }

    // Update the document with the processed media ID
    await admin.firestore().collection('posts').doc(postId).update({
      instagramMediaId: media_id,
      postStatus: 'reelsProcessed'
    });

    console.log(`Instagram Reels processed and document updated. Media ID: ${media_id}`);
    return media_id;
  } catch (error) {
    console.error(`Error processing Instagram Reels post ${postId}:`, error);
    await admin.firestore().collection('posts').doc(postId).update({
      postStatus: 'reelsProcessingFailed',
      reelsProcessingError: error.message
    });
    throw error;
  }
};

module.exports = {
  processInstagramReels,
  uploadVideoToInstagram,
  checkInstagramMediaStatus
};