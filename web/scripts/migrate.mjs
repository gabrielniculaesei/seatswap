/**
 * Migration runner. Applies db/migrations/*.sql in filename order, once each.
 *
 * No ORM, no migration framework: numbered SQL files and a table that records
 * which ones ran (CLAUDE.md §12, §17). Each file runs inside its own transaction,
 * so a failure leaves the database on the last good migration.
 *
 *   npm run migrate --prefix web
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'db', 'migrations');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const applied = new Map(
    (await sql`SELECT filename, checksum FROM schema_migrations`).map((row) => [
      row.filename,
      row.checksum,
    ]),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  let ran = 0;
  for (const filename of files) {
    const body = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
    const checksum = createHash('sha256').update(body).digest('hex').slice(0, 16);

    const previous = applied.get(filename);
    if (previous) {
      // An edited migration that already ran is almost always a mistake, and a
      // silent one: the database and the file no longer describe the same schema.
      if (previous !== checksum) {
        console.error(
          `${filename} already ran but its contents changed ` +
            `(${previous} -> ${checksum}). Add a new migration instead of editing this one.`,
        );
        process.exitCode = 1;
        return;
      }
      continue;
    }

    process.stdout.write(`applying ${filename} ... `);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`
        INSERT INTO schema_migrations (filename, checksum) VALUES (${filename}, ${checksum})
      `;
    });
    console.log('ok');
    ran += 1;
  }

  console.log(ran === 0 ? 'already up to date' : `applied ${ran} migration(s)`);
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await sql.end();
}
