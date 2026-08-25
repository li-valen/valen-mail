/**
 * Local type declarations for `nodemailer` (9.x), which ships no types of
 * its own — confirmed by inspecting the installed package (no "types" or
 * "typings" field in package.json, no .d.ts anywhere under lib/).
 *
 * Written by hand rather than adding `@types/nodemailer`, mirroring this
 * project's own web-push.d.ts: `nodemailer` is the one new dependency
 * Plan 4 authorises (proven against these exact Gmail accounts by
 * tracking/scripts/send-test.mjs), and a types-only devDependency is still
 * a second package name in package.json and a second thing to keep
 * current.
 *
 * Narrow on purpose: this declares the surface sync/src/send/transports.ts
 * actually calls today — `createTransport` and the returned transport's
 * `close()` — not nodemailer's full API (sendMail, verify, pooled
 * transports, OAuth2, DKIM, ...). Plan 4 Task 3 (POST /api/send) will need
 * `sendMail`; that task must add its declaration here first, which is the
 * intended friction — a hand declaration that has drifted from the
 * library is worse than none, and a small one drifts less.
 */
declare module 'nodemailer' {
  /** The one credential shape this service ever sends: an account's own
   *  Gmail address and app password (see ../src/config.ts's AccountConfig
   *  and ../src/send/transports.ts). */
  export interface TransportAuth {
    readonly user: string;
    readonly pass: string;
  }

  /**
   * The subset of SMTPTransport's real options this service uses: a fixed
   * host/port pair (smtp.gmail.com:465, always secure) plus one account's
   * credential. Nodemailer's actual options object accepts many more knobs
   * (connection pooling, TLS overrides, a `service` shorthand, OAuth2...);
   * none of them are used here, so none are declared.
   */
  export interface SmtpTransportOptions {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly auth: TransportAuth;
  }

  /**
   * What `createTransport` returns (a `Mailer` instance, in the real
   * library — which also has `sendMail`, `verify`, `isIdle`, and more).
   * Only `close` is declared; see the module doc comment above for why
   * `sendMail` is deliberately absent until Task 3 needs it.
   */
  export interface Transport {
    close(): void;
  }

  const nodemailer: {
    createTransport(options: SmtpTransportOptions): Transport;
  };

  export default nodemailer;
}
