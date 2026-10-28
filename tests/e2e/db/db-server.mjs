// Starts an in-memory Postgres (PGlite) on a local port with stand-ins for Supabase-only pieces
// (vault, pg_net, roles), then applies the real migration.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { readFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 54329);
const db = await PGlite.create();

await db.exec(`
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  end $$;
  create schema if not exists extensions;
  create or replace function extensions.gen_random_bytes(n int) returns bytea language sql as $$
    select decode(substr(repeat(md5(random()::text), 4), 1, n * 2), 'hex')
  $$;
  create schema if not exists vault;
  create table vault.secrets (id serial primary key, name text unique, secret text, description text);
  create view vault.decrypted_secrets as select id, name, secret as decrypted_secret, description from vault.secrets;
  create or replace function vault.create_secret(secret text, name text, description text) returns int language sql as $$
    insert into vault.secrets (name, secret, description) values (name, secret, description) returning id
  $$;
`);

let migration = readFileSync(new URL("../../../supabase/migrations/001_edgebot.sql", import.meta.url), "utf8");
migration = migration.replace(/create extension if not exists pg_net;/, "");
await db.exec(migration);

const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
await server.start();
console.log(`READY ${port}`);
process.on("SIGTERM", async () => { await server.stop(); process.exit(0); });
