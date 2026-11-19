-- Callers can cancel an order by phone; staff get a "CANCELLED" notice.
-- An order can now have more than one notification per channel (placed, cancelled).
alter table public.orders add column if not exists cancelled_at timestamptz;

alter table public.notifications add column if not exists kind text not null default 'order_placed'
    check (kind in ('order_placed', 'order_cancelled', 'callback'));
alter table public.notifications drop constraint if exists notifications_order_id_channel_key;
alter table public.notifications add constraint notifications_order_kind_channel_key unique (order_id, kind, channel);

-- Looking up a caller's orders by phone number.
create index if not exists orders_by_phone on public.orders (business_id, customer_phone, status);
