require('dotenv').config();
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, query, where, getDocs } = require('firebase/firestore');
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');
const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

// Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyAx_5ZnR__8sizS5_1k3uP-gilviDiGO6Q",
  authDomain: "toft-d4f39.firebaseapp.com",
  projectId: "toft-d4f39",
  storageBucket: "toft-d4f39.appspot.com",
  messagingSenderId: "277892110082",
  appId: "1:277892110082:web:4d4578f88e521c2fb3141b",
  measurementId: "G-L976F1ZSTY",
};

// Initialiser Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Login credentials fra .env fil
const EMAIL = process.env.FIREBASE_EMAIL;
const PASSWORD = process.env.FIREBASE_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('Fejl: FIREBASE_EMAIL og FIREBASE_PASSWORD skal være sat i .env filen');
  process.exit(1);
}

async function setupHostingConfig(subdomain) {
  const firebaserc = {
    projects: {
      default: firebaseConfig.projectId
    },
    targets: {
      [firebaseConfig.projectId]: {
        hosting: {
          [subdomain]: [subdomain]
        }
      }
    }
  };

  const firebaseJson = {
    hosting: {
      target: subdomain,
      public: "dist",
      ignore: [
        "firebase.json",
        "**/.*",
        "**/node_modules/**"
      ],
      rewrites: [{
        source: "**",
        destination: "/index.html"
      }]
    }
  };

  const configDir = path.join(os.tmpdir(), `hosting-${subdomain}`);
  await fs.ensureDir(configDir);
  await fs.writeJson(path.join(configDir, '.firebaserc'), firebaserc);
  await fs.writeJson(path.join(configDir, 'firebase.json'), firebaseJson);
  
  return configDir;
}

async function deployToSubdomain(subdomain) {
  try {
    console.log(`\nOpdaterer ${subdomain}...`);
    const configDir = await setupHostingConfig(subdomain);
    
    // Kopier dist til temp mappe
    const tempDistPath = path.join(configDir, 'dist');
    const possiblePaths = [
      path.resolve(__dirname, './dist'),
      path.resolve(__dirname, '../dist'),
      path.resolve(__dirname, './functions/dist')
    ];

    let validSourcePath = null;
    for (const testPath of possiblePaths) {
      if (fs.existsSync(testPath)) {
        console.log(`✓ Fandt dist-mappe på: ${testPath}`);
        validSourcePath = testPath;
        break;
      } else {
        console.log(`✗ Ingen dist-mappe på: ${testPath}`);
      }
    }
    
    if (!validSourcePath) {
      throw new Error(`Kunne ikke finde dist-mappen. Tjekket følgende stier:\n${possiblePaths.join('\n')}`);
    }
    
    await fs.ensureDir(tempDistPath);
    await fs.copy(validSourcePath, tempDistPath);
    
    // Deploy til subdomænet
    console.log(`Deployer til ${subdomain}...`);
    execSync(`firebase deploy --only hosting:${subdomain} --project ${firebaseConfig.projectId}`, {
      cwd: configDir,
      stdio: 'inherit'
    });
    
    // Ryd op
    await fs.remove(configDir);
    console.log(`✓ ${subdomain} opdateret succesfuldt`);
    return true;
  } catch (error) {
    console.error(`Fejl ved opdatering af ${subdomain}:`, error);
    return false;
  }
}

async function updateAllDomains() {
  try {
    // Log ind først
    console.log('Logger ind på Firebase...');
    await signInWithEmailAndPassword(auth, EMAIL, PASSWORD);
    console.log('Login succesfuld!');
    
    console.log('Henter aktive domæner fra databasen...');
    
    // Hent alle aktive domæner fra domains collection
    const domainsRef = collection(db, 'domains');
    const q = query(domainsRef, where('status', '==', 'active'));
    const snapshot = await getDocs(q);
    
    const domains = [];
    snapshot.forEach(doc => {
      const subdomain = doc.data()?.subdomain;
      if (subdomain) {
        domains.push(subdomain);
      }
    });
    
    console.log(`Fundet ${domains.length} aktive domæner:`, domains);
    
    if (domains.length === 0) {
      console.log('Ingen aktive domæner fundet.');
      return;
    }
    
    // Opdater alle domæner parallelt, men med en grænse på 3 samtidige
    const batchSize = 3;
    for (let i = 0; i < domains.length; i += batchSize) {
      const batch = domains.slice(i, i + batchSize);
      console.log(`\nOpdaterer batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(domains.length/batchSize)}:`, batch);
      await Promise.all(batch.map(domain => deployToSubdomain(domain)));
    }
    
    console.log('\n✓ Alle domæner er blevet opdateret!');
  } catch (error) {
    console.error('Fejl ved opdatering af domæner:', error);
    process.exit(1);
  }
}

// Kør opdateringen
updateAllDomains(); 