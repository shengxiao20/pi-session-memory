import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'pi-session-memory';
const PERIOD = 'last-year';
const OUTPUT_PATH = resolve('.github/assets/npm-download-history.svg');
const WIDTH = 900;
const HEIGHT = 340;
const PLOT = { left: 72, right: 852, top: 104, bottom: 278 };

export function downloadRangeUrl(packageName = PACKAGE_NAME, period = PERIOD) {
  return `https://api.npmjs.org/downloads/range/${encodeURIComponent(period)}/${encodeURIComponent(packageName)}`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function formatDate(day) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));
}

function formatCompact(value) {
  return new Intl.NumberFormat('en-US', {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value);
}

function validatePayload(payload, packageName) {
  if (payload?.package !== packageName) throw new Error(`npm downloads API returned package ${JSON.stringify(payload?.package)} instead of ${JSON.stringify(packageName)}.`);
  if (!Array.isArray(payload.downloads) || payload.downloads.length === 0) throw new Error('npm downloads API returned no daily download records.');
  for (const record of payload.downloads) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record?.day) || !Number.isInteger(record?.downloads) || record.downloads < 0) {
      throw new Error('npm downloads API returned an invalid daily download record.');
    }
  }
}

function chartSeries(downloads) {
  const firstPositive = downloads.findIndex(record => record.downloads > 0);
  if (firstPositive === -1) throw new Error('npm downloads API returned no positive download count for the selected period.');
  const visible = downloads.slice(Math.max(0, firstPositive - 1));
  let total = 0;
  return visible.map(record => ({ ...record, cumulative: total += record.downloads }));
}

function linePath(points) {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
}

export function renderDownloadChart(payload, packageName = PACKAGE_NAME) {
  validatePayload(payload, packageName);
  const series = chartSeries(payload.downloads);
  const total = series.at(-1).cumulative;
  const plotWidth = PLOT.right - PLOT.left;
  const plotHeight = PLOT.bottom - PLOT.top;
  const points = series.map((record, index) => ({
    ...record,
    x: PLOT.left + (index / (series.length - 1)) * plotWidth,
    y: PLOT.bottom - (record.cumulative / total) * plotHeight,
  }));
  const path = linePath(points);
  const areaPath = `${path} L${PLOT.right},${PLOT.bottom} L${PLOT.left},${PLOT.bottom} Z`;
  const yTicks = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    return {
      value: Math.round(total * (1 - ratio)),
      y: PLOT.top + plotHeight * ratio,
    };
  });
  const xTickIndexes = [...new Set([0, Math.round((series.length - 1) / 2), series.length - 1])];
  const dateRange = `${formatDate(series[0].day)} – ${formatDate(series.at(-1).day)}`;
  const accessibleTotal = new Intl.NumberFormat('en-US').format(total);
  const sourceUrl = downloadRangeUrl(packageName);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(packageName)} npm download history</title>
  <desc id="description">${escapeXml(accessibleTotal)} cumulative downloads from ${escapeXml(series[0].day)} through ${escapeXml(series.at(-1).day)}, using daily npm downloads API data.</desc>
  <metadata>Source: ${escapeXml(sourceUrl)}; range end: ${escapeXml(payload.end)}</metadata>
  <defs>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5b5bd6" stop-opacity="0.34"/>
      <stop offset="1" stop-color="#5b5bd6" stop-opacity="0.03"/>
    </linearGradient>
    <style>
      .background { fill: #ffffff; stroke: #d8dee4; }
      .heading { fill: #1f2328; font: 600 20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .metric { fill: #1f2328; font: 700 28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .label { fill: #656d76; font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .grid { stroke: #d8dee4; stroke-width: 1; }
      .line { fill: none; stroke: #5b5bd6; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
      @media (prefers-color-scheme: dark) {
        .background { fill: #0d1117; stroke: #30363d; }
        .heading, .metric { fill: #e6edf3; }
        .label { fill: #8d96a0; }
        .grid { stroke: #30363d; }
        .line { stroke: #8b8bf0; }
      }
    </style>
  </defs>
  <rect class="background" x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" rx="12"/>
  <text class="heading" x="28" y="38">npm download history</text>
  <text class="metric" x="28" y="73">${escapeXml(accessibleTotal)}</text>
  <text class="label" x="${28 + accessibleTotal.length * 17}" y="72">cumulative downloads</text>
  <text class="label" x="${PLOT.right}" y="38" text-anchor="end">Rolling 365-day API range · updated through ${escapeXml(formatDate(payload.end))}</text>
  ${yTicks.map(tick => `<line class="grid" x1="${PLOT.left}" y1="${tick.y.toFixed(2)}" x2="${PLOT.right}" y2="${tick.y.toFixed(2)}"/><text class="label" x="${PLOT.left - 10}" y="${(tick.y + 4).toFixed(2)}" text-anchor="end">${escapeXml(formatCompact(tick.value))}</text>`).join('\n  ')}
  <path d="${areaPath}" fill="url(#area)"/>
  <path class="line" d="${path}"/>
  <circle cx="${points.at(-1).x.toFixed(2)}" cy="${points.at(-1).y.toFixed(2)}" r="4.5" fill="#5b5bd6"/>
  ${xTickIndexes.map(index => `<text class="label" x="${points[index].x.toFixed(2)}" y="302" text-anchor="${index === 0 ? 'start' : index === series.length - 1 ? 'end' : 'middle'}">${escapeXml(formatDate(series[index].day))}</text>`).join('\n  ')}
  <text class="label" x="${WIDTH / 2}" y="326" text-anchor="middle">${escapeXml(dateRange)} · public npm downloads API</text>
</svg>
`;
}

export async function generateDownloadChart({ packageName = PACKAGE_NAME, outputPath = OUTPUT_PATH, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(downloadRangeUrl(packageName));
  if (!response.ok) throw new Error(`npm downloads API request failed: ${response.status} ${response.statusText}`);
  const payload = await response.json();
  const svg = renderDownloadChart(payload, packageName);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, svg, 'utf8');
  return { outputPath, downloads: payload.downloads.reduce((sum, record) => sum + record.downloads, 0), start: payload.start, end: payload.end };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = await generateDownloadChart();
  console.log(`Wrote ${result.outputPath} from npm data for ${result.start} through ${result.end} (${result.downloads} downloads).`);
}
