const axios = require("axios");
const admin = require('firebase-admin');

const searchAndReplace = (text, replacements) => {
  replacements.forEach(replacement => {
    if (replacement.use_regex) {
      text = text.replace(new RegExp(replacement.search, "gi"), replacement.replace_with);
    } else {
      text = text.replace(new RegExp(replacement.search, "g"), replacement.replace_with);
    }
  });
  return text;
};

// Import the configuration file
const config = require('./config');

const generateShortUrl = async (longUrl, userId) => {
  try {
    // 1. Først tjek om brugeren allerede har et tag i Firebase
    const userDoc = await admin.firestore().collection('users').doc(userId).get();
    let userTag;
    
    if (userDoc.exists && userDoc.data().dubTagId) {
      // Brug eksisterende tag ID fra Firebase
      userTag = { id: userDoc.data().dubTagId };
      console.log('Bruger dubTagId fra Firebase:', userTag.id);
    } else {
      // Hent alle tags fra Dub.co
      const tagsResponse = await axios.get('https://api.dub.co/tags', {
        headers: {
          'Authorization': `Bearer dub_uuPK2diVwXw4oVtWZVvGOQgE`,
        }
      });

      // Find eksisterende tag eller opret nyt
      if (Array.isArray(tagsResponse.data)) {
        userTag = tagsResponse.data.find(tag => tag.name === userId);
      } else if (Array.isArray(tagsResponse.data.tags)) {
        userTag = tagsResponse.data.tags.find(tag => tag.name === userId);
      }

      if (!userTag) {
        // Opret nyt tag
        try {
          const tagResponse = await axios.post('https://api.dub.co/tags', {
            name: userId,
            color: "blue"
          }, {
            headers: {
              'Authorization': `Bearer dub_uuPK2diVwXw4oVtWZVvGOQgE`,
              'Content-Type': 'application/json'
            }
          });
          userTag = tagResponse.data;
          
          // Gem det nye tag ID i Firebase
          await admin.firestore().collection('users').doc(userId).update({
            dubTagId: userTag.id
          });
          
          console.log('Nyt tag oprettet og gemt i Firebase:', userTag.id);
        } catch (error) {
          if (error.response?.data?.error?.code === 'conflict') {
            // Hvis tag allerede findes, hent det igen
            const refreshResponse = await axios.get('https://api.dub.co/tags', {
              headers: {
                'Authorization': `Bearer dub_uuPK2diVwXw4oVtWZVvGOQgE`,
              }
            });
            
            // Håndter både array og objekt response
            if (Array.isArray(refreshResponse.data)) {
              userTag = refreshResponse.data.find(tag => tag.name === userId);
            } else if (Array.isArray(refreshResponse.data.tags)) {
              userTag = refreshResponse.data.tags.find(tag => tag.name === userId);
            }
            
            console.log('Tag fundet efter conflict:', userTag);
          } else {
            throw error;
          }
        }
      } else {
        // Gem det fundne tag ID i Firebase
        await admin.firestore().collection('users').doc(userId).update({
          dubTagId: userTag.id
        });
        console.log('Eksisterende tag gemt i Firebase:', userTag.id);
      }
    }

    // Verificer at vi har et gyldigt tag
    if (!userTag || !userTag.id) {
      console.error('Kunne ikke finde eller oprette tag for userId:', userId);
      throw new Error('Tag ikke tilgængeligt');
    }

    // 2. Opret link med tag
    const linkData = {
      url: longUrl,
      domain: "selink.dk",
      publicStats: false,
      tagIds: [userTag.id]
    };

    console.log('Opretter link med data:', JSON.stringify(linkData, null, 2));

    const response = await axios.post('https://api.dub.co/links', linkData, {
      headers: {
        'Authorization': `Bearer dub_uuPK2diVwXw4oVtWZVvGOQgE`,
        'Content-Type': 'application/json'
      }
    });

    console.log("Link oprettet med response:", JSON.stringify(response.data, null, 2));

    if (response.data && response.data.key) {
      return `https://selink.dk/${response.data.key}`;
    } else if (response.data && response.data.data && response.data.data.key) {
      return `https://selink.dk/${response.data.data.key}`;
    }
    
    throw new Error('Kunne ikke finde kort URL i response');
    
  } catch (error) {
    console.error("Fejl ved generering af kort URL:", error.response?.data || error.message);
    return longUrl;
  }
};

const processText = async (data) => {
  console.log("processText called with data:", JSON.stringify(data));
  try {
    const { text, longUrl, userId } = data;
    
    if (!userId) {
      console.error("Intet userId modtaget");
      throw new Error('userId er påkrævet');
    }

    console.log("Generating short URL for:", longUrl, "with userId:", userId);
    const shortUrl = await generateShortUrl(longUrl, userId);
    console.log("Generated short URL:", shortUrl);

    const replacements = [
      { search: /(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi, replace_with: shortUrl, use_regex: true },
    ];

    console.log("Applying text replacements");
    const processedText = searchAndReplace(text, replacements);
    console.log("Processed text:", processedText);

    const result = {
      newText: processedText,
      newShortUrl: shortUrl,
    };
    console.log("Returning result from processText:", JSON.stringify(result));
    return result;
  } catch (error) {
    console.error("Error in processText:", error);
    throw error;
  }
};

module.exports = processText;