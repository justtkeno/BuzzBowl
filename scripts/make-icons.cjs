// Renders the PNG app icons from src/client/public/icons/icon.svg.
// Run after changing the logo: node scripts/make-icons.cjs (needs Playwright with Chromium).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '../src/client/public/icons');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
// The tile is the first <rect>; the rest is the mark.
const tile = svg.match(/<rect[^>]*\/>/)[0];
const bg = tile.match(/fill="([^"]+)"/)[1];
const mark = svg.replace(tile, '').replace(/<\/?svg[^>]*>/g, '');

/** Full-bleed square with the mark scaled to `scale`: the OS applies its own shape (maskable icons need the middle 80%). */
const square = (scale) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${bg}"/>` +
  `<g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${mark}</g></svg>`;

const outputs = [
  ['icon-192.png', 192, svg], // rounded tile, purpose "any"
  ['icon-512.png', 512, svg],
  ['icon-maskable-512.png', 512, square(0.85)],
  ['apple-touch-icon.png', 180, square(1)], // iOS rounds the corners itself
  ['favicon-32.png', 32, svg],
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [file, size, src] of outputs) {
    await page.setViewportSize({ width: size, height: size });
    const sized = src.replace('<svg ', `<svg width="${size}" height="${size}" `);
    await page.setContent(`<html><body style="margin:0;background:transparent">${sized}</body></html>`);
    await page.locator('svg').screenshot({ path: path.join(dir, file), omitBackground: true });
    console.log('wrote', file);
  }
  await browser.close();
})();
