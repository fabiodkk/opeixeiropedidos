-- Permite ao motorista encerrar a rota com uma ou mais origens já coletadas.
-- As demais origens permanecem auditáveis e viram pedido do próximo dia.
create or replace function public.opeixeiro_deliver_selected_origins(
  p_order_id uuid,
  p_driver_name text,
  p_keep_origin_unit_ids uuid[]
) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_destination uuid; v_requested_by uuid; v_next_order uuid; v_next_date date;
  v_cutoff time; v_next_cutoff timestamptz; v_row record; v_keep jsonb; v_defer jsonb;
  v_count int:=0;
begin
  if coalesce(array_length(p_keep_origin_unit_ids,1),0)=0 then raise exception 'Selecione ao menos uma coleta confirmada.'; end if;
  if exists (
    select 1 from unnest(p_keep_origin_unit_ids) x(origin_id)
    where not exists (
      select 1 from opeixeiro_dispatch_releases r
      where r.order_id=p_order_id and r.origin_unit_id=x.origin_id and r.status='scanned'
        and lower(trim(r.driver_name))=lower(trim(p_driver_name))
    )
  ) then raise exception 'Todas as coletas escolhidas precisam estar confirmadas por este motorista.'; end if;
  if exists (
    select 1 from opeixeiro_dispatch_releases r
    where r.order_id=p_order_id and r.status='scanned'
      and not (r.origin_unit_id = any(p_keep_origin_unit_ids))
  ) then raise exception 'Existe coleta confirmada fora da seleção; ela não pode ser reagendada automaticamente.'; end if;

  select destination_unit_id,requested_by,delivery_date+1 into v_destination,v_requested_by,v_next_date
  from opeixeiro_orders where id=p_order_id for update;
  if v_destination is null then raise exception 'Pedido não encontrado.'; end if;
  select collection_cutoff_time into v_cutoff from opeixeiro_access_settings where id=true;
  v_next_cutoff:=((v_next_date+coalesce(v_cutoff,'18:00'::time)) at time zone 'America/Sao_Paulo');
  select id into v_next_order from opeixeiro_orders where destination_unit_id=v_destination and delivery_date=v_next_date;
  if v_next_order is null then
    insert into opeixeiro_orders(destination_unit_id,requested_by,delivery_date,status,cutoff_at,submitted_at)
    values(v_destination,v_requested_by,v_next_date,'scheduled_next_day',v_next_cutoff,now()) returning id into v_next_order;
  end if;

  for v_row in select requester_name,items from opeixeiro_order_contributions where order_id=p_order_id loop
    select coalesce(jsonb_agg(value),'[]'::jsonb) into v_keep
    from jsonb_array_elements(v_row.items) value
    where nullif(value->>'origin_unit_id','')::uuid = any(p_keep_origin_unit_ids);
    select coalesce(jsonb_agg(value),'[]'::jsonb) into v_defer
    from jsonb_array_elements(v_row.items) value
    where nullif(value->>'origin_unit_id','')::uuid is null or not (nullif(value->>'origin_unit_id','')::uuid = any(p_keep_origin_unit_ids));
    if jsonb_array_length(v_defer)>0 then
      insert into opeixeiro_order_contributions(order_id,requester_name,items,updated_at) values(v_next_order,v_row.requester_name,v_defer,now())
      on conflict(order_id,requester_name) do update set items=opeixeiro_merge_order_items(opeixeiro_order_contributions.items,excluded.items),updated_at=now();
      v_count:=v_count+jsonb_array_length(v_defer);
    end if;
    if jsonb_array_length(v_keep)=0 then delete from opeixeiro_order_contributions where order_id=p_order_id and requester_name=v_row.requester_name;
    else update opeixeiro_order_contributions set items=v_keep,updated_at=now() where order_id=p_order_id and requester_name=v_row.requester_name; end if;
  end loop;
  if v_count=0 then raise exception 'Não há itens de outras coletas para reagendar.'; end if;
  update opeixeiro_dispatch_releases set status='cancelled',withdrawal_reason='Reagendado após finalização parcial',return_requested_at=now()
  where order_id=p_order_id and not (origin_unit_id = any(p_keep_origin_unit_ids)) and status='released';
  perform opeixeiro_rebuild_order_from_contributions(p_order_id);
  perform opeixeiro_rebuild_order_from_contributions(v_next_order);
  insert into opeixeiro_operational_events(order_id,event_type,actor_name,client_occurred_at,metadata)
  values(p_order_id,'partial_route_rescheduled',p_driver_name,now(),jsonb_build_object('kept_origins',p_keep_origin_unit_ids,'next_order_id',v_next_order,'deferred_items',v_count));
  return jsonb_build_object('ok',true,'next_order_id',v_next_order,'next_delivery_date',v_next_date,'deferred_items',v_count);
end $$;
grant execute on function public.opeixeiro_deliver_selected_origins(uuid,text,uuid[]) to anon, authenticated;
