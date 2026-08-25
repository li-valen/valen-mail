import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Generates client/public/icon-192.png and icon-512.png.
 *
 * These two files are referenced by manifest.webmanifest and by
 * index.html's apple-touch-icon link, and both were missing — which
 * degrades "Add to Home Screen" on iOS, and Task 6's Web Push REQUIRES a
 * Home-Screen install to work at all.
 *
 * Written as a script rather than as two committed binaries of unknown
 * provenance: this is the whole recipe, it takes no dependency (node:zlib
 * ships with Node), and the artwork is derived from client/DESIGN.md's own
 * tokens rather than from an external asset.
 *
 * The mark is the design thesis compressed to 192px — DESIGN.md's memory
 * test is "a line down the page with marks on it, and it tells you when it
 * doesn't know", so the icon is the time spine (§4.2) carrying one of each
 * read-state mark (§5.2): a filled disc, an open ring, and an error bar.
 * The three chromatics are the product's entire palette, used in the one
 * place DESIGN.md permits colour.
 *
 * Run with:  node scripts/generate-icons.mjs
 */

// ---------------------------------------------------------------------------
// Palette — client/DESIGN.md §2.2 primitives, dark ladder. A dark ground is
// used because the manifest's theme_color is already --p-ink-1000 and an
// icon must be one fixed image on every home screen, light or dark.
// ---------------------------------------------------------------------------
const GROUND = [0x0b, 0x0b, 0x10]; // --p-ink-1000
const SPINE = [0x65, 0x65, 0x7d]; // --p-ink-600  (the time axis)
const CONFIRMED = [0x4a, 0xa4, 0x7a]; // --p-green-400
const AWAITING = [0xcf, 0x8b, 0x22]; // --p-amber-400
const UNCONFIRMABLE = [0x8e, 0x99, 0xe0]; // --p-steel-300

// ---------------------------------------------------------------------------
// Geometry, in unit space (0..1), scaled to whatever size is requested.
// Everything sits inside a circle of radius 0.4 about the centre so an
// Android adaptive-icon crop cannot clip a mark.
// ---------------------------------------------------------------------------
const SPINE_X = 0.5;
const SPINE_HALF_WIDTH = 0.014;
const SPINE_TOP = 0.16;
const SPINE_BOTTOM = 0.84;

const DISC = { y: 0.29, radius: 0.095 };
const RING = { y: 0.5, radius: 0.095, stroke: 0.033 };
const BAR = { top: 0.68, bottom: 0.8, capHalfWidth: 0.095, halfThickness: 0.015 };

/** Samples per pixel, per axis. 4 gives 16 coverage samples per pixel,
 *  which is enough to keep a 5px-wide spine from looking ragged without
 *  needing a real rasteriser. */
const SUPERSAMPLE = 4;

const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

function distanceTo(x, y, cx, cy) {
  return Math.hypot(x - cx, y - cy);
}

/**
 * The layer stack, back to front. Each entry answers "is this unit-space
 * point inside me?"; the renderer resolves coverage by supersampling and
 * composites in order.
 */
const LAYERS = [
  {
    colour: SPINE,
    covers: (x, y) =>
      inRect(x, y, SPINE_X - SPINE_HALF_WIDTH, SPINE_TOP, SPINE_X + SPINE_HALF_WIDTH, SPINE_BOTTOM),
  },
  {
    // Confirmed: a filled disc. Closed — something is inside it.
    colour: CONFIRMED,
    covers: (x, y) => distanceTo(x, y, SPINE_X, DISC.y) <= DISC.radius,
  },
  {
    // Awaiting: the same footprint with nothing inside it. The spine shows
    // through the middle, which is the point — it is an empty container,
    // not an error.
    colour: AWAITING,
    covers: (x, y) => {
      const distance = distanceTo(x, y, SPINE_X, RING.y);
      return distance <= RING.radius && distance >= RING.radius - RING.stroke;
    },
  },
  {
    // Unconfirmable: an error bar. The only mark taller than it is wide —
    // it has extent, not a position.
    colour: UNCONFIRMABLE,
    covers: (x, y) =>
      inRect(
        x, y,
        SPINE_X - BAR.capHalfWidth, BAR.top - BAR.halfThickness,
        SPINE_X + BAR.capHalfWidth, BAR.top + BAR.halfThickness,
      ) ||
      inRect(
        x, y,
        SPINE_X - BAR.capHalfWidth, BAR.bottom - BAR.halfThickness,
        SPINE_X + BAR.capHalfWidth, BAR.bottom + BAR.halfThickness,
      ) ||
      inRect(
        x, y,
        SPINE_X - BAR.halfThickness, BAR.top,
        SPINE_X + BAR.halfThickness, BAR.bottom,
      ),
  },
];

/** Fraction of this pixel covered by `covers`, by supersampling. */
function coverage(covers, pixelX, pixelY, size) {
  let hits = 0;
  for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
    const y = (pixelY + (sy + 0.5) / SUPERSAMPLE) / size;
    for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
      const x = (pixelX + (sx + 0.5) / SUPERSAMPLE) / size;
      if (covers(x, y)) hits += 1;
    }
  }
  return hits / (SUPERSAMPLE * SUPERSAMPLE);
}

/** Raw RGBA scanlines with a leading filter byte per row (filter type 0). */
function renderScanlines(size) {
  const rowLength = size * 4 + 1;
  const raw = Buffer.alloc(rowLength * size);

  for (let py = 0; py < size; py += 1) {
    const rowStart = py * rowLength;
    raw[rowStart] = 0; // filter: none
    for (let px = 0; px < size; px += 1) {
      let [r, g, b] = GROUND;
      for (const layer of LAYERS) {
        const alpha = coverage(layer.covers, px, py, size);
        if (alpha === 0) continue;
        r = Math.round(r * (1 - alpha) + layer.colour[0] * alpha);
        g = Math.round(g * (1 - alpha) + layer.colour[1] * alpha);
        b = Math.round(b * (1 - alpha) + layer.colour[2] * alpha);
      }
      const offset = rowStart + 1 + px * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = 255; // fully opaque: an app icon is a solid square
    }
  }
  return raw;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, checksum]);
}

function encodePng(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // compression: deflate
  header[11] = 0; // filter: adaptive
  header[12] = 0; // interlace: none

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(renderScanlines(size), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outputDir = path.resolve(import.meta.dirname, '..', 'public');
for (const size of [192, 512]) {
  const file = path.join(outputDir, `icon-${size}.png`);
  writeFileSync(file, encodePng(size));
  console.log(`wrote ${file}`);
}
