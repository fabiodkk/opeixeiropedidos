alter table public.validity_beta_access_requests
  add column if not exists stable_device_id text;
create index if not exists validity_beta_stable_device_idx
  on public.validity_beta_access_requests(stable_device_id) where stable_device_id is not null;

create or replace function public.lobo_pro_register_beta_access(payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_phone text:=regexp_replace(coalesce(payload->>'phone',''),'[^0-9]','','g');
v_name text:=left(trim(coalesce(payload->>'user_name','')),120);
v_device text:=left(trim(coalesce(payload->>'device_id','')),160);
v_stable text:=left(trim(coalesce(payload->>'stable_device_id','')),160);
v_id uuid; v_blocked uuid;
begin
 if length(v_phone) in (10,11) then v_phone:='55'||v_phone; end if;
 if length(v_phone)<10 or v_name='' or v_device='' or v_stable='' then raise exception 'Dados obrigatórios ausentes'; end if;
 select id into v_blocked from public.validity_beta_access_requests
 where (stable_device_id=v_stable or phone_e164=v_phone) and plan_status in ('blocked','revoked') limit 1;
 if v_blocked is not null then
   update public.validity_beta_access_requests set device_id=v_device,device_model=left(payload->>'device_model',160),
    android_version=left(payload->>'android_version',40),metadata=payload,updated_at=now() where id=v_blocked returning id into v_id;
   return jsonb_build_object('ok',true,'request_id',v_id,'status','blocked');
 end if;
 select id into v_id from public.validity_beta_access_requests where stable_device_id=v_stable order by updated_at desc limit 1;
 if v_id is not null then
   update public.validity_beta_access_requests set phone_e164=v_phone,user_name=v_name,device_id=v_device,
    device_model=left(payload->>'device_model',160),android_version=left(payload->>'android_version',40),
    relationship=left(payload->>'relationship',120),requested_plan=left(payload->>'requested_plan',120),
    metadata=payload,updated_at=now() where id=v_id;
 else
   insert into public.validity_beta_access_requests(phone_e164,user_name,device_id,stable_device_id,device_model,android_version,relationship,requested_plan,metadata,updated_at)
   values(v_phone,v_name,v_device,v_stable,left(payload->>'device_model',160),left(payload->>'android_version',40),left(payload->>'relationship',120),left(payload->>'requested_plan',120),payload,now())
   returning id into v_id;
 end if;
 return jsonb_build_object('ok',true,'request_id',v_id);
end $$;

create or replace function public.lobo_pro_check_beta_access(payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_device text:=left(trim(coalesce(payload->>'device_id','')),160);
v_stable text:=left(trim(coalesce(payload->>'stable_device_id','')),160); v_row record;
begin
 if v_device='' and v_stable='' then return jsonb_build_object('approved',false,'status','invalid_device'); end if;
 select plan_status,access_approved_at,access_revoked_at into v_row
 from public.validity_beta_access_requests
 where (v_stable<>'' and stable_device_id=v_stable) or device_id=v_device
 order by case when plan_status in ('blocked','revoked') then 0 when plan_status='active' then 1 else 2 end,updated_at desc limit 1;
 return jsonb_build_object('approved',coalesce(v_row.plan_status='active',false),
  'status',coalesce(v_row.plan_status,'not_found'),'approved_at',v_row.access_approved_at,'revoked_at',v_row.access_revoked_at);
end $$;
grant execute on function public.lobo_pro_register_beta_access(jsonb) to anon,authenticated;
grant execute on function public.lobo_pro_check_beta_access(jsonb) to anon,authenticated;
