const express = require("express");
const axios = require("axios");
const cors = require("cors");
const config = require('./config');
const app = express();
app.use(cors());

// Use environment variables to dynamically set the PORT and Access Token for security
const PORT = process.env.PORT || 3001;
const access_token =
  process.env.FB_ACCESS_TOKEN ||
  "EAAvJ5UcfHO0BO7K2UszzETpG4qlZCYqVui9fKzjxmDMdH08OFJX5V4e2LEPnOoF2tDgng9ge1WYBcrRXlZCbHiKfENo1hsaNABFpAPzlmqXfdd5fHvLIZCJiN8CcWILGrFj2f1wYo2kSveWZASzciQdGGJeQ0wH17DSZCs38T6xeTXsy96ZAIhZBppdRJmw"; // Set this in production environment

app.get("/api/get-ad-preview", async (req, res) => {
  const creative_id = req.query.creative_id;

  if (!creative_id) {
    return res.status(400).send({ error: "Missing creative_id" });
  }

  try {
    // Make the request to the Facebook Graph API
    const response = await axios.get(
      `https://graph.facebook.com/${config.meta.version}/${creative_id}/previews`,
      {
        params: {
          ad_format: "DESKTOP_FEED_STANDARD", // Adjust the format if needed
          access_token: access_token, // User Access Token
        },
      },
    );

    // Check if the response contains the preview data
    if (response.data && response.data.data && response.data.data.length > 0) {
      const preview = response.data.data[0].body; // Get the iframe preview HTML
      res.json({ preview }); // Send the preview back to the frontend
    } else {
      res
        .status(404)
        .send({ error: "Preview not available for this creative." });
    }
  } catch (error) {
    console.error(
      "Error fetching ad preview:",
      error.response ? error.response.data : error.message,
    );

    // Handle errors and return appropriate messages
    if (error.response && error.response.status === 403) {
      res
        .status(403)
        .send("Permission denied. Ensure you have all required permissions.");
    } else if (error.response && error.response.status === 400) {
      res.status(400).send("Bad Request: " + error.response.data.error.message);
    } else {
      res.status(500).send("Failed to fetch ad preview.");
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} or production`);
});
