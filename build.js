/* © 2026 pemdem. All rights reserved.
   Build for Cloudflare Pages: copies the site into dist/, scrambles app.js and minifies style.css.
   The readable source stays in the (private) repo; visitors only ever download dist/. */
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const out = path.join(__dirname, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);

const stamp = Date.now().toString(36);
const banner = '/* © 2026 pemdem. All rights reserved. Proprietary software: copying, re-hosting or redistribution is prohibited. */\n';

// 1. Scramble the app logic.
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const scrambled = JavaScriptObfuscator.obfuscate(src, {
  compact: true,
  target: 'browser',
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  splitStrings: true,
  splitStringsChunkLength: 12,
  transformObjectKeys: false,
  controlFlowFlattening: false, // keeps the app fast
  deadCodeInjection: false,
  selfDefending: false,
  disableConsoleOutput: false,
  numbersToExpressions: true,
  simplify: true,
  unicodeEscapeSequence: false
}).getObfuscatedCode();
fs.writeFileSync(path.join(out, `app.${stamp}.js`), banner + scrambled);

// 2. Minify the stylesheet.
const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .replace(/\s*([{}:;,>])\s*/g, '$1')
  .replace(/;}/g, '}')
  .trim();
fs.writeFileSync(path.join(out, `style.${stamp}.css`), banner + css);

// 3. Page: point at the built files (unique names, so no stale caches).
let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
  .replace(/href="style\.css(\?v=[^"]*)?"/, `href="style.${stamp}.css"`)
  .replace(/src="app\.js(\?v=[^"]*)?"/, `src="app.${stamp}.js"`)
  .replace(/<!--[\s\S]*?-->/g, '');
fs.writeFileSync(path.join(out, 'index.html'), html);

// 4. Security headers and licence.
fs.copyFileSync(path.join(__dirname, '_headers'), path.join(out, '_headers'));
fs.copyFileSync(path.join(__dirname, 'LICENSE'), path.join(out, 'LICENSE.txt'));

console.log('Built dist/ with app.' + stamp + '.js');
