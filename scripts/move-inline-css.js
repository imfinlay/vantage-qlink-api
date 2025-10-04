// scripts/move-inline-css.js
// Moves all <style>...</style> blocks from public/index.html to public/site.css
// - Creates a timestamped backup of index.html
// - Inserts <link rel="stylesheet" href="/site.css"> if not present
// - Appends to site.css if it already exists (idempotent)

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const htmlPath = path.join(ROOT, 'public', 'index.html');
const cssPath = path.join(ROOT, 'public', 'site.css');

if (!fs.existsSync(htmlPath)) {
  console.error('ERROR: public/index.html not found.');
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, 'utf8');
const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

let parts = [];
let newHtml = html.replace(styleRe, (_full, css) => {
  parts.push(css.trim());
  return ''; // remove the block
});

if (parts.length === 0) {
  console.log('No <style> blocks found. Nothing to move.');
  process.exit(0);
}

const banner = `/* extracted from index.html on ${new Date().toISOString()} */\n`;
const cssOut = banner + parts.join('\n\n') + '\n';

if (fs.existsSync(cssPath)) {
  fs.appendFileSync(cssPath, '\n' + cssOut);
  console.log(`Appended ${parts.length} <style> block(s) to public/site.css`);
} else {
  fs.writeFileSync(cssPath, cssOut);
  console.log(`Created public/site.css with ${parts.length} <style> block(s)`);
}

// Ensure a link tag exists
const linkTag = '<link rel="stylesheet" href="/site.css">';
if (!/\b<link\b[^>]*href=["'][^"']*site\.css["']/i.test(newHtml)) {
  if (/<head[^>]*>/i.test(newHtml)) {
    newHtml = newHtml.replace(/<head[^>]*>/i, (m) => `${m}\n    ${linkTag}`);
  } else if (/<\/head>/i.test(newHtml)) {
    newHtml = newHtml.replace(/<\/head>/i, `  ${linkTag}\n</head>`);
  } else {
    // no <head>; put it at the top
    newHtml = `${linkTag}\n` + newHtml;
  }
}

// Collapse extra blank lines
newHtml = newHtml.replace(/\n{3,}/g, '\n\n');

// Backup + write
const backupPath = htmlPath + '.bak.' + Date.now();
fs.writeFileSync(backupPath, html, 'utf8');
fs.writeFileSync(htmlPath, newHtml, 'utf8');

console.log(`Updated public/index.html (backup -> ${path.basename(backupPath)})`);

