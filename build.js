const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, 'dist');
fs.mkdirSync(dist, { recursive: true });

const filesToCopy = ['index.html', 'app.js', 'manifest.json'];
for (const file of filesToCopy) {
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, path.join(dist, file));
  }
}

// Ensure 404 fallback serves index.html for SPA routing
if (fs.existsSync('index.html')) {
  fs.copyFileSync('index.html', path.join(dist, '404.html'));
}

const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  fs.cpSync(publicDir, dist, { recursive: true });
}

console.log('✅ Build successful. Assets deployed to dist/:', fs.readdirSync(dist));
