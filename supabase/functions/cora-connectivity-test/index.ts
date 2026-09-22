// Diagnóstico privado de mTLS. Solicita somente um token de acesso; nunca cria
// fatura, cobrança, PIX ou transferência.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
const json=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
const pem=(name:string)=>{const encoded=Deno.env.get(name)??"";return encoded?new TextDecoder().decode(Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))):""};
serve(async request=>{
 if(request.method!=="POST")return json(405,{error:"method_not_allowed"});
 try{
  const body=await request.json().catch(()=>({}));
  const production=String(body.environment||"stage").toLowerCase()==="production";
  const prefix=production?"CORA_":"CORA_STAGE_";
  const clientId=(Deno.env.get(prefix+"CLIENT_ID")??"").trim();
  const certChain=pem(prefix+"CERTIFICATE_PEM_B64"),privateKey=pem(prefix+"PRIVATE_KEY_PEM_B64");
  if(!clientId||!certChain||!privateKey)return json(500,{error:"credentials_not_configured",environment:production?"production":"stage"});
  const client=Deno.createHttpClient({certChain,privateKey});
  const endpoint=production?"https://matls-clients.api.cora.com.br/token":"https://matls-clients.api.stage.cora.com.br/token";
  const response=await fetch(endpoint,{method:"POST",client,headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"client_credentials",client_id:clientId})});
  if(!response.ok)return json(502,{ok:false,environment:production?"production":"stage",cora_status:response.status});
  return json(200,{ok:true,environment:production?"production":"stage",message:"Autenticação mTLS validada; nenhuma cobrança foi criada."});
 }catch{return json(500,{error:"connectivity_failed"})}
});
