import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const db = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
);
const adminToken = Deno.env.get("VALIDITY_SALES_ADMIN_TOKEN") || "";
const greenUrl = (Deno.env.get("GREEN_API_URL") || "").replace(/\/$/, "");
const greenId = Deno.env.get("GREEN_API_INSTANCE_ID") || "",
  greenToken = Deno.env.get("GREEN_API_TOKEN") || "";
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-admin-token",
};
const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PT260 — Vendas</title><style>:root{color-scheme:dark}body{margin:0;background:#07110d;color:#edf7ef;font:15px system-ui}main{max-width:900px;margin:auto;padding:20px}h1{margin:0}.muted{color:#9bb5a7}.card{background:#102019;border:1px solid #285342;border-radius:16px;padding:16px;margin:12px 0}.row{display:grid;grid-template-columns:1fr auto;gap:12px}button{background:#35c878;color:#052511;border:0;border-radius:10px;padding:11px 14px;font-weight:800}button:disabled{opacity:.45}input,select{background:#07110d;color:white;border:1px solid #39624e;border-radius:9px;padding:10px}@media(max-width:600px){.row{grid-template-columns:1fr}}</style><main><h1>Validade PT260 — Vendas</h1><p class="muted">Confirme o recebimento antes de liberar o aparelho.</p><div class="card"><p><label>Vendedor <input id="seller" value="A.Fabio.C.Silva"></label></p><p><label>Valor recebido (R$) <input id="amount" value="119,00"></label></p><p><label>Meio <select id="method"><option>PIX manual</option><option>Dinheiro</option><option>Transferência</option></select></label></p><label><input id="paid" type="checkbox"> Confirmo que o pagamento foi recebido</label></div><div id="list">Carregando…</div></main><script>const token=new URLSearchParams(location.search).get('token')||'',list=document.querySelector('#list');function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}async function call(body){const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json','x-admin-token':token},body:JSON.stringify(body)}),d=await r.json();if(!r.ok)throw Error(d.error||'Falha');return d}async function load(){try{const d=await call({action:'list'});list.innerHTML=d.rows.map(x=>'<section class="card"><div class="row"><b>'+esc(x.user_name)+' · final '+esc(x.phone_e164.slice(-4))+'</b><b>'+esc(x.plan_status)+'</b></div><p>Aparelho: '+esc(x.device_model||'não informado')+' · Android '+esc(x.android_version||'—')+'</p><p>Plano: '+esc(x.requested_plan||'—')+'<br>Estabelecimento: '+esc(x.establishment_name||'—')+'</p><button '+(x.plan_status==='active'?'disabled':'')+' onclick="approve(\''+x.id+'\')">'+(x.plan_status==='active'?'Venda registrada e acesso liberado':'Registrar venda e liberar acesso')+'</button></section>').join('')||'<p>Nenhuma solicitação.</p>'}catch{list.textContent='Acesso negado ou painel indisponível.'}}async function approve(id){if(!document.querySelector('#paid').checked){alert('Confirme primeiro que o pagamento foi recebido.');return}if(!confirm('Registrar a venda e liberar este aparelho?'))return;try{await call({action:'approve',id,seller:document.querySelector('#seller').value,amount:document.querySelector('#amount').value,payment_method:document.querySelector('#method').value,payment_confirmed:true});await load()}catch(e){alert(e.message)}}load();</script></html>`;
async function send(phone: string, message: string) {
  const r = await fetch(
    `${greenUrl}/waInstance${greenId}/sendMessage/${greenToken}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: phone + "@c.us", message }),
    },
  );
  if (!r.ok) throw new Error("WhatsApp HTTP " + r.status);
}
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  if (req.method === "GET")
    return new Response(html, {
      headers: {
        ...cors,
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  try {
    const token =
      req.headers.get("x-admin-token") || url.searchParams.get("token") || "";
    if (!adminToken || token !== adminToken)
      return Response.json(
        { error: "Acesso negado" },
        { status: 401, headers: cors },
      );
    const body = await req.json();
    if (body.action === "block") {
      const operator = String(body.seller || "A.Fabio.C.Silva").slice(0, 120);
      const now = new Date().toISOString();
      const { error } = await db
        .from("validity_beta_access_requests")
        .update({
          plan_status: "blocked",
          access_revoked_at: now,
          revoked_by: operator,
          updated_at: now,
        })
        .eq("id", body.id);
      if (error) throw error;
      return Response.json({ ok: true }, { headers: cors });
    }
    if (body.action === "list") {
      const { data, error } = await db
        .from("validity_beta_access_requests")
        .select(
          "id,user_name,phone_e164,device_model,android_version,requested_plan,plan_status,establishment_name",
        )
        .order("updated_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return Response.json({ rows: data }, { headers: cors });
    }
    if (body.action === "approve") {
      if (body.payment_confirmed !== true)
        return Response.json(
          { error: "Confirme o recebimento" },
          { status: 400, headers: cors },
        );
      const normalized = String(body.amount || "")
          .replace(/\./g, "")
          .replace(",", "."),
        amountCents = Math.round(Number(normalized) * 100);
      if (!Number.isInteger(amountCents) || amountCents < 1)
        return Response.json(
          { error: "Valor inválido" },
          { status: 400, headers: cors },
        );
      const seller = String(body.seller || "A.Fabio.C.Silva").slice(0, 120),
        now = new Date().toISOString();
      const { data, error } = await db
        .from("validity_beta_access_requests")
        .update({
          plan_status: "active",
          access_approved_at: now,
          approved_by: seller,
          sale_registered_at: now,
          seller_name: seller,
          updated_at: now,
        })
        .eq("id", body.id)
        .select("id,phone_e164,user_name,device_model,requested_plan")
        .single();
      if (error) throw error;
      const sale = await db
        .from("validity_sales")
        .upsert(
          {
            access_request_id: data.id,
            seller_name: seller,
            buyer_name: data.user_name,
            buyer_phone_e164: data.phone_e164,
            plan_name: data.requested_plan,
            amount_cents: amountCents,
            payment_method: String(body.payment_method || "PIX manual").slice(
              0,
              60,
            ),
            payment_status: "manually_confirmed",
            sold_at: now,
          },
          { onConflict: "access_request_id" },
        );
      if (sale.error) throw sale.error;
      await send(
        data.phone_e164,
        `✅ *Acesso Validade PT260 liberado*\n\nOlá, ${data.user_name}. Seu aparelho ${data.device_model || "cadastrado"} foi autorizado. Abra novamente o aplicativo conectado à internet.`,
      );
      return Response.json({ ok: true }, { headers: cors });
    }
    return Response.json(
      { error: "Ação inválida" },
      { status: 400, headers: cors },
    );
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500, headers: cors },
    );
  }
});
