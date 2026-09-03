-- A conferência manual também cria reposição obrigatória quando algo não chegou.
-- O evento final contém faltas, sobras e compras para a notificação do grupo.

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
  v_next_order uuid;
  v_next_item uuid;
  v_fallback_origin uuid;
  v_row record;
  v_delivered numeric;
  v_missing numeric;
  v_extra numeric;
  v_shortages jsonb := '[]'::jsonb;
  v_extras jsonb := '[]'::jsonb;
begin
  if p_order_id is null or nullif(trim(p_driver_name), '') is null then raise exception 'Pedido e motorista são obrigatórios.'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Informe os itens efetivamente entregues.'; end if;
  if nullif(trim(p_notes), '') is null then raise exception 'Descreva como a entrega foi confirmada.'; end if;
  select * into v_order from public.opeixeiro_orders where id = p_order_id for update;
  if not found then raise exception 'Pedido não encontrado.'; end if;
  if v_order.status = 'delivered' then raise exception 'Este pedido já está concluído.'; end if;
  select id into v_fallback_origin from public.opeixeiro_units where code = 'PEIXARIA' limit 1;

  -- Cada falta da entrega manual é acrescentada ao pedido do próximo dia.
  for v_row in
    select oi.id as order_item_id, oi.product_id, oi.requested_qty, oi.unit, p.canonical_name,
      coalesce((select op.origin_unit_id from public.opeixeiro_order_item_pickups op where op.order_item_id = oi.id order by op.created_at nulls last limit 1), p.default_origin_unit_id, v_fallback_origin) as origin_unit_id
    from public.opeixeiro_order_items oi join public.opeixeiro_products p on p.id = oi.product_id
    where oi.order_id = p_order_id
  loop
    select coalesce((x.value->>'qty')::numeric, 0) into v_delivered
    from jsonb_array_elements(p_items) x(value)
    where lower(trim(x.value->>'name')) = lower(trim(v_row.canonical_name)) limit 1;
    v_delivered := coalesce(v_delivered, 0);
    v_missing := greatest(0, v_row.requested_qty - v_delivered);
    v_extra := greatest(0, v_delivered - v_row.requested_qty);
    if v_missing > 0 then
      if v_next_order is null then
        select id into v_next_order from public.opeixeiro_orders
        where destination_unit_id = v_order.destination_unit_id and delivery_date = v_order.delivery_date + 1
          and status in ('submitted', 'scheduled_next_day') order by created_at limit 1;
        if v_next_order is null then
          insert into public.opeixeiro_orders(destination_unit_id, requested_by, delivery_date, status, cutoff_at, submitted_at)
          values(v_order.destination_unit_id, v_order.requested_by, v_order.delivery_date + 1, 'scheduled_next_day', now(), now())
          returning id into v_next_order;
        end if;
      end if;
      insert into public.opeixeiro_order_carryover_requirements(order_id, product_id, required_qty, source_receipt_id)
      values(v_next_order, v_row.product_id, v_missing, null)
      on conflict(order_id, product_id) do update set required_qty = public.opeixeiro_order_carryover_requirements.required_qty + excluded.required_qty;
      insert into public.opeixeiro_order_items(order_id, product_id, requested_qty, unit, mandatory_carryover_qty)
      values(v_next_order, v_row.product_id, v_missing, v_row.unit, v_missing)
      on conflict(order_id, product_id) do update set
        requested_qty = public.opeixeiro_order_items.requested_qty + excluded.requested_qty,
        mandatory_carryover_qty = public.opeixeiro_order_items.mandatory_carryover_qty + excluded.mandatory_carryover_qty
      returning id into v_next_item;
      insert into public.opeixeiro_order_item_pickups(order_item_id, origin_unit_id, planned_qty)
      values(v_next_item, v_row.origin_unit_id, v_missing)
      on conflict(order_item_id, origin_unit_id) do update set planned_qty = public.opeixeiro_order_item_pickups.planned_qty + excluded.planned_qty;
      v_shortages := v_shortages || jsonb_build_array(jsonb_build_object('name', v_row.canonical_name, 'qty', v_missing, 'unit', v_row.unit));
    end if;
    if v_extra > 0 then
      v_extras := v_extras || jsonb_build_array(jsonb_build_object('name', v_row.canonical_name, 'qty', v_extra, 'unit', v_row.unit));
    end if;
  end loop;

  if p_purchase is not null and p_purchase <> 'null'::jsonb then
    if jsonb_typeof(p_purchase) <> 'object' then raise exception 'Dados da compra inválidos.'; end if;
    v_origin_id := nullif(trim(p_purchase->>'supply_origin_unit_id'), '')::uuid;
    v_source := nullif(trim(p_purchase->>'authorization_source'), '');
    v_store := nullif(trim(p_purchase->>'store_name'), '');
    v_purchase_items := p_purchase->'purchased_items';
    v_cash_id := nullif(trim(p_purchase->>'cash_unit_id'), '')::uuid;
    if v_origin_id is null or v_source not in ('responsible', 'cash') or v_store is null or jsonb_typeof(v_purchase_items) <> 'array' or jsonb_array_length(v_purchase_items) = 0 then raise exception 'Preencha local, verba, compra e itens da compra de última hora.'; end if;
    if v_source = 'responsible' and nullif(trim(p_purchase->>'authorized_by'), '') is null then raise exception 'Informe o responsável que entregou a verba.'; end if;
    if v_source = 'cash' and v_cash_id is null then raise exception 'Informe o caixa utilizado.'; end if;
    insert into public.opeixeiro_internal_purchase_relations(order_id, driver_name, supply_origin_unit_id, authorization_source, authorized_by, cash_unit_id, store_name, is_market, purchased_items, receipt_path, status, receipt_expires_at)
    values(p_order_id, trim(p_driver_name), v_origin_id, v_source, case when v_source = 'responsible' then trim(p_purchase->>'authorized_by') else null end, case when v_source = 'cash' then v_cash_id else null end, v_store, lower(v_store) = 'mercado', v_purchase_items, p_receipt_path, 'reviewed', now() + interval '90 days') returning id into v_purchase_id;
    insert into public.opeixeiro_additional_stock_entries(purchase_relation_id, order_id, destination_unit_id, product_name, quantity, unit, driver_name)
    select v_purchase_id, p_order_id, v_order.destination_unit_id, nullif(trim(x.item->>'name'), ''), (x.item->>'qty')::numeric, coalesce(nullif(trim(x.item->>'unit'), ''), 'unidade'), trim(p_driver_name)
    from jsonb_array_elements(v_purchase_items) as x(item)
    where nullif(trim(x.item->>'name'), '') is not null and coalesce((x.item->>'qty')::numeric, 0) > 0;
  end if;

  update public.opeixeiro_orders set status = 'delivered', updated_at = now() where id = p_order_id;
  insert into public.opeixeiro_operational_events(order_id, event_type, actor_name, client_occurred_at, metadata)
  values(p_order_id, 'admin_manual_delivery_confirmed', nullif(trim(p_actor_name), ''), now(),
    jsonb_build_object('driver_name', trim(p_driver_name), 'items', p_items, 'notes', trim(p_notes), 'receipt_path', p_receipt_path,
      'purchase_relation_id', v_purchase_id, 'purchase', p_purchase, 'shortages', v_shortages, 'extras', v_extras, 'next_order_id', v_next_order));
  return jsonb_build_object('order_id', p_order_id, 'purchase_relation_id', v_purchase_id, 'next_order_id', v_next_order, 'shortages', v_shortages, 'extras', v_extras, 'status', 'delivered');
end;
$$;

drop trigger if exists opeixeiro_whatsapp_admin_manual_delivery on public.opeixeiro_operational_events;
create trigger opeixeiro_whatsapp_admin_manual_delivery
after insert on public.opeixeiro_operational_events
for each row when (new.event_type = 'admin_manual_delivery_confirmed')
execute function public.opeixeiro_notify_logistics_whatsapp();
