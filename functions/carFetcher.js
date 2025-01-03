const axios = require('axios');

async function fetchCarsWithRetry(dealerId, apiKey, maxRetries = 3) {
  let attempts = 0;
  
  while (attempts < maxRetries) {
    try {
      const response = await axios.get(
        `https://api.autodesktop.dk/api/vehicles/${dealerId}`,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      return response.data;
    } catch (error) {
      attempts++;
      if (attempts === maxRetries) {
        throw new Error(`Failed to fetch cars after ${maxRetries} attempts: ${error.message}`);
      }
      // Vent 1 sekund mellem forsøg
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function fetchBiltorvetCarsWithRetry(dealerId, maxRetries = 3) {
  let attempts = 0;
  
  while (attempts < maxRetries) {
    try {
      const response = await axios.get(
        `https://api.biltorvet.dk/api/vehicles/dealer/${dealerId}`,
        {
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
      
      return response.data;
    } catch (error) {
      attempts++;
      if (attempts === maxRetries) {
        throw new Error(`Failed to fetch Biltorvet cars after ${maxRetries} attempts: ${error.message}`);
      }
      // Vent 1 sekund mellem forsøg
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

module.exports = {
  fetchCarsWithRetry,
  fetchBiltorvetCarsWithRetry
}; 