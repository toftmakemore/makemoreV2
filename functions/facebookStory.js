const axios = require('axios');
const admin = require('firebase-admin');

// Initialize Firebase if it hasn't been initialized yet
if (!admin.apps.length) {
  admin.initializeApp();
}

const initializeVideoUpload = async (pageId, accessToken) => {
  const url = `https://graph.facebook.com/${pageId}/video_stories?upload_phase=start&access_token=${accessToken}`;
  const response = await axios.post(url);
  console.log("Initialize Video Upload Response:", response.data);
  return response.data;
};

const uploadVideo = async (uploadUrl, accessToken, videoUrl) => {
  const headers = {
    'Authorization': `OAuth ${accessToken}`,
    'file_url': videoUrl
  };
  const response = await axios.post(uploadUrl, null, { headers });
  console.log("Upload Video Response:", response.data);
  return response.data;
};

const finishVideoUpload = async (pageId, accessToken, videoId) => {
  const url = `https://graph.facebook.com/${pageId}/video_stories?upload_phase=finish&video_id=${videoId}&access_token=${accessToken}`;
  const response = await axios.post(url);
  console.log("Finish Video Upload Response:", response.data);
  return response.data;
};

const processFacebookStory = async (postData, postId, metaUserData) => {
  try {
    console.log(`Processing Facebook Story for post ${postId}`);

    if (!metaUserData) {
      throw new Error(`MetaUserData missing for post ${postId}`);
    }

    const pageId = metaUserData.facebook_id;  // Assuming facebook_id is used as pageId
    const accessToken = metaUserData.pageAccessToken;

    if (!pageId || !accessToken) {
      throw new Error(`Missing facebook_id or pageAccessToken in metaUserData for post ${postId}`);
    }

    const { images } = postData;
    const videoUrl = images && images.length > 0 ? images[0] : null;

    if (!videoUrl) {
      throw new Error(`No video URL found for Story post ${postId}`);
    }

    console.log(`Initializing video upload for Story post ${postId}`);
    const initData = await initializeVideoUpload(pageId, accessToken);
    if (!initData.video_id || !initData.upload_url) {
      throw new Error(`Failed to initialize video upload for post ${postId}. Response: ${JSON.stringify(initData)}`);
    }
    const { video_id, upload_url } = initData;

    console.log(`Uploading video for Story post ${postId}`);
    await uploadVideo(upload_url, accessToken, videoUrl);

    console.log(`Finishing video upload for Story post ${postId}`);
    const finishResponse = await finishVideoUpload(pageId, accessToken, video_id);

    console.log(`Updating Firestore document for Story post ${postId}`);
    await admin.firestore().collection("posts").doc(postId).update({
      storyVideoId: video_id,
      storyUploadStatus: 'prepared',
      storyUploadedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Story video prepared successfully for post ${postId}. Video ID: ${video_id}`);
    return { data: video_id };
  } catch (error) {
    console.error(`Error processing Story for post ${postId}:`, error);
    
    // Update Firestore document with error status
    await admin.firestore().collection("posts").doc(postId).update({
      storyUploadStatus: 'failed',
      storyUploadError: error.message
    });

    throw error;
  }
};

module.exports = {
  processFacebookStory
};