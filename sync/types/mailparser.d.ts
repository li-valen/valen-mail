/**
 * Local type declarations for `mailparser` (3.9.x), which ships no types of
 * its own — confirmed against the INSTALLED package: no "types"/"typings"
 * field in its package.json and no .d.ts anywhere under lib/.
 *
 * Hand-written rather than adding `@types/mailparser`, mirroring this
 * project's own web-push.d.ts and nodemailer.d.ts. `mailparser` was already
 * a declared dependency before anything imported it, so the parsed-message
 * route (Plan 6 Task 1) adds no package; a types-only devDependency would
 * have been the one new package name in that plan, for a surface this
 * service uses a handful of fields of.
 *
 * Narrow on purpose. This declares what src/api/message.ts actually reads,
 * not mailparser's full API (MailParser the stream class, headers/
 * headerLines, textAsHtml, replyTo, priority, checksums, per-attachment
 * header maps, ...). Everything below was verified by
 * running the real parser over the fixtures in tests/fixtures/messages/,
 * not written from memory — in particular:
 *
 *  - `to`/`cc` are an AddressObject for one header occurrence and an ARRAY
 *    of them when the message carries the header more than once. Both
 *    shapes come out of the same field, so both are declared.
 *  - An entry in `value` is EITHER an address or an RFC 5322 group
 *    (`{name, group: [...]}` with no `address` at all), so `address` is
 *    optional. Anything reading it has to cope with its absence.
 *  - `html` is `undefined` (not null, not '') when no text/html part
 *    exists. It is declared `string | false` on the truthy side because
 *    mailparser's own cid-rewriting path can hand back a non-string, and a
 *    boundary that trusts it to be a string would put `false` on the wire.
 *  - `partId` is mailparser's RECONSTRUCTION of the IMAP part number, not
 *    a value read off the wire — see src/api/message.ts for where that
 *    reconstruction diverges and what corrects it.
 */
declare module 'mailparser' {
  /** One entry of an address header: a mailbox, or a named group of them. */
  export interface EmailAddress {
    readonly address?: string;
    readonly name?: string;
    readonly group?: readonly EmailAddress[];
  }

  /** One occurrence of an address header. `html`/`text` are mailparser's
   *  own pre-rendered forms of it; this service builds its own and reads
   *  only `value`. */
  export interface AddressObject {
    readonly value: readonly EmailAddress[];
    readonly html?: string;
    readonly text?: string;
  }

  /**
   * One attachment as mailparser reports it. `content` IS present (a
   * Buffer of the decoded bytes) and is deliberately not read anywhere in
   * this service — see src/api/message.ts. `size` is the DECODED length,
   * which is NOT the same number as BODYSTRUCTURE's encoded `size`.
   */
  export interface Attachment {
    readonly partId?: string;
    readonly filename?: string;
    readonly contentType?: string;
    readonly size?: number;
    readonly contentDisposition?: string;
    /** The raw `Content-ID` header value, angle brackets included. */
    readonly contentId?: string;
    /** `contentId` with the angle brackets stripped — what a `cid:` URL in
     *  the html body actually references. */
    readonly cid?: string;
    /** True when the part sits under a multipart/related, i.e. it is an
     *  embedded resource of the body rather than a separate download. */
    readonly related?: boolean;
    readonly content?: Buffer;
  }

  export interface ParsedMail {
    readonly html?: string | false;
    readonly text?: string;
    readonly subject?: string;
    readonly date?: Date;
    readonly from?: AddressObject;
    readonly to?: AddressObject | readonly AddressObject[];
    readonly cc?: AddressObject | readonly AddressObject[];
    /** The `Message-ID` header, angle brackets INCLUDED, or undefined when
     *  the message carries none. */
    readonly messageId?: string;
    /**
     * The `References` chain, oldest → newest, each entry with its angle
     * brackets.
     *
     * The union is not defensive typing — it is what the parser genuinely
     * returns, verified against mailparser 3.9 over real header bytes: a
     * BARE STRING for exactly one reference, an ARRAY for several,
     * `undefined` for an absent header and `[]` for a present-but-empty
     * one. Same shape hazard `to`/`cc` carry above. Normalised by
     * `normalizeReferences` in src/api/message.ts.
     */
    readonly references?: string | readonly string[];
    readonly attachments: readonly Attachment[];
  }

  export interface SimpleParserOptions {
    /**
     * Leaves `cid:` references in the html alone. MUST be true here: the
     * default (false) rewrites every embedded image into a base64 `data:`
     * URI, which inlines attachment CONTENT into the html this service
     * returns as JSON.
     */
    readonly keepCidLinks?: boolean;
  }

  export function simpleParser(
    source: Buffer,
    options?: SimpleParserOptions,
  ): Promise<ParsedMail>;
}
