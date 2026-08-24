import { glob } from 'node:fs/promises';
import path from 'node:path';

/**
 * Verifies every module under src/ can actually be loaded under
 * --experimental-strip-types — the same flag the deployed service runs
 * under, which rejects TypeScript-only constructs (parameter properties,
 * enums, namespaces, decorators) that `tsc --noEmit` alone would not catch.
 *
 * The file list is discovered by globbing src/**\/*.ts rather than
 * hardcoded, so a newly added module is covered automatically. A gate that
 * silently stops covering new files is the exact regression this exists to
 * catch.
 */

const SYNC_ROOT = path.resolve(import.meta.dirname, '..');

async function findSourceFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const file of glob('src/**/*.ts', { cwd: SYNC_ROOT })) {
    files.push(file);
  }
  return files.sort();
}

async function main(): Promise<void> {
  const files = await findSourceFiles();

  if (files.length === 0) {
    throw new Error('check:runtime found no files under src/ — the glob pattern is broken');
  }

  const failures: Array<{ file: string; error: unknown }> = [];
  for (const file of files) {
    try {
      await import(path.join(SYNC_ROOT, file));
    } catch (error) {
      failures.push({ file, error });
    }
  }

  if (failures.length > 0) {
    for (const { file, error } of failures) {
      console.error(`runtime import FAILED: ${file}`);
      console.error(error);
    }
    throw new Error(`check:runtime failed for ${failures.length} of ${files.length} module(s)`);
  }

  console.log(`runtime import OK (${files.length} modules)`);
}

await main();
