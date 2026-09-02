-- Cada item comprado fora entra como saldo adicional auditável na unidade que pediu o abastecimento.
create table if not exists public.opeixeiro_additional_stock_entries (
  id uuid primary key default gen_random_uuid(),
  purchase_relation_id uuid not null references public.opeixeiro_internal_purchase_relations(id) on delete cascade,
  order_id uuid not null references public.opeixeiro_orders(id) on delete cascade,
  destination_unit_id uuid references public.opeixeiro_units(id),
  product_name text not null,
  quantity numeric not null check (quantity > 0),
  unit text not null default 'unidade',
  driver_name text not null,
  created_at timestamptz not null default now(),
  unique (purchase_relation_id, product_name, unit)
);

alter table public.opeixeiro_internal_purchase_relations add column if not exists receipt_expires_at timestamptz;
alter table public.opeixeiro_additional_stock_entries enable row level security;
drop policy if exists "opeixeiro additional stock read" on public.opeixeiro_additional_stock_entries;
create policy "opeixeiro additional stock read" on public.opeixeiro_additional_stock_entries for select to anon,authenticated using (true);

create or replace function public.opeixeiro_purge_expired_internal_receipts()
returns integer language plpgsql security definer set search_path=public,storage as $$
declare v_deleted integer;
begin
  delete from storage.objects
   where bucket_id='opeixeiro-internal-purchase-receipts'
     and created_at < now() - interval '3 months';
  get diagnostics v_deleted = row_count;
  update public.opeixeiro_internal_purchase_relations
     set receipt_path=null, receipt_expires_at=null, updated_at=now()
   where receipt_path is not null and receipt_expires_at < now();
  return v_deleted;
end $$;

-- Executa diariamente às 03:30. Se pg_cron ainda não estiver habilitado,
-- a função continua disponível para o agendamento do Supabase Dashboard.
create extension if not exists pg_cron with schema extensions;
do $$ begin
  if exists (select 1 from pg_extension where extname='pg_cron')
     and not exists (select 1 from cron.job where jobname='opeixeiro-purge-internal-receipts') then
    perform cron.schedule('opeixeiro-purge-internal-receipts','30 3 * * *','select public.opeixeiro_purge_expired_internal_receipts()');
  end if;
exception when undefined_table or undefined_function then
  raise notice 'pg_cron indisponível; configure o agendamento no Supabase.';
end $$;
