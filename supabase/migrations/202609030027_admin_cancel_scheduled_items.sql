create or replace function public.opeixeiro_admin_cancel_scheduled_items(p_order_id uuid,p_names jsonb,p_actor_name text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_removed jsonb;
begin
  if not exists(select 1 from opeixeiro_orders where id=p_order_id and status in ('submitted','scheduled_next_day')) then raise exception 'Somente pedidos pendentes ou agendados podem ter itens cancelados.'; end if;
  if jsonb_typeof(p_names)<>'array' or jsonb_array_length(p_names)=0 then raise exception 'Selecione ao menos um item.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('name',p.canonical_name,'qty',oi.requested_qty,'unit',oi.unit)),'[]'::jsonb) into v_removed
  from opeixeiro_order_items oi join opeixeiro_products p on p.id=oi.product_id
  where oi.order_id=p_order_id and exists(select 1 from jsonb_array_elements_text(p_names) n where lower(n)=lower(p.canonical_name));
  if jsonb_array_length(v_removed)=0 then raise exception 'Nenhum item selecionado foi encontrado neste pedido.'; end if;
  update opeixeiro_order_contributions c set items=coalesce((select jsonb_agg(x.value) from jsonb_array_elements(c.items) x(value) where not exists(select 1 from jsonb_array_elements_text(p_names) n where lower(n)=lower(x.value->>'name'))),'[]'::jsonb) where c.order_id=p_order_id;
  delete from opeixeiro_order_contributions where order_id=p_order_id and jsonb_array_length(items)=0;
  perform opeixeiro_rebuild_order_from_contributions(p_order_id);
  insert into opeixeiro_operational_events(order_id,event_type,actor_name,client_occurred_at,metadata) values(p_order_id,'admin_order_items_cancelled',nullif(trim(p_actor_name),''),now(),jsonb_build_object('cancelled_items',v_removed));
  return jsonb_build_object('removed',v_removed);
end $$;
grant execute on function public.opeixeiro_admin_cancel_scheduled_items(uuid,jsonb,text) to anon,authenticated;
alter table opeixeiro_operational_events drop constraint if exists opeixeiro_operational_events_event_type_check;
alter table opeixeiro_operational_events add constraint opeixeiro_operational_events_event_type_check check(event_type=any(array['dispatch_released','pickup_scanned','delivery_receipt_scanned','offline_queued','delivery_shortage_reported','partial_route_rescheduled','internal_purchase_receipt_sent','internal_purchase_whatsapp_failed','emergency_pickup_alerted','emergency_product_photo_sent','admin_manual_delivery_confirmed','admin_phone_incident','admin_order_items_cancelled']));
drop trigger if exists opeixeiro_whatsapp_admin_order_items_cancelled on opeixeiro_operational_events;
create trigger opeixeiro_whatsapp_admin_order_items_cancelled after insert on opeixeiro_operational_events for each row when(new.event_type='admin_order_items_cancelled') execute function opeixeiro_notify_logistics_whatsapp();
