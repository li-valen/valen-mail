import { describe, expect, it, vi } from 'vitest';
import { ApiError, moveMessage } from '../src/api';

/**
 * POST /api/message/{accountId}/{folder}/{uid}/move — the second call in
 * this client that changes the user's real Gmail.
 *
 * Held to the same boundary discipline as `setMessageFlag`: the path
 * shape has to match what sync/src/api/routes.ts matches, a non-2xx has
 * to surface as an ApiError so the caller can roll its optimistic
 * removal back, and a malformed 200 has to degrade in the SAFE direction
 * — which for each of the two fields is a different direction, and is
 * asserted as such below.
 */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const TICKET = { folder: '[Gmail]/Trash', uid: 900, origin: 'inbox' };

function ok(body: unknown = { ok: true, moved: true, undo: TICKET }) {
  return vi.fn().mockResolvedValue(jsonResponse(body));
}

describe('moveMessage / what goes on the wire', () => {
  it('posts to /api/message/{accountId}/{folder}/{uid}/move', async () => {
    const fetchImpl = ok();
    await moveMessage('primary', 'INBOX', '33097', { to: 'archive' }, fetchImpl);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('/api/message/primary/INBOX/33097/move');
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('POST');
  });

  it('encodes a folder containing a slash so it stays one path segment', async () => {
    const fetchImpl = ok();
    await moveMessage('primary', '[Gmail]/Trash', '12', { to: 'undo', origin: 'inbox' }, fetchImpl);
    const path = String(fetchImpl.mock.calls[0]?.[0]);
    expect(path).toBe('/api/message/primary/%5BGmail%5D%2FTrash/12/move');
    expect(path.replace('/api/message/', '').split('/')).toHaveLength(4);
  });

  it('sends the destination as a literal and nothing else', async () => {
    // A body carrying a folder NAME is what makes this route dangerous.
    // sync/src/api/move.ts rejects an unknown key outright, so a client
    // that added one would break every move rather than fail quietly —
    // this pins that the client sends exactly what the route accepts.
    const fetchImpl = ok();
    await moveMessage('primary', 'INBOX', '1', { to: 'trash' }, fetchImpl);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ to: 'trash' });
  });

  it('replays an undo ticket as the origin the server issued', async () => {
    const fetchImpl = ok();
    await moveMessage('primary', '[Gmail]/Trash', '900', { to: 'undo', origin: 'spam' }, fetchImpl);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      to: 'undo',
      origin: 'spam',
    });
  });

  it('sends no bearer token and rides the same-origin session cookie', async () => {
    const fetchImpl = ok();
    await moveMessage('primary', 'INBOX', '1', { to: 'archive' }, fetchImpl);
    const init = fetchImpl.mock.calls[0]?.[1] ?? {};
    expect(new Headers(init.headers ?? {}).get('authorization')).toBeNull();
    expect(init.credentials).toBe('same-origin');
  });
});

describe('moveMessage / what comes back', () => {
  it('returns the ticket so the caller can offer an undo', async () => {
    const result = await moveMessage('a', 'INBOX', '1', { to: 'trash' }, ok());
    expect(result).toEqual({ moved: true, undo: TICKET });
  });

  it('reports moved:false without treating it as an error', async () => {
    const fetchImpl = ok({ ok: true, moved: false, undo: null });
    const result = await moveMessage('a', 'INBOX', '1', { to: 'trash' }, fetchImpl);
    expect(result.moved).toBe(false);
    expect(result.undo).toBeNull();
  });

  it('throws ApiError carrying the status on a non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 502 }));
    await expect(moveMessage('a', 'INBOX', '1', { to: 'trash' }, fetchImpl)).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(moveMessage('a', 'INBOX', '1', { to: 'trash' }, fetchImpl)).rejects.toMatchObject({
      status: 502,
    });
  });

  it('a 409 is an ApiError too — the caller must roll back either way', async () => {
    // "This account has no Spam folder" is not a transport failure, but
    // the message did not move, so the row has to come back.
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 409 }));
    await expect(moveMessage('a', 'INBOX', '1', { to: 'spam' }, fetchImpl)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('moveMessage / a malformed 200 degrades in the SAFE direction', () => {
  it('assumes the move HAPPENED when `moved` is missing', () => {
    // The call returned 2xx, so it did. Reporting otherwise would roll a
    // row back into a list it has already left, putting a message the
    // user archived back in front of them.
    return expect(moveMessage('a', 'INBOX', '1', { to: 'trash' }, ok({}))).resolves.toMatchObject({
      moved: true,
    });
  });

  it('offers NO undo when the ticket is missing a field', async () => {
    // Inverted safety for the other field: a partial ticket replayed
    // would move an unrelated message into the user's inbox, so anything
    // unrecognised is refused rather than patched with a default.
    for (const undo of [
      undefined,
      null,
      {},
      { folder: '[Gmail]/Trash', uid: 900 },
      { folder: '[Gmail]/Trash', origin: 'inbox' },
      { uid: 900, origin: 'inbox' },
      { folder: '', uid: 900, origin: 'inbox' },
      { folder: '[Gmail]/Trash', uid: '900', origin: 'inbox' },
      { folder: '[Gmail]/Trash', uid: 0, origin: 'inbox' },
      { folder: '[Gmail]/Trash', uid: -1, origin: 'inbox' },
      { folder: '[Gmail]/Trash', uid: 1.5, origin: 'inbox' },
      { folder: '[Gmail]/Trash', uid: 900, origin: '' },
      'a ticket',
      42,
    ]) {
      const result = await moveMessage('a', 'INBOX', '1', { to: 'trash' }, ok({ moved: true, undo }));
      expect(result.undo, `accepted ${JSON.stringify(undo)}`).toBeNull();
    }
  });

  it('the ticket guard is not vacuous — a complete ticket is accepted', async () => {
    const result = await moveMessage('a', 'INBOX', '1', { to: 'trash' }, ok({ moved: true, undo: TICKET }));
    expect(result.undo).toEqual(TICKET);
  });
});
