const functions = require('firebase-functions');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

exports.simulateFetchAndStoreCars = functions.https.onRequest(async (request, response) => {
  if (request.method !== 'POST') {
    response.status(405).send('Metode ikke tilladt');
    return;
  }

  const db = admin.firestore();
  const { userId, existingCars, newCars } = request.body;

  if (!userId || !Array.isArray(existingCars) || !Array.isArray(newCars)) {
    response.status(400).send('Ugyldig anmodning. Sørg for at inkludere userId, existingCars og newCars.');
    return;
  }

  try {
    const newVehicles = [];
    const newPriceVehicles = [];
    const soldVehicles = [];
    const daysForSaleVehicles = [];

    // Sammenlign eksisterende og nye biler
    for (const newCar of newCars) {
      const existingCar = existingCars.find(car => car.id === newCar.id);
      
      if (!existingCar) {
        newVehicles.push(newCar);
      } else if (existingCar.priceInt !== newCar.priceInt) {
        newPriceVehicles.push(newCar);
      }

      // Tjek dage til salg
      const createdDate = new Date(newCar.createdDate);
      const today = new Date();
      const daysSinceCreated = Math.floor((today - createdDate) / (1000 * 60 * 60 * 24));
      if (daysSinceCreated > 0 && daysSinceCreated % 15 === 0 && daysSinceCreated <= 365) {
        daysForSaleVehicles.push({ ...newCar, daysForSale: daysSinceCreated });
      }
    }

    // Find solgte biler
    for (const existingCar of existingCars) {
      if (!newCars.some(car => car.id === existingCar.id)) {
        soldVehicles.push(existingCar);
      }
    }

    // Opdater dealerCars
    const batch = db.batch();
    for (const car of newCars) {
      const carRef = db.collection('users').doc(userId).collection('dealerCars').doc(car.id.toString());
      batch.set(carRef, car, { merge: true });
    }

    // Slet gamle collections og opret nye hvis der er data
    const collections = [
      { name: 'newVehicles', data: newVehicles },
      { name: 'newPriceVehicles', data: newPriceVehicles },
      { name: 'soldVehicles', data: soldVehicles },
      { name: 'daysForSaleVehicles', data: daysForSaleVehicles }
    ];

    for (const collection of collections) {
      const collectionRef = db.collection('users').doc(userId).collection(collection.name);
      
      // Slet eksisterende dokumenter i collectionen
      const existingDocs = await collectionRef.get();
      existingDocs.forEach(doc => {
        batch.delete(doc.ref);
      });

      // Tilføj nye dokumenter, hvis der er data
      if (collection.data.length > 0) {
        collection.data.forEach(item => {
          const docRef = collectionRef.doc(item.id.toString());
          batch.set(docRef, item);
        });
      }
    }

    await batch.commit();

    response.status(200).json({
      message: 'Simulering gennemført',
      stats: {
        totalCars: newCars.length,
        newVehicles: newVehicles.length,
        newPriceVehicles: newPriceVehicles.length,
        soldVehicles: soldVehicles.length,
        daysForSaleVehicles: daysForSaleVehicles.length
      }
    });
  } catch (error) {
    console.error('Fejl ved simulering:', error);
    response.status(500).send('Intern serverfejl');
  }
});
