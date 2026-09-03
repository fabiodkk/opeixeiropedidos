-- Fluxo completo do painel administrativo para concluir uma rota sem o aplicativo.
-- Não altera o aplicativo do motorista nem pedidos em andamento até o administrador confirmar.

drop function if exists public.opeixeiro_admin_manual_delivery(uuid, text, jsonb, text, text);

create or replace function public.opeixeiro_admin_manual_delivery(
  p_order_id uuid,
  p_driver_name text,
  p_items jsonb,
  p_notes text,
  p_actor_name text,
  p_receipt_path text,
  p_purchase jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.opeixeiro_orders%rowtype;
  v_purchase_id uuid;
  v_origin_id uuid;
  v_cash_id uuid;
  v_source text;
  v_store text;
  v_purchase_items jsonb;
begin
  if p_order_id is null or nullif(trim(p_driver_name), '') is null then
    raise exception 'Pedido e motorista são obrigatórios.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Informe os itens efetivamente entregues.';
  end if;
  if nullif(trim(p_notes), '') is null then
    raise exception 'Descreva como a entrega foi confirmada.';
  end if;

  select * into v_order from public.opeixeiro_orders where id = p_order_id for update;
  if not found then raise exception 'Pedido não encontrado.'; end if;
  if v_order.status = 'delivered' then raise exception 'Este pedido já está concluído.'; end if;

  if p_purchase is not null and p_purchase <> 'null'::jsonb then
    if jsonb_typeof(p_purchase) <> 'object' then raise exception 'Dados da compra inválidos.'; end if;
    v_origin_id := nullif(trim(p_purchase->>'supply_origin_unit_id'), '')::uuid;
    v_source := nullif(trim(p_purchase->>'authorization_source'), '');
    v_store := nullif(trim(p_purchase->>'store_name'), '');
    v_purchase_items := p_purchase->'purchased_items';
    v_cash_id := nullif(trim(p_purchase->>'cash_unit_id'), '')::uuid;
    if v_origin_id is null or v_source not in ('responsible', 'cash') or v_store is null
      or jsonb_typeof(v_purchase_items) <> 'array' or jsonb_array_length(v_purchase_items) = 0 then
      raise exception 'Preencha local, verba, compra e itens da compra de última hora.';
    end if;
    if v_source = 'responsible' and nullif(trim(p_purchase->>'authorized_by'), '') is null then
      raise exception 'Informe o responsável que entregou a verba.';
    end if;
    if v_source = 'cash' and v_cash_id is null then raise exception 'Informe o caixa utilizado.'; end if;

    insert into public.opeixeiro_internal_purchase_relations (
      order_id, driver_name, supply_origin_unit_id, authorization_source, authorized_by,
      cash_unit_id, store_name, is_market, purchased_items, receipt_path, status, receipt_expires_at
    ) values (
      p_order_id, trim(p_driver_name), v_origin_id, v_source,
      case when v_source = 'responsible' then trim(p_purchase->>'authorized_by') else null end,
      case when v_source = 'cash' then v_cash_id else null end,
      v_store, lower(v_store) = 'mercado', v_purchase_items, p_receipt_path, 'reviewed', now() + interval '90 days'
    ) returning id into v_purchase_id;

    insert into public.opeixeiro_additional_stock_entries (
      purchase_relation_id, order_id, destination_unit_id, product_name, quantity, unit, driver_name
    )
    select v_purchase_id, p_order_id, v_order.destination_unit_id,
      nullif(trim(x.item->>'name'), ''), (x.item->>'qty')::numeric,
      coalesce(nullif(trim(x.item->>'unit'), ''), 'unidade'), trim(p_driver_name)
    from jsonb_array_elements(v_purchase_items) as x(item)
    where nullif(trim(x.item->>'name'), '') is not null and coalesce((x.item->>'qty')::numeric, 0) > 0;
  end if;

  update public.opeixeiro_orders set status = 'delivered', updated_at = now() where id = p_order_id;
  insert into public.opeixeiro_operational_events (
    order_id, event_type, actor_name, client_occurred_at, metadata
  ) values (
    p_order_id, 'admin_manual_delivery_confirmed', nullif(trim(p_actor_name), ''), now(),
    jsonb_build_object('driver_name', trim(p_driver_name), 'items', p_items, 'notes', trim(p_notes),
      'receipt_path', p_receipt_path, 'purchase_relation_id', v_purchase_id, 'purchase', p_purchase)
  );
  return jsonb_build_object('order_id', p_order_id, 'purchase_relation_id', v_purchase_id, 'status', 'delivered');
end;
$$;

grant execute on function public.opeixeiro_admin_manual_delivery(uuid, text, jsonb, text, text, text, jsonb) to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('opeixeiro-admin-manual-receipts', 'opeixeiro-admin-manual-receipts', false, 5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "opeixeiro admin manual receipts read" on storage.objects;
create policy "opeixeiro admin manual receipts read" on storage.objects for select to anon, authenticated
  using (bucket_id = 'opeixeiro-admin-manual-receipts');
drop policy if exists "opeixeiro admin manual receipts upload" on storage.objects;
create policy "opeixeiro admin manual receipts upload" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'opeixeiro-admin-manual-receipts');
drop policy if exists "opeixeiro admin internal purchase receipts read" on storage.objects;
create policy "opeixeiro admin internal purchase receipts read" on storage.objects for select to anon, authenticated
  using (bucket_id = 'opeixeiro-internal-purchase-receipts');
drop policy if exists "opeixeiro admin internal purchase receipts upload" on storage.objects;
create policy "opeixeiro admin internal purchase receipts upload" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'opeixeiro-internal-purchase-receipts');
