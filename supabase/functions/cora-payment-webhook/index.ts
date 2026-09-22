// Webhook público da Cora. A chave secreta na URL protege o endpoint e cada
// evento só atualiza cobranças já conhecidas pelo identificador da fatura.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
const response = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

serve(async (request) => {
  if (request.method !== "POST") return response(405, { error: "method_not_allowed" });
  const suppliedKey = new URL(request.url).searchParams.get("key") ?? "";
  const expectedKey = Deno.env.get("CORA_WEBHOOK_SECRET") ?? "";
  if (!expectedKey || suppliedKey !== expectedKey) return response(401, { error: "unauthorized" });

  const eventType = request.headers.get("webhook-event-type") ?? "";
  const invoiceId = request.headers.get("webhook-resource-id") ?? "";
  const eventId = request.headers.get("webhook-event-id") ?? "";
  if (eventType !== "invoice.paid" || !invoiceId || !eventId) return response(200, { ignored: true });

  const paidAt = new Date().toISOString();
  const reserve = await db.from("cora_pix_reserve")
    .update({ status: "paid", paid_at: paidAt, cora_event_id: eventId, updated_at: paidAt })
    .eq("cora_invoice_id", invoiceId).in("status", ["available", "reserved"]);
  if (reserve.error) return response(500, { error: "reserve_update_failed" });

  const owner = await db.from("owner_pix_access_requests")
    .update({ status: "paid", paid_at: paidAt, updated_at: paidAt })
    .eq("cora_invoice_id", invoiceId).neq("status", "paid");
  if (owner.error) return response(500, { error: "owner_request_update_failed" });

  return response(200, { ok: true });
});
