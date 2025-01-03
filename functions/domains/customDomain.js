const functions = require('firebase-functions');
const admin = require('firebase-admin');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

async function setupHostingConfig(subdomain) {
  // Opret .firebaserc fil
  const firebaserc = {
    projects: {
      default: process.env.GCLOUD_PROJECT
    },
    targets: {
      [process.env.GCLOUD_PROJECT]: {
        hosting: {
          [subdomain]: [subdomain]
        }
      }
    }
  };

  // Opret firebase.json fil
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

  const tempDir = os.tmpdir();
  const configDir = path.join(tempDir, `hosting-${subdomain}`);
  
  await fs.ensureDir(configDir);
  await fs.writeJson(path.join(configDir, '.firebaserc'), firebaserc);
  await fs.writeJson(path.join(configDir, 'firebase.json'), firebaseJson);
  
  return configDir;
}

async function deployToHosting(subdomain, configDir) {
  try {
    // Opret hosting site
    execSync(`firebase hosting:sites:create ${subdomain} --project ${process.env.GCLOUD_PROJECT}`, {
      cwd: configDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        FIREBASE_TOKEN: functions.config().ci?.token
      }
    });

    // Find den korrekte sti til dist-mappen
    const projectRoot = process.cwd();
    console.log('Nuværende arbejdsmappe (cwd):', projectRoot);
    
    const possibleDistPaths = [
      path.join(projectRoot, 'functions', 'dist'),  // Primær placering
      path.resolve(__dirname, '../dist'),           // Relativ sti fra domains
      path.join(projectRoot, 'dist')                // Fallback
    ];

    console.log('Leder efter dist-mappe i følgende stier:');
    let distPath = null;

    for (const searchPath of possibleDistPaths) {
      const exists = fs.existsSync(searchPath);
      console.log(`- ${searchPath} (${exists ? 'FUNDET' : 'IKKE FUNDET'})`);
      
      if (exists) {
        // Validér at det faktisk er en dist-mappe med index.html
        const stats = fs.statSync(searchPath);
        const hasIndexHtml = fs.existsSync(path.join(searchPath, 'index.html'));
        const isDirectory = stats.isDirectory();
        
        console.log(`  Validering af ${searchPath}:`);
        console.log(`  - Er en mappe: ${isDirectory}`);
        console.log(`  - Har index.html: ${hasIndexHtml}`);
        console.log(`  - Indhold: ${fs.readdirSync(searchPath).join(', ')}`);
        
        if (isDirectory && hasIndexHtml) {
          distPath = searchPath;
          console.log('✓ Gyldig dist-mappe fundet:', distPath);
          break;
        }
      }
    }

    const tempDistPath = path.join(configDir, 'dist');

    if (!distPath) {
      console.log('Opretter midlertidig dist mappe i cloud functions miljø');
      await fs.ensureDir(tempDistPath);
      await fs.writeFile(
        path.join(tempDistPath, 'index.html'),
        `<!DOCTYPE html>
        <html>
          <head>
            <title>${subdomain}</title>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
              body { 
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                margin: 0;
                padding: 20px;
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
                background: #f5f5f5;
              }
              .container {
                text-align: center;
                padding: 40px;
                background: white;
                border-radius: 8px;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
              }
              h1 { color: #2c3e50; margin-bottom: 16px; }
              p { color: #34495e; line-height: 1.6; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>Dit subdomæne er klar!</h1>
              <p>Du kan nu deploye din side til ${subdomain}.web.app</p>
              <p>Brug firebase deploy kommandoen for at uploade din side.</p>
            </div>
          </body>
        </html>`
      );
      console.log('Midlertidig dist mappe oprettet');
    } else {
      console.log(`Bruger eksisterende dist-mappe fra: ${distPath}`);
      try {
        await fs.ensureDir(tempDistPath);
        await fs.copy(distPath, tempDistPath, {
          overwrite: true,
          errorOnExist: false,
          preserveTimestamps: true
        });
        console.log('Dist-mappe kopieret succesfuldt');
      } catch (copyError) {
        console.error('Fejl ved kopiering af dist-mappe:', copyError);
        throw new Error(`Kunne ikke kopiere dist-mappen: ${copyError.message}`);
      }
    }

    // Deploy til det nye site
    console.log('Starter deployment til Firebase Hosting...');
    
    // Deploy til det nye site
    execSync(`firebase deploy --only hosting:${subdomain} --project ${process.env.GCLOUD_PROJECT}`, {
      cwd: configDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        FIREBASE_TOKEN: functions.config().ci?.token
      }
    });
    console.log('Deployment gennemført succesfuldt');

    return true;
  } catch (error) {
    console.error('Deployment fejlede:', error);
    throw new Error(`Deployment fejlede: ${error.message}`);
  }
}

exports.setupFirebaseHosting = async (req, res) => {
  try {
    // Verificer auth token
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Ingen authorization header' });
    }

    const token = authHeader.split('Bearer ')[1];
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(token);
    } catch (error) {
      console.error('Token verifikation fejlede:', error);
      return res.status(401).json({ error: 'Ugyldig token' });
    }

    // Tjek brugerrolle
    const userDoc = await admin.firestore().collection('users').doc(decodedToken.uid).get();
    const userRole = userDoc.data()?.role;
    
    if (userRole !== 1 && userRole !== 2) {
      return res.status(403).json({ error: 'Kun admin kan oprette subdomæner' });
    }

    const { subdomain, isTestDomain } = req.body;
    
    if (!subdomain) {
      return res.status(400).json({ error: 'Subdomæne er påkrævet' });
    }

    let finalSubdomain = subdomain;
    
    // Hvis det er et test domæne, tilføj prefix
    if (isTestDomain) {
      finalSubdomain = `fir-${subdomain}`;
    }

    // Valider subdomæne format
    const subdomainRegex = /^[a-z0-9][a-z0-9-]{4,61}[a-z0-9]$/;
    if (!subdomainRegex.test(finalSubdomain)) {
      return res.status(400).json({ 
        error: 'Ugyldigt subdomæne format. Subdomænet skal være mellem 6 og 63 tegn og må kun indeholde små bogstaver, tal og bindestreger.' 
      });
    }

    try {
      console.log('Opsætter hosting konfiguration...');
      const configDir = await setupHostingConfig(finalSubdomain);

      console.log('Deployer til Firebase Hosting...');
      await deployToHosting(finalSubdomain, configDir);

      // Gem domænet i domains collection
      console.log('Gemmer domæne i Firestore...');
      await admin.firestore()
        .collection('domains')
        .add({
          domain: `${finalSubdomain}.web.app`,
          subdomain: finalSubdomain,
          userId: decodedToken.uid,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          status: 'active',
          isTestDomain: !!isTestDomain
        });

      // Opdater brugerens dokument med det nye subdomæne
      console.log('Opdaterer bruger dokument...');
      await admin.firestore()
        .collection('users')
        .doc(decodedToken.uid)
        .update({
          'adminSettings.whiteLabel.browserSettings.subdomain': finalSubdomain,
          'adminSettings.whiteLabel.browserSettings.domain': `${finalSubdomain}.web.app`,
          'adminSettings.whiteLabel.browserSettings.status': 'active',
          'adminSettings.whiteLabel.browserSettings.setupDate': admin.firestore.FieldValue.serverTimestamp(),
          'adminSettings.whiteLabel.browserSettings.isTestDomain': !!isTestDomain
        });

      // Ryd op
      await fs.remove(configDir);

      return res.status(200).json({
        success: true,
        domain: `${finalSubdomain}.web.app`,
        message: 'Subdomæne oprettet og deployed succesfuldt'
      });

    } catch (error) {
      console.error('Hosting setup error:', error);
      throw new Error(`Kunne ikke opsætte hosting: ${error.message}`);
    }

  } catch (error) {
    console.error('Setup failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}; 