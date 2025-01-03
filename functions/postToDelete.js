const functions = require("firebase-functions");
const admin = require('firebase-admin');

// Initialiser Firebase Admin, hvis det ikke allerede er gjort
if (!admin.apps.length) {
  admin.initializeApp();
}

// Planlagt funktion til at tjekke og flytte posts baseret på dealerCars
exports.checkAndMoveDeletedCarPosts = functions.pubsub
  .schedule('0 7 * * *') // Cron job for hver dag kl. 07.00
  .timeZone('Europe/Copenhagen')
  .onRun(async (context) => {
    const db = admin.firestore();
    console.log('Starter tjek af slettede biler i postSend');

    try {
      // Hent alle dokumenter fra postSend
      const postSendSnapshot = await db.collection('postSend').get();

      for (const postDoc of postSendSnapshot.docs) {
        const postData = postDoc.data();
        const userId = postData.id; // Dette er brugerens Firebase UID
        
        if (!userId) {
          console.log(`Springer over post ${postDoc.id} - mangler bruger ID`);
          continue;
        }

        // Find alle URLs fra posten (både direkte og i children)
        const urls = new Set();
        
        // Tjek direkte caseUrl
        if (postData.caseUrl) {
          urls.add(postData.caseUrl);
        }

        // Tjek children for caseUrls
        if (postData.children && Array.isArray(postData.children)) {
          postData.children.forEach(child => {
            if (child.caseUrl) {
              urls.add(child.caseUrl);
            }
          });
        }

        // Hvis ingen URLs blev fundet, fortsæt til næste post
        if (urls.size === 0) {
          console.log(`Ingen URLs fundet i post ${postDoc.id}`);
          continue;
        }

        // Tjek om nogle af bilerne ikke længere findes i dealerCars
        let shouldMove = false;
        const missingUrls = [];
        
        for (const url of urls) {
          try {
            const dealerCarsSnapshot = await db.collection('users')
              .doc(userId)
              .collection('dealerCars')
              .where('url', '==', url)
              .get();

            if (dealerCarsSnapshot.empty) {
              console.log(`Bil med URL ${url} findes ikke længere i dealerCars for bruger ${userId}`);
              shouldMove = true;
              missingUrls.push(url);
            } else {
              console.log(`Bil med URL ${url} findes stadig i dealerCars for bruger ${userId}`);
            }
          } catch (error) {
            console.error(`Fejl ved tjek af bil med URL ${url}:`, error);
          }
        }

        // Hvis mindst én bil er væk, dupliker posten til postToDelete
        if (shouldMove) {
          try {
            // Tilføj ekstra metadata før duplikering
            const postToDelete = {
              ...postData,
              originalPostId: postDoc.id,
              movedAt: admin.firestore.FieldValue.serverTimestamp(),
              reason: 'car_no_longer_exists',
              affectedUrls: missingUrls,
              originalCollection: 'postSend'
            };

            // Opret dokument i postToDelete
            await db.collection('postToDelete').add(postToDelete);

            console.log(`Post ${postDoc.id} duplikeret til postToDelete. Manglende biler med URLs: ${missingUrls.join(', ')}`);
          } catch (error) {
            console.error(`Fejl ved duplikering af post ${postDoc.id}:`, error);
          }
        }
      }

      console.log('Færdig med at tjekke slettede biler i postSend');
      return null;
    } catch (error) {
      console.error('Fejl i checkAndMoveDeletedCarPosts:', error);
      return null;
    }
  });
