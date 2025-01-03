const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');
const config = require('./config');

// Hent Facebook insights for et opslag
async function getFacebookInsights(pageAccessToken, postId) {
  try {
    const measurements = "post_impressions_unique,post_engagements,post_clicks,post_reactions_like_total";
    const url = `https://graph.facebook.com/${postId}?fields=insights.metric(${measurements})&access_token=${pageAccessToken}`;
    
    const response = await axios.get(url);
    
    if (response.data && response.data.insights && response.data.insights.data) {
      return response.data.insights.data;
    }
    
    return null;
  } catch (error) {
    console.error(`Fejl ved hentning af Facebook insights for post ${postId}:`, error);
    return null;
  }
}

// Aggreger insights data
function aggregateInsightsData(insightsData) {
  const aggregatedData = {
    post_impressions_unique: 0,
    post_clicks: 0,
    post_reactions_like_total: 0,
    post_engagements: 0
  };

  if (!Array.isArray(insightsData)) return aggregatedData;

  insightsData.forEach(insight => {
    if (insight.values && insight.values[0]) {
      aggregatedData[insight.name] = insight.values[0].value;
    }
  });

  return aggregatedData;
}

// Hent Instagram insights for et opslag
async function getInstagramInsights(accessToken, mediaId) {
  try {
    // Først, hent media type
    const mediaResponse = await axios.get(
      `https://graph.facebook.com/${config.meta.version}/${mediaId}`, {
      params: {
        fields: 'media_type,media_product_type',
        access_token: accessToken
      }
    });

    // Vælg metrics baseret på media type og product type
    let metrics;
    const mediaType = mediaResponse.data.media_type;
    const productType = mediaResponse.data.media_product_type;

    if (mediaType === 'VIDEO' || productType === 'REELS') {
      metrics = 'reach,plays,saved,total_interactions';  // Opdateret til korrekte video/reels metrics
    } else {
      metrics = 'impressions,reach,saved,total_interactions';
    }

    // Hent insights med de korrekte metrics
    const response = await axios.get(
      `https://graph.facebook.com/${config.meta.version}/${mediaId}/insights`, {
      params: {
        metric: metrics,
        access_token: accessToken
      }
    });

    return response.data?.data || null;

  } catch (error) {
    console.error('Fejl ved hentning af Instagram insights:', {
      mediaId,
      error: error.response?.data?.error
    });
    return null;
  }
}

// Aggreger Instagram insights data
function aggregateInstagramInsights(insights) {
  const analytics = {
    impressions: 0,
    reach: 0,
    saved: 0,
    total_interactions: 0
  };

  insights.forEach(metric => {
    switch (metric.name) {
      case 'impressions':
      case 'reach':
      case 'saved':
        analytics[metric.name] = metric.values[0]?.value || 0;
        break;
      case 'total_interactions':
      case 'engagement':  // Håndterer både video og billede engagement
        analytics.total_interactions = metric.values[0]?.value || 0;
        break;
    }
  });

  return analytics;
}

// Tilføj konstanter for batch begrænsninger
const BATCH_SIZE = 50; // Facebook tillader op til 50 requests i én batch
const DELAY_BETWEEN_BATCHES = 1000; // 1 sekund mellem hver batch

// Hjælpefunktion til at dele array op i mindre batches
function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Hjælpefunktion til at vente mellem requests
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Opdater batchFacebookInsights funktionen
async function batchFacebookInsights(pageAccessToken, postIds) {
  try {
    const results = [];
    const batches = chunkArray(postIds, BATCH_SIZE);
    
    for (const batchPostIds of batches) {
      const batch = batchPostIds.map(postId => ({
        method: 'GET',
        relative_url: `${postId}?fields=insights.metric(post_impressions_unique,post_engagements,post_clicks,post_reactions_like_total)`
      }));

      const response = await axios.post(
        'https://graph.facebook.com',
        {
          batch: JSON.stringify(batch),
          access_token: pageAccessToken,
          include_headers: true // Tilføj headers for at se rate limit info
        },
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }
      );

      // Tjek rate limit headers
      const rateLimit = response.headers['x-fb-ads-insights-throttle'];
      if (rateLimit) {
        const { app_id_util_pct, acc_id_util_pct } = JSON.parse(rateLimit);
        console.log('Rate limit status:', { app_id_util_pct, acc_id_util_pct });
        
        // Hvis vi nærmer os grænsen, vent længere
        if (app_id_util_pct > 80 || acc_id_util_pct > 80) {
          await delay(DELAY_BETWEEN_BATCHES * 2);
        }
      }

      results.push(...response.data.map(item => {
        if (!item.body) return null;
        const body = JSON.parse(item.body);
        return body.insights?.data || null;
      }));

      // Vent mellem batches for at undgå rate limiting
      await delay(DELAY_BETWEEN_BATCHES);
    }

    return results;
  } catch (error) {
    console.error('Fejl ved batch Facebook insights:', error);
    if (error.response?.data?.error?.code === 4) {
      // Håndter rate limiting fejl
      console.log('Rate limit nået, venter før næste forsøg');
      await delay(DELAY_BETWEEN_BATCHES * 5);
      // Kunne implementere retry logik her
    }
    return new Array(postIds.length).fill(null);
  }
}

// Opdater batchInstagramInsights funktionen på samme måde
async function batchInstagramInsights(accessToken, mediaIds) {
  try {
    const results = [];
    const batches = chunkArray(mediaIds, BATCH_SIZE);
    
    for (const batchMediaIds of batches) {
      // Først hent media types
      const mediaTypesBatch = batchMediaIds.map(mediaId => ({
        method: 'GET',
        relative_url: `${config.meta.version}/${mediaId}?fields=media_type,media_product_type`
      }));

      const mediaTypesResponse = await axios.post(
        'https://graph.facebook.com',
        {
          batch: JSON.stringify(mediaTypesBatch),
          access_token: accessToken,
          include_headers: true
        },
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }
      );

      // Opret insights batch baseret på media types
      const insightsBatch = mediaTypesResponse.data.map((item, index) => {
        if (!item.body) return null;
        const mediaData = JSON.parse(item.body);
        const metrics = (mediaData.media_type === 'VIDEO' || mediaData.media_product_type === 'REELS')
          ? 'reach,plays,saved,total_interactions'
          : 'impressions,reach,saved,total_interactions';

        return {
          method: 'GET',
          relative_url: `${config.meta.version}/${batchMediaIds[index]}/insights?metric=${metrics}`
        };
      });

      // Vent mellem media type og insights requests
      await delay(DELAY_BETWEEN_BATCHES);

      const insightsResponse = await axios.post(
        'https://graph.facebook.com',
        {
          batch: JSON.stringify(insightsBatch.filter(Boolean)),
          access_token: accessToken,
          include_headers: true
        },
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }
      );

      results.push(...insightsResponse.data.map(item => {
        if (!item.body) return null;
        const body = JSON.parse(item.body);
        return body.data || null;
      }));

      await delay(DELAY_BETWEEN_BATCHES);
    }

    return results;
  } catch (error) {
    console.error('Fejl ved batch Instagram insights:', error);
    return new Array(mediaIds.length).fill(null);
  }
}

// Hovedfunktion til at hente og gemme analytics
exports.fetchAndStoreSocialAnalytics = async (userId) => {
  try {
    const db = admin.firestore();
    
    // Hent user document med MetaSettings
    const userDoc = await db.collection('users').doc(userId).get();
    
    if (!userDoc.exists || !userDoc.data().MetaSettings) {
      throw new Error('MetaSettings ikke fundet for bruger');
    }

    const { 
      page_access_token: pageAccessToken,
      facebookPageId,
      instagramBusinessAccountId
    } = userDoc.data().MetaSettings;

    if (!pageAccessToken) {
      throw new Error('Page access token ikke fundet i MetaSettings');
    }

    console.log(`Fundet Meta credentials for bruger ${userId}:`, {
      hasFacebookId: !!facebookPageId,
      hasInstagramId: !!instagramBusinessAccountId
    });
    
    // Hent ALLE posts fra postSend collection
    const postsSnapshot = await db.collection('postSend')
      .where('id', '==', userId)
      .get();

    console.log(`Fandt ${postsSnapshot.size} opslag for bruger ${userId}`);

    let totalFacebookAnalytics = {
      post_impressions_unique: 0,
      post_clicks: 0,
      post_reactions_like_total: 0,
      post_engagements: 0,
      total_posts: 0
    };

    let totalInstagramAnalytics = {
      impressions: 0,
      reach: 0,
      video_views: 0,
      saved: 0,
      total_interactions: 0,
      total_posts: 0
    };

    const processedFacebookPosts = [];
    const processedInstagramPosts = [];

    // Gennemgå hver post
    let processedCount = 0;
    for (const postDoc of postsSnapshot.docs) {
      processedCount++;
      const postData = postDoc.data();
      
      // Log post detaljer
      console.log(`Behandler opslag ${processedCount}/${postsSnapshot.size}:`, {
        id: postDoc.id,
        postFB: postData.postFB,
        postIG: postData.postIG,
        postId: postData.postId,
        facebookPostId: postData.facebookPostId,
        instagramPostId: postData.instagramPostId
      });

      const postAnalytics = {
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      };
      
      // Håndter Facebook posts - tjek begge mulige ID felter
      const fbPostId = postData.facebookPostId || postData.postId;
      if (fbPostId) {
        console.log(`Behandler Facebook post: ${fbPostId}`);
        processedFacebookPosts.push(fbPostId);
        
        try {
          const insights = await getFacebookInsights(pageAccessToken, fbPostId);
          if (insights) {
            const fbAnalytics = aggregateInsightsData(insights);
            postAnalytics.facebook = fbAnalytics;
            
            Object.keys(fbAnalytics).forEach(key => {
              if (key in totalFacebookAnalytics) {
                totalFacebookAnalytics[key] += fbAnalytics[key];
              }
            });
            totalFacebookAnalytics.total_posts++;
            console.log(`Facebook insights hentet for post ${postDoc.id}`);
          } else {
            console.warn(`Ingen insights fundet for Facebook post: ${fbPostId}`);
          }
        } catch (error) {
          console.error(`Fejl ved hentning af Facebook insights for post ${postDoc.id}:`, error);
        }
      }

      // Håndter Instagram posts
      if (postData.instagramPostId) {
        console.log(`Behandler Instagram post: ${postData.instagramPostId}`);
        processedInstagramPosts.push(postData.instagramPostId);
        
        try {
          const insights = await getInstagramInsights(pageAccessToken, postData.instagramPostId);
          if (insights) {
            const igAnalytics = aggregateInstagramInsights(insights);
            postAnalytics.instagram = igAnalytics;
            
            Object.keys(igAnalytics).forEach(key => {
              if (key in totalInstagramAnalytics) {
                totalInstagramAnalytics[key] += igAnalytics[key];
              }
            });
            totalInstagramAnalytics.total_posts++;
            console.log(`Instagram insights hentet for post ${postDoc.id}`);
          } else {
            console.warn(`Ingen insights fundet for Instagram post: ${postData.instagramPostId}`);
          }
        } catch (error) {
          console.error(`Fejl ved hentning af Instagram insights for post ${postDoc.id}:`, error);
        }
      }

      // Gem analytics på det individuelle postSend dokument
      if (postAnalytics.facebook || postAnalytics.instagram) {
        try {
          await postDoc.ref.update({
            analytics: postAnalytics
          });
          console.log(`Opdaterede analytics for post ${postDoc.id}`);
        } catch (error) {
          console.error(`Fejl ved opdatering af analytics for post ${postDoc.id}:`, error);
        }
      } else {
        console.log(`Ingen analytics at gemme for post ${postDoc.id}`);
      }
    }

    console.log(`Behandling af opslag afsluttet. Behandlede ${processedCount} af ${postsSnapshot.size} opslag`);
    console.log('Facebook posts behandlet:', processedFacebookPosts.length);
    console.log('Instagram posts behandlet:', processedInstagramPosts.length);

    // Saml alle IDs først
    const facebookPostIds = postsSnapshot.docs
      .map(doc => doc.data().facebookPostId || doc.data().postId)
      .filter(Boolean);
    
    const instagramPostIds = postsSnapshot.docs
      .map(doc => doc.data().instagramPostId)
      .filter(Boolean);

    console.log(`Behandler ${facebookPostIds.length} Facebook posts og ${instagramPostIds.length} Instagram posts i batches`);

    // Hent data i batches
    const [facebookResults, instagramResults] = await Promise.all([
      batchFacebookInsights(pageAccessToken, facebookPostIds),
      batchInstagramInsights(pageAccessToken, instagramPostIds)
    ]);

    // Gem total analytics i users collection uden processedPosts
    const analyticsRef = db.collection('users').doc(userId).collection('analytics').doc('meta');
    await analyticsRef.set({
      facebook: totalFacebookAnalytics,
      instagram: totalInstagramAnalytics,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return {
      facebook: totalFacebookAnalytics,
      instagram: totalInstagramAnalytics
    };

  } catch (error) {
    console.error('Fejl i fetchAndStoreSocialAnalytics:', error);
    throw error;
  }
};

// HTTP endpoint til at hente analytics
exports.getSocialAnalytics = functions.https.onRequest((req, res) => {
  res.set('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'GET');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '3600');
    res.status(204).send('');
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const userId = req.query.userId;
  if (!userId) {
    res.status(400).json({ error: 'userId er påkrævet' });
    return;
  }

  exports.fetchAndStoreSocialAnalytics(userId)
    .then(analytics => {
      res.status(200).json({ success: true, data: analytics });
    })
    .catch(error => {
      console.error('Fejl ved hentning af analytics:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    });
});
