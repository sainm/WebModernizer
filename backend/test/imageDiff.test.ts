import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { comparePngs, pngDimensions } from '../src/core/imageDiff.js';

function makePng(width: number, height: number, painter: (x: number, y: number) => [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = painter(x, y);
      const index = (width * y + x) * 4;
      png.data[index] = r;
      png.data[index + 1] = g;
      png.data[index + 2] = b;
      png.data[index + 3] = a;
    }
  }
  return PNG.sync.write(png);
}

const white = (): [number, number, number, number] => [255, 255, 255, 255];

describe('visual diff', () => {
  it('reports zero change for identical images', () => {
    const image = makePng(20, 10, white);
    const result = comparePngs(image, image);
    expect(result.changedPixels).toBe(0);
    expect(result.diffPercent).toBe(0);
    expect(result.dimensionMismatch).toBe(false);
    expect(result.totalPixels).toBe(200);
  });

  it('detects a single changed pixel', () => {
    const before = makePng(20, 10, white);
    const after = makePng(20, 10, (x, y) => (x === 5 && y === 5 ? [0, 0, 0, 255] : white()));
    const result = comparePngs(before, after);
    expect(result.changedPixels).toBe(1);
    expect(result.diffPercent).toBeCloseTo(0.5, 2);
    expect(result.dimensionMismatch).toBe(false);
  });

  it('ignores sub-threshold anti-aliasing noise', () => {
    const before = makePng(4, 4, white);
    const after = makePng(4, 4, () => [247, 247, 247, 255]);
    // 8 levels of difference stays below the default threshold of 12.
    expect(comparePngs(before, after).changedPixels).toBe(0);
  });

  it('treats a size change as a mismatch instead of silently cropping', () => {
    const before = makePng(20, 10, white);
    const after = makePng(20, 14, white);
    const result = comparePngs(before, after);
    expect(result.dimensionMismatch).toBe(true);
    expect(result.changedPixels).toBeGreaterThan(0);
    expect(result.height).toBe(14);
  });

  it('reads the dimensions of a captured screenshot', () => {
    expect(pngDimensions(makePng(7, 3, white))).toEqual({ width: 7, height: 3 });
  });
});
