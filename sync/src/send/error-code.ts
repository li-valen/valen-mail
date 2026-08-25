/**
 * The one detail of a caught error this send path is willing to log.
 *
 * Plan 4's Global Constraints forbid logging a subject, body, recipient or
 * token, and an error's `message` routinely carries all four by accident:
 * nodemailer quotes the SMTP server's reply, which quotes the recipient
 * address, and a `fetch`/`URL` failure can quote the request it failed on,
 * which is a recipient list. Logging the error OBJECT is therefore the
 * same leak as logging the message, one `console.error` argument later.
 *
 * A code is the diagnostic that survives that rule intact: nodemailer sets
 * `EAUTH`, `EENVELOPE`, `ESOCKET`, `ETIMEDOUT` and friends, and Node sets
 * `ECONNREFUSED`/`ENOTFOUND` on socket errors — enough to tell an
 * operator whether the credential, the recipient or the network is at
 * fault, with no content attached. Anything without a string `code` falls
 * back to the error's constructor name ('Error', 'TypeError'), which is
 * likewise content-free.
 *
 * Its own module because two callers a layer apart need it — ./send.ts's
 * per-recipient failure path and ./transports.ts's shutdown path — and
 * having the lower-level one import from the higher-level one to share
 * twelve lines would be a worse shape than one small file.
 */
export function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return error instanceof Error ? error.name : 'unknown';
}
