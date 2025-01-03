const { google } = require('googleapis');
const config = require('./config'); // Importér dine statiske credentials fra config.js

async function authorize() {
  try {
    const credentials = config.googleSheets.serviceAccount; // Hent credentials fra config.js
    const client = new google.auth.JWT(
      credentials.client_email,
      null,
      credentials.private_key.replace(/\\n/g, '\n'), // Sørg for korrekt formatering af private_key
      ['https://www.googleapis.com/auth/spreadsheets.readonly']
    );
    return client;
  } catch (error) {
    console.error('Fejl ved autorisation:', error);
    throw error;
  }
}

/**
 * Henter data fra det specificerede Google Sheets dokument.
 * @param {string} spreadsheetId - ID'et på Google Sheets dokumentet.
 * @param {string} range - Området i regnearket, f.eks. 'Sheet1!A2:A100'.
 */
async function getDataFromGoogleSheets(spreadsheetId, range) {
  const auth = await authorize();
  const sheets = google.sheets({ version: 'v4', auth });
  
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });
    return response.data.values;
  } catch (err) {
    console.error('API fejl:', err);
    throw err;
  }
}

/**
 * Integrerer data fra Google Sheets med benchmarker data.
 * @param {Object} benchmarkerData - Eksisterende benchmarker data.
 */
async function integrateGoogleSheetsData(benchmarkerData) {
  const spreadsheetId = config.googleSheets.spreadsheetId; // Brug det ID fra din config.js
  const range = 'A2:E100'; // Vi justerer dette område til de faktiske kolonner du bruger (A til E)

  try {
    const sheetsData = await getDataFromGoogleSheets(spreadsheetId, range);
    
    // Antager at første række er overskrifter
    const headers = sheetsData[0];
    const data = sheetsData.slice(1);

    // Find den relevante række baseret på ejendomsmæglerens navn
    const relevantRow = data.find(row => row[headers.indexOf('Ejendomsmægler')] === benchmarkerData['home benchmarker'].name);

    if (relevantRow) {
      // Tilføj data fra Google Sheets til benchmarker data
      headers.forEach((header, index) => {
        benchmarkerData['home benchmarker'][`sheets_${header}`] = relevantRow[index];
      });
    }

    return benchmarkerData;
  } catch (error) {
    console.error('Fejl ved integrering af Google Sheets data:', error);
    return benchmarkerData; // Returner original data hvis der opstår en fejl
  }
}

/**
 * Henter en tilfældig postText fra Google Sheets.
 * @param {string} range - Området i regnearket, f.eks. 'A2:A100'.
 */
async function getPostTextFromSheets(range) {
    const spreadsheetId = config.googleSheets.spreadsheetId; // Brug det ID fra din config.js
    try {
      console.log(`Attempting to fetch data from range: ${range}`);
      const sheetsData = await getDataFromGoogleSheets(spreadsheetId, range);
      console.log(`Received data from Sheets:`, sheetsData);
      if (sheetsData && sheetsData.length > 0) {
        const randomIndex = Math.floor(Math.random() * sheetsData.length);
        const selectedText = sheetsData[randomIndex][0];
        console.log(`Selected postText: ${selectedText}`);
        return selectedText;
      }
      console.log('No data available in the specified range');
      return 'Ingen postText tilgængelig';
    } catch (error) {
      console.error('Fejl ved hentning af postText:', error);
      return 'Fejl ved hentning af postText';
    }
  }

module.exports = {
  integrateGoogleSheetsData,
  getPostTextFromSheets
};
