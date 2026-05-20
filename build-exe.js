const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const assets = {};

function addFile(relPath) {
  const abs = path.join(PUBLIC, relPath);
  if (!fs.existsSync(abs)) return;
  const ext = path.extname(relPath).toLowerCase();
  if (['.png', '.ico', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.woff', '.woff2', '.ttf', '.eot'].includes(ext)) {
    assets[relPath] = { t: 'b', d: fs.readFileSync(abs).toString('base64') };
  } else {
    assets[relPath] = { t: 't', d: fs.readFileSync(abs, 'utf8') };
  }
}

function walk(dir, prefix) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    else addFile(rel);
  }
}

walk(PUBLIC, '');

fs.writeFileSync(path.join(ROOT, '_embedded.js'), 'module.exports = ' + JSON.stringify(assets) + ';\n');
console.log(`✓ Embedded ${Object.keys(assets).length} files from public/`);
