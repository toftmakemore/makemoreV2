import { initializeApp } from 'firebase/app';
import { getFirestore, setDoc, doc, serverTimestamp } from 'firebase/firestore';
import BiltorvetScraper from './src/scrapers/biltorvet.js';
import pLimit from 'p-limit';

// Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyAx_5ZnR__8sizS5_1k3uP-gilviDiGO6Q",
  authDomain: "toft-d4f39.firebaseapp.com",
  projectId: "toft-d4f39",
  storageBucket: "toft-d4f39.appspot.com",
  messagingSenderId: "277892110082",
  appId: "1:277892110082:web:4d4578f88e521c2fb3141b",
  measurementId: "G-L976F1ZSTY"
};

class BatchScraper {
  constructor(config = {}) {
    this.firebaseConfig = config.firebase;
    this.db = getFirestore(initializeApp(this.firebaseConfig));
    
    // Konfiguration
    this.concurrentLimit = config.concurrentLimit || 5; // Antal samtidige scrapes
    this.batchSize = config.batchSize || 50; // Antal URLs per batch
    this.retryAttempts = config.retryAttempts || 3;
    this.delayBetweenBatches = config.delayBetweenBatches || 5000; // 5 sekunder mellem batches
    
    // Rate limiting
    this.limit = pLimit(this.concurrentLimit);
    
    // Statistik
    this.stats = {
      total: 0,
      success: 0,
      failed: 0,
      startTime: null,
      endTime: null
    };
  }

  async processBatch(urls) {
    const scrapers = Array(this.concurrentLimit).fill(null).map(() => new BiltorvetScraper());
    const results = { success: [], failed: [] };

    try {
      // Kør concurrent scraping med rate limiting
      const promises = urls.map(url => 
        this.limit(async () => {
          const scraper = scrapers.find(s => !s.isBusy);
          if (!scraper) throw new Error('Ingen tilgængelig scraper');
          
          scraper.isBusy = true;
          try {
            console.log(`Processing: ${url}`);
            const data = await this.processUrl(url, scraper);
            results.success.push({ url, data });
          } catch (error) {
            console.error(`Fejl ved ${url}:`, error.message);
            results.failed.push({ url, error: error.message });
          } finally {
            scraper.isBusy = false;
          }
        })
      );

      await Promise.all(promises);
    } finally {
      // Luk alle scrapers
      await Promise.all(scrapers.map(s => s.close()));
    }

    return results;
  }

  async processUrl(url, scraper, attempt = 1) {
    try {
      const carData = await scraper.scrapeCarPage(url);
      
      // Strukturer data til Firebase format
      const firebaseData = {
        id: url.split('/').pop(),
        categoryName: carData.category || 'Bil',
        headline: carData.headline,
        description: carData.description,
        createdDate: new Date().toISOString(),
        price: carData.price,
        priceInt: parseInt((carData.price || '').replace(/\D/g, '')) || 0,
        salesType: carData.priceType || 'Kontant',
        paymentTypes: carData.priceType || 'Kontant',
        leasingDetails: carData.leasingDetails || null,
        attachments: (carData.images || []).map(this.formatImageUrl),
        fields: carData.fields || {},
        url: url,
        lastUpdated: new Date().toISOString(),
        scrapedAt: serverTimestamp()
      };

      // Gem i Firebase
      await this.saveToFirebase(firebaseData);
      this.stats.success++;
      return firebaseData;

    } catch (error) {
      if (attempt < this.retryAttempts) {
        console.log(`Retry attempt ${attempt + 1} for ${url}`);
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        return this.processUrl(url, scraper, attempt + 1);
      }
      this.stats.failed++;
      throw error;
    }
  }

  formatImageUrl(url) {
    if (!url) return '';
    // Fjern width, height og fit parametre
    const cleanUrl = url.replace(/width=\d+,height=\d+,fit=cover,/, '');
    // Sikr at URL starter med https://
    return cleanUrl.startsWith('https://') ? cleanUrl : `https://${cleanUrl}`;
  }

  async saveToFirebase(carData) {
    try {
      const carRef = doc(this.db, 'scraped_cars', carData.id);
      await setDoc(carRef, {
        ...carData,
        lastUpdated: new Date().toISOString()
      });
      console.log(`Bil gemt i Firebase med ID: ${carData.id}`);
    } catch (error) {
      console.error('Fejl ved gemning i Firebase:', error);
      throw error;
    }
  }

  async processAllUrls(urls) {
    this.stats = {
      total: urls.length,
      success: 0,
      failed: 0,
      startTime: new Date(),
      endTime: null
    };

    console.log(`Starting processing of ${urls.length} URLs`);

    // Del URLs op i batches
    const batches = [];
    for (let i = 0; i < urls.length; i += this.batchSize) {
      batches.push(urls.slice(i, i + this.batchSize));
    }

    console.log(`Opdelt i ${batches.length} batches`);

    // Proces hver batch
    for (let i = 0; i < batches.length; i++) {
      console.log(`\nProcessing batch ${i + 1}/${batches.length}`);
      const results = await this.processBatch(batches[i]);
      
      // Log batch resultater
      console.log(`Batch ${i + 1} completed:`, {
        success: results.success.length,
        failed: results.failed.length,
        successUrls: results.success.map(s => s.url),
        failedUrls: results.failed.map(f => f.url)
      });

      // Vent mellem batches
      if (i < batches.length - 1) {
        console.log(`Venter ${this.delayBetweenBatches/1000} sekunder før næste batch...`);
        await new Promise(resolve => setTimeout(resolve, this.delayBetweenBatches));
      }
    }

    this.stats.endTime = new Date();
    this.logFinalStats();
  }

  logFinalStats() {
    const duration = (this.stats.endTime - this.stats.startTime) / 1000;
    console.log('\nScraping Completed!');
    console.log('------------------------');
    console.log(`Total URLs: ${this.stats.total}`);
    console.log(`Successful: ${this.stats.success}`);
    console.log(`Failed: ${this.stats.failed}`);
    console.log(`Duration: ${duration.toFixed(2)} seconds`);
    console.log(`Average: ${(this.stats.success / duration).toFixed(2)} URLs/second`);
  }
}

// Brug:
const scraper = new BatchScraper({
  firebase: firebaseConfig,
  concurrentLimit: 3,
  batchSize: 10,
  retryAttempts: 3,
  delayBetweenBatches: 5000
});

const urls = [
    'https://www.biltorvet.dk/bil/porsche/911/3-8-coupe-pdk/2700650',
    'https://www.biltorvet.dk/bil/alfa-romeo/tonale/1-3-phev-veloce-aut--q4/2591243',
    'https://www.biltorvet.dk/elbiler/audi/e-tron/50-proline-quattro/2697884'
];

scraper.processAllUrls(urls)
  .then(() => {
    console.log('Alt er færdigt!');
    process.exit(0);
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  }); 