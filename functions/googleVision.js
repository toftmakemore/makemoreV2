// Ændr imports
const admin = require('firebase-admin');
const vision = require('@google-cloud/vision');
const axios = require('axios');

// Initialiser Firebase Admin (hvis ikke allerede gjort andetsteds)
if (!admin.apps.length) {
  admin.initializeApp();
}

// Initialiser Vision client med Firebase credentials
const client = new vision.ImageAnnotatorClient({
  credential: admin.credential.applicationDefault()
});

// Funktion til at konvertere RGB til HEX
function rgbToHex(color) {
  const red = Math.round(color.red);
  const green = Math.round(color.green);
  const blue = Math.round(color.blue);
  return `#${((1 << 24) + (red << 16) + (green << 8) + blue)
    .toString(16)
    .slice(1)}`;
}

// Funktion til at konvertere HEX til RGB
function hexToRgb(hex) {
  hex = hex.replace('#', '');
  const bigint = parseInt(hex, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return [r, g, b];
}

// Funktion til at beregne farveafstand (Euclidean distance)
function colorDistance(rgb1, rgb2) {
  return Math.sqrt(
    Math.pow(rgb1[0] - rgb2[0], 2) +
    Math.pow(rgb1[1] - rgb2[1], 2) +
    Math.pow(rgb1[2] - rgb2[2], 2)
  );
}

// Function to map fuel type to powerTrain
function mapPowerTrain(fuelType) {
  fuelType = fuelType.toLowerCase();
  if (fuelType.includes("diesel")) {
    return "diesel";
  } else if (fuelType.includes("benzin") || fuelType.includes("petrol")) {
    return "petrol";
  } else if (fuelType.includes("hybrid")) {
    return "hybrid";
  } else if (fuelType.includes("electric") || fuelType.includes("el")) {
    return "electric";
  } else {
    return "petrol";
  }
}

// Function to map transmission
function mapTransmission(gearbox) {
  gearbox = gearbox.toLowerCase();
  if (gearbox.includes("automatisk") || gearbox.includes("automatic")) {
    return "automatic";
  } else if (gearbox.includes("manuel") || gearbox.includes("manual")) {
    return "manual";
  } else {
    return "automatic";
  }
}

// Funktion til at hente tilgængelige farver fra Imagin.studio's API
async function getAvailablePaints(make, modelFamily, modelYear) {
  const baseUrl = "https://cdn.imagin.studio/getPaints";
  const paramsList = [
    {
      customer: "img",
      target: "car",
      make: make.toLowerCase(),
      modelFamily: modelFamily.toLowerCase(),
      modelYear: modelYear,
    },
    {
      customer: "img",
      target: "car",
      make: make.toLowerCase(),
      modelFamily: modelFamily.toLowerCase(),
    },
    {
      customer: "img",
      target: "make",
      make: make.toLowerCase(),
    },
  ];

  for (const params of paramsList) {
    try {
      const response = await axios.get(baseUrl, { params });
      if (response.status === 200) {
        const data = response.data;
        const paintCombinations = data.paintData?.paintCombinations || {};
        const paints = [];
        for (const [paintId, paintInfo] of Object.entries(paintCombinations)) {
          const hexColor = paintInfo.paintSwatch?.primary?.lowLight;
          if (hexColor) {
            paints.push({
              paintId,
              hexColor,
            });
          }
        }
        if (paints.length > 0) {
          console.log(`Fundet ${paints.length} farver med parametre: ${JSON.stringify(params)}`);
          return paints;
        }
      }
    } catch (error) {
      console.error(`Fejl ved hentning af farver med parametre: ${JSON.stringify(params)}`);
      console.error(`Error: ${error.response ? error.response.data : error.message}`);
    }
  }
  console.log("Ingen tilgængelige farver fundet efter alle forsøg.");
  return [];
}

// Opdateret getDominantColor funktion
async function getDominantColor(imageUrl) {
  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(response.data, 'binary');
    
    // Først laver vi object detection for at finde bilen
    const [objectResult] = await client.objectLocalization({ image: { content: imageBuffer } });
    const objects = objectResult.localizedObjectAnnotations;
    
    // Find bil-objektet
    const car = objects.find(obj => 
      ['Car', 'Vehicle', 'Land vehicle'].includes(obj.name)
    );

    if (!car) {
      console.error('Ingen bil fundet i billedet');
      return null;
    }

    // Tjek confidence score
    if (car.score < 0.8) { // 80% sikkerhed
      console.error('Ikke sikker nok på at det er en bil:', car.score);
      return null;
    }

    console.log('Fundet bil i billedet med confidence:', car.score);
    
    // Få bilens vertices (hjørnepunkter)
    const vertices = car.boundingPoly.normalizedVertices;
    
    // Analyser farver i billedet
    const [result] = await client.imageProperties({ image: { content: imageBuffer } });
    const colors = result.imagePropertiesAnnotation.dominantColors.colors;

    if (colors && colors.length > 0) {
      // Filtrer og sorter farver
      const filteredColors = colors
        .filter(color => {
          const brightness = (color.color.red + color.color.green + color.color.blue) / 3;
          return brightness > 30 && brightness < 240; // Ignorer ekstreme lyse/mørke farver
        })
        .filter(color => color.score > 0.1) // Kun betydelige farver
        .sort((a, b) => b.score - a.score);

      console.log('Analyserede farver:', filteredColors.map(c => ({
        hex: rgbToHex(c.color),
        score: c.score,
        pixel_fraction: c.pixelFraction
      })));

      if (filteredColors.length > 0) {
        const dominantColor = filteredColors[0].color;
        return rgbToHex(dominantColor);
      }
    }
    
    console.log('Ingen passende farver fundet.');
    return null;
    
  } catch (error) {
    console.error('Fejl ved bilanalyse:', error.message);
    return null;
  }
}

// Funktion til at finde det bedste farvematch baseret på farveafstand
function findBestPaintMatch(dominantColorHex, paints) {
  const dominantRgb = hexToRgb(dominantColorHex);
  let minDistance = Infinity;
  let bestPaint = null;

  for (const paint of paints) {
    const paintRgb = hexToRgb(paint.hexColor);
    const distance = colorDistance(dominantRgb, paintRgb);
    if (distance < minDistance) {
      minDistance = distance;
      bestPaint = paint;
    }
  }

  return bestPaint;
}

// Opdateret getValgtPaintId funktion
async function getValgtPaintId(data) {
  try {
    // Validér input data
    if (!data || !data.fields || !data.attachments?.image_1) {
      console.error('Ugyldigt input format:', data);
      return {
        success: false,
        message: 'Ugyldigt input format'
      };
    }

    console.log('Modtaget bil data:', {
      make: data.fields.Mærke,
      model: data.fields.Model,
      year: data.fields.Årgang,
      imageUrl: data.attachments.image_1
    });

    const imageUrl = data.attachments.image_1;
    const dominantColorHex = await getDominantColor(imageUrl);
    
    if (!dominantColorHex) {
      return { 
        success: false, 
        message: 'Kunne ikke identificere bilen eller dens farve i billedet' 
      };
    }

    console.log('Fundet dominant farve:', dominantColorHex);

    const paints = await getAvailablePaints(
      data.fields.Mærke,
      data.fields.Model,
      data.fields.Årgang
    );

    if (paints.length === 0) {
      console.error('Ingen tilgængelige farver fundet');
      return { success: false, message: 'Ingen tilgængelige farver fundet' };
    }

    const bestPaint = findBestPaintMatch(dominantColorHex, paints);
    if (!bestPaint) {
      console.error('Kunne ikke finde matchende farve');
      return { success: false, message: 'Kunne ikke finde matchende farve' };
    }

    console.log('Fundet matchende paintId:', bestPaint.paintId);
    return {
      success: true,
      paintId: bestPaint.paintId,
      message: 'PaintId fundet succesfuldt'
    };

  } catch (error) {
    console.error('Fejl i getValgtPaintId:', error);
    return {
      success: false,
      message: 'Der opstod en fejl ved farveanalysen',
      error: error.message
    };
  }
}

// Eksporter kun de nødvendige funktioner
module.exports = {
  getValgtPaintId
};
