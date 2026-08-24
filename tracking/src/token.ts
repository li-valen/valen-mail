/**
 * 128 bits of randomness, rendered as hex. The token is opaque: it carries
 * no recipient, account, or message identifier.
 *
 * Mailspring base64-encodes {messageId, accountId, recipient} directly into
 * the URL, which anyone inspecting the pixel can decode — and a forwarded
 * message leaks the original recipient's address. A random token resolved
 * server-side costs one database read and leaks nothing. See spec AD4.
 */
const TOKEN_LENGTH_BYTES = 16;
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_LENGTH_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isValidToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}
