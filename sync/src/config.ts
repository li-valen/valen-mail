/** Gmail permits ~15 concurrent IMAP connections per account; one IDLE
 *  connection each keeps ten accounts comfortably inside that. The cap
 *  exists to stop a config typo from opening an unbounded number. */
export const MAX_ACCOUNTS = 10;

/** Google renders app passwords in four spaced groups; the spaces are
 *  presentational and must be stripped before use. */
const APP_PASSWORD_LENGTH = 16;

export interface AccountConfig {
  readonly id: string;
  readonly email: string;
  readonly appPassword: string;
  readonly isPrimary: boolean;
}

export interface SyncConfig {
  readonly accounts: readonly AccountConfig[];
  readonly databaseUrl: string;
  readonly port: number;
}

function parseAccount(raw: unknown, index: number): AccountConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`accounts[${index}] is not an object`);
  }
  const record = raw as Record<string, unknown>;
  const id = record.id;
  const email = record.email;
  const password = record.appPassword;
  const isPrimary = record.isPrimary;

  if (typeof id !== 'string' || !id) throw new Error(`accounts[${index}] has no id`);

  if (typeof email !== 'string') {
    throw new Error(`account "${id}" has no email`);
  }
  const trimmedEmail = email.trim();
  if (!trimmedEmail || !trimmedEmail.includes('@')) {
    throw new Error(`account "${id}" has an invalid email`);
  }

  if (typeof password !== 'string') throw new Error(`account "${id}" has no appPassword`);

  const stripped = password.replace(/\s+/g, '');
  if (stripped.length !== APP_PASSWORD_LENGTH) {
    // Never echo the value — an error message is the easiest place to leak
    // a credential into a log aggregator.
    throw new Error(
      `account "${id}": appPassword must be ${APP_PASSWORD_LENGTH} characters ` +
      `after removing spaces, got ${stripped.length}`,
    );
  }

  // isPrimary must be explicitly a boolean or absent (defaults to false)
  if (isPrimary !== undefined && typeof isPrimary !== 'boolean') {
    throw new Error(`account "${id}": isPrimary must be a boolean`);
  }

  return { id, email: trimmedEmail, appPassword: stripped, isPrimary: isPrimary === true };
}

function parsePort(portStr: string | undefined): number {
  // If PORT is absent or empty string, use default
  if (!portStr) return 8080;

  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${portStr}"`);
  }
  return port;
}

export function loadConfig(raw: unknown, env: NodeJS.ProcessEnv): SyncConfig {
  if (!Array.isArray(raw)) throw new Error('accounts config must be a JSON array');
  if (raw.length === 0) throw new Error('accounts config is empty');
  if (raw.length > MAX_ACCOUNTS) {
    throw new Error(`too many accounts: ${raw.length} exceeds MAX_ACCOUNTS ${MAX_ACCOUNTS}`);
  }

  const accounts = raw.map(parseAccount);

  const seenIds = new Set<string>();
  const seenEmails = new Set<string>();
  for (const account of accounts) {
    if (seenIds.has(account.id)) throw new Error(`duplicate account id "${account.id}"`);
    seenIds.add(account.id);

    const emailLower = account.email.toLowerCase();
    if (seenEmails.has(emailLower)) {
      // Find the duplicate account's id for better error messaging
      const first = accounts.find(a => a.email.toLowerCase() === emailLower);
      throw new Error(
        `duplicate email: account "${account.id}" and "${first?.id}" both use email (case-insensitive)`,
      );
    }
    seenEmails.add(emailLower);
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const port = parsePort(env.PORT);

  return { accounts, databaseUrl, port };
}
