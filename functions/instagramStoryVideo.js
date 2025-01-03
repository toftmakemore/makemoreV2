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

// Function to upload video to Instagram Story
const uploadVideoToInstagramStory = async (instagram_id, page_access_token, video_url) => {
  const url = `https://graph.facebook.com/${config.meta.version}/${instagram_id}/media`;
  const payload = {
    video_url: video_url,
    access_token: page_access_token,
    media_type: 'STORIES'
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

// Main function to prepare Instagram Story video
const prepareInstagramStoryVideo = async (postData, postId, metaUserData) => {
  console.log(`Preparing Instagram Story video for post ${postId}`);

  try {
    const instagram_id = metaUserData.instagram_id;
    const page_access_token = metaUserData.pageAccessToken;

    if (!instagram_id) {
      throw new Error('No Instagram ID found in metadata');
    }

    // Assuming the first image in the array is the video for Story
    const video_url = postData.images[0];

    const uploadResult = await uploadVideoToInstagramStory(instagram_id, page_access_token, video_url);
    if (uploadResult.error) {
      throw new Error(`Error uploading video: ${uploadResult.error}`);
    }

    const media_id = uploadResult.data;

    // Update the document with the prepared media ID
    await admin.firestore().collection('posts').doc(postId).update({
      instagramMediaId: media_id,
      postStatus: 'storyPrepared'
    });

    console.log(`Instagram Story video prepared and document updated. Media ID: ${media_id}`);
    return media_id;
  } catch (error) {
    console.error(`Error preparing Instagram Story video for post ${postId}:`, error);
    await admin.firestore().collection('posts').doc(postId).update({
      postStatus: 'storyPreparationFailed',
      storyPreparationError: error.message
    });
    throw error;
  }
};

module.exports = {
  prepareInstagramStoryVideo,
  uploadVideoToInstagramStory
};