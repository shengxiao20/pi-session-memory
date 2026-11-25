import assert from 'node:assert/strict';
import { downloadRangeUrl, renderDownloadChart } from '../scripts/generate-download-chart.mjs';

assert.equal(
  downloadRangeUrl('@scope/package name'),
  'https://api.npmjs.org/downloads/range/last-year/%40scope%2Fpackage%20name',
);

assert.throws(() => renderDownloadChart({ package: 'another-package', downloads: [] }));
assert.throws(() => renderDownloadChart({ package: 'pi-session-memory', downloads: [] }));

console.log('download chart tests passed');
