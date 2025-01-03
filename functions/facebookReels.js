const axios = require('axios');
const admin = require('firebase-admin');

// Initialize Firebase if it hasn't been initialized yet
if (!admin.apps.length) {
  admin.initializeApp();
}

const initializeReelsUpload = async (pageId, accessToken) => {
  const url = `https://graph.facebook.com/${pageId}/video_reels?upload_phase=start&access_token=${accessToken}`;
  const response = await axios.post(url);
  console.log("Initialize Reels Upload Response:", response.data);
  return response.data;
};

const uploadReelsVideo = async (uploadUrl, accessToken, videoUrl) => {
  const headers = {
    'Authorization': `OAuth ${accessToken}`,
    'file_url': videoUrl
  };
  const response = await axios.post(uploadUrl, null, { headers });
  console.log("Upload Reels Video Response:", response.data);
  return response.data;
};

const prepareReelsVideo = async (pageId, accessToken, videoUrl) => {
  try {
    // Step 1: Initialize session
    const initData = await initializeReelsUpload(pageId, accessToken);
    if (!initData.video_id || !initData.upload_url) {
      throw new Error("Failed to initialize reels upload. Response: " + JSON.stringify(initData));
    }
    const { video_id, upload_url } = initData;

    // Step 2: Upload the video file
    const uploadResponse = await uploadReelsVideo(upload_url, accessToken, videoUrl);
    if (!uploadResponse.success) {
      throw new Error("Failed to upload reels video. Response: " + JSON.stringify(uploadResponse));
    }

    return { video_id, upload_url };
  } catch (error) {
    console.error("Error in prepareReelsVideo:", error);
    throw error;
  }
};

const processFacebookReels = async (postData, postId, metaUserData) => {
  try {
    console.log(`Processing Facebook Reels for post ${postId}`);

    if (!metaUserData) {
      throw new Error(`MetaUserData missing for post ${postId}`);
    }

    const pageId = metaUserData.facebook_id;  // Assuming facebook_id is used as pageId
    const accessToken = metaUserData.pageAccessToken;

    if (!pageId || !accessToken) {
      throw new Error(`Missing facebook_id or pageAccessToken in metaUserData for post ${postId}`);
    }

    const { images, subject, text } = postData;
    const videoUrl = images && images.length > 0 ? images[0] : null;

    if (!videoUrl) {
      throw new Error(`No video URL found for Reels post ${postId}`);
    }

    console.log(`Preparing Reels video for post ${postId}`);
    const result = await prepareReelsVideo(pageId, accessToken, videoUrl);

    console.log(`Updating Firestore document for post ${postId}`);
    await admin.firestore().collection("posts").doc(postId).update({
      reelsVideoId: result.video_id,
      reelsUploadUrl: result.upload_url,
      reelsPageId: pageId,
      reelsAccessToken: accessToken,
      reelsTitle: subject,
      reelsDescription: text,
      reelsUploadStatus: 'prepared',
      reelsUploadedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Reels video prepared successfully for post ${postId}. Video ID: ${result.video_id}`);
    return { data: result.video_id };
  } catch (error) {
    console.error(`Error processing Reels for post ${postId}:`, error);
    
    // Update Firestore document with error status
    await admin.firestore().collection("posts").doc(postId).update({
      reelsUploadStatus: 'failed',
      reelsUploadError: error.message
    });

    throw error;
  }
};
module.exports = {
  processFacebookReels
};