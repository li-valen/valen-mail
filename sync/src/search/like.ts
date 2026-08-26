/**
 * Escapes the three characters LIKE/ILIKE treat as syntax, so a user
 * searching for `100%` gets messages containing "100%" rather than every
 * message in the mailbox, and `a_b` does not also match `axb`.
 *
 * Backslash is escaped FIRST — reversing the order would double-escape the
 * backslashes this function itself just introduced.
 *
 * No `ESCAPE` clause accompanies this in the SQL, deliberately: backslash
 * is LIKE's default escape character regardless of any GUC, and writing
 * `escape '\'` would put a backslash inside a SQL STRING LITERAL, whose
 * meaning genuinely does depend on `standard_conforming_strings` (the same
 * hazard pushFolderClause documents for '\Flagged'). The pattern itself
 * travels as a bound parameter and is never parsed as a literal at all.
 *
 * **This is a SEPARATE defence from parameterization, not a weaker
 * version of it.** A bound parameter cannot inject SQL; it can still be
 * a PATTERN, because `%` and `_` are LIKE syntax inside the value rather
 * than inside the statement. Dropping this would not open an injection —
 * it would silently turn `from:100%` into "every sender".
 *
 * Lives in its own file so ./clause.ts can use it without importing
 * ../db.ts, which imports ./clause.ts. ../db.ts re-exports it, so the
 * name every existing caller and test already imports is unchanged.
 */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (char) => `\\${char}`);
}
