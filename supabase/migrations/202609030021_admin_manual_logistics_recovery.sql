-- Recuperação administrativa quando a operação não pode usar o celular do motorista.
-- Não remove QR, itens ou histórico: apenas grava a decisão manual e, na entrega,
-- conclui o pedido com as quantidades confirmadas pelo responsável.
create or replace function public.opeixeiro_admin_manual_delivery(
  p_order_id uuid,
  p_driver_name text,
  p_items jsonb,
  p_notes text,
  p_actor_name text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_destination text;
begin
  if p_order_id is null or coalesce(trim(p_driver_name),'')='' or coalesce(trim(p_notes),'')='' or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then
    raise exception 'Pedido, motorista, observação e itens são obrigatórios.';
  end if;
  select u.name into v_destination from public.opeixeiro_orders o join public.opeixeiro_units u on u.id=o.destination_unit_id where o.id=p_order_id for update;
  if v_destination is null then raise exception 'Pedido não encontrado.'; end if;
  update public.opeixeiro_orders set status='delivered',updated_at=now() where id=p_order_id;
  insert into public.opeixeiro_operational_events(order_id,event_type,actor_name,client_occurred_at,metadata)
  values(p_order_id,'admin_manual_delivery_confirmed',trim(p_actor_name),now(),jsonb_build_object('driver_name',trim(p_driver_name),'items',p_items,'notes',trim(p_notes),'destination',v_destination));
  return jsonb_build_object('completed',true,'destination',v_destination);
end;
$$;

create or replace function public.opeixeiro_admin_phone_incident(
  p_order_id uuid,
  p_driver_name text,
  p_stage text,
  p_notes text,
  p_actor_name text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_order_id is null or coalesce(trim(p_driver_name),'')='' or coalesce(trim(p_notes),'')='' then
    raise exception 'Pedido, motorista e relato são obrigatórios.';
  end if;
  if coalesce(trim(p_stage),'') not in ('manual_pickup','driver_change','device_unavailable') then
    raise exception 'Etapa da ocorrência inválida.';
  end if;
  if not exists(select 1 from public.opeixeiro_orders where id=p_order_id) then raise exception 'Pedido não encontrado.'; end if;
  insert into public.opeixeiro_operational_events(order_id,event_type,actor_name,client_occurred_at,metadata)
  values(p_order_id,'admin_phone_incident',trim(p_actor_name),now(),jsonb_build_object('driver_name',trim(p_driver_name),'stage',trim(p_stage),'notes',trim(p_notes)));
  return jsonb_build_object('registered',true);
end;
$$;

grant execute on function public.opeixeiro_admin_manual_delivery(uuid,text,jsonb,text,text) to anon,authenticated;
grant execute on function public.opeixeiro_admin_phone_incident(uuid,text,text,text,text) to anon,authenticated;
