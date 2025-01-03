const axios = require('axios');
const admin = require('firebase-admin');
const config = require('./config');

async function publishFacebookPost(postData) {
  const { pageAccessToken, creative_id, videoId } = postData;

  if (!pageAccessToken || !creative_id) {
    throw new Error('pageAccessToken eller creative_id mangler');
  }

  const retries = 5;
  const waitSeconds = 10;
  let effectiveObjectStoryId = null;

  for (let i = 0; i < retries; i++) {
    try {
      const detailsResponse = await axios.get(`https://graph.facebook.com/${config.meta.version}/${creative_id}`, {
        params: {
          fields: 'effective_object_story_id',
          access_token: pageAccessToken
        }
      });

      if (detailsResponse.data.effective_object_story_id) {
        effectiveObjectStoryId = detailsResponse.data.effective_object_story_id;
        console.log(`effective_object_story_id fundet: ${effectiveObjectStoryId}`);
        break;
      } else {
        console.log(`effective_object_story_id ikke fundet, forsøger igen om ${waitSeconds} sekunder.`);
        await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
      }
    } catch (error) {
      console.error('Fejl ved hentning af effective_object_story_id:', error);
    }
  }

  if (!effectiveObjectStoryId) {
    throw new Error('Kunne ikke finde effective_object_story_id efter flere forsøg.');
  }

  try {
    let publishEndpoint;
    let publishParams;

    if (videoId) {
      publishEndpoint = `https://graph.facebook.com/${config.meta.version}/${effectiveObjectStoryId}`;
      publishParams = {
        is_published: 'true',
        access_token: pageAccessToken,
        video_id: videoId
      };
      console.log('Publicerer video post med videoId:', videoId);
    } else {
      publishEndpoint = `https://graph.facebook.com/${config.meta.version}/${effectiveObjectStoryId}`;
      publishParams = {
        is_published: 'true',
        access_token: pageAccessToken
      };
      console.log('Publicerer almindelig post');
    }

    const publishResponse = await axios.post(publishEndpoint, null, {
      params: publishParams
    });

    console.log('Publish response:', publishResponse.data);

    if (publishResponse.data.success || publishResponse.data.id) {
      const storyIds = effectiveObjectStoryId.split('_');
      return {
        pageId: storyIds[0],
        storyId: storyIds[1],
        postId: effectiveObjectStoryId,
        isVideo: !!videoId
      };
    } else {
      throw new Error('Fejl ved publicering: ' + JSON.stringify(publishResponse.data));
    }
  } catch (error) {
    console.error('Fejl ved publicering:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = { publishFacebookPost };