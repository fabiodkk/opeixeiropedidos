import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL") || "";
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const greenUrl = (Deno.env.get("GREEN_API_URL") || "").replace(/\/$/, "");
const instance = Deno.env.get("GREEN_API_INSTANCE_ID") || "";
const token = Deno.env.get("GREEN_API_TOKEN") || "";
const group = Deno.env.get("GREEN_API_LOGISTICS_GROUP_CHAT_ID") || "";
const db = createClient(url, key);

const bytes = (base64: string) => Uint8Array.from(atob(base64.replace(/^data:image\/\w+;base64,/, "")), (c) => c.charCodeAt(0));
const clean = (v: unknown) => String(v || "").trim();

async function sendFile(path: string, caption: string) {
  const { data } = await db.storage.from("opeixeiro-audits").createSignedUrl(path, 60 * 60 * 24 * 7);
  if (!data?.signedUrl) throw new Error("Não foi possível criar URL segura da evidência");
  const result = await fetch(`${greenUrl}/waInstance${instance}/sendFileByUrl/${token}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: group, urlFile: data.signedUrl, fileName: path.split("/").pop(), caption }),
  });
  if (!result.ok) throw new Error("Green-API não aceitou a evidência");
}

async function sendInternalReceipt(path: string, caption: string) {
  const { data } = await db.storage.from("opeixeiro-internal-purchase-receipts").createSignedUrl(path, 60 * 60 * 24 * 7);
  if (!data?.signedUrl) throw new Error("Não foi possível criar URL segura da nota fiscal");
  const result = await fetch(`${greenUrl}/waInstance${instance}/sendFileByUrl/${token}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: group, urlFile: data.signedUrl, fileName: "nota-fiscal-compra-interna.jpg", caption }),
  });
  if (!result.ok) throw new Error("Green-API não aceitou a nota fiscal");
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  try {
    const body = await req.json();
    const action = clean(body.action);
    const deviceId = clean(body.device_id);
    if (!deviceId || !["bind_profile", "emergency_pickup", "product_evidence", "internal_purchase_receipt"].includes(action)) return new Response("Invalid request", { status: 400 });

    if (action === "bind_profile") {
      const name = clean(body.driver_name);
      const image = clean(body.selfie_base64);
      if (!name || !image) return new Response("Missing selfie or profile", { status: 400 });
      const stamp = Date.now(); const path = `selfies/${deviceId}/${stamp}.jpg`;
      const { error } = await db.storage.from("opeixeiro-audits").upload(path, bytes(image), { contentType: "image/jpeg", upsert: false });
      if (error) throw error;
      await db.from("opeixeiro_operational_events").insert({ event_type: "driver_selfie_verified", actor_name: name, client_occurred_at: new Date().toISOString(), metadata: { device_id: deviceId, selfie_path: path, profile_created: true } });
      return Response.json({ ok: true });
    }

    if (action === "internal_purchase_receipt") {
      const purchaseId = clean(body.purchase_id), orderId = clean(body.order_id), name = clean(body.driver_name), image = clean(body.receipt_base64);
      if (!purchaseId || !orderId || !name || !image) return new Response("Missing internal purchase data", { status: 400 });
      const { data: purchase, error: purchaseError } = await db.from("opeixeiro_internal_purchase_relations")
        .select("id,store_name,supply_origin_unit_id,authorization_source,authorized_by,purchased_items,opeixeiro_units!opeixeiro_internal_purchase_relations_supply_origin_unit_id_fkey(name)")
        .eq("id", purchaseId).eq("order_id", orderId).eq("driver_name", name).single();
      if (purchaseError || !purchase) throw new Error("Relação de compra não encontrada");
      const path = `receipts/${purchaseId}/${Date.now()}.jpg`;
      const { error: uploadError } = await db.storage.from("opeixeiro-internal-purchase-receipts").upload(path, bytes(image), { contentType: "image/jpeg", upsert: false });
      if (uploadError) throw uploadError;
      const itemLines = Array.isArray(purchase.purchased_items) ? purchase.purchased_items.map((item: any) => `• ${item.name}: ${item.qty} ${item.unit || "unidade"}`).join("\n") : "• Itens não informados";
      const author = purchase.authorization_source === "cash" ? "Verba retirada de caixa" : `Autorizado por: ${clean(purchase.authorized_by)}`;
      const caption = `🧾 *Compra externa autorizada — Relação interna*\nMotorista: ${name}\nSolicitante do abastecimento: ${clean(purchase.opeixeiro_units?.name)}\n${author}\nLocal da compra: ${clean(purchase.store_name)}\n\n*Itens comprados:*\n${itemLines}\n\nFoto obrigatória: nota fiscal.`;
      const stockEntries = Array.isArray(purchase.purchased_items) ? purchase.purchased_items
        .filter((item: any) => clean(item?.name) && Number(item?.qty) > 0)
        .map((item: any) => ({ purchase_relation_id: purchaseId, order_id: orderId, destination_unit_id: purchase.supply_origin_unit_id, product_name: clean(item.name), quantity: Number(item.qty), unit: clean(item.unit) || "unidade", driver_name: name })) : [];
      if (stockEntries.length) {
        const { error: stockError } = await db.from("opeixeiro_additional_stock_entries").upsert(stockEntries, { onConflict: "purchase_relation_id,product_name,unit" });
        if (stockError) throw stockError;
      }
      const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
      const { error: relationError } = await db.from("opeixeiro_internal_purchase_relations")
        .update({ receipt_path: path, receipt_expires_at: expiresAt, status: "purchased", updated_at: new Date().toISOString() }).eq("id", purchaseId);
      if (relationError) throw relationError;
      try {
        await sendInternalReceipt(path, caption);
        await db.from("opeixeiro_internal_purchase_relations").update({ status: "attached_to_route", updated_at: new Date().toISOString() }).eq("id", purchaseId);
        await db.from("opeixeiro_operational_events").insert({ order_id: orderId, event_type: "internal_purchase_receipt_sent", actor_name: name, client_occurred_at: new Date().toISOString(), metadata: { purchase_id: purchaseId, receipt_path: path, receipt_expires_at: expiresAt, purchased_items: purchase.purchased_items, additional_stock_entries: stockEntries.length } });
      } catch (messageError) {
        await db.from("opeixeiro_operational_events").insert({ order_id: orderId, event_type: "internal_purchase_whatsapp_failed", actor_name: name, client_occurred_at: new Date().toISOString(), metadata: { purchase_id: purchaseId, error: String(messageError), purchased_items: purchase.purchased_items } });
        throw messageError;
      }
      return Response.json({ ok: true });
    }

    const orderId = clean(body.order_id);
    const { data: order, error: orderError } = await db.from("opeixeiro_orders")
      .select("id,created_at,delivery_date,opeixeiro_units!opeixeiro_orders_destination_unit_id_fkey(name),opeixeiro_order_items(requested_qty,unit,opeixeiro_products(canonical_name,is_emergency))")
      .eq("id", orderId).single();
    if (orderError || !order) throw new Error("Pedido não encontrado");
    const localHour = new Date(order.created_at).toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false });
    const emergency = Number(localHour) >= 9 && (order.opeixeiro_order_items || []).filter((i: any) => i.opeixeiro_products?.is_emergency);
    if (!emergency?.length) return Response.json({ ok: true, ignored: true });
    const name = clean(body.driver_name);
    const destination = clean(order.opeixeiro_units?.name) || "destino informado";
    const items = emergency.map((i: any) => `• ${i.opeixeiro_products?.canonical_name}: ${i.requested_qty} ${i.unit}`).join("\n");

    if (action === "emergency_pickup") {
      const { data: selfie } = await db.from("opeixeiro_operational_events").select("metadata")
        .eq("event_type", "driver_selfie_verified").eq("actor_name", name).order("client_occurred_at", { ascending: false }).limit(1).maybeSingle();
      const selfiePath = clean(selfie?.metadata?.selfie_path);
      const caption = `🚨 EMERGÊNCIA após 09:00\nMotorista: ${name}\nDestino: ${destination}\nItens:\n${items}\n\nO motorista está indo fazer a coleta. A foto dos produtos é obrigatória após coletar.`;
      if (selfiePath) await sendFile(selfiePath, caption);
      else await fetch(`${greenUrl}/waInstance${instance}/sendMessage/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: group, message: caption }) });
      await db.from("opeixeiro_operational_events").insert({ order_id: orderId, event_type: "emergency_pickup_alerted", actor_name: name, client_occurred_at: new Date().toISOString(), metadata: { device_id: deviceId } });
      return Response.json({ ok: true, emergency: true });
    }

    const image = clean(body.product_base64);
    if (!image) return new Response("Missing product image", { status: 400 });
    const path = `products/${orderId}/${Date.now()}.jpg`;
    const { error } = await db.storage.from("opeixeiro-audits").upload(path, bytes(image), { contentType: "image/jpeg", upsert: false });
    if (error) throw error;
    await sendFile(path, `✅ EMERGÊNCIA COLETADA\nMotorista: ${name}\nDestino: ${destination}\nItens:\n${items}`);
    await db.from("opeixeiro_operational_events").insert({ order_id: orderId, event_type: "emergency_product_photo_sent", actor_name: name, client_occurred_at: new Date().toISOString(), metadata: { device_id: deviceId, product_path: path } });
    return Response.json({ ok: true });
  } catch (error) { console.error(error); return new Response("Audit failed", { status: 500 }); }
});
