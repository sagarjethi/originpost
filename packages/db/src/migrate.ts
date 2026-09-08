import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://originpost:originpost@localhost:65432/originpost";
const here = dirname(fileURLToPath(import.meta.url));
const migrationsPath = resolve(here, "../migrations");
const sql = postgres(databaseUrl, { max: 1 });

try {
  await sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  const files = (await readdir(migrationsPath))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  for (const name of files) {
    const applied = await sql<{ name: string }[]>`select name from schema_migrations where name = ${name}`;
    if (applied.length) continue;
    const migration = await readFile(resolve(migrationsPath, name), "utf8");
    await sql.begin(async (transaction) => {
      await transaction.unsafe(migration);
      await transaction`insert into schema_migrations (name) values (${name})`;
    });
    console.log(`Applied ${name}.`);
  }
  console.log("OriginPost database migrations completed.");
} finally {
  await sql.end();
}
