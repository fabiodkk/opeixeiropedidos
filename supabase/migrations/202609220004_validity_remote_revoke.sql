alter table public.validity_beta_access_requests
  add column if not exists access_revoked_at timestamptz,
  add column if not exists revoked_by text;

create or replace function public.lobo_pro_check_beta_access(payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_device text:=left(trim(coalesce(payload->>'device_id','')),160); v_row record;
begin
 if v_device='' then return jsonb_build_object('approved',false,'status','invalid_device'); end if;
 select plan_status,access_approved_at,access_revoked_at into v_row
 from public.validity_beta_access_requests where device_id=v_device limit 1;
 return jsonb_build_object('approved',coalesce(v_row.plan_status='active',false),
   'status',coalesce(v_row.plan_status,'not_found'),'approved_at',v_row.access_approved_at,
   'revoked_at',v_row.access_revoked_at);
end $$;
grant execute on function public.lobo_pro_check_beta_access(jsonb) to anon,authenticated;
