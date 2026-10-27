import { PNG } from 'pngjs';

export interface ImageDiffResult {
  width: number;
  height: number;
  totalPixels: number;
  changedPixels: number;
  /** Share of differing pixels in percent, rounded to two decimals. */
  diffPercent: number;
  dimensionMismatch: boolean;
}

/**
 * Pixel comparison for visual regression.
 *
 * A pixel counts as changed when any colour channel differs by more than `threshold`.
 * A small threshold filters anti-aliasing noise, which otherwise makes every run look
 * different on a non-deterministic renderer. Size changes always count as a mismatch:
 * a collapsed layout is exactly the regression this check exists to catch.
 */
export function comparePngs(baseline: Buffer, current: Buffer, threshold = 12): ImageDiffResult {
  const before = PNG.sync.read(baseline);
  const after = PNG.sync.read(current);

  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const dimensionMismatch = before.width !== after.width || before.height !== after.height;

  const totalPixels = width * height;
  let changedPixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const insideBefore = x < before.width && y < before.height;
      const insideAfter = x < after.width && y < after.height;

      if (!insideBefore || !insideAfter) {
        changedPixels += 1;
        continue;
      }

      const i = (before.width * y + x) * 4;
      const j = (after.width * y + x) * 4;
      const delta = Math.max(
        Math.abs(before.data[i] - after.data[j]),
        Math.abs(before.data[i + 1] - after.data[j + 1]),
        Math.abs(before.data[i + 2] - after.data[j + 2]),
        Math.abs(before.data[i + 3] - after.data[j + 3]),
      );
      if (delta > threshold) changedPixels += 1;
    }
  }

  return {
    width,
    height,
    totalPixels,
    changedPixels,
    diffPercent: totalPixels === 0 ? 0 : Math.round((changedPixels / totalPixels) * 10000) / 100,
    dimensionMismatch,
  };
}

export function pngDimensions(buffer: Buffer): { width: number; height: number } {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height };
}

export function toDataUrl(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}
