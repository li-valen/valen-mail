import { describe, it, expect } from 'vitest';
import { orderIdentities, handleIdentities } from '../src/api/identities.ts';
import { createRouter } from '../src/api/routes.ts';
import { createRouterFromConfig } from '../src/api/server.ts';
import type { AccountConfig } from '../src/config';
import { makeFakeDb, makeFakePool, readJson, TOKEN, AUTH } from './helpers/api-fakes.ts';

/**
 * Plan 4 Task 2 — GET /api/identities.
 *
 * Three layers, each proving something the layer below it cannot:
 *  - orderIdentities: the pure ordering/serialisation rule.
 *  - handleIdentities: the Response it is wrapped in (status, headers).
 *  - the router: that the route is actually reachable, gated by auth, and
 *    wired to a real `accounts` array rather than a fossil default.
 */

const ACCOUNT_PRIMARY: AccountConfig = {
  id: 'primary',
  email: 'primary@example.com',
  appPassword: 'p'.repeat(16),
  isPrimary: true,
};
const ACCOUNT_SECOND: AccountConfig = {
  id: 'second',
  email: 'second@example.com',
  appPassword: 's'.repeat(16),
  isPrimary: false,
};
const ACCOUNT_THIRD: AccountConfig = {
  id: 'third',
  email: 'third@example.com',
  appPassword: 't'.repeat(16),
  isPrimary: false,
};

describe('orderIdentities', () => {
  it('puts the primary account first even when it is NOT first in config order', () => {
    // The load-bearing case: config lists primary second, and the
    // response must still open with it — a composer that just takes
    // identities[0] as the send-from default must never land on a
    // non-primary account because of where accounts.json happened to list it.
    const accounts = [ACCOUNT_SECOND, ACCOUNT_PRIMARY, ACCOUNT_THIRD];

    const identities = orderIdentities(accounts);

    expect(identities.map((identity) => identity.id)).toEqual(['primary', 'second', 'third']);
    expect(identities[0]!.isPrimary).toBe(true);
  });

  it('preserves config order among the non-primary accounts', () => {
    const accounts = [ACCOUNT_THIRD, ACCOUNT_PRIMARY, ACCOUNT_SECOND];
    expect(orderIdentities(accounts).map((identity) => identity.id)).toEqual([
      'primary',
      'third',
      'second',
    ]);
  });

  it('carries only id, email, and isPrimary', () => {
    expect(orderIdentities([ACCOUNT_PRIMARY])).toEqual([
      { id: 'primary', email: 'primary@example.com', isPrimary: true },
    ]);
  });

  it('never carries appPassword, even though the input account has it', () => {
    const identities = orderIdentities([ACCOUNT_PRIMARY, ACCOUNT_SECOND]);
    expect(JSON.stringify(identities)).not.toContain(ACCOUNT_PRIMARY.appPassword);
    expect(JSON.stringify(identities)).not.toContain(ACCOUNT_SECOND.appPassword);
  });

  it('returns an empty list for no accounts, rather than throwing', () => {
    expect(orderIdentities([])).toEqual([]);
  });

  it('does not mutate the accounts array it is given', () => {
    const accounts = [ACCOUNT_SECOND, ACCOUNT_PRIMARY];
    const snapshot = JSON.stringify(accounts);
    orderIdentities(accounts);
    expect(JSON.stringify(accounts)).toBe(snapshot);
  });
});

describe('handleIdentities', () => {
  it('serialises the ordered list as 200 JSON, private/no-store', async () => {
    const response = handleIdentities([ACCOUNT_SECOND, ACCOUNT_PRIMARY]);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await readJson(response)).toEqual({
      identities: [
        { id: 'primary', email: 'primary@example.com', isPrimary: true },
        { id: 'second', email: 'second@example.com', isPrimary: false },
      ],
    });
  });

  it('never lets an app password reach the serialized response body', async () => {
    const response = handleIdentities([ACCOUNT_PRIMARY, ACCOUNT_SECOND, ACCOUNT_THIRD]);
    const raw = await response.clone().text();

    expect(raw).not.toContain(ACCOUNT_PRIMARY.appPassword);
    expect(raw).not.toContain(ACCOUNT_SECOND.appPassword);
    expect(raw).not.toContain(ACCOUNT_THIRD.appPassword);
  });
});

const FAKE_POOL = makeFakePool().pool;

/** `createRouter`'s 8th positional parameter — see routes.ts's own doc
 *  comment for why `accounts` was appended there rather than inserted
 *  earlier in the list. */
function routerWith(accounts: readonly AccountConfig[]) {
  return createRouter(makeFakeDb(), FAKE_POOL, TOKEN, null, undefined, null, undefined, accounts);
}

describe('GET /api/identities — routing', () => {
  it('returns the ordered identities for an authenticated caller', async () => {
    const router = routerWith([ACCOUNT_SECOND, ACCOUNT_PRIMARY]);

    const response = await router(new Request('http://x/api/identities', { headers: AUTH }));

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      identities: [
        { id: 'primary', email: 'primary@example.com', isPrimary: true },
        { id: 'second', email: 'second@example.com', isPrimary: false },
      ],
    });
  });

  it('requires a credential', async () => {
    const router = routerWith([ACCOUNT_PRIMARY]);
    const response = await router(new Request('http://x/api/identities'));
    expect(response.status).toBe(401);
  });

  it('never leaks an app password even on the unauthenticated path', async () => {
    // Belt and suspenders: prove the 401 body itself carries nothing,
    // since an unauthenticated caller never reaches handleIdentities at all.
    const router = routerWith([ACCOUNT_PRIMARY]);
    const response = await router(new Request('http://x/api/identities'));
    const raw = await response.clone().text();
    expect(raw).not.toContain(ACCOUNT_PRIMARY.appPassword);
  });

  it('a POST to /api/identities is 404, not a silent write route', async () => {
    const router = routerWith([ACCOUNT_PRIMARY]);
    const response = await router(
      new Request('http://x/api/identities', { method: 'POST', headers: AUTH }),
    );
    expect(response.status).toBe(404);
  });

  it('defaults to an empty identity list when the router is built with no accounts at all', async () => {
    // createRouter's own default (`[]`) — every pre-Task-2 call site that
    // builds a router without passing accounts must still answer 200 with
    // an empty list, never throw.
    const router = createRouter(makeFakeDb(), FAKE_POOL, TOKEN);
    const response = await router(new Request('http://x/api/identities', { headers: AUTH }));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ identities: [] });
  });

  it('adds no route of its own beyond the exact path: a near-miss path is still 404', async () => {
    const router = routerWith([ACCOUNT_PRIMARY]);
    const response = await router(
      new Request('http://x/api/identities/primary', { headers: AUTH }),
    );
    expect(response.status).toBe(404);
  });
});

describe('createRouterFromConfig — threads config.accounts through to /api/identities', () => {
  const BASE_CONFIG = {
    accounts: [ACCOUNT_SECOND, ACCOUNT_PRIMARY],
    databaseUrl: 'postgresql://localhost/x',
    port: 8080,
    trackingConfig: null,
    vapidConfig: null,
  };

  it('reaches the route — not just the type signature', async () => {
    // Mirrors tests/push.test.ts's own "createRouterFromConfig — the
    // server.ts wiring" suite: createRouterFromConfig bundles
    // config.accounts into a positional argument list handed to
    // createRouter, and nothing else in this file would notice that
    // specific wire breaking. Every other test above calls createRouter
    // directly and would stay green even if createRouterFromConfig
    // dropped or transposed this one argument — which is exactly the
    // causally-inert shape this project's own review process has caught
    // and fixed before (see createRouterFromConfig's doc comment).
    const router = createRouterFromConfig(makeFakeDb(), FAKE_POOL, TOKEN, BASE_CONFIG as never);

    const response = await router(new Request('http://x/api/identities', { headers: AUTH }));

    expect(await readJson(response)).toEqual({
      identities: [
        { id: 'primary', email: 'primary@example.com', isPrimary: true },
        { id: 'second', email: 'second@example.com', isPrimary: false },
      ],
    });
  });
});
