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

  if (typeof id !== 'string' || !id) throw new Error(`accounts[${index}] has no id`);
  if (typeof email !== 'string' || !email.includes('@')) {
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

  return { id, email, appPassword: stripped, isPrimary: record.isPrimary === true };
}

export function loadConfig(raw: unknown, env: NodeJS.ProcessEnv): SyncConfig {
  if (!Array.isArray(raw)) throw new Error('accounts config must be a JSON array');
  if (raw.length === 0) throw new Error('accounts config is empty');
  if (raw.length > MAX_ACCOUNTS) {
    throw new Error(`too many accounts: ${raw.length} exceeds MAX_ACCOUNTS ${MAX_ACCOUNTS}`);
  }

  const accounts = raw.map(parseAccount);

  const seen = new Set<string>();
  for (const account of accounts) {
    if (seen.has(account.id)) throw new Error(`duplicate account id "${account.id}"`);
    seen.add(account.id);
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  return { accounts, databaseUrl, port: Number(env.PORT ?? 8080) };
}
