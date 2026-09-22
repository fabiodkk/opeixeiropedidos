create table if not exists public.validity_sales (
  id uuid primary key default gen_random_uuid(),
  access_request_id uuid not null unique references public.validity_beta_access_requests(id),
  seller_name text not null,
  buyer_name text not null,
  buyer_phone_e164 text not null,
  plan_name text,
  amount_cents integer not null check (amount_cents >= 0),
  payment_method text not null,
  payment_status text not null check (payment_status in ('manually_confirmed','cora_paid')),
  sold_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
alter table public.validity_sales enable row level security;
revoke all on public.validity_sales from anon,authenticated;
