const axios = require('axios');
const admin = require('firebase-admin');
const config = require('./config');

async function makeRequestWithRetry(url, method = 'get', options = {}, maxAttempts = 5, delay = 10) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await axios({
        method,
        url,
        ...options
      });

      if (response.status === 200) {
        return response.data;
      }
      
      console.log(`Forsøg ${attempt + 1}: Status kode ${response.status}, prøver igen om ${delay} sekunder.`);
    } catch (error) {
      console.error(`Forsøg ${attempt + 1}: Fejl opstod:`, error.message);
      if (attempt === maxAttempts - 1) throw error;
    }
    
    await new Promise(resolve => setTimeout(resolve, delay * 1000 * (2 ** attempt)));
  }
  
  return null;
}

async function getMediaInfo(mediaId, accessToken) {
  const url = `https://graph.facebook.com/${config.meta.version}/${mediaId}`;
  const params = {
    fields: 'id,permalink,shortcode,caption,media_url',
    access_token: accessToken
  };

  const response = await makeRequestWithRetry(url, 'get', { params });
  return response;
}

async function publishInstagramPost(postData) {
  const { instagram_id, pageAccessToken, instagramMediaId } = postData;

  if (!instagram_id || !pageAccessToken || !instagramMediaId) {
    throw new Error('Manglende påkrævede parametre: instagram_id, pageAccessToken eller instagramMediaId');
  }

  try {
    // Publicer mediet
    const publishUrl = `https://graph.facebook.com/${config.meta.version}/${instagram_id}/media_publish`;
    const publishData = {
      creation_id: instagramMediaId,
      access_token: pageAccessToken
    };

    const publishResponse = await makeRequestWithRetry(publishUrl, 'post', { data: publishData });

    if (!publishResponse || !publishResponse.id) {
      throw new Error('Fejl ved publicering af Instagram opslag');
    }

    // Hent detaljeret information om det publicerede medie
    const mediaInfo = await getMediaInfo(publishResponse.id, pageAccessToken);

    // Bestem om det er en video baseret på media_url
    const isVideo = mediaInfo?.media_url?.toLowerCase().includes('.mp4');

    return {
      result: {
        instagram_id,
        media_id: instagramMediaId,
        published_id: publishResponse.id,
        permalink: mediaInfo?.permalink,
        shortcode: mediaInfo?.shortcode,
        media_url: mediaInfo?.media_url,
        caption: mediaInfo?.caption,
        isVideo,
        status: 'Success'
      }
    };

  } catch (error) {
    console.error('Fejl i publishInstagramPost:', error);
    throw error;
  }
}

module.exports = { publishInstagramPost };
