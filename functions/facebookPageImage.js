const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');
const config = require('./config');

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
  admin.initializeApp();
}

// Helper function to make requests with retry logic
const makeRequestWithRetry = async (url, method = 'post', data = null, headers = null, maxAttempts = 5, delay = 20) => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await axios({
        method,
        url,
        data,
        headers,
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

// Function to upload photo to Facebook without publishing
const uploadPhotoUnpublished = async (facebook_id, page_access_token, image_url) => {
  console.log("Uploading an unpublished photo to Facebook...");
  const url = `https://graph.facebook.com/${config.meta.version}/${facebook_id}/photos`;
  const payload = {
    url: image_url,
    published: 'false',  // Ensure the image is uploaded but not published
    access_token: page_access_token,
  };
  const response = await makeRequestWithRetry(url, 'post', payload);
  if (response && response.data && response.data.id) {
    const photo_id = response.data.id;
    console.log(`Photo uploaded successfully with ID: ${photo_id}`);
    return { data: { photo_id: photo_id } };
  } else {
    console.error("Failed to upload photo to Facebook.");
    return { data: { error: "Failed to upload photo" } };
  }
};

const formatTextForFacebook = (text) => {
  // Replace HTML encoded line breaks (&#13;) with actual newlines
  let formattedText = text.replace(/&#13;/g, '\n');

  // Return the formatted text
  return formattedText;
};

// Main function to handle the Facebook Page Image post without publishing
const handleFacebookPageImage = async (postData, postId, metaUserData) => {
  console.log(`Handling Facebook Page Image post ${postId}`);
  try {
    const facebook_id = metaUserData.facebook_id;
    const page_access_token = metaUserData.pageAccessToken;

    if (!facebook_id || !page_access_token) {
      throw new Error("Facebook ID or Page Access Token missing in metadata");
    }

    // Extract image URL
    let image_url;
    if (postData.children && postData.children[0] && postData.children[0].images && postData.children[0].images[0]) {
      image_url = postData.children[0].images[0];
    } else if (postData.images && postData.images[0]) {
      image_url = postData.images[0];
    } else {
      throw new Error("No image URL found in the post data");
    }

    // Format the text for Facebook
    const formattedText = formatTextForFacebook(postData.text);

    // Upload photo without publishing
    const uploadResult = await uploadPhotoUnpublished(facebook_id, page_access_token, image_url);
    if (uploadResult.data.error) {
      throw new Error(`Error uploading image: ${uploadResult.data.error}`);
    }

    const photo_id = uploadResult.data.photo_id;

    // Update the document with the uploaded photo ID and formatted text, but do not publish
    const updateData = {
      facebookPhotoId: photo_id,
      postStatus: 'ready',  // Indicate that the post is ready but not published
      formattedText: formattedText,  // Store the formatted text in Firestore for future reference
      processingStatus: 'completed',
      processingEndTime: admin.firestore.FieldValue.serverTimestamp(),
      run: false,  // Reset run to false after processing
    };

    await admin.firestore().collection('posts').doc(postId).update(updateData);

    console.log(`Facebook Page Image post prepared successfully with photo ID: ${photo_id}.`);
    return { result: `Post prepared with photo ID: ${photo_id}` };
  } catch (error) {
    console.error(`Error handling Facebook Page Image post ${postId}:`, error);
    await admin.firestore().collection('posts').doc(postId).update({
      postStatus: 'failed',
      processingStatus: 'error',
      processingError: error.message,
      processingEndTime: admin.firestore.FieldValue.serverTimestamp(),
      run: false,  // Reset run to false after error
    });
    throw error;
  }
};

// Trigger function to watch for changes in the 'run' field
exports.watchRunFieldChange = functions.firestore
  .document('posts/{postId}')
  .onUpdate(async (change, context) => {
    const newData = change.after.data();
    const oldData = change.before.data();
    const postId = context.params.postId;

    // Check if 'run' has changed from false to true
    if (oldData.run === false && newData.run === true) {
      console.log(`Run status changed to true for post ${postId}. Starting processing.`);

      try {
        // Fetch metaUserData
        const metaUserDataDoc = await admin.firestore().collection("metaUserData").doc(newData.dealerId).get();
        const metaUserData = metaUserDataDoc.exists ? metaUserDataDoc.data() : null;

        if (!metaUserData) {
          throw new Error(`MetaUserData missing for dealerId: ${newData.dealerId}`);
        }

        // Process the post without publishing
        if (newData.postingType === 'facebookPageImage') {
          await handleFacebookPageImage(newData, postId, metaUserData);
        } else {
          throw new Error(`Unsupported posting type: ${newData.postingType}`);
        }

      } catch (error) {
        console.error(`Error processing post ${postId}:`, error);
        await change.after.ref.update({
          postStatus: 'failed',
          processingStatus: 'error',
          processingError: error.message,
          processingEndTime: admin.firestore.FieldValue.serverTimestamp(),
          run: false,
        });
      }
    } else {
      console.log(`No changes in run status or run is not true for post ${postId}. Skipping processing.`);
    }
  });

// Export the functions
exports.handleFacebookPageImage = handleFacebookPageImage;