import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const db=createClient(Deno.env.get("SUPABASE_URL")||"",Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"");
// A conta operacional do robô é a instância fallback. A instância principal
// pode ser uma conta pessoal desconectada e não deve impedir o cadastro Beta.
const greenUrl=(Deno.env.get("GREEN_API_FALLBACK_URL")||Deno.env.get("GREEN_API_URL")||"").replace(/\/$/,"");
const greenInstance=Deno.env.get("GREEN_API_FALLBACK_INSTANCE_ID")||Deno.env.get("GREEN_API_INSTANCE_ID")||"";
const greenToken=Deno.env.get("GREEN_API_FALLBACK_TOKEN")||Deno.env.get("GREEN_API_TOKEN")||"";
const organizer="5511989346164";
const digits=(v:unknown)=>String(v||"").replace(/\D/g,"");
const clean=(v:unknown,max=120)=>String(v||"").trim().slice(0,max);
async function sha256(value:string){const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join("")}
async function send(phone:string,message:string){
 const response=await fetch(greenUrl+"/waInstance"+greenInstance+"/sendMessage/"+greenToken,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chatId:phone+"@c.us",message})});
 if(!response.ok)throw new Error("Green API HTTP "+response.status);
}
serve(async(request)=>{
 if(request.method!=="POST")return new Response("Method not allowed",{status:405});
 try{
  const payload=await request.json();let phone=digits(payload?.phone);
  if(phone.length===10||phone.length===11)phone="55"+phone;
  const name=clean(payload?.user_name),relationship=clean(payload?.relationship)||"Não informado";
  const plan=clean(payload?.requested_plan)||"Quero conversar";
  const deviceModel=clean(payload?.device_model,160)||"Não informado";
  const androidVersion=clean(payload?.android_version,40)||"Não informado";
  if(phone.length<12||!name)return Response.json({error:"invalid_request"},{status:400});
  const code=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,"0");
  const expiresAt=new Date(Date.now()+10*60_000).toISOString();
  const deviceId=clean(payload?.device_id,160);
  let requestQuery=db.from("validity_beta_access_requests").select("id").eq("phone_e164",phone);
  if(deviceId)requestQuery=requestQuery.eq("device_id",deviceId);
  const {data:requestRow,error:requestError}=await requestQuery.order("updated_at",{ascending:false}).limit(1).maybeSingle();
  if(requestError)throw requestError;
  if(!requestRow)return Response.json({error:"access_request_not_found"},{status:404});
  const {error}=await db.from("validity_beta_access_requests").update({
   verification_code_hash:await sha256(code),verification_expires_at:expiresAt,
   last_menu_sent_at:new Date().toISOString(),plan_status:"awaiting_whatsapp_confirmation",
   relationship,requested_plan:plan,device_model:deviceModel,android_version:androidVersion,
   updated_at:new Date().toISOString()
  }).eq("id",requestRow.id);
  if(error)throw error;
  const menu="🤖 *Validade PT260 — confirme seu telefone*\n\nOlá, "+name+
   ". Recebemos seu cadastro.\n\nSeu código é: *"+code.slice(0,3)+"-"+code.slice(3)+
   "*\nEle vale por 10 minutos.\n\n*Responda somente assim:*\n*CONFIRMAR "+code+"*\n\n"+
   "Não envie outra informação junto. Depois da confirmação, o chatbot mostrará o próximo passo.\n\n"+
   "A cobrança por PIX/QR Code ainda não está disponível.";
  await send(phone,menu);
  if(phone!==organizer)await send(organizer,"📥 *Novo cadastro Validade PT260*\n\nNome: "+name+
   "\nTelefone: +"+phone+"\nAparelho: "+deviceModel+"\nAndroid: "+androidVersion+
   "\nVínculo: "+relationship+"\nPlano informado: "+plan+
   "\nStatus: aguardando confirmação no WhatsApp.");
  return Response.json({ok:true,menu_sent:true,phone_last4:phone.slice(-4)});
 }catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:500})}
});
