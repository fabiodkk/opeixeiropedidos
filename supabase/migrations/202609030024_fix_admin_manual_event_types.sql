-- Os fluxos operacionais adicionados depois da primeira versão também precisam
-- ser aceitos pelo histórico de eventos.
alter table public.opeixeiro_operational_events
  drop constraint if exists opeixeiro_operational_events_event_type_check;
alter table public.opeixeiro_operational_events
  add constraint opeixeiro_operational_events_event_type_check check (event_type = any (array[
    'dispatch_released', 'pickup_scanned', 'delivery_receipt_scanned', 'offline_queued',
    'delivery_shortage_reported', 'partial_route_rescheduled',
    'internal_purchase_receipt_sent', 'internal_purchase_whatsapp_failed',
    'emergency_pickup_alerted', 'emergency_product_photo_sent',
    'admin_manual_delivery_confirmed', 'admin_phone_incident'
  ]));
