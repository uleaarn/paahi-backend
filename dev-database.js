/**
 * In-process Postgres (PGlite) with the real Supabase migrations applied.
 * Used by the tests and the text simulator — never by the phone server.
 *
 * Supabase provides the "auth" schema and the anon/authenticated roles; PGlite
 * doesn't, so minimal stand-ins are created first. Queries then run as the
 * paahi_app role, so row-level security applies exactly as in production.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PGlite } from '@electric-sql/pglite';
import { Database, pgliteAdapter } from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'supabase', 'migrations');

const SUPABASE_STANDINS = `
    create schema if not exists auth;
    create table if not exists auth.users (id uuid primary key);
    do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$;
    create or replace function auth.uid() returns uuid language sql stable
        as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
`;

/**
 * @param {object} [o]
 * @param {string|null} [o.dataDir] persist to a folder (simulator); in-memory if null (tests)
 * @returns {Promise<{ db: Database, raw: PGlite }>}
 */
export async function createDevDatabase({ dataDir = null } = {}) {
    const raw = dataDir ? new PGlite(dataDir) : new PGlite();
    const applied = (await raw.query("select to_regclass('public.orders') is not null as ok")).rows[0].ok;
    if (!applied) {
        await raw.exec(SUPABASE_STANDINS);
        for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()) {
            await raw.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
        }
    }
    return { db: new Database(pgliteAdapter(raw), { role: 'paahi_app' }), raw };
}
