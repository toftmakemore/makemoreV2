const OpenAI = require('openai');
const config = require('./config');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');

// Initialize OpenAI API configuration
const openai = new OpenAI({
  apiKey: config.openAi.apiKey,
  organization: config.openAi.organizationId,
});

// Opdateret processPostText funktion
async function processPostText(postText, emne, platform, files, messages) {
  try {
    console.log('Behandler tekst:', postText);
    console.log('Emne:', emne);
    console.log('Platform:', platform);
    console.log('Antal filer:', files?.length);
    console.log('Messages:', messages);

    // Håndter billed- og videoanalyse hvis der er filer
    if (files && files.length > 0) {
      for (let i = 0; i < messages.length; i++) {
        if (Array.isArray(messages[i].content)) {
          for (let j = 0; j < messages[i].content.length; j++) {
            const content = messages[i].content[j];
            if (content.type === 'image_url' || content.type === 'video_url') {
              const fileUrl = content.image_url?.url || content.video_url;
              const fileType = getFileType(fileUrl);
              
              if (fileType === 'image') {
                const imageDescription = await analyzeImage(fileUrl);
                messages[i].content[j] = {
                  type: 'text',
                  text: `Billedbeskrivelse: ${imageDescription}`
                };
              } else if (fileType === 'video') {
                const transcription = await transcribeVideo(fileUrl);
                messages[i].content[j] = {
                  type: 'text',
                  text: `Videotransskription: ${transcription}`
                };
              } else {
                console.warn(`Ukendt filtype for URL: ${fileUrl}`);
              }
            }
          }
        }
      }
    }

    // Optimeret blog post håndtering
    if (platform === 'blog') {
      const enhancedMessages = [
        {
          role: "system",
          content: `Du er en professionel content writer. 
                    Følg disse retningslinjer:
                    - Brug kun simple HTML tags: <p>, <h2>, <h3>, <ul>, <li>, <strong>, <em>
                    - Undgå komplekse HTML strukturer
                    - Brug <p> tags til almindelig tekst
                    - Brug <h2> til hovedoverskrifter
                    - Brug <h3> til underoverskrifter
                    - Brug <ul> og <li> til lister
                    - Brug <strong> til fremhævet tekst
                    - Undgå at bruge classes, styles eller andre attributter
                    - Hold strukturen så simpel som mulig`
        },
        ...messages
      ];

      const response = await openai.chat.completions.create({
        model: "gpt-4-turbo-preview",
        messages: enhancedMessages,
        max_tokens: 4000,
        temperature: 0.7,
        presence_penalty: 0.6,
        frequency_penalty: 0.3,
        top_p: 0.9,
        stream: false
      });

      // Simplificér output yderligere
      let content = response.choices[0].message.content;
      
      // Fjern eventuelle komplekse strukturer
      content = content
        .replace(/<div[^>]*>/g, '<p>')
        .replace(/<\/div>/g, '</p>')
        .replace(/\s+class="[^"]*"/g, '')
        .replace(/\s+style="[^"]*"/g, '')
        .replace(/<(?!\/?(p|br|h[1-6]|ul|li|strong|em)(?=>|\s.*?>))\/?[^>]*>/g, '');

      return content;
    }

    // Standard håndtering for alle andre typer posts
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      max_tokens: 300,
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error processing post text:', error);
    throw error;
  }
}

// Behold alle eksisterende hjælpefunktioner
function getFileType(url) {
  const videoExtensions = ['mp4', 'mov', 'avi', 'webm', 'mkv'];
  const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];
  
  const extension = url.split('.').pop().toLowerCase();
  
  if (videoExtensions.includes(extension)) {
    return 'video';
  } else if (imageExtensions.includes(extension)) {
    return 'image';
  } else {
    if (url.includes('video') || videoExtensions.some(ext => url.includes(ext))) {
      return 'video';
    } else if (url.includes('image') || imageExtensions.some(ext => url.includes(ext))) {
      return 'image';
    }
  }
  
  return 'unknown';
}

async function analyzeImage(imageUrl) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Beskriv dette billede detaljeret på dansk." },
            { 
              type: "image_url", 
              image_url: { url: imageUrl }
            }
          ],
        },
      ],
      max_tokens: 300,
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error('Fejl ved analyse af billede:', error);
    return 'Kunne ikke analysere billedet.';
  }
}

async function transcribeVideo(videoUrl) {
  try {
    const tempFilePath = path.join(os.tmpdir(), 'temp_video.mp4');
    await downloadVideo(videoUrl, tempFilePath);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: "whisper-1",
    });

    fs.unlinkSync(tempFilePath);
    return transcription.text;
  } catch (error) {
    console.error('Error transcribing video:', error);
    return 'Kunne ikke transskribere videoen.';
  }
}

async function downloadVideo(videoUrl, outputPath) {
  const response = await axios({
    method: 'get',
    url: videoUrl,
    responseType: 'stream'
  });

  const writer = fs.createWriteStream(outputPath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// Ny hjælpefunktion til at forbedre indholdet
function enhanceContent(content) {
  // Tilføj SEO-venlige HTML attributter
  content = content.replace(/<h2>/g, '<h2 class="blog-heading">');
  content = content.replace(/<h3>/g, '<h3 class="blog-subheading">');
  
  // Tilføj faktabokse
  content = content.replace(/\[FAKTA\](.*?)\[\/FAKTA\]/gs, 
    '<div class="faktaboks"><h4>Fakta</h4>$1</div>');
  
  // Formatér citater
  content = content.replace(/\[CITAT\](.*?)\[\/CITAT\]/gs,
    '<blockquote class="blog-quote">$1</blockquote>');
  
  // Tilføj call-to-actions
  content = content.replace(/\[CTA\](.*?)\[\/CTA\]/gs,
    '<div class="cta-box"><p>$1</p></div>');
  
  // Tilføj tabel af indhold hvis indlægget er langt
  if (content.length > 2000) {
    const toc = generateTableOfContents(content);
    content = `${toc}\n${content}`;
  }
  
  return content;
}

// Ny hjælpefunktion til at generere indholdsfortegnelse
function generateTableOfContents(content) {
  const headings = content.match(/<h2[^>]*>(.*?)<\/h2>/g) || [];
  if (headings.length === 0) return '';
  
  const tocItems = headings.map(heading => {
    const title = heading.replace(/<[^>]+>/g, '');
    const anchor = title.toLowerCase().replace(/\s+/g, '-');
    return `<li><a href="#${anchor}">${title}</a></li>`;
  });
  
  return `
    <div class="table-of-contents">
      <h3>Indholdsfortegnelse</h3>
      <ul>${tocItems.join('')}</ul>
    </div>
  `;
}

module.exports = {
  processPostText,
  analyzeImage,
  transcribeVideo,
  getFileType,
  enhanceContent // Eksporter den nye funktion
};
