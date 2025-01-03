const functions = require('firebase-functions');
const admin = require('firebase-admin');

exports.createRecurringInvoices = functions.pubsub.schedule('0 0 * * *').onRun(async (context) => {
  const db = admin.firestore();
  const now = new Date();

  try {
    // Hent alle brugere med recurring invoices
    const usersSnapshot = await db.collection('users')
      .where('hasRecurringInvoice', '==', true)
      .get();

    console.log(`Fandt ${usersSnapshot.size} brugere med recurring invoices`);

    for (const userDoc of usersSnapshot.docs) {
      const userData = userDoc.data();
      
      // Tjek om nextInvoiceDate er defineret og er mindre end eller lig med nu
      if (!userData.nextInvoiceDate) {
        console.log(`Bruger ${userDoc.id} mangler nextInvoiceDate - springer over`);
        continue;
      }

      const nextInvoiceDate = userData.nextInvoiceDate.toDate();
      
      // Hvis det ikke er tid til ny faktura endnu, spring over
      if (nextInvoiceDate > now) {
        console.log(`Ikke tid til ny faktura for bruger ${userDoc.id} endnu. Næste dato: ${nextInvoiceDate}`);
        continue;
      }

      console.log(`Opretter ny faktura for bruger ${userDoc.id}`);

      // Beregn priser baseret på brugertype
      let basePrice = userData.role === 2 ? 14995 : 2995; // Admin eller normal bruger
      let items = [{
        description: userData.role === 2 
          ? 'System abonnement - månedlig administrator licens'
          : 'System abonnement - månedlig licens',
        quantity: 1,
        rate: basePrice,
        amount: basePrice
      }];

      // Hvis det er en admin, tilføj pris for ekstra brugere
      if (userData.role === 2) {
        const userCount = (await db.collection('users')
          .where('createdBy', '==', userDoc.id)
          .where('role', '==', 3)
          .get()).size;

        if (userCount > 0) {
          const userLicensePrice = 495 * userCount;
          items.push({
            description: `Bruger licenser (${userCount} brugere)`,
            quantity: userCount,
            rate: 495,
            amount: userLicensePrice
          });
          basePrice += userLicensePrice;
        }
      }

      const invoiceData = {
        type: 'system',
        createdAt: now,
        dueDate: new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000), // 8 dage
        invoiceNumber: `INV-${now.getFullYear().toString().substr(-2)}${(now.getMonth() + 1).toString().padStart(2, '0')}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`,
        status: 'udstedt',
        items,
        subtotal: basePrice,
        tax: basePrice * 0.25,
        total: basePrice * 1.25,
        customerInfo: {
          name: userData.name || '',
          address: userData.address || '',
          phone: userData.phone || '',
          email: userData.email || '',
          cvr: userData.cvr || ''
        },
        recurring: true
      };

      // Opret ny faktura
      await db.collection('users').doc(userDoc.id)
        .collection('invoices').add(invoiceData);

      // Opdater nextInvoiceDate til næste måned
      const nextMonth = new Date(nextInvoiceDate);
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      
      await userDoc.ref.update({
        nextInvoiceDate: nextMonth,
        lastInvoiceDate: now
      });

      console.log(`Faktura oprettet og nextInvoiceDate opdateret for bruger ${userDoc.id}`);
    }

    console.log('Recurring invoices process completed successfully');
    return null;
  } catch (error) {
    console.error('Error creating recurring invoices:', error);
    throw error;
  }
}); 