-- Paahi core schema: businesses, calls, orders, callback requests, notification outbox.
--
-- Tenant isolation is enforced by Postgres row-level security, not only by app code:
--   * The voice backend connects as role "paahi_app" (no BYPASSRLS). Every
--     transaction sets app.business_id; policies only expose that business's rows.
--   * Business owners/staff (Supabase Auth, role "authenticated") can read only
--     rows of businesses they are members of. They cannot write through the API.
--   * "anon" gets nothing.
-- After applying, give paahi_app a login (run once, in the SQL editor, with your own password):
--   alter role paahi_app with login password '<generate-a-long-random-password>';

-- ---------------------------------------------------------------- roles
do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'paahi_app') then
        create role paahi_app nologin nobypassrls;
    end if;
end
$$;

grant usage on schema public to paahi_app;

-- Current tenant for this transaction (set by the backend with set_config(..., true)).
create or replace function public.paahi_current_business()
returns text
language sql
stable
as $$ select nullif(current_setting('app.business_id', true), '') $$;

grant execute on function public.paahi_current_business() to paahi_app;

-- ---------------------------------------------------------------- tables
create table public.businesses (
    id          text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    name        text not null,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create table public.locations (
    business_id text not null references public.businesses (id) on delete cascade,
    id          text not null,
    name        text,
    address     text,
    phone       text,
    updated_at  timestamptz not null default now(),
    primary key (business_id, id)
);

-- Who may read a business's data in a dashboard (Supabase Auth users).
create table public.business_members (
    business_id text not null references public.businesses (id) on delete cascade,
    user_id     uuid not null references auth.users (id) on delete cascade,
    role        text not null default 'staff' check (role in ('owner', 'staff')),
    created_at  timestamptz not null default now(),
    primary key (business_id, user_id)
);

create table public.calls (
    id               uuid primary key default gen_random_uuid(),
    business_id      text not null references public.businesses (id),
    location_id      text,
    call_sid         text not null,
    routed_by        text,
    started_at       timestamptz not null,
    ended_at         timestamptz,
    language         text,
    language_history jsonb not null default '[]'::jsonb,
    outcome          text,          -- order_placed | handoff | no_order | abandoned_with_items | ...
    handoff_reason   text,
    events           jsonb not null default '[]'::jsonb,  -- stages and latency; no transcript text
    created_at       timestamptz not null default now(),
    unique (business_id, call_sid)
);

create table public.orders (
    id               uuid primary key default gen_random_uuid(),
    business_id      text not null references public.businesses (id),
    location_id      text not null,
    call_sid         text not null,
    idempotency_key  text not null,
    status           text not null default 'confirmed'
                     check (status in ('confirmed', 'accepted', 'completed', 'cancelled')),
    order_type       text not null check (order_type in ('pickup', 'delivery')),
    customer_name    text not null check (length(customer_name) between 1 and 60),
    customer_phone   text not null check (customer_phone ~ '^[0-9]{10}$'),
    delivery_address text,
    items            jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),
    subtotal         numeric(10, 2) not null check (subtotal >= 0),
    currency         text not null default 'USD',
    order_notes      text,
    allergy_notes    text,
    language         text not null,
    confirmed_at     timestamptz not null,
    created_at       timestamptz not null default now(),
    unique (business_id, idempotency_key),
    foreign key (business_id, location_id) references public.locations (business_id, id),
    check (order_type <> 'delivery' or delivery_address is not null)
);

create table public.callback_requests (
    id               uuid primary key default gen_random_uuid(),
    business_id      text not null references public.businesses (id),
    location_id      text,
    call_sid         text not null,
    idempotency_key  text not null,
    customer_phone   text not null check (customer_phone ~ '^[0-9]{10}$'),
    customer_name    text,
    reason           text not null,
    language         text,
    order_snapshot   jsonb,
    status           text not null default 'open' check (status in ('open', 'done')),
    created_at       timestamptz not null default now(),
    unique (business_id, idempotency_key)
);

-- Outbox: written in the same transaction as the order, delivered afterwards.
-- Delivery status is tracked separately from whether the order exists.
create table public.notifications (
    id                  uuid primary key default gen_random_uuid(),
    business_id         text not null references public.businesses (id),
    order_id            uuid references public.orders (id),
    callback_request_id uuid references public.callback_requests (id),
    channel             text not null check (channel in ('email', 'webhook')),
    status              text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
    attempts            integer not null default 0,
    last_error          text,
    next_attempt_at     timestamptz not null default now(),
    sent_at             timestamptz,
    created_at          timestamptz not null default now(),
    check (num_nonnulls(order_id, callback_request_id) = 1),
    unique (order_id, channel),
    unique (callback_request_id, channel)
);

create index orders_business_created on public.orders (business_id, created_at desc);
create index calls_business_started on public.calls (business_id, started_at desc);
create index notifications_due on public.notifications (business_id, status, next_attempt_at);

-- ---------------------------------------------------------------- privileges
-- Supabase grants table access to anon/authenticated by default; take it back.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.businesses, public.locations, public.business_members, public.calls,
                public.orders, public.callback_requests, public.notifications to authenticated;

-- The voice backend never deletes.
grant select, insert, update on public.businesses, public.locations, public.calls, public.orders,
                                public.callback_requests, public.notifications to paahi_app;

-- ---------------------------------------------------------------- row-level security
alter table public.businesses        enable row level security;
alter table public.locations         enable row level security;
alter table public.business_members  enable row level security;
alter table public.calls             enable row level security;
alter table public.orders            enable row level security;
alter table public.callback_requests enable row level security;
alter table public.notifications     enable row level security;

alter table public.businesses        force row level security;
alter table public.locations         force row level security;
alter table public.business_members  force row level security;
alter table public.calls             force row level security;
alter table public.orders            force row level security;
alter table public.callback_requests force row level security;
alter table public.notifications     force row level security;

-- Backend: only the business set for the current transaction.
create policy app_businesses on public.businesses for all to paahi_app
    using (id = public.paahi_current_business())
    with check (id = public.paahi_current_business());
create policy app_locations on public.locations for all to paahi_app
    using (business_id = public.paahi_current_business())
    with check (business_id = public.paahi_current_business());
create policy app_calls on public.calls for all to paahi_app
    using (business_id = public.paahi_current_business())
    with check (business_id = public.paahi_current_business());
create policy app_orders on public.orders for all to paahi_app
    using (business_id = public.paahi_current_business())
    with check (business_id = public.paahi_current_business());
create policy app_callbacks on public.callback_requests for all to paahi_app
    using (business_id = public.paahi_current_business())
    with check (business_id = public.paahi_current_business());
create policy app_notifications on public.notifications for all to paahi_app
    using (business_id = public.paahi_current_business())
    with check (business_id = public.paahi_current_business());

-- Dashboard users: read-only, only their own businesses.
create policy member_reads_own_membership on public.business_members for select to authenticated
    using (user_id = auth.uid());
create policy member_businesses on public.businesses for select to authenticated
    using (id in (select business_id from public.business_members where user_id = auth.uid()));
create policy member_locations on public.locations for select to authenticated
    using (business_id in (select business_id from public.business_members where user_id = auth.uid()));
create policy member_calls on public.calls for select to authenticated
    using (business_id in (select business_id from public.business_members where user_id = auth.uid()));
create policy member_orders on public.orders for select to authenticated
    using (business_id in (select business_id from public.business_members where user_id = auth.uid()));
create policy member_callbacks on public.callback_requests for select to authenticated
    using (business_id in (select business_id from public.business_members where user_id = auth.uid()));
create policy member_notifications on public.notifications for select to authenticated
    using (business_id in (select business_id from public.business_members where user_id = auth.uid()));
