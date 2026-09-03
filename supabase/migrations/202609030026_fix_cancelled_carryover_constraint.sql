-- Não atualiza temporariamente uma reposição para zero: a remove diretamente.
create or replace function public.opeixeiro_cancel_unneeded_manual_carryover()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_next uuid; v_item jsonb; v_product uuid; v_missing numeric; v_current_required numeric; v_cancelled jsonb := '[]'::jsonb;
begin
  if new.event_type <> 'admin_manual_delivery_confirmed' then return new; end if;
  v_next := nullif(new.metadata->>'next_order_id','')::uuid;
  if v_next is null then return new; end if;
  for v_item in select value from jsonb_array_elements(coalesce(new.metadata->'items','[]'::jsonb)) loop
    if not coalesce((v_item->>'cancel_reorder')::boolean,false) then continue; end if;
    select oi.product_id, greatest(0,oi.requested_qty-coalesce((v_item->>'qty')::numeric,0)) into v_product,v_missing
    from public.opeixeiro_order_items oi join public.opeixeiro_products p on p.id=oi.product_id
    where oi.order_id=new.order_id and lower(p.canonical_name)=lower(v_item->>'name') limit 1;
    if v_product is null or v_missing<=0 then continue; end if;
    select required_qty into v_current_required from public.opeixeiro_order_carryover_requirements where order_id=v_next and product_id=v_product;
    if coalesce(v_current_required,0)<=v_missing then
      delete from public.opeixeiro_order_carryover_requirements where order_id=v_next and product_id=v_product;
    else
      update public.opeixeiro_order_carryover_requirements set required_qty=required_qty-v_missing where order_id=v_next and product_id=v_product;
    end if;
    update public.opeixeiro_order_items set requested_qty=requested_qty-v_missing, mandatory_carryover_qty=greatest(0,mandatory_carryover_qty-v_missing) where order_id=v_next and product_id=v_product;
    delete from public.opeixeiro_order_items where order_id=v_next and product_id=v_product and requested_qty<=0;
    v_cancelled:=v_cancelled||jsonb_build_array(jsonb_build_object('name',v_item->>'name','qty',v_missing,'unit',v_item->>'unit'));
  end loop;
  if jsonb_array_length(v_cancelled)>0 then update public.opeixeiro_operational_events set metadata=metadata||jsonb_build_object('cancelled_items',v_cancelled) where id=new.id; end if;
  if not exists(select 1 from public.opeixeiro_order_items where order_id=v_next) then delete from public.opeixeiro_orders where id=v_next; end if;
  return new;
end $$;
