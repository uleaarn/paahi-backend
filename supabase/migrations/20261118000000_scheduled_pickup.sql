-- Scheduled pickup: when the caller will collect the order.
-- null means as soon as possible (ordered while open).
alter table public.orders add column if not exists pickup_at timestamptz;
