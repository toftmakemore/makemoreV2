const fs = require('fs-extra');
const path = require('path');

async function copyDistToFunctions() {
  const sourcePath = path.resolve(__dirname, 'dist');
  const targetPath = path.resolve(__dirname, 'functions/dist');
  
  try {
    console.log('Kopierer dist-mappe til functions...');
    console.log('Fra:', sourcePath);
    console.log('Til:', targetPath);
    
    // Sikr at target-mappen eksisterer
    await fs.ensureDir(targetPath);
    
    // Kopier dist til functions/dist
    await fs.copy(sourcePath, targetPath, {
      overwrite: true,
      preserveTimestamps: true
    });
    
    console.log('✓ Dist-mappe er blevet kopieret til functions/dist');
  } catch (error) {
    console.error('Fejl ved kopiering af dist-mappe:', error);
    process.exit(1);
  }
}

copyDistToFunctions(); 