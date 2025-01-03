const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

exports.loadDataToFirestore = functions.https.onRequest(async (req, res) => {
  // Enable CORS
  res.set("Access-Control-Allow-Origin", "*");

  if (req.method === "OPTIONS") {
    // Send response to OPTIONS requests
    res.set("Access-Control-Allow-Methods", "POST");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Max-Age", "3600");
    res.status(204).send("");
    return;
  }

  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    const data = req.body;

    if (!data || Object.keys(data).length === 0) {
      res.status(400).send("No data provided");
      return;
    }

    const db = admin.firestore();
    const batch = db.batch();

    // Assuming the data structure is similar to your Python script
    for (const [date, items] of Object.entries(data)) {
      for (const item of items) {
        const docRef = db.collection("posts").doc(); // Generate a new document ID
        batch.set(docRef, {
          ...item,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          publishDate: date,
        });
      }
    }

    await batch.commit();

    res
      .status(200)
      .json({ message: "Data successfully loaded into Firestore" });
  } catch (error) {
    console.error("Error loading data to Firestore:", error);
    res.status(500).json({ error: "Failed to load data to Firestore" });
  }
});
