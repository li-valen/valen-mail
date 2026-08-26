/**
 * Spec 5.6 — removing Postbox's OWN tracking pixel from a message body
 * before that body is rendered.
 *
 * WHY THIS EXISTS. Gmail files a copy of every SMTP send into the sender's
 * own Sent folder, and that copy is byte-identical to one a real recipient
 * received — same body, same live token. Measured 2026-08-25: one send to
 * two recipients produced TWO Sent copies sharing one Message-ID, each
 * carrying that recipient's own token. So when the sender re-reads what
 * they wrote, the pixel fetches and the event is attributed to a recipient
 * who did nothing.
 *
 * Nothing can be done about that inside Gmail's own clients. But inside
 * Postbox we own the render path completely, so the honest fix is simply
 * to never make the request: strip the pixel before the html reaches the
 * iframe. "Postbox does not lie to you about your own mail" is a property
 * we can actually hold, and this module is where it is held.
 *
 * APPLIED TO EVERY RENDERED BODY, NOT JUST THE SENT COPY. The Sent copy is
 * the loudest case, not the only one: a reply quoting the original carries
 * the original recipient's pixel, so rendering that INBOX copy reports
 * "alice opened your mail" when what actually happened is that Alice
 * replied and the user read her reply — the same lie in a different folder.
 * Spec 5.6 asks for the rule on ANY body for exactly this reason ("a reply
 * or bounce can carry the original pixel and fire phantom opens
 * indefinitely").
 *
 * A folder condition would also protect nothing. This installation has ONE
 * user, so any pixel on our own TRACKING_BASE_URL origin, in any message in
 * any of their accounts, was minted here for mail that user sent. Rendering
 * it can never produce a true fact — only the user's own read reported as
 * someone else's. Scoping by folder would have been a restriction with no
 * case behind it.
 *
 * THE RULE IS DELIBERATELY NARROW, AND BOTH HALVES ARE LOAD-BEARING:
 *
 *  1. Only `<img>` elements whose `src` is an ABSOLUTE url on our own
 *     TRACKING_BASE_URL origin, under that base's `/o/` path — the exact
 *     shape ../send/build.ts's `pixelUrl` emits. Nothing else.
 *  2. Everything else survives verbatim: third-party pixels, images the
 *     user embedded, `cid:` inline parts, and any image on our own origin
 *     that is not under `/o/`.
 *
 * Rule 2 is not politeness. Remote images load by DEFAULT in this product,
 * at the user's explicit request, so a stripper that removed every remote
 * image would delete the pictures the user actually wanted while still
 * passing any test that only checked "the tracking pixel is gone". Removing
 * a legitimate image is a real regression, not a safe over-correction.
 *
 * WHY A REGEX AND NOT A DOM PARSER. There is no DOM in this runtime and a
 * parser would be a new dependency (Plan constraint: none). That is
 * acceptable here for a reason that does not generalise: this function only
 * ever DELETES a complete `<img ...>` match, never rewrites or reassembles
 * one, so the failure modes are bounded to "removed too much" or "removed
 * too little" — it cannot synthesise a tag. And every ambiguous case is
 * resolved toward KEEPING the image (see `ownPixelBase` and the `[^>]*`
 * note below), so the direction of failure is the safe one.
 *
 * This is NOT sanitisation and must not grow into it. ./message.ts's own
 * doc comment explains at length why the sandboxed iframe is the security
 * boundary and why a server-side sanitiser would erode it; this removes one
 * specific url we ourselves put there, which is a different job entirely.
 */

/**
 * The path segment tracking serves pixels from — `/o/{token}.png`, per
 * spec 5.1 and tracking/vercel.json's own rewrite. Written here as the
 * boundary between "our tracking endpoint" and "an ordinary asset that
 * happens to be on the same host", so an image at
 * `https://track.example/assets/logo.png` is never mistaken for a pixel.
 */
const PIXEL_PATH_SEGMENT = '/o/';

/**
 * One `<img>` element. `[^>]*` cannot span an attribute value containing
 * `>`, so such a tag matches only partially — the `src` extraction below
 * then fails and the tag is left alone. That is the correct direction: a
 * weird-but-legitimate image survives, and the only pixel we lose is one
 * written in a shape ../send/build.ts cannot produce (it emits `alt=""`
 * and nothing else).
 */
const IMG_TAG = /<img\b[^>]*>/gi;

/**
 * The `src` attribute, in all three quoting forms HTML allows.
 *
 * The leading `[\s/]` is what keeps this from matching `data-src`,
 * `lowsrc` or any other attribute merely ENDING in "src" — without it, a
 * lazy-loading image's `data-src` would be read as the real one.
 */
const SRC_ATTRIBUTE = /[\s/]src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/i;

/**
 * Parses TRACKING_BASE_URL once per call rather than per `<img>`.
 *
 * Returns null — meaning "strip nothing" — for an absent or malformed
 * base. An operator typo in TRACKING_BASE_URL must not make this function
 * throw on a route whose actual job is rendering the user's mail, and it
 * must not fall back to a looser match either: with no trustworthy origin
 * to compare against, the honest answer is to leave the body alone.
 */
function ownPixelBase(pixelBase: string | null): URL | null {
  if (!pixelBase) return null;
  try {
    return new URL(pixelBase);
  } catch {
    return null;
  }
}

/**
 * True when `src` addresses our own tracking pixel.
 *
 * Parsed as an ABSOLUTE url with no base, deliberately. Passing the pixel
 * base as `new URL`'s second argument would resolve a RELATIVE `src` — say
 * `"/o/abc.png"` in some unrelated newsletter — onto our own origin and
 * delete an image that was never ours. A relative src throws here instead,
 * and throwing means "not ours".
 *
 * `URL` normalises the host to lower case on both sides, so this compares
 * origins the way DNS does rather than the way `===` on a raw string would.
 * The path prefix mirrors `pixelUrl` in ../send/build.ts exactly, trailing
 * slashes and all, so a base carrying a path (`https://host/px/`) matches
 * `/px/o/...` and not `/o/...`.
 */
function isOwnPixelUrl(src: string, base: URL): boolean {
  let target: URL;
  try {
    target = new URL(src);
  } catch {
    return false;
  }
  if (target.origin !== base.origin) return false;
  return target.pathname.startsWith(`${base.pathname.replace(/\/+$/, '')}${PIXEL_PATH_SEGMENT}`);
}

/** The `src` value of one `<img>` tag, or null when it carries none this
 *  function is confident about. */
function srcOf(tag: string): string | null {
  const match = SRC_ATTRIBUTE.exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/**
 * Returns `html` with our own tracking pixels removed, and every other byte
 * untouched.
 *
 * Total: never throws, and returns the input unchanged whenever it cannot
 * establish with confidence that a given `<img>` is ours — including when
 * tracking is not configured at all (`pixelBase` null), which is a
 * supported startup state (see config.ts's parseTrackingConfig).
 *
 * `null` in, `null` out: a message with no html alternative stays that way
 * rather than becoming an empty string, which ParsedMessage.html
 * distinguishes.
 */
export function stripOwnTrackingPixels(html: string | null, pixelBase: string | null): string | null {
  if (html === null) return null;
  const base = ownPixelBase(pixelBase);
  if (base === null) return html;

  return html.replace(IMG_TAG, (tag) => {
    const src = srcOf(tag);
    if (src === null) return tag;
    return isOwnPixelUrl(src, base) ? '' : tag;
  });
}
