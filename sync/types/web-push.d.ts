/**
 * Local type declarations for `web-push` (3.6.7), which ships no types of
 * its own.
 *
 * Written by hand rather than adding `@types/web-push`, because exactly
 * ONE new dependency was authorised for this project and `web-push` is it.
 * A types-only devDependency is still a second package name in
 * package.json and a second thing to keep current, and only three symbols
 * are used here.
 *
 * Narrow on purpose: this declares the surface sync/src/push/send.ts
 * actually calls, not the library's full API. Adding a call means adding
 * its declaration here first, which is the intended friction — a hand
 * declaration that has drifted from the library is worse than none, and a
 * small one drifts less.
 */
declare module 'web-push' {
  /** The `sub`/`aud`/keypair triple RFC 8292 signs each JWT with. */
  export interface VapidDetails {
    readonly subject: string;
    readonly publicKey: string;
    readonly privateKey: string;
  }

  /** The browser's subscription, as `PushSubscription.toJSON()` yields it. */
  export interface WebPushSubscription {
    readonly endpoint: string;
    readonly keys: {
      readonly p256dh: string;
      readonly auth: string;
    };
  }

  /**
   * Exactly the options sync/src/push/send.ts passes, and no more.
   *
   * `urgency` and `topic` were declared and never used; they are gone (fix
   * round 1). This interface is the reason `SendImpl` can be typed rather
   * than taking a `Record<string, unknown>` — an index signature would
   * accept `vapidDetais` silently, producing an unsigned push. Adding an
   * option means adding it here first, which is the intended friction.
   */
  export interface RequestOptions {
    readonly vapidDetails?: VapidDetails;
    /** Seconds the push service may hold an undelivered message. */
    readonly TTL?: number;
    /** Milliseconds before the HTTP request to the push service is aborted. */
    readonly timeout?: number;
  }

  export interface SendResult {
    readonly statusCode: number;
    readonly body: string;
    readonly headers: Record<string, string>;
  }

  /**
   * What `sendNotification` rejects with on a non-2xx from the push
   * service. `statusCode` is the field ../src/push/vapid.ts's
   * `shouldPruneOnStatus` reads; `endpoint` is present on the real error
   * object and is declared here so it is visible that it must never be
   * logged.
   */
  export class WebPushError extends Error {
    readonly statusCode: number;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly endpoint: string;
  }

  /** `generateVAPIDKeys` is deliberately NOT declared: the keypair is
   *  generated once by the `npx web-push generate-vapid-keys` CLI, never
   *  by this service at runtime. Declaring it would be an unused
   *  declaration and an invitation to mint a key on a code path. */
  const webpush: {
    sendNotification(
      subscription: WebPushSubscription,
      payload?: string | Buffer | null,
      options?: RequestOptions,
    ): Promise<SendResult>;
  };

  export default webpush;
}
