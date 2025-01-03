const admin = require('firebase-admin');
const axios = require('axios');
const config = require('./config');

// Helper function to make requests with retry logic
const makeRequestWithRetry = async (url, method = 'get', data = null, headers = null, maxAttempts = 3, delay = 20) => {
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

// Function to create image container for Instagram
const createImageContainerForInstagram = async (data, metaUserData) => {
  try {
    const { image_url, caption } = data;
    console.log(`Creating image container for Instagram from URL: ${image_url}`);

    // Validate metaUserData
    if (!metaUserData || !metaUserData.instagram_id || !metaUserData.pageAccessToken) {
      console.error('Invalid metaUserData:', JSON.stringify(metaUserData));
      throw new Error('Manglende Instagram konfiguration');
    }

    const containerUrl = `https://graph.facebook.com/${config.meta.version}/${metaUserData.instagram_id}/media`;
    const containerPayload = {
      image_url: image_url,
      caption: caption,
      access_token: metaUserData.pageAccessToken
    };
    
    const containerResponse = await makeRequestWithRetry(containerUrl, 'post', containerPayload);
    if (!containerResponse || !containerResponse.data || !containerResponse.data.id) {
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

// Function to process Instagram post
const processInstagramPost = async (postData, postId) => {
  console.log(`Processing Instagram post ${postId}`);

  try {
    const instagramContainerIds = [];
    
    // Sikrer at vi har et userId
    if (!postData.id) {
      throw new Error('User ID (id) mangler i postData');
    }

    // Behandl teksten med userId
    const processedText = await processText({
      text: postData.text,
      longUrl: postData.caseUrl,
      userId: postData.id  // Tilføj userId her
    });

    if (postData.children && postData.children.length > 0) {
      for (const child of postData.children) {
        if (child.images && child.images.length > 0) {
          for (let i = 0; i < child.images.length; i++) {
            const imageUrl = child.images[i];
            console.log(`Processing image ${i + 1}: ${imageUrl}`);

            const result = await createImageContainerForInstagram({
              image_url: imageUrl,
              caption: i === 0 ? processedText.newText : '' // Brug den behandlede tekst
            }, postData.id); // Brug id som dealerId

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
        postStatus: 'allImagesProcessed'
      });

      console.log(`All images processed and document updated. Container IDs: ${instagramContainerIds.join(', ')}`);
    } else {
      throw new Error('No children found with images for Instagram post');
    }

    return instagramContainerIds;
  } catch (error) {
    console.error(`Error processing Instagram post ${postId}:`, error);
    await admin.firestore().collection('posts').doc(postId).update({
      postStatus: 'containerCreationFailed',
      containerCreationError: error.message
    });
    throw error;
  }
};

module.exports = {
  processInstagramPost,
  createImageContainerForInstagram
};