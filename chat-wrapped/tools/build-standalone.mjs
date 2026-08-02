// Flattens the app into a single self-contained HTML file — no server, no
// modules, no network. Useful two ways: as a shareable preview, and as a
// static build you can drop on any host.
//
//   node tools/build-standalone.mjs
//     → dist/chat-wrapped.html    full standalone document
//     → dist/artifact.html        same page as body-only fragment
//
// The writer and the paywall are excluded by design: both need a server, and a
// control that fails when pressed is worse than one that isn't there.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(ROOT, p), 'utf8');

// Dependency order matters — these are concatenated, not resolved.
const MODULES = [
  'brand.js',
  'text.js',
  'parser.js',
  'stats.js',
  'moments.js',
  'deck.js',
  'app.js',
];

/**
 * Concatenation puts every module in one scope, so two files declaring the
 * same top-level name produce a SyntaxError that only shows up at runtime in
 * the browser. Catch it at build time and name the offender instead.
 */
function topLevelNames(source) {
  const names = [];
  const re = /^(?:const|let|var|class|function|async function)\s+([A-Za-z0-9_$]+)/gm;
  for (const m of source.matchAll(re)) names.push(m[1]);
  return names;
}

/**
 * Strip ES module syntax so the files can be concatenated into one classic
 * script. Only the forms this codebase actually uses are handled; anything
 * else should fail loudly rather than be silently mangled.
 */
function flatten(source, file) {
  let out = source
    // `import { a, b } from './x.js';`  and  `import x from './x.js';`
    .replace(/^\s*import\s+[^;]*?\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
    // `export const` / `export function` / `export class` / `export async`
    .replace(/^\s*export\s+(?=(?:const|let|var|function|class|async)\b)/gm, '')
    // `export { a, b };`
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '');

  if (/^\s*(?:import|export)\b/m.test(out)) {
    const line = out.split('\n').find((l) => /^\s*(?:import|export)\b/.test(l));
    throw new Error(`${file}: unhandled module syntax → ${line.trim()}`);
  }
  return out;
}

const css = await read('styles.css');
const html = await read('index.html');

// Lift the page body out of index.html so markup lives in exactly one place.
const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/);
if (!bodyMatch) throw new Error('index.html: could not find <body>');
const body = bodyMatch[1].replace(/\s*<script[\s\S]*?<\/script>\s*/g, '\n');

let script = '';
const seen = new Map();
for (const file of MODULES) {
  const code = flatten(await read(file), file);
  for (const name of topLevelNames(code)) {
    if (seen.has(name)) {
      throw new Error(
        `Duplicate top-level "${name}" in ${file} and ${seen.get(name)}. ` +
          `Move it into text.js and import it from both.`
      );
    }
    seen.set(name, file);
  }
  script += `\n/* ===== ${file} ===== */\n${code}\n`;
}

const NOTE = `
      <p class="privacy">
        <strong>Preview build.</strong> Everything here runs in your browser — your chat is never
        uploaded and nothing is stored. The written awards and the roast need the server, so this
        build shows the full stats deck without them.
      </p>`;

const page = `<title>Chat Wrapped — your group chat, recapped</title>
<style>
${css}
</style>
${body.replace('</main>', `${NOTE}\n    </main>`)}
<script>
window.CW_STANDALONE = true;
${script}
</script>
`;

const doc = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="description" content="Upload a WhatsApp export and get a Wrapped-style recap of your group chat. Runs entirely in your browser." />
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>💬</text></svg>" />
${page}
  </body>
</html>
`;

await mkdir(join(ROOT, 'dist'), { recursive: true });
await writeFile(join(ROOT, 'dist/chat-wrapped.html'), doc);
await writeFile(join(ROOT, 'dist/artifact.html'), page);

const kb = (s) => `${Math.round(s.length / 1024)} KB`;
console.log(`dist/chat-wrapped.html  ${kb(doc)}`);
console.log(`dist/artifact.html      ${kb(page)}`);
