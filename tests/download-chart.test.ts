import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { downloadRangeUrl, renderDownloadChart } from '../scripts/generate-download-chart.mjs';

const fixture = {
  package: 'pi-session-memory',
  start: '2026-09-10',
  end: '2026-09-13',
  downloads: [
    { day: '2026-09-10', downloads: 0 },
    { day: '2026-09-11', downloads: 3 },
    { day: '2026-09-12', downloads: 4 },
    { day: '2026-09-13', downloads: 5 },
  ],
};

assert.equal(
  downloadRangeUrl('@scope/package name'),
  'https://api.npmjs.org/downloads/range/last-year/%40scope%2Fpackage%20name',
);

const svg = renderDownloadChart(fixture);
assert.match(svg, /<title id="title">pi-session-memory npm download history<\/title>/);
assert.match(svg, />12<\/text>/);
assert.match(svg, /Sep 10, 2026/);
assert.match(svg, /Sep 13, 2026/);
assert.match(svg, /Rolling 365-day API range/);
assert.doesNotMatch(svg, /NaN|undefined/);

assert.throws(
  () => renderDownloadChart({ ...fixture, package: 'another-package' }),
  /returned package/,
);
assert.throws(
  () => renderDownloadChart({ ...fixture, downloads: [] }),
  /no daily download records/,
);

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/download-history.yml', import.meta.url), 'utf8');
const generated = readFileSync(new URL('../.github/assets/npm-download-history.svg', import.meta.url), 'utf8');

assert.match(readme, /\.github\/assets\/npm-download-history\.svg/);
assert.match(readme, /public \[npm downloads API\]/);
assert.match(workflow, /schedule:/);
assert.match(workflow, /permissions:\n  contents: write/);
assert.match(workflow, /npm run downloads:chart/);
assert.match(workflow, /git add \.github\/assets\/npm-download-history\.svg/);
assert.match(generated, /<svg[^>]+role="img"/);
assert.match(generated, /Source: https:\/\/api\.npmjs\.org\/downloads\/range\/last-year\/pi-session-memory/);
assert.doesNotMatch(generated, /NaN|undefined/);

console.log('download chart tests passed');
