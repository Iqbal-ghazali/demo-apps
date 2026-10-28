// Quality gate before deploy. No dependencies; prints one line per check.
// Usage: node tests/check.mjs site/index.html

import { readFileSync, statSync } from 'node:fs';

const file = process.argv[2] || 'site/index.html';
let html = '';
try {
  html = readFileSync(file, 'utf8');
} catch {
  console.error(`✗ ${file} not found`);
  process.exit(1);
}

const checks = [
  ['File is under 200 KB', statSync(file).size < 200 * 1024],
  ['Starts with <!doctype html>', /^\s*<!doctype html>/i.test(html)],
  ['Declares a language (<html lang>)', /<html[^>]*\blang=["'][\w-]+["']/i.test(html)],
  ['Has a <title>', /<title>[^<]+<\/title>/i.test(html)],
  ['Has a mobile viewport', /<meta[^>]+name=["']viewport["']/i.test(html)],
  ['Self-contained: no external scripts', !/<script[^>]+src=["']https?:/i.test(html)],
  ['Self-contained: no external stylesheets or fonts', !/<link[^>]+href=["']https?:/i.test(html)],
  ['No external images', !/<img[^>]+src=["']https?:/i.test(html)],
  ['Every image has alt text', !/<img(?![^>]*\balt=)[^>]*>/i.test(html)],
  ['No empty links (href="#")', !/<a[^>]+href=["']#["']/i.test(html)],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) failed++;
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
