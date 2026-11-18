# Database (Supabase Postgres)

Paahi stores confirmed orders, callback requests, call records and the staff-notification outbox in Supabase Postgres. **An order counts as placed only after the database confirms the save.** Email and webhook notifications are sent afterwards and retried. Their status is tracked separately.

## Tables

| Table | What it holds |
|---|---|
| `businesses`, `locations` | Synced from `businesses/*/business.json` at startup (the files stay the source of truth) |
| `orders` | One row per confirmed order. `unique (business_id, idempotency_key)` makes duplicates impossible |
| `callback_requests` | Staff callback requests (caller asked for a person, the order couldn't be saved, and so on) |
| `notifications` | Outbox: one row per order/callback per channel (email, webhook), with status, attempts and last error |
| `calls` | One row per call: business, language history, outcome, stages and latency. **No transcript text** |
| `business_members` | Which Supabase Auth users can read which business's data (for a future dashboard) |

Schema: [`supabase/migrations/20261117000000_paahi_core.sql`](../supabase/migrations/20261117000000_paahi_core.sql).

## Tenant isolation (enforced by Postgres)

- The voice backend connects as the role **`paahi_app`**, which cannot bypass row-level security.
- Every transaction runs `set_config('app.business_id', <id>, true)`. Every table's policy only exposes rows where `business_id` matches. A query with a missing `WHERE` still can't read or change another business's rows (covered by tests).
- The server **refuses to start** if its database role is a superuser or has `BYPASSRLS`, or if the schema is missing.
- Dashboard users (`authenticated`) can only **read** rows of businesses listed for them in `business_members`. `anon` gets nothing.
- `paahi_app` has no `DELETE` permission.

## One-time setup

1. **Create a Supabase project** (any region near your callers, such as US East for New Jersey).
2. **Apply the migration.** Either paste the migration file into *SQL Editor → New query → Run*, or use the Supabase CLI:
   ```bash
   supabase link --project-ref <your-project-ref>
   ```
   ```bash
   supabase db push
   ```
3. **Give the backend role a password.** In the SQL Editor, run this with a long random password you generate:
   ```sql
   alter role paahi_app with login password '<long-random-password>';
   ```
4. **Set `DATABASE_URL`** on the server. Use the **pooler** connection string from *Project Settings → Database → Connection string*, with the user changed to `paahi_app.<project-ref>`:
   ```text
   postgresql://paahi_app.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   ```
   Port 5432 is the session pooler; 6543 (the transaction pooler) also works, because Paahi sets the business per transaction. If the pooler rejects the custom role, use the direct connection (`db.<project-ref>.supabase.co:5432`, user `paahi_app`). Direct connections need IPv6 or Supabase's IPv4 add-on.
5. **Optional but recommended:** download the project's SSL certificate (*Database settings → SSL*) and put its contents in `DATABASE_CA_CERT`. Without it the connection is still encrypted, but the server's certificate isn't verified.
6. **Start the server.** It logs `Database connected as paahi_app (row-level security enforced)` and syncs each business into `businesses` and `locations`.

## Notifications

- Each confirmed order creates one outbox row per working channel: email if the business has an `email_to_env` value and `EMAIL_USER`/`EMAIL_PASS` are set, and webhook if `webhook_url_env` has a value.
- Delivery is attempted immediately after the save, then retried every minute with backoff (2, 4, 8… minutes), up to 6 attempts. Webhooks carry an `Idempotency-Key` header, so a receiver can ignore repeats.
- **The server refuses to start** if a business takes orders but has no working channel. An order nobody hears about is worse than no order.
- To see stuck notifications, run this in Supabase:
  `select * from notifications where status <> 'sent' order by created_at desc;`

## Local development

Tests and `npm run simulate` use **PGlite**: real Postgres running inside Node, with this same migration and the same row-level security. No Supabase account is needed for those. The simulator keeps its data in `logs/simulator/db`.
