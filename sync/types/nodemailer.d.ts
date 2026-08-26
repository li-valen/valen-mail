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
 * Narrow on purpose: this declares the surface sync/src/send/ actually
 * calls today — `createTransport`, and the returned transport's
 * `sendMail()` and `close()` — not nodemailer's full API (verify, pooled
 * transports, OAuth2, DKIM, attachments, streams, callbacks, ...).
 *
 * Plan 4 Task 3 added `sendMail`, which Task 2 deliberately left out until
 * a caller existed. Every field below was checked against the INSTALLED
 * nodemailer 9.0.5 rather than written from memory: the options this
 * service passes are read by lib/mailer/index.js -> lib/mail-composer,
 * and the resolved value is assembled in lib/smtp-transport/index.js
 * (`info.envelope`/`info.messageId`) on top of lib/smtp-connection's
 * `{accepted, rejected}` (with `info.response` set from the final server
 * reply). Anything nodemailer would also accept but this service never
 * sends stays undeclared on purpose.
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
   * The SMTP envelope, set explicitly on every send (spec 5.3).
   *
   * When present, nodemailer uses THIS for `MAIL FROM`/`RCPT TO` and stops
   * deriving them from the To:/Cc: headers — which is the entire mechanism
   * behind per-recipient tracked sends: the headers carry the whole group
   * on every copy, the envelope carries exactly one address, so each
   * recipient receives the copy holding their own pixel.
   */
  export interface SendMailEnvelope {
    readonly from: string;
    readonly to: readonly string[];
  }

  /**
   * The mail options sync/src/send/send.ts passes, and only those.
   *
   * `to`/`cc` are declared as string arrays because that is all this
   * service sends; nodemailer itself also accepts a comma-joined string
   * and `{name, address}` objects. `cc` is optional and OMITTED (never
   * `[]`) when a send has no cc recipients.
   *
   * `messageId` is supplied rather than left to nodemailer's generator:
   * the same id is minted into the tracking database BEFORE the send, so
   * all N per-recipient copies of one logical message share one
   * Message-ID exactly as an ordinary group email would.
   */
  export interface SendMailOptions {
    readonly from: string;
    readonly to: readonly string[];
    readonly cc?: readonly string[];
    readonly subject: string;
    readonly text: string;
    readonly html: string;
    readonly messageId: string;
    /**
     * `In-Reply-To` and `References`, mapped straight onto those headers by
     * lib/mail-composer/index.js's header loop — verified against the
     * INSTALLED nodemailer 9.0.5 by compiling a message and reading the
     * bytes back, not from memory. An ARRAY of references is joined with
     * single spaces into ONE header, which is what RFC 5322 wants; a
     * falsy value (undefined, or an empty array) sets no header at all.
     */
    readonly inReplyTo?: string;
    readonly references?: readonly string[];
    readonly envelope: SendMailEnvelope;
  }

  /**
   * What a resolved `sendMail` hands back.
   *
   * `accepted`/`rejected` are the envelope addresses the server took and
   * refused — per-address, and NOT redundant with the promise settling:
   * nodemailer rejects the promise only when the whole send failed, so a
   * partially-refused envelope resolves with entries in `rejected`. This
   * service sends one envelope recipient at a time, so a non-empty
   * `rejected` means that one recipient did not get the mail, and
   * send.ts reports `ok: false` for them on exactly that basis.
   */
  export interface SentMessageInfo {
    readonly accepted: readonly string[];
    readonly rejected: readonly string[];
    readonly response: string;
    readonly envelope: SendMailEnvelope;
    readonly messageId: string;
  }

  /**
   * What `createTransport` returns (a `Mailer` instance, in the real
   * library — which also has `verify`, `isIdle`, event emitters and more).
   *
   * `sendMail` is declared in its promise form only. The real signature
   * takes an optional Node-style callback and returns `void` when given
   * one; this service always awaits, and declaring the overload would only
   * make it possible to call it in a way nothing here should.
   */
  export interface Transport {
    sendMail(options: SendMailOptions): Promise<SentMessageInfo>;
    close(): void;
  }

  const nodemailer: {
    createTransport(options: SmtpTransportOptions): Transport;
  };

  export default nodemailer;
}
