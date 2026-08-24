/**
 * A 68-byte 1x1 fully transparent RGBA PNG.
 *
 * Invisibility comes from these bytes, NOT from markup. The injected <img>
 * tag deliberately carries no width/height/style/class, because zero
 * dimensions and hidden styling are the primary heuristics tracking-pixel
 * blockers match on. See spec 5.1.
 */
export const PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';

export const PIXEL_BYTES: Uint8Array = Uint8Array.from(
  atob(PIXEL_PNG_BASE64),
  (char) => char.charCodeAt(0),
);

/**
 * Without these, Gmail's image proxy and Vercel's own CDN cache the
 * response and every open after the first is silently lost. See spec 5.5.
 */
export const NO_STORE_HEADERS: Record<string, string> = {
  'content-type': 'image/png',
  'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
  pragma: 'no-cache',
  expires: '0',
};

export function pixelResponse(): Response {
  return new Response(PIXEL_BYTES, { status: 200, headers: NO_STORE_HEADERS });
}
