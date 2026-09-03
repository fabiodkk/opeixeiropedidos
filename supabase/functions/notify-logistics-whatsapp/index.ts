import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const webhookSecret = Deno.env.get("LOGISTICS_WEBHOOK_SECRET") || "";
const greenApiUrl = (Deno.env.get("GREEN_API_URL") || "").replace(/\/$/, "");
const greenInstanceId = Deno.env.get("GREEN_API_INSTANCE_ID") || "";
const greenApiToken = Deno.env.get("GREEN_API_TOKEN") || "";
const logisticsGroupId = Deno.env.get("GREEN_API_LOGISTICS_GROUP_CHAT_ID") || "";
// Arquivo público do painel. Ele não contém segredos de servidor.
const ordersPanelFileUrl = Deno.env.get("ORDERS_PANEL_FILE_URL") || "";

const db = createClient(supabaseUrl, serviceRoleKey);

type WebhookPayload = {
  type?: string;
  table?: string;
  record?: { order_id?: string; status?: string; driver_name?: string; checker_name?: string; scanned_by_driver?: string; requester_name?: string; items?: unknown; event_type?: string; actor_name?: string; message?: string; metadata?: Record<string, unknown> };
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function statusPtBr(status: unknown): string {
  const labels: Record<string, string> = {
    submitted: "Pedido enviado",
    scheduled_next_day: "Agendado para o próximo dia",
    delivered: "Entrega concluída",
    released: "Liberado para coleta",
    scanned: "Coleta confirmada",
    cancelled: "Cancelado",
  };
  return labels[text(status)] || "Em andamento";
}

function formatItems(items: Array<{ name?: string; qty?: number; unit?: string; origin?: string }>) {
  return items.map((item) => `• ${text(item.name)}: ${item.qty} ${text(item.unit) || "unidade"}${item.origin ? ` — retirar em ${item.origin}` : ""}`).join("\n");
}

function confirmedItems(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item: Record<string, unknown>) => ({
    name: text(item.name),
    qty: Number(item.qty ?? item.delivered_qty ?? 0),
    expected: Number(item.expected_qty ?? item.qty ?? 0),
    unit: text(item.unit) || "unidade",
  }));
}

function formatConfirmedItems(items: Array<{ name: string; qty: number; expected: number; unit: string }>, label: string) {
  return items.map((item) => {
    const difference = item.qty - item.expected;
    const detail = difference === 0 ? "" : difference < 0 ? ` — faltaram ${Math.abs(difference)} ${item.unit}` : ` — ${difference} ${item.unit} a mais`;
    return `• ${item.name}: ${label} ${item.qty} ${item.unit}${detail}`;
  }).join("\n");
}

async function sendGreenMessage(message: string) {
  // O WhatsApp aceita mensagens longas, mas dividir por linha evita truncar pedidos grandes.
  const lines = message.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current && (current.length + line.length + 1) > 3500) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line;
  }
  if (current) chunks.push(current);
  for (let index = 0; index < chunks.length; index += 1) {
    const prefix = chunks.length > 1 ? `(${index + 1}/${chunks.length})\n` : "";
    const response = await fetch(`${greenApiUrl}/waInstance${greenInstanceId}/sendMessage/${greenApiToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: logisticsGroupId, message: prefix + chunks[index] }),
    });
    if (!response.ok) throw new Error(`Green-API returned ${response.status}`);
  }

  // Em grupos, a Green-API não suporta botão interativo. Enviamos o arquivo
  // atualizado como documento no fim da notificação, sem tokens ou chaves.
  if (ordersPanelFileUrl) {
    const response = await fetch(`${greenApiUrl}/waInstance${greenInstanceId}/sendFileByUrl/${greenApiToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: logisticsGroupId,
        urlFile: ordersPanelFileUrl,
        fileName: "Criar-Pedidos.html",
        caption: "👇 *Toque em ABRIR para criar pedidos.*",
      }),
    });
    if (!response.ok) throw new Error(`Green-API file delivery returned ${response.status}`);
  }
}

serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!webhookSecret || request.headers.get("x-logistics-webhook-secret") !== webhookSecret) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!greenApiUrl || !greenInstanceId || !greenApiToken || !logisticsGroupId) {
    console.error("Green-API configuration is incomplete");
    return new Response("Messaging configuration is incomplete", { status: 503 });
  }

  try {
    const payload = await request.json() as WebhookPayload;
    if (payload.table === "opeixeiro_scheduled_announcement") {
      const announcement = text(payload.record?.message);
      if (!announcement) return Response.json({ ignored: true });
      await sendGreenMessage(announcement);
      return Response.json({ sent: true, scheduled: true });
    }
    const acceptedTables = ["opeixeiro_order_contributions", "opeixeiro_dispatch_releases", "opeixeiro_delivery_receipts", "opeixeiro_operational_events"];
    if (!acceptedTables.includes(payload.table || "") || !payload.record?.order_id) {
      return Response.json({ ignored: true });
    }
    if (payload.table === "opeixeiro_dispatch_releases" && !((payload.type === "INSERT" && payload.record.status === "released") || payload.record.status === "scanned")) {
      return Response.json({ ignored: true });
    }
    if (payload.table === "opeixeiro_delivery_receipts" && payload.record.status !== "scanned") {
      return Response.json({ ignored: true });
    }
    if (payload.table === "opeixeiro_operational_events" && !["partial_route_rescheduled", "admin_manual_delivery_confirmed", "admin_order_items_cancelled"].includes(text(payload.record.event_type))) {
      return Response.json({ ignored: true });
    }

    const { data: order, error } = await db
      .from("opeixeiro_orders")
      .select("id,delivery_date,status,opeixeiro_units!opeixeiro_orders_destination_unit_id_fkey(name,code),opeixeiro_order_contributions(requester_name,items),opeixeiro_order_items(requested_qty,unit,opeixeiro_products(canonical_name),opeixeiro_order_item_pickups(planned_qty,opeixeiro_units(name)))")
      .eq("id", payload.record.order_id)
      .single();
    if (error || !order) throw new Error(error?.message || "Order not found");

    const itemLines: Array<{ name: string; qty: number; unit: string; origin: string }> = [];
    for (const item of order.opeixeiro_order_items || []) {
      const pickups = item.opeixeiro_order_item_pickups || [];
      itemLines.push({
        name: text(item.opeixeiro_products?.canonical_name) || "Produto",
        qty: Number(item.requested_qty) || 0,
        unit: text(item.unit) || "unidade",
        origin: pickups.map((pickup: { opeixeiro_units?: { name?: string } }) => text(pickup.opeixeiro_units?.name)).filter(Boolean).join(", "),
      });
    }
    const requesters = (order.opeixeiro_order_contributions || []).map((row: { requester_name?: string }) => text(row.requester_name)).filter(Boolean).join(", ");
    const destination = text(order.opeixeiro_units?.name) || text(order.opeixeiro_units?.code) || "Destino não informado";
    if (payload.table === "opeixeiro_operational_events" && payload.record.event_type === "partial_route_rescheduled") {
      const nextOrderId = text(payload.record.metadata?.next_order_id);
      if (!nextOrderId) throw new Error("Reagendamento sem pedido futuro");
      const { data: nextOrder, error: nextOrderError } = await db
        .from("opeixeiro_orders")
        .select("delivery_date,opeixeiro_order_items(requested_qty,unit,opeixeiro_products(canonical_name),opeixeiro_order_item_pickups(opeixeiro_units(name)))")
        .eq("id", nextOrderId)
        .single();
      if (nextOrderError || !nextOrder) throw new Error(nextOrderError?.message || "Pedido reagendado não encontrado");
      const pendingItems = (nextOrder.opeixeiro_order_items || []).map((item: { requested_qty?: number; unit?: string; opeixeiro_products?: { canonical_name?: string }; opeixeiro_order_item_pickups?: Array<{ opeixeiro_units?: { name?: string } }> }) => ({
        name: text(item.opeixeiro_products?.canonical_name) || "Produto",
        qty: Number(item.requested_qty) || 0,
        unit: text(item.unit) || "unidade",
        origin: (item.opeixeiro_order_item_pickups || []).map((pickup) => text(pickup.opeixeiro_units?.name)).filter(Boolean).join(", "),
      }));
      const message = [
        "📅 *Parte do pedido foi reagendada*",
        `Destino: ${destination}`,
        `Motorista: ${text(payload.record.actor_name) || "não informado"}`,
        `Entrega atual: ${text(order.delivery_date)}`,
        `Novo agendamento: ${text(nextOrder.delivery_date)}`,
        "",
        "*Itens que ficaram para a próxima rota:*",
        formatItems(pendingItems) || "• Itens pendentes não identificados",
        "",
        "A parte já coletada seguirá normalmente para o destino.",
      ].join("\n");
      await sendGreenMessage(message);
      return Response.json({ sent: true, order_id: order.id, rescheduled_order_id: nextOrderId });
    }
    if (payload.table === "opeixeiro_operational_events" && payload.record.event_type === "admin_manual_delivery_confirmed") {
      const metadata = payload.record.metadata || {};
      const rawItems = Array.isArray(metadata.items) ? metadata.items as Array<Record<string, unknown>> : [];
      const cancelledNames = new Set(rawItems.filter((item) => item.cancel_reorder === true).map((item) => text(item.name).toLocaleLowerCase()));
      const delivered = confirmedItems(rawItems.filter((item) => !cancelledNames.has(text(item.name).toLocaleLowerCase())));
      const shortages = (Array.isArray(metadata.shortages) ? metadata.shortages as Array<Record<string, unknown>> : []).filter((item) => !cancelledNames.has(text(item.name).toLocaleLowerCase()));
      const extras = Array.isArray(metadata.extras) ? metadata.extras as Array<Record<string, unknown>> : [];
      const purchase = metadata.purchase as Record<string, unknown> | null;
      const purchased = Array.isArray(purchase?.purchased_items) ? purchase.purchased_items as Array<Record<string, unknown>> : [];
      const nextOrderId = text(metadata.next_order_id);
      const nextDate = nextOrderId ? "reposição criada para o próximo agendamento" : "sem reposição pendente";
      const lines = [
        "📋 *Entrega concluída manualmente*",
        `Motorista: ${text(metadata.driver_name) || "não informado"}`,
        `Destino: ${destination}`,
        `Entrega: ${text(order.delivery_date)}`,
        "",
        "*Itens informados como entregues:*",
        formatConfirmedItems(delivered, "entregues:") || "• Nenhum item informado",
      ];
      if (shortages.length) {
        lines.push("", "⚠️ *Não coletados / não entregues — ficam para o próximo agendamento:*", formatItems(shortages.map((item) => ({ name: text(item.name), qty: Number(item.qty) || 0, unit: text(item.unit) || "unidade" }))));
      }
      if (cancelledNames.size) {
        lines.push("", "🚫 *Itens não são mais necessários — não serão reagendados:*", `Solicitado por: ${text(payload.record.actor_name) || "Administração"}`, formatItems(rawItems.filter((item) => cancelledNames.has(text(item.name).toLocaleLowerCase())).map((item) => ({ name: text(item.name), qty: Number(item.qty) || 0, unit: text(item.unit) || "unidade" }))));
      }
      if (extras.length) {
        lines.push("", "➕ *Quantidade a mais informada na entrega:*", formatItems(extras.map((item) => ({ name: text(item.name), qty: Number(item.qty) || 0, unit: text(item.unit) || "unidade" }))));
      }
      if (purchased.length) {
        const money = text(purchase?.authorization_source) === "cash" ? "dinheiro do caixa" : `verba entregue por ${text(purchase?.authorized_by) || "responsável"}`;
        lines.push("", "🛒 *Compra de última hora adicionada ao estoque:*", `Local: ${text(purchase?.store_name) || "não informado"} · ${money}`, formatItems(purchased.map((item) => ({ name: text(item.name), qty: Number(item.qty) || 0, unit: text(item.unit) || "unidade" }))));
      }
      lines.push("", `Situação: ${nextDate}.`);
      await sendGreenMessage(lines.join("\n"));
      return Response.json({ sent: true, order_id: order.id, manual_delivery: true });
    }
    if (payload.table === "opeixeiro_operational_events" && payload.record.event_type === "admin_order_items_cancelled") {
      const cancelled = Array.isArray(payload.record.metadata?.cancelled_items) ? payload.record.metadata.cancelled_items as Array<Record<string, unknown>> : [];
      await sendGreenMessage(["🚫 *Itens não são mais necessários*", `Solicitado por: ${text(payload.record.actor_name) || "Administração"}`, `Destino: ${destination}`, "", "*Itens removidos do pedido e sem reagendamento:*", formatItems(cancelled.map((item) => ({ name: text(item.name), qty: Number(item.qty) || 0, unit: text(item.unit) || "unidade" }))) || "• Nenhum item informado"].join("\n"));
      return Response.json({ sent: true, order_id: order.id, cancelled: true });
    }
    if (payload.table === "opeixeiro_dispatch_releases") {
      const collected = payload.record.status === "scanned";
      const items = confirmedItems(payload.record.items);
      const message = [
        collected ? "✅ *Coleta confirmada pelo motorista*" : "📦 *Coleta liberada pelo conferente*",
        `Motorista: ${text(payload.record.driver_name) || "não informado"}`,
        `Conferente: ${text(payload.record.checker_name) || "não informado"}`,
        `Destino: ${destination}`,
        `Entrega: ${text(order.delivery_date)}`,
        "",
        collected ? "*Quantidades efetivamente coletadas:*" : "*Quantidades despachadas pelo conferente:*",
        formatConfirmedItems(items, collected ? "coletados:" : "despachados:") || "• Nenhum item informado",
      ].join("\n");
      await sendGreenMessage(message);
      return Response.json({ sent: true, order_id: order.id });
    }
    if (payload.table === "opeixeiro_delivery_receipts") {
      const items = confirmedItems(payload.record.items);
      const hasDifference = items.some((item) => item.qty !== item.expected);
      const message = [
        hasDifference ? "⚠️ *Entrega conferida com divergência*" : "🏁 *Entrega conferida e confirmada*",
        `Motorista: ${text(payload.record.scanned_by_driver) || "não informado"}`,
        `Destino: ${destination}`,
        `Conferente: ${text(payload.record.requester_name) || "não informado"}`,
        `Entrega: ${text(order.delivery_date)}`,
        "",
        "*Quantidades confirmadas no recebimento:*",
        formatConfirmedItems(items, "recebidos:") || "• Nenhum item informado",
      ].join("\n");
      await sendGreenMessage(message);
      return Response.json({ sent: true, order_id: order.id, has_difference: hasDifference });
    }
    const heading = payload.table === "opeixeiro_order_contributions"
      ? (payload.type === "INSERT" ? "🧾 *Novo pedido — O Peixeiro Logística*" : "🔄 *Pedido mesclado/atualizado — O Peixeiro Logística*")
      : "Atualização do pedido";
    const message = [
      heading,
      `Destino: ${destination}`,
      `Entrega: ${text(order.delivery_date)}`,
      `Solicitante(s): ${requesters || "Não informado"}`,
      "",
      "*Itens e retirada:*",
      formatItems(itemLines) || "• Nenhum item informado",
      "",
      `Status: ${statusPtBr(order.status)}.`,
    ].join("\n");
    await sendGreenMessage(message);
    return Response.json({ sent: true, order_id: order.id });
  } catch (error) {
    console.error("WhatsApp notification error", error);
    return Response.json({ sent: false, error: "Unable to send notification" }, { status: 500 });
  }
});
