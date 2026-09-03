-- 12:00 GMT corresponde a 09:00 em São Paulo (UTC-3).
create or replace function public.opeixeiro_send_morning_driver_notice()
returns void
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  v_secret text;
  v_message text := E'☀️ *Bom dia, família O Peixeiro!*\n\nO prazo estimado para carregamento dos pedidos normalmente vai até *09:00 da manhã*.\n\n*Motoristas:*\n1. Baixem e abram o aplicativo O Peixeiro Motorista.\n2. Entrem com a conta criada; quem ainda não criou pode criar pelo próprio app.\n3. Acompanhem por este grupo cada etapa da logística.\n4. Finalizem o acesso antes do carregamento para que o despacho possa liberar a coleta.\n5. No local, escaneiem o QR Code de coleta; no destino, escaneiem o QR de recebimento.\n\n*Conferência/despacho:* confiram os itens, escolham o motorista cadastrado e gerem o QR Code de liberação.\n\nTodos acompanham os próximos passos por este grupo. Estamos em implantação e contamos com a colaboração de toda a família O Peixeiro.\n\n📲 Baixe o aplicativo: https://github.com/fabiodkk/opeixeiropedidos/releases/latest';
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'logistics_webhook_secret' limit 1;
  if coalesce(v_secret, '') = '' then raise exception 'Segredo do webhook de logística não configurado'; end if;
  perform net.http_post(
    url := 'https://suipuquznkksgrkchqrv.functions.supabase.co/notify-logistics-whatsapp',
    body := jsonb_build_object('type', 'INSERT', 'table', 'opeixeiro_scheduled_announcement', 'record', jsonb_build_object('message', v_message)),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-logistics-webhook-secret', v_secret),
    timeout_milliseconds := 5000
  );
end;
$$;

do $$
declare v_job bigint;
begin
  for v_job in select jobid from cron.job where jobname = 'opeixeiro-motoristas-09h' loop
    perform cron.unschedule(v_job);
  end loop;
  perform cron.schedule('opeixeiro-motoristas-09h', '0 12 * * *', 'select public.opeixeiro_send_morning_driver_notice()');
end;
$$;
