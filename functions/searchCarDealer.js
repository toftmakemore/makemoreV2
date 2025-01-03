const axios = require('axios');

async function searchCarDealer(value) {
  try {
    const response = await axios.post(
      'https://www.biltorvet.dk/Api/Company/Search',
      {
        MakeIdList: [],
        SearchString: value
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    return {
      success: true,
      data: response.data
    };
  } catch (error) {
    console.error('Fejl ved søgning efter bilforhandler:', error);
    return {
      success: false,
      error: error.message,
      details: error.response?.data || 'Ingen yderligere detaljer'
    };
  }
}

module.exports = { searchCarDealer };
