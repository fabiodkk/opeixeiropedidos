-- Avisos diários enviados ao grupo de logística. pg_cron está em GMT:
-- 01:00 GMT = 22:00 em São Paulo; 08:00 GMT = 05:00 em São Paulo.
create extension if not exists pg_net with schema extensions;

create or replace function public.opeixeiro_send_daily_logistics_notice(p_notice text)
returns void
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  v_secret text;
  v_message text;
begin
  v_message := case p_notice
    when 'deadline_22' then E'📢 *PEDIDOS DO PRÓXIMO DIA*\n\nQuem precisar fazer pedido para amanhã tem até *05:00 da manhã* para finalizar no painel.\n\n*Como criar pedido:*\n1. Abra o painel O Peixeiro.\n2. Escolha seu perfil e a unidade.\n3. Informe as quantidades dos produtos.\n4. Confira o local de retirada indicado em cada item.\n5. Toque em “Enviar para despacho”.\n\nApós 05:00, pedidos comuns passam para o próximo dia. Se faltar algo urgente, use a opção de produto/compra de última hora e informe o responsável.\n\n*Motoristas:* instalem o aplicativo O Peixeiro Motorista, entrem com o perfil e usem o QR Code para confirmar coleta e entrega.\n\n*Quem confere o despacho:* abra Despacho, escolha o motorista cadastrado, confira as quantidades e gere o QR de coleta.\n\n*Quem recebe:* abra Recebimento, confira os itens que chegaram, informe eventuais faltas e gere o QR para o motorista confirmar.\n\nEstamos em fase de implantação. Contamos com a colaboração de toda a família O Peixeiro.'
    when 'deadline_05' then E'⏰ *PRAZO DE PEDIDOS ENCERRADO*\n\nO prazo para pedidos da entrega de hoje encerrou às *05:00*. Pedidos comuns feitos a partir de agora serão agendados para o próximo dia.\n\nSe o estabelecimento precisar de algum item com urgência, use o painel para registrar a solicitação emergencial e avise um responsável.\n\n*Lembretes rápidos:*\n• Motorista: use o QR Code para confirmar cada coleta e a entrega.\n• Despacho: confira as quantidades antes de liberar o QR.\n• Recebimento: confira o que chegou e registre faltas antes de gerar o QR final.\n\nObrigado pela colaboração de toda a família O Peixeiro.'
  end;
  if coalesce(v_message, '') = '' then raise exception 'Aviso diário inválido'; end if;
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
  for v_job in select jobid from cron.job where jobname in ('opeixeiro-pedidos-22h', 'opeixeiro-pedidos-05h') loop
    perform cron.unschedule(v_job);
  end loop;
  perform cron.schedule('opeixeiro-pedidos-22h', '0 1 * * *', $cron$select public.opeixeiro_send_daily_logistics_notice('deadline_22')$cron$);
  perform cron.schedule('opeixeiro-pedidos-05h', '0 8 * * *', $cron$select public.opeixeiro_send_daily_logistics_notice('deadline_05')$cron$);
end;
$$;
