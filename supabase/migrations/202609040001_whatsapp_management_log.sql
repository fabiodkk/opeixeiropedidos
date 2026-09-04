-- Histórico próprio de mensagens para relatórios gerenciais, inclusive após exclusão de pedidos.
create table if not exists public.opeixeiro_whatsapp_message_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  order_id uuid,
  source text not null default 'automated',
  event_type text,
  status text not null check (status in ('sent','failed')),
  message text not null,
  reason text
);
create index if not exists opeixeiro_whatsapp_message_logs_created_idx on public.opeixeiro_whatsapp_message_logs(created_at desc);
alter table public.opeixeiro_whatsapp_message_logs enable row level security;
drop policy if exists "opeixeiro public read whatsapp logs" on public.opeixeiro_whatsapp_message_logs;
create policy "opeixeiro public read whatsapp logs" on public.opeixeiro_whatsapp_message_logs for select to anon using (true);
