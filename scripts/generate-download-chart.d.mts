/** Build the npm daily-download API URL. */
export function downloadRangeUrl(packageName?: string, period?: string): string;

/** Validate the API payload and render its cumulative download chart. */
export function renderDownloadChart(payload: unknown, packageName?: string): string;

/** Fetch daily downloads and write the generated SVG file. */
export function generateDownloadChart(options?: {
  packageName?: string;
  outputPath?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ outputPath: string; downloads: number; start: string; end: string }>;
