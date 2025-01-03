const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');
const config = require('./config');

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
  admin.initializeApp();
}

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

// Function to format text correctly for Facebook posts
const formatFacebookText = (text) => {
  return text
    .replace(/&#13;/g, '')  // Remove unwanted HTML entity for carriage return
    .replace(/\n\n/g, '\n')  // Replace double newlines with single newline
    .replace(/\n/g, '\n\n'); // Ensure single newlines create proper spacing
};

// Function to upload video to Facebook without publishing
const uploadVideoUnpublished = async (facebook_id, page_access_token, video_url) => {
  console.log("Uploading an unpublished video to Facebook...");
  const url = `https://graph-video.facebook.com/${config.meta.version}/${facebook_id}/videos`;
  const payload = {
    file_url: video_url,
    published: 'false',  // Ensure the video is not published
    access_token: page_access_token
  };

  const response = await makeRequestWithRetry(url, 'post', payload);
  if (response && response.data && response.data.id) {
    const video_id = response.data.id;
    console.log(`Video uploaded successfully with ID: ${video_id}`);
    return { data: video_id };
  } else {
    console.error("Failed to upload video to Facebook.");
    return { error: "Failed to upload video" };
  }
};

// Main function to handle the Facebook Page Video upload
const handleFacebookPageVideo = async (postData, postId, metaUserData) => {
  console.log(`Handling Facebook Page Video upload for post ${postId}`);
  try {
    const facebook_id = metaUserData.facebook_id;
    const page_access_token = metaUserData.pageAccessToken;

    if (!facebook_id || !page_access_token) {
      throw new Error("Facebook ID or Page Access Token missing in metadata");
    }

    // Extract video URL from postData
    const video_url = postData.images[0];
    if (!video_url) {
      throw new Error("No video URL found in the post data");
    }

    // Upload the video without publishing
    const uploadResult = await uploadVideoUnpublished(facebook_id, page_access_token, video_url);
    if (uploadResult.error) {
      throw new Error(`Error uploading video: ${uploadResult.error}`);
    }

    const video_id = uploadResult.data;

    // Format the text content for Facebook
    const formattedText = formatFacebookText(postData.text);

    // Update the Firestore document with the uploaded video ID and formatted text
    await admin.firestore().collection('posts').doc(postId).update({
      facebookVideoId: video_id,
      formattedText: formattedText, // Store the properly formatted text
      postStatus: 'videoPrepared',
      processingStatus: 'completed',
      processingEndTime: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Facebook Page Video prepared and document updated. Video ID: ${video_id}`);
    return video_id;
  } catch (error) {
    console.error(`Error handling Facebook Page Video post ${postId}:`, error);

    // Update Firestore document with error details
    await admin.firestore().collection('posts').doc(postId).update({
      postStatus: 'videoPreparationFailed',
      processingStatus: 'error',
      processingError: error.message,
      processingEndTime: admin.firestore.FieldValue.serverTimestamp()
    });

    throw error;
  }
};

module.exports = { handleFacebookPageVideo };