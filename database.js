/**
 * Database access. Every query runs inside a transaction scoped to ONE
 * business: we set app.business_id, and Postgres row-level security (see
 * supabase/migrations) only exposes that business's rows. A bug in app code
 * that forgets a WHERE clause still cannot read or write another tenant.
 *
 * Two adapters with the same tiny interface ({ transaction(fn), close() }):
 *   - pgAdapter:     production, node-postgres pool -> Supabase Postgres
 *   - pgliteAdapter: tests and the simulator, in-process Postgres (PGlite)
 */
import pg from 'pg';

const STATEMENT_TIMEOUT = '5s';

export function pgAdapter({ connectionString, caCert = null, max = 5 }) {
    const ssl = /localhost|127\.0\.0\.1/.test(connectionString)
        ? false
        : (caCert ? { ca: caCert, rejectUnauthorized: true } : { rejectUnauthorized: false });
    const pool = new pg.Pool({
        connectionString,
        ssl,
        max,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
    });
    pool.on('error', err => console.error('❌ Database pool error:', err.message));
    return {
        sslVerified: Boolean(caCert),
        async transaction(fn) {
            const client = await pool.connect();
            try {
                await client.query('begin');
                const result = await fn({ query: (text, params) => client.query(text, params) });
                await client.query('commit');
                return result;
            } catch (error) {
                try { await client.query('rollback'); } catch { /* connection may be gone */ }
                throw error;
            } finally {
                client.release();
            }
        },
        close: () => pool.end(),
    };
}

export function pgliteAdapter(db) {
    return {
        sslVerified: true,
        transaction: fn => db.transaction(tx => fn({ query: (text, params) => tx.query(text, params) })),
        close: () => db.close(),
    };
}

/**
 * @param {object} adapter
 * @param {string|null} role  SET LOCAL ROLE for each transaction. Only for tests/simulator,
 *                            where the in-process database runs as a superuser.
 */
export class Database {
    constructor(adapter, { role = null } = {}) {
        this.adapter = adapter;
        this.role = role;
        if (role && !/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error('invalid role name');
    }

    /** Run fn(tx) as the given business. Throws if businessId is missing. */
    async forBusiness(businessId, fn) {
        if (!businessId) throw new Error('forBusiness requires a business id');
        return this.adapter.transaction(async tx => {
            await tx.query(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
            if (this.role) await tx.query(`set local role ${this.role}`);
            await tx.query("select set_config('app.business_id', $1, true)", [businessId]);
            return fn(tx);
        });
    }

    /** Startup safety check: the backend must NOT be able to bypass row-level security. */
    async checkTenantSafety() {
        const rows = await this.adapter.transaction(async tx => {
            if (this.role) await tx.query(`set local role ${this.role}`);
            return (await tx.query(
                `select r.rolname, r.rolsuper, r.rolbypassrls,
                        to_regclass('public.orders') is not null as has_schema
                   from pg_roles r where r.rolname = current_user`)).rows;
        });
        const me = rows[0];
        if (!me) throw new Error('could not read current database role');
        if (!me.has_schema) throw new Error('database schema missing: apply supabase/migrations first');
        if (me.rolsuper || me.rolbypassrls) {
            throw new Error(`database role "${me.rolname}" bypasses row-level security; connect as paahi_app instead`);
        }
        return { role: me.rolname };
    }

    async ping() {
        await this.adapter.transaction(tx => tx.query('select 1'));
    }

    close() { return this.adapter.close(); }
}
