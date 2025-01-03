async function getTemplate(templateId) {
  const url = `https://robolly.com/backend/templates?id=${templateId}`;
  
  try {
    console.log('Henter template fra:', url);
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': 'Bearer PeKEYn9ecbQ9EbDEQTnQSGPAb3ECSCUunlalxeJqQxhNYopxcBhASKlrJ37A'
      },
      credentials: 'include'
    });
    
    if (!response.ok) {
      throw new Error(`HTTP fejl! status: ${response.status}`);
    }
    
    const data = await response.json();
    return data;
    
  } catch (error) {
    console.error('Fejl ved hentning af template:', error);
    throw error; // Kaste fejlen videre til den kaldende funktion
  }
}

// Eksporter funktionen
module.exports = { getTemplate };
