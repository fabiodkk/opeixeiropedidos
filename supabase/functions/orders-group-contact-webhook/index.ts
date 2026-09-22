import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ordersGroupId = (
  Deno.env.get("GREEN_API_ORDERS_GROUP_CHAT_ID") || "120363413485472555"
).replace(/@g\.us$/, "");
const receivedOrdersGroupId = (
  Deno.env.get("GREEN_API_RECEIVED_GROUP_CHAT_ID") || "120363432635417808"
).replace(/@g\.us$/, "");
const logisticsGroupId = (
  Deno.env.get("GREEN_API_LOGISTICS_GROUP_CHAT_ID") || "120363414295884590"
).replace(/@g\.us$/, "");
const observerGroupId = (
  Deno.env.get("GREEN_API_OBSERVER_GROUP_CHAT_ID") || "120363410198454262"
).replace(/@g\.us$/, "");
const barGroupId = (
  Deno.env.get("GREEN_API_BAR_GROUP_CHAT_ID") || "120363405291798097"
).replace(/@g\.us$/, "");
const greenApiUrl = (Deno.env.get("GREEN_API_URL") || "").replace(/\/$/, "");
const greenInstanceId = Deno.env.get("GREEN_API_INSTANCE_ID") || "";
const greenApiToken = Deno.env.get("GREEN_API_TOKEN") || "";
const fallbackGreenApiUrl = (
  Deno.env.get("GREEN_API_FALLBACK_URL") || ""
).replace(/\/$/, "");
const fallbackGreenInstanceId =
  Deno.env.get("GREEN_API_FALLBACK_INSTANCE_ID") || "";
const fallbackGreenApiToken = Deno.env.get("GREEN_API_FALLBACK_TOKEN") || "";
const automatedOutboundPaused =
  (Deno.env.get("AUTOMATED_OUTBOUND_PAUSED") || "").toLowerCase() === "true";
// Enquanto a operação está em revisão, somente estes dois colaboradores podem
// receber iniciativa privada do chatbot. Os demais contatos seguem registrados
// para revisão do organizador, sem abordagem automática.
const privateOutboundAllowedPhones = new Set([
  "5512991979144", // Rodolfo
  "5512996548310", // Rodrigo / Confeitaria
  "5512981726846", // Simone: revisão individual do catálogo de vinhos autorizada
  "5512981147680", // Danilo: despacho e confirmação de rota P5 autorizados
  "5512981276290", // Tiago: liberação e confirmação de rota P5 autorizadas
  "5512981639918", // Ely: confirmação autorizada de compra emergencial
  "5512981580280", // Douglas: responsável por incidentes operacionais
]);
const organizerPhone = "5511989346164";
const temporaryDriverAccessOutboundPhones = new Set<string>();
const ordersBotAdminSecret = Deno.env.get("ORDERS_BOT_SETUP_TOKEN") || "";
const logisticsWebhookSecret = Deno.env.get("LOGISTICS_WEBHOOK_SECRET") || "";
const openAiApiKey = Deno.env.get("OPENAI_API_KEY") || "";
// Leitura visual paga fica desligada por padrão. O bot continua reconhecendo
// os itens já aprendidos por texto/legenda sem consumir cota de IA.
const photoVisionEnabled =
  Deno.env.get("OPEIXEIRO_ENABLE_PHOTO_VISION") === "true";
const db = createClient(supabaseUrl, serviceRoleKey);
// Lista operacional local de motoristas já identificados. Ela permite
// atendimento privado mesmo quando a pessoa ainda não entrou no grupo de
// Pedidos; nenhuma informação dessa lista é publicada em grupos.
const trackedDriverPhones: Record<string, string> = {
  // No contexto das fotos do P6, o final 0102 atua como conferente. A função
  // de motorista só é assumida quando alguém a informar explicitamente.
  "5512988770102": "Kleber · Conferente",
  "5512997985997": "Hormenson Mineiro",
  "5512974010671": "Edmar Oliveira Santos",
};
// Contatos que pediram para não receber avisos individuais automáticos sobre
// entrega. O vínculo de rota no grupo permanece possível, sem mensagem privada.
const driverPrivateDeliveryOptOutPhones = new Set([
  // A operação decidiu que motoristas não recebem proativamente mensagens do
  // robô nem convites de grupo. Os responsáveis fazem esse contato quando
  // necessário; acesso já existente ao app não é alterado.
  "5512974010671",
  "5512988770102",
  "5512997985997",
]);
const supplierPrivateMessagingOptOutPhones = new Set(["5512988911534"]);
// Cobertura temporária confirmada pelo organizador: Kayke pode liberar
// sobremesas quando estiver escalado fisicamente no Caixa P2, sem trocar o
// perfil principal do Bar P6.
const temporaryP2DessertReleasePhones = new Set(["5512988773277"]);

// Regra operacional confirmada: estes sabores são coletados normalmente no
// P2. Ela apenas orienta avisos futuros; não cria movimentação de estoque.
const p2DessertPickupProducts = /mousse\s+(?:de\s+)?(?:caf[eé]|maracuj[aá])/i;
const dessertPickupOriginNote = (products: Array<{ name: string }>) =>
  products.some((item) => p2DessertPickupProducts.test(text(item.name)))
    ? "\n\n*Coleta padrão:* P2 (mousses de café e maracujá)."
    : "";

function driverGroupLabel(driverPhone: string) {
  return text(trackedDriverPhones[driverPhone]) ||
    `Motorista final ${driverPhone.slice(-4)}`;
}

function isPeakMovementHours() {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date()));
  return hour >= 11 && hour < 14;
}

async function sendObserverGroupMessage(message: string) {
  // Toda comunicação de saída usa a instância empresarial. Instâncias pessoais
  // podem somente entregar webhooks de leitura para este endpoint.
  await sendOfficialMessage(`${observerGroupId}@g.us`, message);
}

function responseOutputText(payload: any) {
  if (text(payload?.output_text)) return text(payload.output_text);
  return (payload?.output || [])
    .flatMap((item: any) => item?.content || [])
    .filter((item: any) => item?.type === "output_text")
    .map((item: any) => text(item.text))
    .join("\n")
    .trim();
}

// Canal administrativo privado do Fabio. A IA responde somente depois que os
// comandos determinísticos já tiveram oportunidade de executar; ela não pode
// publicar, cancelar ou alterar pedidos por conta própria.
async function organizerPrivateAssistantReply(message: string) {
  if (!openAiApiKey) return "🤖 Assistente administrativo ativo, mas a chave de IA ainda não está disponível no servidor. Tente novamente em instantes.";
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        store: false,
        max_output_tokens: 300,
        instructions:
          "Você é o Assistente administrativo do O Peixeiro, respondendo em português brasileiro no WhatsApp privado do organizador Fabio. Seja direto. Interprete listas, conferências, fotos e status operacionais, mas nunca diga que publicou em grupo, alterou pedido ou confirmou entrega sem um comando determinístico do sistema. Se houver uma lista com 'vai depois', 'faltou', 'sem' ou 'não tem', diga que ela indica separação parcial e cite somente a pendência explícita. Se houver x/xx/xxx, diga que são marcações de conferência, sem inventar quantidades. Ofereça comandos seguros existentes como 'CONFIRMAR P5', 'CORRIGIR P5 P2: item' ou peça instrução explícita para publicar. Nunca revele chaves, senhas, tokens ou dados de outros colaboradores.",
        input: `Mensagem do organizador: ${safeConversationRecord(message)}`,
      }),
    });
    if (!response.ok) throw new Error(`OpenAI ${response.status}`);
    const answer = responseOutputText(await response.json());
    return answer || "🤖 Recebi sua mensagem. Diga se deseja apenas registrar, confirmar o pedido ou publicar a atualização nos grupos.";
  } catch (error) {
    console.error("organizer private assistant failed", error);
    return "🤖 Recebi sua mensagem. Para executar uma ação agora, use por exemplo: *CONFIRMAR P5* ou *CORRIGIR P5 P2: item*.";
  }
}

async function transcribeOperationalAudio(
  downloadUrl: string,
  fileName: string,
  mimeType: string,
) {
  if (!openAiApiKey || !downloadUrl) return "";
  try {
    const audioResponse = await fetch(downloadUrl);
    if (!audioResponse.ok) return "";
    const bytes = new Uint8Array(await audioResponse.arrayBuffer());
    // Limite conservador para manter o webhook rápido e evitar arquivos longos.
    if (!bytes.byteLength || bytes.byteLength > 20 * 1024 * 1024) return "";
    const form = new FormData();
    form.append("model", "gpt-4o-mini-transcribe");
    form.append("language", "pt");
    form.append(
      "file",
      new Blob([bytes], { type: mimeType || "audio/ogg" }),
      fileName || "audio.ogg",
    );
    const transcription = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      { method: "POST", headers: { Authorization: `Bearer ${openAiApiKey}` }, body: form },
    );
    if (!transcription.ok) return "";
    return text((await transcription.json())?.text).slice(0, 4000);
  } catch (error) {
    console.error("operational audio transcription failed", error);
    return "";
  }
}

async function itemsClearlyVisibleInDispatchPhoto(
  downloadUrl: string,
  mimeType: string,
  caption: string,
) {
  if (!photoVisionEnabled || !openAiApiKey || !downloadUrl)
    return [] as Array<{
      name: string;
      qty: number | null;
      unit: string;
      confidence: number;
    }>;
  try {
    const imageResponse = await fetch(downloadUrl);
    if (!imageResponse.ok) return [];
    const imageBytes = new Uint8Array(await imageResponse.arrayBuffer());
    if (imageBytes.byteLength > 10 * 1024 * 1024) return [];
    const visionResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        store: false,
        max_output_tokens: 350,
        instructions:
          'Analise somente a foto de despacho. Retorne JSON válido {"items":[{"name":string,"qty":number|null,"unit":string,"confidence":number}]}. Inclua somente produtos ou volumes claramente visíveis; reconheça separadamente caixas para pescado, caixas de papelão e caixas de isopor quando forem identificáveis. Nunca invente marca, tipo ou quantidade ilegível. Se houver uma lista textual do conferente em outra mensagem, ela é apenas um relato separado: não some, complete ou confirme essa lista a partir da foto. Para volume parcialmente encoberto, use qty null. Isso é evidência operacional, não baixa de estoque nem confirmação de entrega.',
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `Legenda: ${caption || "sem legenda"}`,
              },
              {
                type: "input_image",
                image_url: `data:${mimeType || "image/jpeg"};base64,${encodeBase64(imageBytes)}`,
                detail: "high",
              },
            ],
          },
        ],
      }),
    });
    if (!visionResponse.ok) return [];
    const result = JSON.parse(
      responseOutputText(await visionResponse.json()).replace(
        /^```json\s*|\s*```$/g,
        "",
      ),
    );
    return Array.isArray(result?.items)
      ? result.items
          .filter(
            (item: any) =>
              text(item?.name) && Number(item?.confidence || 0) >= 0.7,
          )
          .slice(0, 20)
          .map((item: any) => ({
            name: text(item.name),
            qty: Number(item.qty) > 0 ? Number(item.qty) : null,
            unit: text(item.unit) || "unidade",
            confidence: Number(item.confidence),
          }))
      : [];
  } catch (_) {
    return [];
  }
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

async function sha256Hex(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function safeConversationRecord(value: unknown) {
  // A auditoria precisa servir como prova operacional, mas nunca pode guardar
  // senha, palavra-chave ou token enviado pelo assistente.
  return text(value)
    .replace(/\b(?:senha|palavra[- ]?chave)\s*[:=-]?\s*\S+/gi, (match) =>
      match.replace(/\S+$/, "[oculta]"),
    )
    .replace(/\b[A-ZÀ-Ú]{4,24}-[A-Z0-9]{3,16}\b/g, "[palavra-chave oculta]")
    .slice(0, 1800);
}
function phone(value: unknown) {
  return text(value).replace(/@.+$/, "").replace(/\D/g, "");
}
function correctedText(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/\bcoxinha\b/gi, "Coxinha")
    .replace(/\bcatupiry\b/gi, "Catupiry")
    .replace(/\brequeijao\b/gi, "requeijão")
    .trim();
}
function normalized(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
}

// Nunca reutilizar uma saudação fixa em mensagens operacionais. A decisão é
// tomada no instante do envio, sempre pelo horário de São Paulo.
function operationalGreeting(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(now));
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}
function quantityNearItem(message: string, item: string) {
  const position = normalized(message).indexOf(normalized(item));
  if (position < 0) return 1;
  const before = message.slice(Math.max(0, position - 16), position);
  // Começa depois do nome do produto: assim o "350" de "lata 350ml"
  // jamais é confundido com quantidade.
  const after = message.slice(
    position + item.length,
    position + item.length + 20,
  );
  // Aceita tanto "3 cx de isca" quanto "2cx filé".
  const match =
    before.match(/(\d+(?:[,.]\d+)?)\s*(?:caixas?|cx)?\s*(?:de\s*)?$/i) ||
    after.match(/^\s*:\s*(\d+(?:[,.]\d+)?)/) ||
    after.match(/^.{0,12}?(\d+(?:[,.]\d+)?)/);
  // Regra operacional do Bar: quando a linha contém o produto, mas não traz
  // número, o pedido representa uma caixa. O valor padrão continua sendo 1;
  // a unidade é definida por itemUnitFor.
  return match ? Number(match[1].replace(",", ".")) || 1 : 1;
}
function itemUnitFor(name: string) {
  if (
    /\b(?:embalag(?:em|ens)?|marmita(?:s)?|tampa(?:s)?|talher(?:es)?|sacola(?:s)?)\b/i.test(
      name,
    )
  )
    return "pacote";
  if (/\bpolpa\b/i.test(name)) return "pacote";
  return /(vodka|campari|aperol|whisky|gin|catuaba|tanqueray|seagers|absolut|orloff|red label|black label|jack daniel)/i.test(
    name,
  )
    ? "unidade"
    : "caixa";
}
const observedP2Items = [
  {
    pattern: /\b(?:vodka\s+)?smirnoff(?:\s*(?:n[ºo.]?\s*)?21)?\b/i,
    name: "Vodka Smirnoff No. 21",
    unit: "unidade",
  },
  { pattern: /\bfanta(?:\s+laranja)?\b/i, name: "Fanta em lata", unit: "lata" },
  { pattern: /\bcoca(?:-?cola)?\b/i, name: "Coca-Cola em lata", unit: "lata" },
  {
    pattern: /\bguaran[aá](?:\s+antarctica)?\b/i,
    name: "Guaraná Antarctica em lata",
    unit: "lata",
  },
  { pattern: /\bheineken\b/i, name: "Heineken", unit: "engradado" },
  { pattern: /\bskol\b/i, name: "Skol", unit: "engradado" },
  { pattern: /\bpolpas?\b/i, name: "Polpas congeladas", unit: "pacote" },
  { pattern: /\bcaldo\s+de\s+cana\b/i, name: "Caldo de cana", unit: "caixa" },
  { pattern: /\b(?:bife\s+)?ancho\b/i, name: "Ancho", unit: "pacote" },
  { pattern: /\bpicanha\b/i, name: "Picanha", unit: "pacote" },
  { pattern: /\balcaparras?\b/i, name: "Alcaparras", unit: "balde" },
];
function observedKnownItems(message: string) {
  return observedP2Items.filter((item) => item.pattern.test(message));
}
function looksLikeObservedOrder(message: string) {
  return (
    /\bP[1-7]\b/i.test(message) &&
    (observedKnownItems(message).length > 0 ||
      message.split(/\r?\n/).filter((line) => text(line)).length >= 3)
  );
}
// Uma conferência/foto recebida durante a operação é sempre do dia corrente.
// Antes, qualquer mensagem observada após 05:00 era exibida como se fosse para
// amanhã, mesmo sem o remetente ter pedido um novo agendamento.
function observedDeliveryDate(message: string) {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }),
  );
  // Só programe para o próximo dia quando isso estiver escrito de forma clara.
  if (/\b(?:amanh[ãa]|pr[oó]ximo\s+dia)\b/i.test(normalized(message)))
    now.setDate(now.getDate() + 1);
  return now.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}
function organizedObservedText(message: string) {
  const p2Items = observedKnownItems(message);
  if (p2Items.length) {
    return `*Itens organizados — coleta no P2:*\n${p2Items.map((item) => `• ${item.name}: 1 ${item.unit}`).join("\n")}`;
  }
  const cleaned = correctedText(message)
    .replace(/\bpoupa\b/gi, "Polpa")
    .replace(/\bcoxa\s+sobre\s+coxa\b/gi, "Coxa e sobrecoxa")
    .replace(/\bcopinho\s*p\/?\s*molho\b/gi, "Copinho para molho")
    .replace(/\bmarmita\b/gi, "Marmitex");
  return cleaned
    .split(/\r?\n/)
    .map((line) => text(line))
    .filter(Boolean)
    .map((line) => {
      if (
        /^(pedido|lista|p[1-7]|precisamos|boa noite|obg)/i.test(line) ||
        /^\*?peixaria\*?$/i.test(line)
      )
        return line;
      return `• ${line}`;
    })
    .join("\n");
}
function mergeDraftItems(
  current: Array<{ name: string; qty: number; unit?: string }>,
  added: Array<{ name: string; qty: number; unit?: string }>,
) {
  const merged = new Map<string, { name: string; qty: number; unit: string }>();
  for (const item of [...current, ...added]) {
    const key = normalized(item.name);
    const previous = merged.get(key);
    merged.set(key, {
      name: previous?.name || item.name,
      qty: (previous?.qty || 0) + (Number(item.qty) || 1),
      unit: previous?.unit || item.unit || itemUnitFor(item.name),
    });
  }
  return [...merged.values()];
}
async function catalogItemsFromMessage(message: string) {
  const { data, error } = await db
    .from("opeixeiro_products")
    .select("canonical_name")
    .eq("active", true)
    .limit(1000);
  if (error) throw error;
  const source = normalized(message);
  const matches = new Map<string, number>();
  const requestLines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      const key = normalized(line);
      // Estas apresentações não fazem parte da operação; não devem ser
      // sugeridas pelo bot, mesmo que apareçam no catálogo geral futuramente.
      return (
        line.length > 0 &&
        !/(coca|guarana|pepsi|pepse|fanta).*(?:600\s*ml|600ml)/.test(key)
      );
    });
  for (const product of data || []) {
    const name = text(product.canonical_name);
    const key = normalized(name);
    // "Peixe" é uma classificação no catálogo, não uma palavra que a pessoa
    // precisa escrever. Assim "filé de linguado" encontra "Filé de linguado Peixe".
    const significant = key
      .split(/[^a-z0-9]+/)
      .filter(
        (word) =>
          word.length >= 4 &&
          !["caixa", "unidade", "embalagem", "com", "para", "peixe"].includes(
            word,
          ),
      );
    for (const line of requestLines) {
      const lineKey = normalized(line);
      const direct = key.length > 3 && lineKey.includes(key);
      const keyword =
        significant.length > 0 &&
        significant.every((word) => lineKey.includes(word));
      if (direct || keyword) {
        matches.set(
          name,
          quantityNearItem(line, direct ? name : significant[0]),
        );
        break;
      }
    }
  }
  // “polenta” sempre aponta para a apresentação palito quando ela existir no catálogo.
  if (source.includes("polenta")) {
    const palito = (data || [])
      .map((p) => text(p.canonical_name))
      .find(
        (name) =>
          normalized(name).includes("polenta") &&
          normalized(name).includes("palito"),
      );
    if (palito) matches.set(palito, quantityNearItem(message, "polenta"));
  }
  // Apelidos e pequenos erros comuns não devem fazer o item específico cair no
  // produto genérico (por exemplo, "costelinha de salmao" virar somente "Salmão").
  const catalogNames = (data || []).map((p) => text(p.canonical_name));
  const aliases = [
    {
      terms: [
        "embalagem",
        "embalagens",
        "marmita",
        "marmitas",
        "tampa",
        "tampas",
        "sacola",
        "sacolas",
        "talher",
        "talheres",
      ],
      words: ["embalagens"],
    },
    { terms: ["bacalhal", "bacalhau"], words: ["bacalhau", "peixe"] },
    {
      terms: ["costelinha de salmao", "costelinha salmao"],
      words: ["costelinha", "salmao"],
    },
    {
      terms: ["caixa pizza pequena", "caixa de pizza pequena", "pizza brotinho", "caixa brotinho"],
      words: ["caixa", "pizza", "pequena"],
    },
    {
      terms: ["caixa pizza grande", "caixa de pizza grande", "pizza grande", "caixa oitavada"],
      words: ["caixa", "pizza", "grande"],
    },
    {
      terms: ["forminha pudim", "forminhas pudim", "forma pudim", "banho maria", "banho-maria", "potinho pudim"],
      words: ["forminha", "pudim"],
    },
    {
      terms: ["potinho mousse", "potinhos mousse", "pote mousse", "mousse 80", "potinho 80ml", "pote 80ml"],
      words: ["potinho", "mousse", "80"],
    },
  ];
  for (const alias of aliases) {
    const term = alias.terms.find((candidate) => source.includes(candidate));
    if (!term) continue;
    const catalogName = catalogNames.find((name) => {
      const key = normalized(name);
      return alias.words.every((word) => key.includes(word));
    });
    if (catalogName) matches.set(catalogName, quantityNearItem(message, term));
  }
  // Catálogo complementar exclusivo deste chatbot: apelidos de bebidas e suas
  // apresentações. Ele não altera o catálogo operacional nem cria produto novo.
  const beverageAliases = [
    { name: "Coca lata 350ml", terms: ["coca lata 350ml"] },
    { name: "Coca Zero lata 350ml", terms: ["coca zero lata 350ml"] },
    { name: "Sprite lata 350ml", terms: ["sprite lata 350ml"] },
    { name: "Sprite Zero lata 350ml", terms: ["sprite zero lata 350ml"] },
    { name: "Skol Lata 350ml", terms: ["skol lata 350ml", "skol lata"] },
    {
      name: "Brahma Lata 350ml",
      terms: [
        "brahma lata 350ml",
        "brama lata",
        "brahma chopp lata",
        "brama chopp lata",
        "brahma lata",
      ],
    },
    { name: "Malzbier Lata 350ml", terms: ["malzbier lata 350ml"] },
    { name: "Original lata 350ml", terms: ["original lata 350ml"] },
    { name: "Água com Gás 500ml", terms: ["agua com gas 500ml"] },
    { name: "Água garrafa 500ml", terms: ["agua garrafa 500ml"] },
    {
      name: "Schweppes Citrus Lata 350ml",
      terms: ["schweppes citrus lata 350ml"],
    },
    { name: "H20 limão garrafa 500ml", terms: ["h20 limao", "h2o limao"] },
    {
      name: "H20 Limoneto Garrafa 500ml",
      terms: ["h20 limoneto", "h2o limoneto"],
    },
    {
      name: "Smirnoff Ice Long Neck 275ml",
      terms: ["smirnof ice", "smirnoff ice", "smirnof", "smirnoff"],
    },
    {
      name: "FYS Limão Siciliano Lata 350ml",
      terms: ["fys limao siciliano", "fys limao"],
    },
    {
      name: "FYS Guaraná da Amazônia Lata 350ml",
      terms: ["fys guarana da amazonia", "fys guarana"],
    },
    {
      name: "FYS Laranja-Pera Lata 350ml",
      terms: ["fys laranja pera", "fys laranja"],
    },
    {
      name: "FYS Tônica Zero com Toque de Limão Siciliano Lata 350ml",
      terms: [
        "fys tonica zero",
        "fys tonica com toque de limao siciliano zero",
        "fys tonica zero siciliano",
      ],
    },
    {
      name: "FYS Tônica com Toque de Limão Siciliano Lata 350ml",
      terms: [
        "fys tonica com toque de limao siciliano",
        "fys tonica siciliano",
      ],
    },
    {
      name: "Pepsi Lata 350ml",
      terms: [
        "pepsi lata",
        "pepse lata",
        "pepsi 350",
        "pepse 350",
        "pepsi",
        "pepse",
      ],
    },
    {
      name: "Pepsi Black Lata 350ml",
      terms: ["pepsi black", "pepse black", "pepsi zero", "pepse zero"],
    },
    {
      name: "Guaraná Antarctica Lata 350ml",
      terms: ["guarana antarctica", "guarana lata", "guarana"],
    },
    {
      name: "Guaraná Antarctica Zero Lata 350ml",
      terms: ["guarana antarctica zero", "guarana zero"],
    },
    { name: "Fanta Laranja Lata 350ml", terms: ["fanta laranja"] },
    {
      name: "Fanta Laranja Zero Lata 350ml",
      terms: ["fanta laranja zero", "fanta zero"],
    },
    { name: "Fanta Uva Lata 350ml", terms: ["fanta uva"] },
    { name: "Itubaína 600ml", terms: ["itubaina", "tubaina"] },
    {
      name: "Soda Limonada Antarctica Lata 350ml",
      terms: ["soda limonada", "soda antarctica"],
    },
    { name: "Sukita Laranja Lata 350ml", terms: ["sukita laranja", "sukita"] },
    { name: "Sukita Uva Lata 350ml", terms: ["sukita uva"] },
    { name: "Red Bull Lata 250ml", terms: ["red bull"] },
    {
      name: "Vodka Smirnoff 998ml",
      terms: ["vodka smirnoff", "smirnoff vodka"],
    },
    { name: "Vodka Orloff 1L", terms: ["vodka orloff", "orloff"] },
    { name: "Vodka Absolut 1L", terms: ["vodka absolut", "absolut"] },
    { name: "Vodka — marca e apresentação a confirmar", terms: ["vodka"] },
    { name: "Catuaba Selvagem 1L", terms: ["catuaba selvagem", "catuaba"] },
    { name: "Gin Seagers 1L", terms: ["gin seagers", "seagers"] },
    { name: "Gin Tanqueray 750ml", terms: ["gin tanqueray", "tanqueray"] },
    { name: "Campari 748ml", terms: ["campari", "campare"] },
    { name: "Aperol 750ml", terms: ["aperol"] },
    { name: "Whisky Jack Daniel's 1L", terms: ["jack daniels", "jack daniel"] },
    {
      name: "Whisky Johnnie Walker Red Label 1L",
      terms: ["red label", "johnnie walker red"],
    },
    {
      name: "Whisky Johnnie Walker Black Label 1L",
      terms: ["black label", "johnnie walker black"],
    },
    {
      name: "Stella Artois Long Neck 330ml",
      terms: ["stella long neck", "stella artois long neck"],
    },
    { name: "Caracu Lata 350ml", terms: ["caracu", "caracu lata"] },
    {
      name: "Corona Extra Long Neck 330ml",
      terms: ["corona long neck", "corona extra"],
    },
    {
      name: "Heineken Zero Long Neck 330ml",
      terms: ["heineken long neck zero", "heineken zero long neck"],
    },
    { name: "Monster Energy", terms: ["monster energy", "monster"] },
    { name: "Petra Lata 350ml", terms: ["petra lata", "petra"] },
  ];
  for (const beverage of beverageAliases) {
    const line = requestLines.find((candidate) =>
      beverage.terms.some((term) => normalized(candidate).includes(term)),
    );
    if (!line) continue;
    if (
      beverage.name === "FYS Tônica com Toque de Limão Siciliano Lata 350ml" &&
      normalized(line).includes("zero")
    )
      continue;
    if (
      beverage.name === "Guaraná Antarctica Lata 350ml" &&
      normalized(line).includes("fys")
    )
      continue;
    if (
      beverage.name === "Vodka — marca e apresentação a confirmar" &&
      /(smirnoff|orloff|absolut)/.test(normalized(line))
    )
      continue;
    const term =
      beverage.terms.find((candidate) =>
        normalized(line).includes(candidate),
      ) || beverage.terms[0];
    // Remove variantes técnicas/duplicadas antes de inserir a apresentação padrão.
    for (const name of [...matches.keys()]) {
      const key = normalized(name);
      if (
        beverage.terms.some(
          (candidate) => key.includes(candidate) || candidate.includes(key),
        )
      )
        matches.delete(name);
    }
    matches.set(beverage.name, quantityNearItem(line, term));
  }
  // Em listas encabeçadas por POLPAS/POUPAS, o colaborador costuma escrever
  // apenas quantidade e sabor nas linhas seguintes. O título fornece o
  // contexto e cada sabor continua sendo um produto independente.
  if (/\bpolpas?\b|\bpoupas?\b/.test(source)) {
    const pulpFlavors = [
      { flavor: "maracuja", name: "Polpa de Maracujá" },
      { flavor: "morango", name: "Polpa de Morango" },
      { flavor: "limao", name: "Polpa de Limão" },
      { flavor: "abacaxi", name: "Polpa de Abacaxi" },
      { flavor: "acerola", name: "Polpa de Acerola" },
      { flavor: "caju", name: "Polpa de Caju" },
      { flavor: "frutas vermelhas", name: "Polpa de Frutas Vermelhas" },
    ];
    for (const pulp of pulpFlavors) {
      const line = requestLines.find((candidate) =>
        normalized(candidate).includes(pulp.flavor),
      );
      if (line) matches.set(pulp.name, quantityNearItem(line, pulp.flavor));
    }
  }
  const sourceWithoutCostelinha = source.replace(
    /costelinha\s+(?:de\s+)?salmao/g,
    " ",
  );
  if (
    source.includes("costelinha") &&
    source.includes("salmao") &&
    !sourceWithoutCostelinha.includes("salmao")
  ) {
    // A correspondência por palavra-chave encontra "Salmão" também; o item
    // composto é o que foi solicitado, portanto removemos esse falso positivo.
    for (const name of matches.keys()) {
      const key = normalized(name);
      if (key === "salmao" || key === "salmao peixe") matches.delete(name);
    }
  }
  // Quando o catálogo possui as duas versões (por exemplo, "Salmão" e
  // "Salmão Peixe"), mantém a apresentação sem o sufixo técnico para não
  // duplicar um único item informado na mensagem.
  for (const name of [...matches.keys()]) {
    const key = normalized(name);
    if (!key.endsWith(" peixe")) continue;
    const baseName = catalogNames.find(
      (candidate) => normalized(candidate) === key.slice(0, -6),
    );
    if (baseName && matches.has(baseName)) matches.delete(name);
  }
  return [...matches].map(([name, qty]) => ({
    name,
    qty,
    unit: itemUnitFor(name),
  }));
}

function refineBarCatalogItems(
  message: string,
  items: Array<{ name: string; qty: number; unit?: string }>,
) {
  const source = normalized(message);
  return items.filter((item) => {
    const name = normalized(item.name);
    // Uma apresentação específica escrita pelo colaborador prevalece sobre
    // correspondências genéricas do mesmo produto.
    if (/coca(?:-?cola)?\s+ks/.test(source))
      return !/^(?:coca|coca-cola)$/.test(name);
    if (/pepsi\s+black/.test(source) && /pepsi lata/.test(name) && !/black/.test(name))
      return false;
    if (/agua\s+com\s+gas/.test(source) && /agua\s+sem\s+gas/.test(name))
      return false;
    if (/original\s+\d+/.test(source) && name === "original") return false;
    return true;
  }).map((item) => ({
    ...item,
    qty: Number(item.qty) > 0 ? Number(item.qty) : 1,
    unit: item.unit || itemUnitFor(item.name),
  }));
}
async function kitchenAvailabilityFromMessage(message: string) {
  const { data, error } = await db
    .from("opeixeiro_portion_catalog")
    .select("id,canonical_name")
    .eq("active", true);
  if (error) throw error;
  const lines = message
    .split(/[\r\n;]+/)
    .map((line) => normalized(line))
    .filter(Boolean);
  const detected = new Map<
    string,
    { id: string; name: string; availability: string }
  >();
  const aliases: Record<string, string[]> = {
    porquinho: ["porquinho", "peixe porquinho", "porcao de porquinho"],
    cacao: ["cacao", "porcao de cacao", "posta de cacao"],
    "guioza de legumes": [
      "guioza de legumes",
      "gyoza de legumes",
      "guioza legumes",
      "gyoza legumes",
    ],
    "guioza bovino": [
      "guioza bovino",
      "gyoza bovino",
      "guioza carne",
      "gyoza carne",
    ],
    "guioza suino": [
      "guioza suino",
      "gyoza suino",
      "guioza porco",
      "gyoza porco",
    ],
    "harumaki de queijo": ["harumaki de queijo", "harumake de queijo"],
    "harumaki de legumes": ["harumaki de legumes", "harumake de legumes"],
    "sache de molho agridoce": [
      "sache de molho agridoce",
      "sache agridoce",
      "molho agridoce",
    ],
  };
  const mark = (product: any, line: string) => {
    const availability = /\b(nao tem|sem |faltou|em falta|acabou)\b/.test(line)
      ? "unavailable"
      : /\b(tem|tenho|disponivel|sim|todos)\b/.test(line)
        ? "available"
        : "";
    if (availability)
      detected.set(product.id, {
        id: product.id,
        name: text(product.canonical_name),
        availability,
      });
  };
  for (const product of data || []) {
    const key = normalized(text(product.canonical_name));
    const terms = aliases[key] || [key];
    for (const line of lines)
      if (terms.some((term) => line.includes(term))) mark(product, line);
  }
  // "tem todos os guiozas" e "tem todos os nikumans" confirmam cada sabor.
  for (const line of lines) {
    const group =
      line.includes("guioza") || line.includes("gyoza")
        ? "guioza"
        : line.includes("nikuman")
          ? "nikuman"
          : "";
    if (group && /\b(tem|tenho|disponivel|todos)\b/.test(line)) {
      for (const product of data || [])
        if (normalized(text(product.canonical_name)).includes(group)) {
          detected.set(product.id, {
            id: product.id,
            name: text(product.canonical_name),
            availability: "available",
          });
        }
    }
  }
  return [...detected.values()];
}
async function barAvailabilityFromMessage(message: string) {
  const { data, error } = await db
    .from("opeixeiro_bar_availability_catalog")
    .select("id,canonical_name,aliases")
    .eq("active", true);
  if (error) throw error;
  const detected = new Map<string, any>();
  const clauses = message
    .split(/[;\r\n]+/)
    .map((value) => normalized(value))
    .filter(Boolean);
  for (const clause of clauses) {
    const availability = /\b(nao tem|sem |faltou|em falta|acabou)\b/.test(
      clause,
    )
      ? "unavailable"
      : /\b(tem|tenho|disponivel|chegou)\b/.test(clause)
        ? "available"
        : "";
    if (!availability) continue;
    // Uma única resposta como "tem todas as polpas" cobre os sabores do
    // catálogo, evitando uma sequência de perguntas para sucos e caipirinhas.
    if (/\b(todas?|todos?)\s+(?:as\s+)?polpas\b/.test(clause)) {
      for (const product of data || [])
        if (normalized(text(product.canonical_name)).startsWith("polpa de ")) {
          detected.set(product.id, {
            id: product.id,
            name: text(product.canonical_name),
            availability,
          });
        }
      continue;
    }
    for (const product of data || []) {
      const terms = [
        normalized(text(product.canonical_name)),
        ...(Array.isArray(product.aliases)
          ? product.aliases.map((alias: any) => normalized(text(alias)))
          : []),
      ];
      if (terms.some((term) => term && clause.includes(term)))
        detected.set(product.id, {
          id: product.id,
          name: text(product.canonical_name),
          availability,
        });
    }
  }
  return [...detected.values()];
}
async function missingItemsConfirmation(
  orderId: string,
  detected: Array<{ name: string; qty: number }>,
) {
  let items = detected;
  if (orderId) {
    const { data } = await db
      .from("opeixeiro_order_items")
      .select("requested_qty,unit,opeixeiro_products(canonical_name)")
      .eq("order_id", orderId);
    const expected = (data || []).map((row: any) => ({
      name: text(row.opeixeiro_products?.canonical_name),
      qty: Number(row.requested_qty) || 0,
      unit: text(row.unit) || "caixa",
    }));
    const found = expected.filter((item) =>
      detected.some(
        (received) => normalized(received.name) === normalized(item.name),
      ),
    );
    if (found.length)
      return `Identifiquei como faltantes, conforme as quantidades do pedido original:\n${found.map((item) => `• ${item.name}: ${item.qty} ${item.unit}`).join("\n")}\n\nOs demais itens do pedido chegaram nas quantidades totais? Você confirma que faltaram somente estes itens?\n\nResponda *SIM* para confirmar ou *EDITAR* com o formato: “Brahma: 1 caixa; Skol: 2 caixas”.`;
  }
  return `Identifiquei como faltantes somente estes itens:\n${items.map((item) => `• ${item.name}: ${item.qty} caixa${item.qty === 1 ? "" : "s"}`).join("\n")}\n\nVocê confirma que faltou somente estes itens? Responda *SIM* para confirmar ou *EDITAR* e envie a correção.`;
}
async function sendGroupMessage(message: string) {
  // O grupo deve permanecer enxuto: links, senhas e arquivos de acesso só
  // seguem em conversa privada e quando forem solicitados pelo colaborador.
  await sendOfficialMessage(`${ordersGroupId}@g.us`, message);
}
async function sendLogisticsGroupMessage(message: string) {
  if (!logisticsGroupId) throw new Error("Grupo de logística não configurado");
  // Incidentes e conferências internas devem circular pelo grupo apenas com
  // o mínimo necessário: status e próximo responsável. Evidências, fotos,
  // conteúdo e hipóteses ficam no relatório/auditoria e no privado permitido.
  await sendOfficialMessage(`${logisticsGroupId}@g.us`, message);
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function forwardGroupMessageForTrace(
  sourceGroupId: string,
  senderName: string,
  senderPhone: string,
  message: string,
  sourceMessageId: string,
) {
  if (
    !sourceMessageId ||
    !message ||
    ![ordersGroupId, receivedOrdersGroupId, barGroupId].includes(sourceGroupId) ||
    sourceGroupId === logisticsGroupId
  ) return false;

  const { data: duplicate } = await db
    .from("opeixeiro_operational_events")
    .select("id")
    .eq("event_type", "offline_queued")
    .contains("metadata", {
      record_kind: "group_message_forward",
      source_message_id: sourceMessageId,
    })
    .limit(1)
    .maybeSingle();
  if (duplicate) return false;

  const delay = 1000 + Math.floor(Math.random() * 14000);
  await wait(delay);
  const sourceLabel = sourceGroupId === receivedOrdersGroupId
    ? "Pedidos / Recebidos"
    : sourceGroupId === ordersGroupId
    ? "Pedidos"
    : "Bar Peixeiro";
  await sendObserverGroupMessage(
    `📌 *Rastreio de mensagem recebida*\n` +
      `Grupo: *${sourceLabel}*\n` +
      `Remetente: *${senderName || "não identificado"}*\n` +
      `Telefone: *+${senderPhone}*\n\n${message}`,
  );
  await db.from("opeixeiro_operational_events").insert({
    event_type: "offline_queued",
    actor_name: senderName || `contato final ${senderPhone.slice(-4)}`,
    occurred_at: new Date().toISOString(),
    metadata: {
      record_kind: "group_message_forward",
      source_group: sourceLabel,
      source_group_id: sourceGroupId,
      source_message_id: sourceMessageId,
      sender_phone: senderPhone,
      sender_name: senderName || "",
      forwarded_to: observerGroupId,
      delay_ms: delay,
      source_text: safeConversationRecord(message),
    },
  });
  return true;
}

async function sendOfficialMessage(chatId: string, message: string) {
  if (automatedOutboundPaused) {
    console.log("WhatsApp outbound paused; event was recorded without sending", {
      chatId,
      length: message.length,
    });
    return;
  }
  const privateRecipient = phone(chatId);
  if (
    chatId.endsWith("@c.us") &&
    privateRecipient !== organizerPhone &&
    !privateOutboundAllowedPhones.has(privateRecipient) &&
    !temporaryDriverAccessOutboundPhones.has(privateRecipient)
  ) {
    console.log("Private WhatsApp outbound held for organizer review", {
      phoneLast4: privateRecipient.slice(-4),
      length: message.length,
    });
    return;
  }
  const credentials = [
    {
      url: fallbackGreenApiUrl,
      instance: fallbackGreenInstanceId,
      token: fallbackGreenApiToken,
    },
    { url: greenApiUrl, instance: greenInstanceId, token: greenApiToken },
  ].filter((item) => item.url && item.instance && item.token);
  const failures: string[] = [];
  for (const credential of credentials) {
    const response = await fetch(
      `${credential.url}/waInstance${credential.instance}/sendMessage/${credential.token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, message }),
      },
    );
    if (response.ok && text((await response.json())?.idMessage)) {
      const recipient = phone(chatId);
      if (recipient && !/@g\.us$/i.test(chatId))
        await db
          .from("opeixeiro_chatbot_conversation_audit")
          .insert({
            phone_e164: recipient,
            channel: "whatsapp_private",
            direction: "outgoing",
            intent: "private_assistant_message",
            summary: safeConversationRecord(message),
            outcome: "Mensagem do assistente enviada.",
          })
          .then(() => undefined)
          .catch(() => undefined);
      return;
    }
    failures.push(`instância ${credential.instance}: ${response.status}`);
  }
  throw new Error(
    `Nenhuma instância Green API conseguiu enviar a mensagem (${failures.join(", ") || "sem credenciais"})`,
  );
}

async function removeParticipantFromOrdersGroup(phoneE164: string) {
  const credentials = [
    { url: fallbackGreenApiUrl, instance: fallbackGreenInstanceId, token: fallbackGreenApiToken },
    { url: greenApiUrl, instance: greenInstanceId, token: greenApiToken },
  ].filter((item) => item.url && item.instance && item.token);
  for (const credential of credentials) {
    const response = await fetch(
      `${credential.url}/waInstance${credential.instance}/removeGroupParticipant/${credential.token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupId: `${ordersGroupId}@g.us`,
          participantChatId: `${phoneE164}@c.us`,
        }),
      },
    );
    if (response.ok) return true;
  }
  return false;
}

async function tryDeleteIncomingOrdersMessage(idMessage: string) {
  if (!idMessage) return false;
  const credentials = [
    { url: fallbackGreenApiUrl, instance: fallbackGreenInstanceId, token: fallbackGreenApiToken },
    { url: greenApiUrl, instance: greenInstanceId, token: greenApiToken },
  ].filter((item) => item.url && item.instance && item.token);
  for (const credential of credentials) {
    const response = await fetch(
      `${credential.url}/waInstance${credential.instance}/deleteMessage/${credential.token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: `${ordersGroupId}@g.us`,
          idMessage,
          onlyForMe: false,
        }),
      },
    );
    if (response.ok) return true;
  }
  return false;
}
function thermalPdf(lines: string[]) {
  const safe = (value: string) =>
    normalized(value)
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  const content = lines
    .slice(0, 48)
    .map(
      (line, index) =>
        `BT /F1 ${index === 0 ? 14 : 10} Tf 34 ${806 - index * 15} Td (${safe(line)}) Tj ET`,
    )
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 226.77 841.89] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${new TextEncoder().encode(content).length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(new TextEncoder().encode(pdf).length);
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}
const nightClosingChecklistLines = [
  "O PEIXEIRO - CHECKLIST NOTURNO",
  "Procedimento interno para cumins e salao",
  "Sexta, sabado e domingo:",
  "[ ] Cumins devem buscar os pedidos nas boquetas.",
  "[ ] Garcons devem manter as maos livres para anotar itens emergentes no caixa.",
  "[ ] No intervalo de almoco, com equipe reduzida, garcons ajudam conforme a demanda.",
  "",
  "A partir das 22h:",
  "[ ] Levantar as cadeiras do salao.",
  "[ ] Fechar todas as janelas.",
  "[ ] Retirar os lixos para facilitar a limpeza da manha.",
  "[ ] Conferir lixo do caixa e da frente do bar.",
  "[ ] Limpar bandejas.",
  "[ ] Limpar camisinha/equipamento de serviço.",
  "[ ] Servir e gelar.",
  "[ ] Desligar lampadas de consumo desnecessarias.",
  "[ ] Conferir se as lampadas internas das geladeiras ficaram apagadas.",
  "[ ] Garcons aguardam o fechamento do caixa antes de sair.",
  "",
  "Em caso de ocorrencia, informe um responsavel.",
  "Procedimento interno solicitado por Kotian.",
];
async function generateNightClosingChecklistPdf(chatId: string) {
  const checkDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
  }).format(new Date());
  const fileName = `checklist-noturno-${checkDate}.pdf`;
  const path = `checklists/${checkDate}/${crypto.randomUUID()}.pdf`;
  const { error: uploadError } = await db.storage
    .from("opeixeiro-kitchen-availability")
    .upload(path, thermalPdf(nightClosingChecklistLines), {
      contentType: "application/pdf",
      upsert: false,
    });
  if (uploadError) throw uploadError;
  const { data: signed, error: signedError } = await db.storage
    .from("opeixeiro-kitchen-availability")
    .createSignedUrl(path, 60 * 60 * 24 * 14);
  if (signedError || !signed?.signedUrl)
    throw signedError || new Error("URL do PDF do checklist não disponível");
  const credentials = [
    { url: fallbackGreenApiUrl, instance: fallbackGreenInstanceId, token: fallbackGreenApiToken },
    { url: greenApiUrl, instance: greenInstanceId, token: greenApiToken },
  ].filter((item) => item.url && item.instance && item.token);
  for (const credential of credentials) {
    const response = await fetch(
      `${credential.url}/waInstance${credential.instance}/sendFileByUrl/${credential.token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId,
          urlFile: signed.signedUrl,
          fileName,
          caption: "🧹 Checklist noturno — procedimento interno para cumins e salão.",
        }),
      },
    );
    if (response.ok) return { fileName, path, sent: true };
  }
  throw new Error("Green API não enviou o PDF do checklist noturno");
}
const salonLowMovementChecklistLines = [
  "O PEIXEIRO - CHECKLIST DE BAIXO MOVIMENTO",
  "Salao | Data: ____ | Responsavel: ____",
  "",
  "[ ] Limpar entrada do restaurante.",
  "[ ] Limpar mesas com agua e sabao.",
  "[ ] Limpar salao e area externa.",
  "[ ] Limpar area kids e cardapios.",
  "[ ] Repor guardanapos.",
  "[ ] Limpar bandejas, talheres, porta-garrafas e afins.",
  "[ ] Limpar palco, piscina e calcada.",
  "[ ] Cuidar das plantas: regar, limpar e tirar matos.",
  "[ ] Limpar e organizar em cima das geladeiras.",
  "[ ] Esfregar o chao proximo ao bar e limpar estufas.",
  "[ ] Limpar janelas e portas de vidro.",
  "[ ] Limpar garrafas de vinho, garrafas do bar e tacas.",
  "[ ] Checar banheiros, banheiro dos funcionarios e vestiario.",
  "[ ] Limpar area das boquetas: pratos sujos e comidas.",
  "[ ] Varrer o salao.",
  "",
  "Use somente quando nao prejudicar atendimento ou seguranca.",
];
async function generateSalonLowMovementChecklistPdf(chatId: string) {
  const checkDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
  }).format(new Date());
  const fileName = `checklist-salao-baixo-movimento-${checkDate}.pdf`;
  const path = `checklists/${checkDate}/${crypto.randomUUID()}-salao.pdf`;
  const { error: uploadError } = await db.storage
    .from("opeixeiro-kitchen-availability")
    .upload(path, thermalPdf(salonLowMovementChecklistLines), {
      contentType: "application/pdf",
      upsert: false,
    });
  if (uploadError) throw uploadError;
  const { data: signed, error: signedError } = await db.storage
    .from("opeixeiro-kitchen-availability")
    .createSignedUrl(path, 60 * 60 * 24 * 14);
  if (signedError || !signed?.signedUrl)
    throw signedError || new Error("URL do PDF do salão não disponível");
  const credentials = [
    { url: fallbackGreenApiUrl, instance: fallbackGreenInstanceId, token: fallbackGreenApiToken },
    { url: greenApiUrl, instance: greenInstanceId, token: greenApiToken },
  ].filter((item) => item.url && item.instance && item.token);
  for (const credential of credentials) {
    const response = await fetch(
      `${credential.url}/waInstance${credential.instance}/sendFileByUrl/${credential.token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId,
          urlFile: signed.signedUrl,
          fileName,
          caption: "🧽 Checklist do salão — usar em período de baixo movimento.",
        }),
      },
    );
    if (response.ok) return { fileName, path, sent: true };
  }
  throw new Error("Green API não enviou o PDF do checklist do salão");
}
async function sendKitchenAvailabilityPrintout(
  sessionId: string,
  personName: string,
  unavailable: string[],
  checkDate: string,
) {
  if (!unavailable.length) return;
  const fileName = `faltas-cozinha-${checkDate}-${personName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pdf`;
  const path = `daily/${checkDate}/${sessionId}.pdf`;
  const lines = [
    "O PEIXEIRO",
    "FALTAS INFORMADAS - COZINHA",
    `Data: ${checkDate}`,
    `Informado por: ${personName}`,
    "",
    "NAO DISPONIVEL:",
    ...unavailable.map((item) => `- ${item}`),
    "",
    "Imprimir no caixa - autorizado por Kotian.",
  ];
  const { error: uploadError } = await db.storage
    .from("opeixeiro-kitchen-availability")
    .upload(path, thermalPdf(lines), {
      contentType: "application/pdf",
      upsert: true,
    });
  if (uploadError) throw uploadError;
  const { data: signed, error: signedError } = await db.storage
    .from("opeixeiro-kitchen-availability")
    .createSignedUrl(path, 60 * 60 * 24 * 14);
  if (signedError || !signed?.signedUrl)
    throw signedError || new Error("URL do PDF não disponível");
  const response = await fetch(
    `${greenApiUrl}/waInstance${greenInstanceId}/sendFileByUrl/${greenApiToken}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: `${ordersGroupId}@g.us`,
        urlFile: signed.signedUrl,
        fileName,
        caption: `🖨️ Lista de faltas da cozinha — ${personName}. PDF térmico para impressão no caixa.`,
      }),
    },
  );
  if (!response.ok)
    throw new Error(`Green API não enviou o PDF (${response.status})`);
  await db.from("opeixeiro_kitchen_availability_printouts").upsert(
    {
      check_session_id: sessionId,
      storage_path: path,
      authorized_by: "Kotian",
      sent_to_group_at: new Date().toISOString(),
    },
    { onConflict: "check_session_id" },
  );
}
async function sendBarAvailabilityPrintout(
  sessionId: string,
  barName: string,
  personName: string,
  unavailable: string[],
  checkDate: string,
) {
  if (!unavailable.length) return;
  const fileName = `faltas-bar-${checkDate}-${sessionId}.pdf`;
  const path = `bar/${checkDate}/${sessionId}.pdf`;
  const lines = [
    "O PEIXEIRO",
    `FALTAS - ${barName}`,
    `Data: ${checkDate}`,
    `Informado por: ${personName}`,
    "",
    "NAO DISPONIVEL:",
    ...unavailable.map((item) => `- ${item}`),
    "",
    "Imprimir no caixa.",
  ];
  const { error: uploadError } = await db.storage
    .from("opeixeiro-kitchen-availability")
    .upload(path, thermalPdf(lines), {
      contentType: "application/pdf",
      upsert: true,
    });
  if (uploadError) throw uploadError;
  const { data: signed, error: signedError } = await db.storage
    .from("opeixeiro-kitchen-availability")
    .createSignedUrl(path, 60 * 60 * 24 * 14);
  if (signedError || !signed?.signedUrl)
    throw signedError || new Error("URL do PDF do bar não disponível");
  const credentials = [
    { url: greenApiUrl, instance: greenInstanceId, token: greenApiToken },
    {
      url: fallbackGreenApiUrl,
      instance: fallbackGreenInstanceId,
      token: fallbackGreenApiToken,
    },
  ].filter((item) => item.url && item.instance && item.token);
  for (const credential of credentials) {
    const response = await fetch(
      `${credential.url}/waInstance${credential.instance}/sendFileByUrl/${credential.token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: `${ordersGroupId}@g.us`,
          urlFile: signed.signedUrl,
          fileName,
          caption: `🖨️ Itens em falta — ${barName}. Lista para impressão no caixa.`,
        }),
      },
    );
    if (response.ok) return;
  }
  throw new Error("Nenhuma instância conseguiu enviar o PDF do bar");
}

serve(async (request) => {
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  try {
    const payload = (await request.json()) as Record<string, any>;
    // Varredura silenciosa de imagens ja arquivadas: usada apenas pelo
    // organizador para enriquecer o relatorio. Nao envia mensagens, nao da
    // baixa e exige segredo administrativo para evitar consumo indevido.
    if (text(payload.type) === "analyze_report_photos_batch") {
      const suppliedSecret = request.headers.get("x-logistics-webhook-secret") || "";
      if (!logisticsWebhookSecret || suppliedSecret !== logisticsWebhookSecret)
        return new Response("Unauthorized", { status: 401 });
      const dates = Array.isArray(payload.report_dates)
        ? payload.report_dates.map((value: unknown) => text(value)).filter((value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value))
        : [];
      const batchSize = Math.min(Math.max(Number(payload.limit) || 10, 1), 20);
      if (!dates.length) return Response.json({ ignored: true, reason: "report_dates_required" });
      const { data: rows, error } = await db
        .from("opeixeiro_whatsapp_report_imports")
        .select("id,report_date,media_path,media_type,message_text,chatbot_interpretation")
        .in("report_date", dates)
        .not("media_path", "is", null)
        .ilike("chatbot_interpretation", "Foto operacional detectada%")
        .order("message_at", { ascending: true })
        .limit(batchSize);
      if (error) throw error;
      let identified = 0;
      for (const row of rows || []) {
        const mediaPath = text(row.media_path);
        const { data: signed, error: signedError } = await db.storage
          .from("opeixeiro-report-media")
          .createSignedUrl(mediaPath, 900);
        if (signedError || !signed?.signedUrl) continue;
        const items = await itemsClearlyVisibleInDispatchPhoto(
          signed.signedUrl,
          text(row.media_type || "image/jpeg"),
          text(row.message_text),
        );
        const interpretation = items.length
          ? `Leitura visual para relatorio: ${items.map((item) => `${item.qty || "quantidade nao legivel"} ${item.unit} de ${item.name}`).join("; ")}. Evidencia visual somente; sem baixa automatica.`
          : "Foto analisada para relatorio; nenhum item ou quantidade ficou legivel o bastante para registro operacional.";
        await db.from("opeixeiro_whatsapp_report_imports").update({
          chatbot_interpretation: interpretation,
          correction_or_learning: "Leitura por imagem mantida como evidencia; itens incertos nao geram entrega, estoque ou divergencia.",
        }).eq("id", row.id);
        if (items.length) {
          identified += items.length;
          await db.from("opeixeiro_operational_events").insert({
            event_type: "offline_queued",
            actor_name: "Assistente O Peixeiro",
            occurred_at: new Date().toISOString(),
            metadata: {
              record_kind: "silent_report_photo_visual_review",
              report_import_id: row.id,
              report_date: row.report_date,
              items,
              inventory_effect: "none_until_human_confirmation",
            },
          });
        }
      }
      return Response.json({ analyzed: (rows || []).length, identified_items: identified, silent: true });
    }
    if (text(payload.type) === "kotian_delivery_partner_suggestion") {
      const suppliedSecret = request.headers.get("x-logistics-webhook-secret") || "";
      if (!logisticsWebhookSecret || suppliedSecret !== logisticsWebhookSecret)
        return new Response("Unauthorized", { status: 401 });
      await sendOfficialMessage(
        "5512981521549@c.us",
        "🤖 *Sugestão do Assistente O Peixeiro*\n\nHoje identificamos uma oportunidade de integração simples com entregadoras, por exemplo a Loggi, para registrar automaticamente quando um pedido foi separado, coletado e entrou em rota.\n\nIsso pode reduzir dependência de confirmações manuais de fornecedores e manter o rastreio de cada pedido no sistema. Se quiser, podemos preparar um teste controlado com uma rota antes de integrar a operação inteira.",
      );
      return Response.json({ sent: true, kotian_delivery_partner_suggestion: true });
    }
    if (text(payload.type) === "delivery_item_confirmation") {
      const suppliedSecret =
        request.headers.get("x-logistics-webhook-secret") || "";
      if (!logisticsWebhookSecret || suppliedSecret !== logisticsWebhookSecret)
        return new Response("Unauthorized", { status: 401 });
      const orderId = text(payload.order_id);
      if (!orderId)
        throw new Error("Pedido não informado para confirmação de entrega");
      const { data: order, error: orderError } = await db
        .from("opeixeiro_orders")
        .select(
          "id,status,recipient_name,destination_unit_id,opeixeiro_units!opeixeiro_orders_destination_unit_id_fkey(name,code),opeixeiro_order_items(requested_qty,unit,opeixeiro_products(canonical_name))",
        )
        .eq("id", orderId)
        .maybeSingle();
      if (orderError || !order)
        throw orderError || new Error("Pedido não encontrado");
      if (order.status !== "delivered")
        return Response.json({ ignored: true, reason: "order_not_delivered" });
      const unit = order.opeixeiro_units as any;
      const items = order.opeixeiro_order_items || [];
      const itemLines =
        items
          .map(
            (item: any) =>
              `• ${text(item.opeixeiro_products?.canonical_name || "Item")}: ${text(item.requested_qty)} ${text(item.unit || "unidade")}`,
          )
          .join("\n") || "• Itens não disponíveis";
      const { data: contacts } = await db
        .from("opeixeiro_orders_group_contacts")
        .select("phone_e164,display_name,role_label")
        .eq("unit_id", order.destination_unit_id)
        .eq("is_group_member", true)
        .limit(20);
      let sent = 0;
      for (const contact of contacts || []) {
        const already = await db
          .from("opeixeiro_private_delivery_audit")
          .select("id")
          .eq("phone_e164", text(contact.phone_e164))
          .eq("delivery_kind", "delivery_item_confirmation_sent")
          .eq("message_reference", `order:${orderId}`)
          .limit(1);
        if (already.data?.length) continue;
        const question = `🤖 *Assistente O Peixeiro — conferência de entrega*\n\nOlá, ${text(contact.display_name || "responsável")}. O pedido para *${text(unit?.name || unit?.code || "sua unidade")}* foi marcado como entregue.\n\nConfira os itens:\n${itemLines}\n\nResponda uma opção:\n• *CHEGOU TODO*\n• *CHEGOU PARCIAL* — descreva o que faltou\n• *VEIO A MAIS* — descreva os itens e quantidades\n• *NÃO CHEGOU*\n\nA resposta atualiza a conferência e o próximo pedido.`;
        try {
          await sendOfficialMessage(
            `${text(contact.phone_e164)}@c.us`,
            question,
          );
          await db.from("opeixeiro_private_delivery_audit").insert({
            phone_e164: text(contact.phone_e164),
            recipient_name: text(contact.display_name),
            delivery_kind: "delivery_item_confirmation_sent",
            channel: "whatsapp_private",
            message_reference: `order:${orderId}`,
            notes:
              "Pergunta automática de entrega com lista integral de itens; senha não exibida.",
          });
          await db.from("opeixeiro_chatbot_conversation_audit").insert({
            phone_e164: text(contact.phone_e164),
            participant_name: text(contact.display_name),
            direction: "outgoing",
            intent: "delivery_item_confirmation",
            order_id: order.id,
            summary:
              "Solicitada conferência privada com a lista integral de itens entregues.",
            outcome:
              "Aguardando resposta: completo, parcial, falta ou item a mais.",
            metadata: { item_types: items.length },
          });
          sent++;
        } catch (sendError) {
          console.error("delivery confirmation private send failed", sendError);
        }
      }
      return Response.json({ sent: true, recipients: sent, order_id: orderId });
    }
    if (text(payload.type) === "evening_pending_delivery_followup") {
      const suppliedSecret =
        request.headers.get("x-logistics-webhook-secret") || "";
      if (!logisticsWebhookSecret || suppliedSecret !== logisticsWebhookSecret)
        return new Response("Unauthorized", { status: 401 });
      const today = new Date().toLocaleDateString("en-CA", {
        timeZone: "America/Sao_Paulo",
      });
      const groupOnly = Boolean(payload.group_only);
      const ordersOnly = Boolean(payload.orders_only);
      const { data: pendingOrders, error: pendingError } = await db
        .from("opeixeiro_orders")
        .select(
          "id,delivery_date,status,recipient_name,destination_unit_id,opeixeiro_units!opeixeiro_orders_destination_unit_id_fkey(name,code),opeixeiro_order_contributions(requester_name),opeixeiro_order_items(requested_qty,unit,opeixeiro_products(canonical_name))",
        )
        .lte("delivery_date", today)
        .not("status", "in", "(delivered,cancelled)")
        .order("delivery_date", { ascending: true })
        .limit(100);
      if (pendingError) throw pendingError;
      const orders = pendingOrders || [];
      if (!orders.length) {
        await sendLogisticsGroupMessage(
          "✅ *Fechamento 21h50*\n\nNão há pedidos pendentes de entrega no sistema neste momento.",
        );
        return Response.json({ sent: true, pending_orders: 0 });
      }
      const details = orders.map((order: any) => {
        const rows = order.opeixeiro_order_items || [];
        const totalVolumes = rows.reduce(
          (sum: number, row: any) => sum + (Number(row.requested_qty) || 0),
          0,
        );
        const types = rows.length;
        const requester = text(
          order.opeixeiro_order_contributions?.[0]?.requester_name ||
            order.recipient_name ||
            "Responsável não identificado",
        );
        return {
          order,
          requester,
          totalVolumes,
          types,
          unitName: text(
            order.opeixeiro_units?.name ||
              order.opeixeiro_units?.code ||
              "Destino não informado",
          ),
        };
      });
      if (!ordersOnly)
        await sendLogisticsGroupMessage(
          `📋 *Pedidos ainda sem entrega — fechamento 21h50*\n\n${details.map((entry: any) => `• *${entry.unitName}* — ${entry.requester}\n  ${entry.types} tipo(s) de item · ${entry.totalVolumes} volume(s) solicitado(s) · entrega ${entry.order.delivery_date}`).join("\n\n")}\n\nConfiram no aplicativo ou informem no grupo quando houver coleta e recebimento.`,
        );
      let privateSent = 0;
      for (const entry of details) {
        const currentItems = (entry.order.opeixeiro_order_items || [])
          .map(
            (item: any) =>
              `• ${text(item.opeixeiro_products?.canonical_name || "Item")}: ${text(item.requested_qty)} ${text(item.unit || "unidade")}`,
          )
          .join("\n");
        const question = `🤖 *Assistente O Peixeiro*\n\nOlá, ${entry.requester}. O pedido para *${entry.unitName}* segue sem confirmação de entrega.\n\nSão *${entry.types} tipo(s) de item* e *${entry.totalVolumes} volume(s)* solicitados. A lista abaixo é a versão atual do pedido, já considerando as correções registradas:\n\n${currentItems}\n\nVocê ainda precisa do pedido todo? Responda:\n• *PRECISO TODO*\n• *CHEGOU TODO*\n• *CHEGOU PARCIAL*\n• *NÃO PRECISO*\n\nSe ainda precisar, diga também o que deseja *adicionar* para a próxima entrega.`;
        // A confirmação individual não vai para O Peixeiro Pedidos. Assim o
        // grupo fica reservado ao fluxo operacional e não acumula cobranças
        // repetidas; às 21h50 ela segue diretamente ao responsável no privado.
        if (groupOnly) continue;
        const { data: contacts } = await db
          .from("opeixeiro_orders_group_contacts")
          .select("phone_e164,display_name")
          .eq("unit_id", entry.order.destination_unit_id)
          .eq("is_group_member", true)
          .limit(20);
        const recipient =
          (contacts || []).find(
            (contact: any) =>
              normalized(text(contact.display_name)) ===
              normalized(entry.requester),
          ) || (contacts || [])[0];
        if (recipient?.phone_e164) {
          try {
            await sendOfficialMessage(
              `${text(recipient.phone_e164)}@c.us`,
              question,
            );
            await db.from("opeixeiro_private_delivery_audit").insert({
              phone_e164: text(recipient.phone_e164),
              recipient_name: entry.requester,
              delivery_kind: "pending_order_confirmation_sent",
              channel: "whatsapp_private",
              notes: `Confirmação diária 21h50: ${entry.types} tipo(s), ${entry.totalVolumes} volume(s), destino ${entry.unitName}.`,
            });
            await db.from("opeixeiro_chatbot_conversation_audit").insert({
              phone_e164: text(recipient.phone_e164),
              participant_name: entry.requester,
              direction: "outgoing",
              intent: "evening_pending_delivery_followup",
              order_id: entry.order.id,
              summary: `Confirmação diária enviada com lista atual: ${entry.types} tipo(s) e ${entry.totalVolumes} volume(s).`,
              outcome: "Aguardando confirmação de necessidade ou recebimento.",
              metadata: {
                destination: entry.unitName,
                item_types: entry.types,
                volumes: entry.totalVolumes,
              },
            });
            privateSent++;
          } catch (privateError) {
            console.error(
              "private pending-order followup failed",
              privateError,
            );
          }
        }
      }
      return Response.json({
        sent: true,
        pending_orders: details.length,
        private_sent: privateSent,
      });
    }
    if (text(payload.type) === "send_operational_daily_report") {
      const suppliedSecret =
        request.headers.get("x-orders-bot-admin-secret") ||
        request.headers.get("x-logistics-webhook-secret") ||
        "";
      if (
        !suppliedSecret ||
        ![ordersBotAdminSecret, logisticsWebhookSecret]
          .filter(Boolean)
          .includes(suppliedSecret)
      )
        return new Response("Unauthorized", { status: 401 });
      const recipient = phone(payload.phone);
      if (!recipient) throw new Error("Telefone do destinatário não informado");
      const reportCutoff = new Date(Date.now() - 60 * 60_000).toISOString();
      const { data: recentReport } = await db
        .from("opeixeiro_private_delivery_audit")
        .select("id,sent_at")
        .eq("phone_e164", recipient)
        .eq("delivery_kind", "daily_panel_pdf_sent")
        .gte("sent_at", reportCutoff)
        .order("sent_at", { ascending: false })
        .limit(1);
      if (recentReport?.length)
        return Response.json({
          sent: false,
          duplicate_suppressed: true,
          cooldown_minutes: 60,
        });
      const today = new Date().toLocaleDateString("en-CA", {
        timeZone: "America/Sao_Paulo",
      });
      const [{ data: orders }, { data: photo }] = await Promise.all([
        db
          .from("opeixeiro_orders")
          .select(
            "delivery_date,status,opeixeiro_units!opeixeiro_orders_destination_unit_id_fkey(name),opeixeiro_order_items(requested_qty,unit,opeixeiro_products(canonical_name))",
          )
          .in("delivery_date", [
            today,
            new Date(Date.now() + 86400000).toLocaleDateString("en-CA", {
              timeZone: "America/Sao_Paulo",
            }),
          ])
          .order("delivery_date"),
        db
          .from("opeixeiro_daily_photo_summaries")
          .select("summary")
          .eq("summary_date", today)
          .maybeSingle(),
      ]);
      const lines = [
        "O PEIXEIRO LOGISTICA",
        "RELATORIO DIARIO ANTECIPADO",
        `Gerado: ${new Date().toLocaleString("pt-BR")}`,
        "",
        "FOTOS E IDENTIFICACOES",
        `Fotos capturadas: ${text(photo?.summary?.photo_count || 0)}`,
        `Eventos por foto: ${Array.isArray(photo?.summary?.photo_item_detections) ? photo.summary.photo_item_detections.length : 0}`,
        "",
        "PEDIDOS ATUAIS",
      ];
      for (const order of orders || [])
        lines.push(
          `${text(order.opeixeiro_units?.name || "Destino")} | ${text(order.delivery_date)} | ${text(order.status)}`,
          ...(order.opeixeiro_order_items || []).map(
            (item: any) =>
              `- ${text(item.opeixeiro_products?.canonical_name)}: ${text(item.requested_qty)} ${text(item.unit)}`,
          ),
        );
      const path = `reports/${today}/relatorio-diario-antecipado-${crypto.randomUUID()}.pdf`;
      const { error: uploadError } = await db.storage
        .from("opeixeiro-kitchen-availability")
        .upload(path, thermalPdf(lines), {
          contentType: "application/pdf",
          upsert: true,
        });
      if (uploadError) throw uploadError;
      const { data: signed, error: signedError } = await db.storage
        .from("opeixeiro-kitchen-availability")
        .createSignedUrl(path, 3600);
      if (signedError || !signed?.signedUrl)
        throw signedError || new Error("PDF sem URL");
      const credentials = [
        {
          url: fallbackGreenApiUrl,
          instance: fallbackGreenInstanceId,
          token: fallbackGreenApiToken,
        },
        { url: greenApiUrl, instance: greenInstanceId, token: greenApiToken },
      ].filter((item) => item.url && item.instance && item.token);
      for (const credential of credentials) {
        const response = await fetch(
          `${credential.url}/waInstance${credential.instance}/sendFileByUrl/${credential.token}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chatId: `${recipient}@c.us`,
              urlFile: signed.signedUrl,
              fileName: `relatorio-diario-antecipado-${today}.pdf`,
              caption: "Relatorio diario antecipado — O Peixeiro Logistica.",
            }),
          },
        );
        if (response.ok && text((await response.json())?.idMessage)) {
          await db.from("opeixeiro_private_delivery_audit").insert({
            phone_e164: recipient,
            recipient_name: "Administração",
            delivery_kind: "daily_panel_pdf_sent",
            channel: "whatsapp_private",
            message_reference: path,
            notes:
              "Relatório diário antecipado enviado; bloqueio anti-repetição ativo",
          });
          return Response.json({ sent: true, report: path });
        }
      }
      throw new Error("Conta empresarial indisponivel para envio do PDF");
    }
    if (text(payload.type) === "daily_group_profile_access_word") {
      const suppliedSecret =
        request.headers.get("x-logistics-webhook-secret") || "";
      if (!logisticsWebhookSecret || suppliedSecret !== logisticsWebhookSecret)
        return new Response("Unauthorized", { status: 401 });
      const accessWord = text(payload.access_word).toLocaleUpperCase("pt-BR");
      if (!accessWord) throw new Error("Palavra-chave diária não informada");
      await sendOfficialMessage(
        organizerPhone + "@c.us",
        "🔑 *Senhas dos perfis — hoje*\n\nPalavra-chave para os perfis vinculados: *" + accessWord + "*\n\nRenovada automaticamente às *04h40*. Envio centralizado neste chat para você repassar manualmente aos colaboradores autorizados; ela não será publicada nem enviada diretamente a eles.",
      );
      return Response.json({ sent: true, access_word_sent_to_organizer: true });
      await sendGroupMessage(
        `🔑 *Palavra-chave dos perfis — hoje*\n\nPara acessar seu perfil no sistema, use a palavra-chave: *${accessWord}*\n\nEla foi renovada automaticamente às *04h40* e vale para os perfis já vinculados aos contatos dos grupos. Pedidos enviados pelo chatbot e confirmações no WhatsApp continuam sem exigir essa palavra-chave.`,
      );
      return Response.json({ sent: true, access_word_published: true });
    }
    if (text(payload.type) === "list_saved_contact_profiles") {
      const suppliedSecret =
        request.headers.get("x-logistics-webhook-secret") || "";
      if (!logisticsWebhookSecret || suppliedSecret !== logisticsWebhookSecret)
        return new Response("Unauthorized", { status: 401 });
      const [
        { data: contacts, error: contactsError },
        { data: logistics, error: logisticsError },
        { data: profiles, error: profilesError },
        { data: orderKeywords, error: keywordsError },
      ] = await Promise.all([
        db
          .from("opeixeiro_orders_group_contacts")
          .select(
            "phone_e164,display_name,role_label,is_group_member,panel_user_id,opeixeiro_units!opeixeiro_orders_group_contacts_unit_id_fkey(code,name),opeixeiro_panel_users(display_name,default_unit_code,active)",
          )
          .order("display_name"),
        db
          .from("opeixeiro_logistics_stock_contacts")
          .select(
            "phone_e164,display_name,role_label,active,opeixeiro_units(code,name)",
          )
          .order("display_name"),
        db
          .from("opeixeiro_panel_users")
          .select("id,display_name,default_unit_code,active")
          .order("display_name"),
        db
          .from("opeixeiro_order_keywords")
          .select(
            "keyword_label,expires_at,opeixeiro_orders!inner(delivery_date,recipient_name,status,opeixeiro_units!opeixeiro_orders_destination_unit_id_fkey(code,name))",
          )
          .gte("expires_at", new Date().toISOString())
          .order("expires_at"),
      ]);
      if (contactsError || logisticsError || profilesError || keywordsError)
        throw contactsError || logisticsError || profilesError || keywordsError;
      return Response.json({
        contacts: contacts || [],
        logistics_contacts: logistics || [],
        profiles: profiles || [],
        active_order_keywords: orderKeywords || [],
      });
    }
    if (text(payload.type) === "sync_portion_catalog") {
      const suppliedSecret =
        request.headers.get("x-orders-bot-admin-secret") ||
        request.headers.get("x-logistics-webhook-secret") ||
        "";
      if (
        !suppliedSecret ||
        ![ordersBotAdminSecret, logisticsWebhookSecret]
          .filter(Boolean)
          .includes(suppliedSecret)
      )
        return new Response("Unauthorized", { status: 401 });
      const { error } = await db.from("opeixeiro_portion_catalog").upsert(
        [
          { canonical_name: "Porquinho", active: true },
          { canonical_name: "Cação", active: true },
        ],
        { onConflict: "canonical_name" },
      );
      if (error) throw error;
      return Response.json({
        synced: true,
        items: ["Porquinho", "Cação"],
        messages_sent: 0,
      });
    }
    if (text(payload.type) === "sync_identified_bar_contacts") {
      const suppliedSecret =
        request.headers.get("x-orders-bot-admin-secret") ||
        request.headers.get("x-logistics-webhook-secret") ||
        "";
      if (
        !suppliedSecret ||
        ![ordersBotAdminSecret, logisticsWebhookSecret]
          .filter(Boolean)
          .includes(suppliedSecret)
      )
        return new Response("Unauthorized", { status: 401 });
      const unitCodes = ["CAIXA - P4", "BAR_P1", "BAR_P2", "BAR_P4"];
      const { data: units, error: unitsError } = await db
        .from("opeixeiro_units")
        .select("id,code")
        .in("code", unitCodes);
      if (unitsError) throw unitsError;
      const unitId = new Map(
        (units || []).map((unit: any) => [text(unit.code), unit.id]),
      );
      if (unitCodes.some((code) => !unitId.get(code)))
        throw new Error(
          "Uma ou mais unidades dos contatos não foram encontradas",
        );
      const contacts = [
        {
          phone_e164: "5512996288048",
          display_name: "Contato final 8048",
          group_chat_id: ordersGroupId,
          is_group_member: false,
          unit_id: unitId.get("CAIXA - P4"),
          role_label: "Responsável do Caixa P4",
          updated_at: new Date().toISOString(),
        },
        {
          phone_e164: "5512981673413",
          display_name: "Weberson (Didi)",
          group_chat_id: ordersGroupId,
          is_group_member: false,
          unit_id: unitId.get("BAR_P2"),
          role_label: "Conferente do Bar P2",
          updated_at: new Date().toISOString(),
        },
        {
          phone_e164: "5512996508854",
          display_name: "Bento",
          group_chat_id: ordersGroupId,
          is_group_member: false,
          unit_id: unitId.get("BAR_P4"),
          role_label: "Conferente do Bar P4",
          updated_at: new Date().toISOString(),
        },
        {
          phone_e164: "5512996689649",
          display_name: "Qualidade do Peixeiro",
          group_chat_id: ordersGroupId,
          is_group_member: false,
          unit_id: unitId.get("BAR_P1"),
          role_label: "Conferente do Bar P1",
          updated_at: new Date().toISOString(),
        },
      ];
      const { error: contactsError } = await db
        .from("opeixeiro_orders_group_contacts")
        .upsert(contacts, { onConflict: "phone_e164" });
      if (contactsError) throw contactsError;
      const logisticsContacts = contacts.slice(1).map((contact) => ({
        phone_e164: contact.phone_e164,
        display_name: contact.display_name,
        unit_id: contact.unit_id,
        active: true,
        role_label: contact.role_label,
        updated_at: new Date().toISOString(),
      }));
      const { error: logisticsError } = await db
        .from("opeixeiro_logistics_stock_contacts")
        .upsert(logisticsContacts, { onConflict: "phone_e164" });
      if (logisticsError) throw logisticsError;
      return Response.json({
        synced: true,
        contacts: contacts.map((contact) => ({
          suffix: contact.phone_e164.slice(-4),
          name: contact.display_name,
          role: contact.role_label,
        })),
        messages_sent: 0,
      });
    }
    if (text(payload.type) === "announce_bar_availability_chatbot") {
      const suppliedSecret =
        request.headers.get("x-orders-bot-admin-secret") ||
        request.headers.get("x-logistics-webhook-secret") ||
        "";
      if (
        !suppliedSecret ||
        ![ordersBotAdminSecret, logisticsWebhookSecret]
          .filter(Boolean)
          .includes(suppliedSecret)
      )
        return new Response("Unauthorized", { status: 401 });
      await sendGroupMessage(
        "🍹 *Nova conferência de disponibilidade do Bar*\n\nO pessoal do Bar também pode informar aqui os itens que *TEM* e que *NÃO TEM*.\n\nExemplo: *BAR P4 — NÃO TEM Brahma, Skol e água com gás.*\n\nPara sucos e caipirinhas, informe todas as polpas juntas: *TEM polpas de limão, morango e abacaxi; NÃO TEM polpas de maracujá e acerola.* Se houver todas, pode responder *TEM TODAS AS POLPAS*.\n\nO chatbot mostrará os produtos identificados e pedirá confirmação antes de registrar. Depois da confirmação, será enviada uma lista organizada dos itens em falta para o caixa.\n\nAs informações do Bar ficam separadas da conferência de porções da Cozinha.",
      );
      return Response.json({ sent: true, group: ordersGroupId });
    }
    if (text(payload.type) === "bar_availability_morning_check") {
      const suppliedSecret =
        request.headers.get("x-logistics-webhook-secret") || "";
      if (!logisticsWebhookSecret || suppliedSecret !== logisticsWebhookSecret)
        return new Response("Unauthorized", { status: 401 });
      const today = new Date().toLocaleDateString("en-CA", {
        timeZone: "America/Sao_Paulo",
      });
      const { data: representatives, error: representativesError } = await db
        .from("opeixeiro_orders_group_contacts")
        .select(
          "id,display_name,phone_e164,unit_id,role_label,opeixeiro_units!opeixeiro_orders_group_contacts_unit_id_fkey(name,code)",
        )
        .eq("is_group_member", true)
        .not("unit_id", "is", null);
      if (representativesError) throw representativesError;
      let sent = 0;
      for (const representative of representatives || []) {
        const unit = representative.opeixeiro_units as {
          name?: string;
          code?: string;
        } | null;
        if (!/^BAR(?:_|\s*-\s*)P[1-7]$/i.test(text(unit?.code))) continue;
        const { data: existing } = await db
          .from("opeixeiro_bar_availability_sessions")
          .select("id")
          .eq("contact_id", representative.id)
          .eq("check_date", today)
          .in("status", ["awaiting", "awaiting_confirmation", "confirmed"])
          .limit(1)
          .maybeSingle();
        if (existing) continue;
        const { error: insertError } = await db
          .from("opeixeiro_bar_availability_sessions")
          .insert({
            unit_id: representative.unit_id,
            contact_id: representative.id,
            check_date: today,
            status: "awaiting",
          });
        if (insertError) throw insertError;
        await sendLogisticsGroupMessage(
          `☀️ *Bom dia, ${text(representative.display_name || `final ${text(representative.phone_e164).slice(-4)}`)}!*\n\n🍹 *Conferência do ${text(unit?.name || unit?.code)} — antes das 11h*\n\nInforme em uma mensagem o que *TEM* e o que *NÃO TEM* no seu Bar. Para sucos e caipirinhas, reúna os sabores: *TEM polpas de limão, morango e abacaxi; NÃO TEM polpas de maracujá e acerola.* Se tiver todas, escreva *TEM TODAS AS POLPAS*.\n\nSua conferência é individual: somente a resposta do seu telefone será vinculada a esta pergunta.`,
        );
        sent++;
      }
      return Response.json({ sent: true, individual_questions: sent });
    }
    if (text(payload.type) === "test_bar_representative_questions") {
      const suppliedSecret =
        request.headers.get("x-logistics-webhook-secret") || "";
      if (!logisticsWebhookSecret || suppliedSecret !== logisticsWebhookSecret)
        return new Response("Unauthorized", { status: 401 });
      if (
        !fallbackGreenApiUrl ||
        !fallbackGreenInstanceId ||
        !fallbackGreenApiToken
      )
        throw new Error("Instância de consulta não configurada");
      const groupData = async (groupId: string) => {
        const response = await fetch(
          `${fallbackGreenApiUrl}/waInstance${fallbackGreenInstanceId}/getGroupData/${fallbackGreenApiToken}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ groupId: `${groupId}@g.us` }),
          },
        );
        if (!response.ok)
          throw new Error(
            `Não foi possível consultar o grupo (${response.status})`,
          );
        return await response.json();
      };
      const [bar, orders, silentResult] = await Promise.all([
        groupData(barGroupId),
        groupData(ordersGroupId),
        db
          .from("opeixeiro_orders_bot_silent_phone_suffixes")
          .select("phone_suffix")
          .eq("active", true),
      ]);
      const participantPhone = (row: any) =>
        phone(
          row?.phoneNumber || (text(row?.id).endsWith("@c.us") ? row.id : ""),
        );
      const ordersPhones = new Set(
        (orders.participants || []).map(participantPhone).filter(Boolean),
      );
      const silentSuffixes = (silentResult.data || []).map((row: any) =>
        text(row.phone_suffix),
      );
      const eligiblePhones = [
        ...new Set(
          (bar.participants || []).map(participantPhone).filter(Boolean),
        ),
      ].filter(
        (value) =>
          ordersPhones.has(value) &&
          value !== "5511989346164" &&
          !silentSuffixes.some((suffix: string) => value.endsWith(suffix)),
      );
      const contactsResponse = await fetch(
        `${fallbackGreenApiUrl}/waInstance${fallbackGreenInstanceId}/getContacts/${fallbackGreenApiToken}`,
      );
      const greenContacts = contactsResponse.ok
        ? await contactsResponse.json()
        : [];
      const namesByPhone = new Map(
        (greenContacts || []).map((row: any) => [
          phone(row.id),
          text(row.contactName || row.name),
        ]),
      );
      let sent = 0;
      for (const value of eligiblePhones) {
        const { data: contact, error: contactError } = await db
          .from("opeixeiro_orders_group_contacts")
          .upsert(
            {
              phone_e164: value,
              display_name:
                text(namesByPhone.get(value)) ||
                `Contato final ${value.slice(-4)}`,
              group_chat_id: ordersGroupId,
              is_group_member: true,
              last_seen_at: new Date().toISOString(),
            },
            { onConflict: "phone_e164" },
          )
          .select(
            "id,display_name,unit_id,opeixeiro_units!opeixeiro_orders_group_contacts_unit_id_fkey(name,code)",
          )
          .maybeSingle();
        if (contactError || !contact)
          throw contactError || new Error("Contato não pôde ser preparado");
        const unit = contact.opeixeiro_units as {
          name?: string;
          code?: string;
        } | null;
        const hasBar = /^BAR(?:_|\s*-\s*)P[1-7]$/i.test(text(unit?.code));
        await db
          .from("opeixeiro_bar_unit_discovery_sessions")
          .update({ status: "expired", updated_at: new Date().toISOString() })
          .eq("phone_e164", value)
          .eq("status", "awaiting");
        const { error: discoveryError } = await db
          .from("opeixeiro_bar_unit_discovery_sessions")
          .insert({
            phone_e164: value,
            contact_id: contact.id,
            status: "awaiting",
            proposed_unit_code: hasBar ? text(unit?.code) : null,
          });
        if (discoveryError) throw discoveryError;
        if (hasBar) {
          await sendLogisticsGroupMessage(
            `🧪 *Teste do assistente do Bar*\n\n${text(contact.display_name)}, confirme por favor: você está responsável pelo *${text(unit?.name || unit?.code)}* neste momento?\n\nResponda *SIM* ou escreva *ESTOU NO P4*, por exemplo, para corrigir.`,
          );
        } else {
          await sendLogisticsGroupMessage(
            `🧪 *Teste do assistente do Bar*\n\n${text(contact.display_name || `Contato final ${value.slice(-4)}`)}, em qual Peixeiro você está trabalhando no Bar neste momento?\n\nResponda, por exemplo: *ESTOU NO P4*. A resposta ficará vinculada somente ao seu telefone.`,
          );
        }
        sent++;
      }
      return Response.json({
        sent: true,
        individual_questions: sent,
        eligible_suffixes: eligiblePhones.map((value) => value.slice(-4)),
      });
    }
    if (text(payload.type) === "diagnose_orders_group_delivery") {
      const suppliedSecret =
        request.headers.get("x-logistics-webhook-secret") || "";
      if (!logisticsWebhookSecret || suppliedSecret !== logisticsWebhookSecret)
        return new Response("Unauthorized", { status: 401 });
      const inspect = async (
        label: string,
        url: string,
        instance: string,
        token: string,
      ) => {
        if (!url || !instance || !token) return { label, configured: false };
        const stateResponse = await fetch(
          `${url}/waInstance${instance}/getStateInstance/${token}`,
        );
        const state = stateResponse.ok
          ? await stateResponse.json()
          : { http_status: stateResponse.status };
        const historyResponse = await fetch(
          `${url}/waInstance${instance}/getChatHistory/${token}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chatId: `${ordersGroupId}@g.us`,
              count: 20,
            }),
          },
        );
        const history = historyResponse.ok ? await historyResponse.json() : [];
        const tests = (Array.isArray(history) ? history : [])
          .filter((row: any) =>
            /Teste do assistente do Bar/i.test(
              text(row.textMessage || row.caption),
            ),
          )
          .map((row: any) => ({
            id: text(row.idMessage),
            type: text(row.type),
            timestamp: row.timestamp || null,
            preview: text(row.textMessage || row.caption).slice(0, 100),
          }));
        return {
          label,
          configured: true,
          state,
          history_http_status: historyResponse.status,
          test_messages_found: tests,
        };
      };
      return Response.json({
        instances: await Promise.all([
          inspect("primary", greenApiUrl, greenInstanceId, greenApiToken),
          inspect(
            "personal_fallback",
            fallbackGreenApiUrl,
            fallbackGreenInstanceId,
            fallbackGreenApiToken,
          ),
        ]),
      });
    }
    if (
      text(payload.type) === "send_kaike_order_correction_and_bar_forward_text"
    ) {
      const suppliedSecret =
        request.headers.get("x-logistics-webhook-secret") || "";
      if (!logisticsWebhookSecret || suppliedSecret !== logisticsWebhookSecret)
        return new Response("Unauthorized", { status: 401 });
      const { data: bar } = await db
        .from("opeixeiro_units")
        .select("id,name")
        .eq("code", "BAR_P6")
        .maybeSingle();
      if (!bar) throw new Error("Bar P6 não encontrado");
      const { data: order, error: orderError } = await db
        .from("opeixeiro_orders")
        .select(
          "id,delivery_date,opeixeiro_order_items(requested_qty,unit,opeixeiro_products(canonical_name)),opeixeiro_order_keywords(keyword_label,expires_at)",
        )
        .eq("destination_unit_id", bar.id)
        .gte(
          "delivery_date",
          new Date().toLocaleDateString("en-CA", {
            timeZone: "America/Sao_Paulo",
          }),
        )
        .in("status", ["submitted", "scheduled_next_day"])
        .order("delivery_date", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (orderError || !order)
        throw orderError || new Error("Pedido do Bar P6 não encontrado");
      const items = (order.opeixeiro_order_items || [])
        .map(
          (item: any) =>
            `• ${text(item.opeixeiro_products?.canonical_name)}: ${item.requested_qty} ${text(item.unit)}`,
        )
        .join("\n") + dessertPickupOriginNote([...expiringToday, ...expiredYesterday]);
      const keyword = Array.isArray(order.opeixeiro_order_keywords)
        ? order.opeixeiro_order_keywords[0]
        : order.opeixeiro_order_keywords;
      await sendGroupMessage(
        `✅ *Correção — pedido real do Kayke*\n\nKayke, sua resposta anterior foi interpretada incorretamente como simulação. Seu pedido do *BAR P6* está cadastrado no novo sistema para *${text(order.delivery_date)}*:\n\n${items}\n\nPalavra-chave deste ciclo: *${text(keyword?.keyword_label)}*\nEla permanece a mesma até o corte das *04h50*.\n\nSe você não puder receber, informe o final do telefone da pessoa responsável.`,
      );
      await sendGroupMessage(
        "📣 *MENSAGEM PRONTA PARA ENCAMINHAR AO GRUPO DO BAR*\n\nPessoal, vocês já podem fazer normalmente os pedidos para amanhã enviando aqui o que precisam e as quantidades. Estamos organizando e lançando os pedidos no novo sistema.\n\nQuem já entrou no grupo *O peixeiro pedidos* consegue acompanhar como o pedido ficou detalhado e receber a palavra-chave do seu ciclo.\n\nDepois de fazer o pedido, não esqueça de entrar no grupo *O peixeiro pedidos* para acompanhar as atualizações e pegar a palavra-chave correspondente.\n\nSe ainda não estiver no grupo, peça o link de acesso ao responsável.",
      );
      return Response.json({
        sent: true,
        order_id: order.id,
        messages_sent: 2,
      });
    }
    if (text(payload.type) === "bar_membership_audit") {
      const suppliedAuditSecret =
        request.headers.get("x-orders-bot-admin-secret") ||
        request.headers.get("x-logistics-webhook-secret") ||
        "";
      if (
        !suppliedAuditSecret ||
        ![ordersBotAdminSecret, logisticsWebhookSecret]
          .filter(Boolean)
          .includes(suppliedAuditSecret)
      )
        return new Response("Unauthorized", { status: 401 });
      if (
        !fallbackGreenApiUrl ||
        !fallbackGreenInstanceId ||
        !fallbackGreenApiToken
      )
        throw new Error("Instância de auditoria não configurada");
      const groupData = async (groupId: string) => {
        const response = await fetch(
          `${fallbackGreenApiUrl}/waInstance${fallbackGreenInstanceId}/getGroupData/${fallbackGreenApiToken}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ groupId: `${groupId}@g.us` }),
          },
        );
        if (!response.ok)
          throw new Error(
            `Não foi possível consultar o grupo (${response.status})`,
          );
        return await response.json();
      };
      const [bar, orders, logistics] = await Promise.all([
        groupData(barGroupId),
        groupData(ordersGroupId),
        groupData(logisticsGroupId),
      ]);
      const participantPhone = (row: any) =>
        phone(
          row?.phoneNumber || (text(row?.id).endsWith("@c.us") ? row.id : ""),
        );
      const barPhones = new Set(
        (bar.participants || []).map(participantPhone).filter(Boolean),
      );
      const orderPhones = new Set(
        (orders.participants || []).map(participantPhone).filter(Boolean),
      );
      const missing = [...barPhones].filter((value) => !orderPhones.has(value));
      const contactsResponse = await fetch(
        `${fallbackGreenApiUrl}/waInstance${fallbackGreenInstanceId}/getContacts/${fallbackGreenApiToken}`,
      );
      const contacts = contactsResponse.ok ? await contactsResponse.json() : [];
      const namesByPhone = new Map(
        (contacts || []).map((row: any) => [
          phone(row.id),
          text(row.contactName || row.name),
        ]),
      );
      const dairoCandidates = (contacts || [])
        .filter((row: any) =>
          normalized(text(row.contactName || row.name)).includes("dairo"),
        )
        .map((row: any) => phone(row.id))
        .filter(Boolean);
      const primaryStateResponse = await fetch(
        `${greenApiUrl}/waInstance${greenInstanceId}/getStateInstance/${greenApiToken}`,
      );
      const primaryState = primaryStateResponse.ok
        ? text((await primaryStateResponse.json())?.stateInstance)
        : "unavailable";
      return Response.json({
        bar_members: barPhones.size,
        orders_members: orderPhones.size,
        missing_count: missing.length,
        missing_suffixes: missing.map((value) => value.slice(-4)),
        missing_members: missing.map((value) => ({
          phone: value,
          suffix: value.slice(-4),
          name: text(namesByPhone.get(value)) || null,
        })),
        orders_invite_link: text(orders.groupInviteLink),
        logistics_invite_link: text(logistics.groupInviteLink),
        dairo_candidates: dairoCandidates.map((value) => ({
          phone: value,
          suffix: value.slice(-4),
          name: text(namesByPhone.get(value)),
        })),
        hidden_or_unavailable_bar_members: Math.max(
          0,
          Number(bar.size || 0) - barPhones.size,
        ),
        primary_non_personal_instance_state: primaryState,
        private_invites_sent: 0,
      });
    }
    if (text(payload.type) === "send_bar_group_invite_notice") {
      const suppliedAuditSecret =
        request.headers.get("x-orders-bot-admin-secret") ||
        request.headers.get("x-logistics-webhook-secret") ||
        "";
      if (
        !suppliedAuditSecret ||
        ![ordersBotAdminSecret, logisticsWebhookSecret]
          .filter(Boolean)
          .includes(suppliedAuditSecret)
      )
        return new Response("Unauthorized", { status: 401 });
      // O BAR Peixeiro voltou ao modo de observação. Este comando permanece
      // bloqueado para impedir novos envios acidentais pelo número pessoal.
      return Response.json(
        { sent: false, blocked: true, reason: "bar_group_silent_mode" },
        { status: 409 },
      );
      if (
        !fallbackGreenApiUrl ||
        !fallbackGreenInstanceId ||
        !fallbackGreenApiToken
      )
        throw new Error("Instância pessoal não configurada");
      const groupData = async (groupId: string) => {
        const response = await fetch(
          `${fallbackGreenApiUrl}/waInstance${fallbackGreenInstanceId}/getGroupData/${fallbackGreenApiToken}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ groupId: `${groupId}@g.us` }),
          },
        );
        if (!response.ok)
          throw new Error(
            `Não foi possível consultar o grupo (${response.status})`,
          );
        return await response.json();
      };
      const [bar, orders, logistics] = await Promise.all([
        groupData(barGroupId),
        groupData(ordersGroupId),
        groupData(logisticsGroupId),
      ]);
      const participantPhone = (row: any) =>
        phone(
          row?.phoneNumber || (text(row?.id).endsWith("@c.us") ? row.id : ""),
        );
      const orderPhones = new Set(
        (orders.participants || []).map(participantPhone).filter(Boolean),
      );
      const missing = [
        ...new Set(
          (bar.participants || []).map(participantPhone).filter(Boolean),
        ),
      ].filter((value) => !orderPhones.has(value));
      const contactsResponse = await fetch(
        `${fallbackGreenApiUrl}/waInstance${fallbackGreenInstanceId}/getContacts/${fallbackGreenApiToken}`,
      );
      const contacts = contactsResponse.ok ? await contactsResponse.json() : [];
      const namesByPhone = new Map(
        (contacts || []).map((row: any) => [
          phone(row.id),
          text(row.contactName || row.name),
        ]),
      );
      const people = missing
        .map(
          (value) =>
            `${text(namesByPhone.get(value)) || "Contato"} — final ${value.slice(-4)}`,
        )
        .join("\n");
      const message = `📲 *Acesso aos grupos O Peixeiro*\n\nOs contatos abaixo ainda não aparecem no grupo *O peixeiro pedidos*:\n\n${people}\n\nPara acompanhar e lançar os pedidos feitos até as 05h para a próxima entrega, seguem os acessos:\n\n🧾 *O peixeiro pedidos*\n${text(orders.groupInviteLink)}\n\n🚚 *O peixeiro logística*\n${text(logistics.groupInviteLink)}\n\nEntre no grupo correspondente à sua função. Se você já entrou depois desta verificação, desconsidere seu nome.\n\nDaigo já permanece como administrador do grupo de pedidos.`;
      const sendResponse = await fetch(
        `${fallbackGreenApiUrl}/waInstance${fallbackGreenInstanceId}/sendMessage/${fallbackGreenApiToken}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: `${barGroupId}@g.us`, message }),
        },
      );
      if (!sendResponse.ok)
        throw new Error(
          `Não foi possível enviar o aviso (${sendResponse.status})`,
        );
      return Response.json({
        sent: true,
        group: barGroupId,
        missing_count: missing.length,
        suffixes: missing.map((value) => value.slice(-4)),
      });
    }
    if (text(payload.type) === "emergency_receipt_question") {
      if (
        !ordersBotAdminSecret ||
        request.headers.get("x-orders-bot-admin-secret") !==
          ordersBotAdminSecret
      )
        return new Response("Unauthorized", { status: 401 });
      const requestedOrderId = text(payload.order_id);
      const { data: linkedOrder } = requestedOrderId
        ? await db
            .from("opeixeiro_orders")
            .select(
              "id,opeixeiro_units!opeixeiro_orders_destination_unit_id_fkey(id,name,code)",
            )
            .eq("id", requestedOrderId)
            .maybeSingle()
        : { data: null };
      const { data: unit, error: unitError } = linkedOrder?.opeixeiro_units
        ? { data: linkedOrder.opeixeiro_units as any, error: null }
        : await db
            .from("opeixeiro_units")
            .select("id,name,code")
            .eq("code", "BAR_P2")
            .maybeSingle();
      if (unitError || !unit)
        throw new Error(unitError?.message || "BAR - P2 não encontrado");
      await db
        .from("opeixeiro_orders_group_emergency_receipts")
        .update({
          status: "not_received",
          updated_at: new Date().toISOString(),
        })
        .eq("unit_id", unit.id)
        .in("status", [
          "awaiting_answer",
          "awaiting_method",
          "awaiting_items",
          "awaiting_missing_confirmation",
        ]);
      const { error: emergencyError } = await db
        .from("opeixeiro_orders_group_emergency_receipts")
        .insert({
          unit_id: unit.id,
          order_id: linkedOrder?.id || null,
          recipient_name: "Danilo",
        });
      if (emergencyError) throw emergencyError;
      await sendGroupMessage(
        "🚨 *Confirmação de recebimento — emergência*\n\nDanilo, o Claudio confirmou no sistema que o pedido do *BAR - P2* foi separado para despacho. Ele chegou?\n\nResponda *CHEGOU*, *CHEGOU EM PARTES* ou *NÃO CHEGOU*. Se chegou, informe em seguida o que veio e as quantidades recebidas.",
      );
      return Response.json({ sent: true, emergency_receipt_question: true });
    }
    if (text(payload.type) === "emergency_receipt_method_question") {
      if (
        !ordersBotAdminSecret ||
        request.headers.get("x-orders-bot-admin-secret") !==
          ordersBotAdminSecret
      )
        return new Response("Unauthorized", { status: 401 });
      const { data: unit } = await db
        .from("opeixeiro_units")
        .select("id")
        .eq("code", "BAR_P2")
        .maybeSingle();
      if (!unit) throw new Error("BAR - P2 não encontrado");
      await db
        .from("opeixeiro_orders_group_emergency_receipts")
        .update({
          status: "awaiting_method",
          updated_at: new Date().toISOString(),
        })
        .eq("unit_id", unit.id)
        .eq("status", "awaiting_answer");
      await sendGroupMessage(
        "Danilo, para facilitar a conferência, o que é mais fácil informar: *o que veio* ou *o que faltou*?\n\nSe veio tudo exceto algum item, responda por exemplo: *FALTOU 1 caixa de Smirnoff Ice*. Assim eu identifico os itens e peço sua confirmação final.",
      );
      return Response.json({
        sent: true,
        emergency_receipt_method_question: true,
      });
    }
    if (text(payload.type) === "carryover_review_question") {
      if (
        !ordersBotAdminSecret ||
        request.headers.get("x-orders-bot-admin-secret") !==
          ordersBotAdminSecret
      )
        return new Response("Unauthorized", { status: 401 });
      const orderId = text(payload.order_id);
      const { data: order, error: orderError } = await db
        .from("opeixeiro_orders")
        .select(
          "delivery_date,opeixeiro_order_items(requested_qty,mandatory_carryover_qty,unit,opeixeiro_products(canonical_name))",
        )
        .eq("id", orderId)
        .maybeSingle();
      if (orderError || !order)
        throw new Error(
          orderError?.message || "Pedido de reposição não encontrado",
        );
      const items = (order.opeixeiro_order_items || []).filter(
        (item: any) => Number(item.mandatory_carryover_qty) > 0,
      );
      await db
        .from("opeixeiro_orders_group_carryover_reviews")
        .update({
          status: "remove_requested",
          updated_at: new Date().toISOString(),
        })
        .eq("order_id", orderId)
        .eq("status", "awaiting");
      await db
        .from("opeixeiro_orders_group_carryover_reviews")
        .insert({ order_id: orderId, recipient_name: "Danilo" });
      await sendGroupMessage(
        `Danilo, as faltas foram agendadas automaticamente para *${text(order.delivery_date)}*:\n${items.map((item: any) => `• ${text(item.opeixeiro_products?.canonical_name)}: ${item.mandatory_carryover_qty} ${text(item.unit)}`).join("\n")}\n\nVocê ainda precisa de todos esses itens? Se não precisar de algum, responda *REMOVER* e informe item e quantidade. Exemplo: *REMOVER 1 caixa de Skol Lata 350ml*.`,
      );
      return Response.json({ sent: true, carryover_review_question: true });
    }
    if (text(payload.type) === "kitchen_availability_question") {
      const checkDate =
        text(payload.check_date) ||
        new Date().toLocaleDateString("en-CA", {
          timeZone: "America/Sao_Paulo",
        });
      const { data: sessions, error: sessionError } = await db
        .from("opeixeiro_kitchen_availability_check_sessions")
        .select(
          "opeixeiro_orders_group_contacts(display_name),opeixeiro_units(name,code)",
        )
        .eq("check_date", checkDate)
        .eq("status", "awaiting");
      if (sessionError) throw sessionError;
      const byKitchen = new Map<string, { label: string; cooks: string[] }>();
      for (const row of sessions || []) {
        const cook = text(row.opeixeiro_orders_group_contacts?.display_name);
        const unitCode = text(row.opeixeiro_units?.code);
        const unitName = text(row.opeixeiro_units?.name);
        if (!cook || !unitCode) continue;
        const current = byKitchen.get(unitCode) || {
          label: unitName || unitCode,
          cooks: [],
        };
        if (!current.cooks.includes(cook)) current.cooks.push(cook);
        byKitchen.set(unitCode, current);
      }
      if (!byKitchen.size)
        return Response.json({ sent: false, reason: "no_kitchen_contacts" });
      let sent = 0;
      for (const kitchen of byKitchen.values()) {
        await sendGroupMessage(
          `☀️ *Bom dia!*\n\n🍽️ *Conferência de disponibilidade — ${kitchen.label} — antes das 11h*\n\n${kitchen.cooks.join(", ")}, por favor informem o que *TEM* e o que *NÃO TEM* somente nesta cozinha.\n\nPorções: Batata Palito, Polenta, Frango a Passarinho, Isca de Frango, Manjuba, Porquinho, Posta de Espada, Costelinha de Salmão, Lula Dorê, Cabeça de Lula, Pescadinha Porção, Cação, Isca de Linguado, Isca de Tilápia, Isca de Atum, Isca de Tainha, Ova de Tainha e Ova de Peixe.\n\nTambém confirmem: Guioza de legumes, bovino e suíno; Harumaki de queijo e de legumes; Takoyaki; sachê de molho agridoce; e Nikuman de legumes, bovino e suíno.\n\nExemplo: *TEM todos os guiozas e nikumans; NÃO TEM takoyaki e ova de peixe.* Eu mostrarei o resumo para sua confirmação.`,
        );
        sent += 1;
      }
      return Response.json({
        sent: true,
        kitchen_availability_question: true,
        kitchens_sent: sent,
      });
    }
    if (
      text(payload.type) === "confectionery_mousse_expiry_alert" ||
      text(payload.type) === "confectionery_sweets_expiry_alert"
    ) {
      const forceResend = payload.force === true;
      const dateKey = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      const date = new Date(`${dateKey}T12:00:00-03:00`);
      const yesterdayKey = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(date.getTime() - 86400000));
      const todayLabel = new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo",
        dateStyle: "short",
      }).format(new Date());
      const yesterdayLabel = new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo",
        dateStyle: "short",
      }).format(new Date(date.getTime() - 86400000));
      const { data: alreadySent } = await db
        .from("opeixeiro_mousse_expiry_alerts")
        .select("alert_date")
        .eq("alert_date", dateKey)
        .maybeSingle();
      if (alreadySent && !forceResend) {
        return Response.json({ sent: false, duplicate: true });
      }
      const { data: prints, error: printError } = await db
        .from("validity_print_history")
        .select("product,copies,expiry_at");
      if (printError) throw printError;
      const summarize = (day: string) => {
        const grouped = new Map<string, { name: string; labels: number }>();
        for (const row of prints || []) {
          if (!/(mousse|carolina)/i.test(text(row.product))) continue;
          const expiryDay = new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Sao_Paulo",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(row.expiry_at));
          if (expiryDay !== day) continue;
          const key = normalized(text(row.product));
          const previous = grouped.get(key);
          grouped.set(key, {
            name: previous?.name || text(row.product),
            labels: (previous?.labels || 0) + (Number(row.copies) || 0),
          });
        }
        return [...grouped.values()].sort((a, b) =>
          a.name.localeCompare(b.name, "pt-BR"),
        );
      };
      const expiringToday = summarize(dateKey);
      const expiredYesterday = summarize(yesterdayKey);
      if (!expiringToday.length && !expiredYesterday.length)
        return Response.json({ sent: false, no_mousse_alerts: true });
      if (automatedOutboundPaused)
        return Response.json({ sent: false, paused: true, reason: "automated_outbound_paused" });
      const { error: sessionError } = await db.from("opeixeiro_mousse_expiry_alert_sessions").upsert({
        alert_date: dateKey,
        options: [...expiringToday, ...expiredYesterday],
        removed_options: [],
        status: "awaiting_review",
        updated_at: new Date().toISOString(),
      });
      if (sessionError) throw sessionError;
      const listedProducts = [...expiringToday, ...expiredYesterday]
        .map((item, index) => `${index + 1}. ${item.name}: ${item.labels} etiqueta(s)`)
        .join("\n");
      const message = `🍮 *Validade — Confeitaria P2*\n\nResponsável da Confeitaria P2, favor conferir fisicamente as mousses e os doces Carolina.\n\nData atual: *${todayLabel}*\n${expiringToday.length ? `Vencem hoje: *${expiringToday.reduce((sum, item) => sum + item.labels, 0)} etiqueta(s)*.\n` : ""}${expiredYesterday.length ? `Venceram ontem (${yesterdayLabel}): *${expiredYesterday.reduce((sum, item) => sum + item.labels, 0)} etiqueta(s)*.\n` : ""}\n*Itens identificados:*\n${listedProducts}\n\nPara retirar o que ja foi vendido, responda com os numeros separados por virgula. Exemplo: *2, 4*.\nDepois responda *LIBERAR SOBREMESAS* ou *NAO LIBERAR SOBREMESAS*.\n\nReferencia: etiquetas impressas, nao estoque fisico.`;
      await sendGroupMessage(message);
      const { error: alertError } = await db.from("opeixeiro_mousse_expiry_alerts").upsert({
        alert_date: dateKey,
        payload: {
          expiring_today: expiringToday,
          expired_yesterday: expiredYesterday,
        },
      });
      if (alertError) throw alertError;
      return Response.json({
        sent: true,
        confectionery_mousse_expiry_alert: true,
      });
    }
    if (text(payload.type) === "confectionery_dispatch_authorization") {
      const printedDay = text(payload.printed_day);
      const labelsTotal = Number(payload.labels_total) || 0;
      if (!printedDay || labelsTotal <= 100)
        return Response.json({ ignored: true });
      const { data: prints, error: printError } = await db
        .from("validity_print_history")
        .select("product,copies")
        .ilike("product", "%")
        .gte("printed_at", `${printedDay}T00:00:00-03:00`)
        .lt("printed_at", `${printedDay}T23:59:59.999-03:00`);
      if (printError) throw printError;
      const desserts = new Map<string, { name: string; labels: number }>();
      for (const row of prints || []) {
        const productName = text(row.product);
        if (/abacaxi\s+cozido|calda\s+de\s+maracuj[aá]/i.test(productName)) continue;
        if (!/(mousse|pudim|torta|doce|carolina|brownie)/i.test(productName)) continue;
        const key = normalized(text(row.product));
        const previous = desserts.get(key);
        desserts.set(key, {
          name: previous?.name || text(row.product),
          labels: (previous?.labels || 0) + (Number(row.copies) || 0),
        });
      }
      const products = [...desserts.values()].sort((a, b) =>
        a.name.localeCompare(b.name, "pt-BR"),
      );
      if (!products.length)
        return Response.json({ ignored: true, no_desserts: true });
      const dayLabel = new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo",
      }).format(new Date(`${printedDay}T12:00:00-03:00`));
      await sendGroupMessage(
        `🍮 *Autorização para despacho de mousses e pudins*\n\nForam impressas *${labelsTotal} etiquetas* de mousses e pudins em ${dayLabel}.\n\n*Produtos registrados:*\n${products.map((item) => `• ${item.name} — ${item.labels} etiqueta(s)`).join("\n")}\n\nQualquer responsável do *P2* vinculado à conferência, despacho, Bar ou Caixa pode liberar. Para registrar, responda *LIBERAR SOBREMESAS* ou *NÃO LIBERAR SOBREMESAS*.\n\nAntes da liberação, confirmem a quantidade física, o tempo de preparo e que os produtos já ficaram na geladeira pelo tempo necessário e estão *gelados para transporte*. Etiquetas impressas são apenas referência, não contagem física.`,
      );
      return Response.json({
        sent: true,
        confectionery_dispatch_authorization: true,
      });
    }
    if (text(payload.type) === "recipient_receipt_reminder_for_order") {
      if (isPeakMovementHours())
        return Response.json({ sent: false, suppressed: true, reason: "peak_movement_hours" });
      const orderId = text(payload.order_id);
      if (!orderId) return Response.json({ ignored: true });
      const { data: order, error: orderError } = await db
        .from("opeixeiro_orders")
        .select(
          "id,destination_unit_id,recipient_name,opeixeiro_units!opeixeiro_orders_destination_unit_id_fkey(name,code)",
        )
        .eq("id", orderId)
        .maybeSingle();
      if (orderError || !order)
        throw new Error(orderError?.message || "Order not found");
      const { data: contact, error: contactError } = await db
        .from("opeixeiro_orders_group_contacts")
        .select("phone_e164,display_name")
        .eq("unit_id", order.destination_unit_id)
        .eq("is_group_member", true)
        .order("last_seen_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (contactError) throw contactError;
      const receiver = text(
        contact?.display_name ||
          order.recipient_name ||
          "responsável da unidade",
      );
      const { error: confirmationError } = await db
        .from("opeixeiro_missing_qr_recipient_confirmations")
        .upsert(
          {
            order_id: order.id,
            unit_id: order.destination_unit_id,
            recipient_phone: contact?.phone_e164 || null,
            recipient_name: receiver,
            status: "awaiting",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "order_id" },
        );
      if (confirmationError) throw confirmationError;
      const unit = order.opeixeiro_units as any;
      await sendGroupMessage(
        `Olá, ${receiver}! Foi detectado que o pedido para *${text(unit?.name || unit?.code)}* foi informado como separado para despacho, mas não há registro de coleta nem de conferência final pelo QR.\n\nVocê pode informar se chegou? Responda *CHEGOU*, *CHEGOU EM PARTES* ou *NÃO CHEGOU*.\n\nO agendamento da próxima entrega permanece bloqueado até sua confirmação.`,
      );
      return Response.json({ sent: true, recipient_reminder_for_order: true });
    }
    if (text(payload.type) === "manual_receipt_followup") {
      if (isPeakMovementHours())
        return Response.json({ sent: false, suppressed: true, reason: "peak_movement_hours" });
      const orderId = text(payload.order_id);
      if (!orderId) return Response.json({ ignored: true });
      const { data: order, error: orderError } = await db
        .from("opeixeiro_orders")
        .select(
          "recipient_name,opeixeiro_units!opeixeiro_orders_destination_unit_id_fkey(name,code),opeixeiro_order_contributions(requester_name)",
        )
        .eq("id", orderId)
        .maybeSingle();
      if (orderError || !order)
        throw new Error(orderError?.message || "Order not found");
      const requester = text(
        order.opeixeiro_order_contributions?.[0]?.requester_name ||
          order.recipient_name ||
          "responsável que fez o pedido",
      );
      const unit = order.opeixeiro_units as any;
      await sendGroupMessage(
        `Olá, ${requester}! O pedido para *${text(unit?.name || unit?.code)}* está aguardando sua confirmação de recebimento.\n\nSe ele foi recebido fora do aplicativo, informe se *chegou*, *chegou em partes* ou *não chegou*. Se chegou em partes, depois diga o que veio ou o que faltou.\n\nEsta pergunta é somente para quem fez/recebeu o pedido; a resposta será usada na conferência manual.`,
      );
      return Response.json({ sent: true, manual_receipt_followup: true });
    }
    if (text(payload.type) === "late_unconfirmed_item_review") {
      const today = new Date().toLocaleDateString("en-CA", {
        timeZone: "America/Sao_Paulo",
      });
      const { data: events } = await db
        .from("opeixeiro_operational_events")
        .select("id,metadata")
        .eq("event_type", "offline_queued")
        .gte("occurred_at", `${today}T00:00:00-03:00`)
        .order("occurred_at", { ascending: false })
        .limit(300);
      const pending = (events || []).filter((event: any) => {
        const kind = text(event.metadata?.record_kind);
        const status = text(event.metadata?.status || event.metadata?.request_status);
        return [
          "ambiguous_private_receipt_confirmation",
          "standalone_emergency_item_request",
          "emergency_item_candidate_route_link",
          "p3_emergency_consolidated_with_photo_route",
          "p2_inbound_photo_requires_internal_check",
          "closed_cooler_photo_pending_internal_check",
        ].includes(kind) &&
          !/recebido|entregue sem conferência|conclu[ií]do/i.test(status);
      });
      if (!pending.length) return Response.json({ ignored: true, no_pending_reviews: true });
      await sendGroupMessage(
        "📌 Revisão das 17h: responsáveis com itens possivelmente faltantes ou sem conferência, por favor confirmem pelo chatbot se o pedido chegou tudo, chegou parcial ou não chegou. Caso tenha faltado algo, informe apenas o item e a quantidade; a pendência será organizada para o próximo dia.",
      );
      await sendLogisticsGroupMessage(
        "📌 Revisão das 17h iniciada. As conferências pendentes estão sendo retomadas com os responsáveis, sem detalhamento de ocorrências no grupo.",
      );
      await db.from("opeixeiro_operational_events").insert({
        event_type: "offline_queued",
        actor_name: "Assistente O Peixeiro",
        occurred_at: new Date().toISOString(),
        metadata: {
          record_kind: "daily_1700_unconfirmed_items_review",
          pending_count: pending.length,
          status: "revisão de possíveis faltas enviada aos responsáveis pelo grupo",
        },
      });
      return Response.json({ sent: true, late_unconfirmed_item_review: pending.length });
    }
    if (text(payload.type) === "recipient_receipt_reminder") {
      if (isPeakMovementHours())
        return Response.json({ sent: false, suppressed: true, reason: "peak_movement_hours" });
      const confirmationId = text(payload.confirmation_id);
      if (!confirmationId) return Response.json({ ignored: true });
      const { data: confirmation, error: confirmationError } = await db
        .from("opeixeiro_missing_qr_recipient_confirmations")
        .select(
          "id,status,recipient_name,opeixeiro_orders!inner(opeixeiro_units!opeixeiro_orders_destination_unit_id_fkey(name,code),opeixeiro_dispatch_releases(status),opeixeiro_delivery_receipts(status))",
        )
        .eq("id", confirmationId)
        .maybeSingle();
      if (confirmationError) throw confirmationError;
      const order = confirmation?.opeixeiro_orders as any;
      const hasQrProgress =
        (order?.opeixeiro_dispatch_releases || []).some(
          (row: any) => row.status === "scanned",
        ) ||
        (order?.opeixeiro_delivery_receipts || []).some(
          (row: any) => row.status === "scanned",
        );
      if (!confirmation || confirmation.status !== "awaiting" || hasQrProgress)
        return Response.json({ ignored: true, qr_progress: hasQrProgress });
      const unit = order?.opeixeiro_units || {};
      const receiver = text(
        confirmation.recipient_name || "responsável da unidade",
      );
      await sendGroupMessage(
        `Olá, ${receiver}! Foi detectado que o pedido para *${text(unit.name || unit.code)}* foi informado pelo conferente do estoque como separado para despacho, mas não há registro de coleta nem de conferência final pelo QR.\n\nVocê pode informar se chegou? Responda *CHEGOU*, *CHEGOU EM PARTES* ou *NÃO CHEGOU*.\n\nO agendamento da próxima entrega permanece bloqueado até sua confirmação.`,
      );
      await db
        .from("opeixeiro_missing_qr_recipient_confirmations")
        .update({
          last_reminded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", confirmation.id);
      return Response.json({ sent: true, recipient_reminder: true });
    }
    if (text(payload.typeWebhook) !== "incomingMessageReceived")
      return Response.json({ ignored: true });
    const sender = payload.senderData || {};
    const rawChatId = text(
      sender.chatId || sender.chat_id || payload.chatId,
    );
    const chatId = rawChatId.replace(/@g\.us$/, "");
    let message = text(
      payload.messageData?.textMessageData?.textMessage ||
        payload.messageData?.extendedTextMessageData?.text ||
        payload.messageData?.fileMessageData?.caption ||
        payload.messageData?.imageMessageData?.caption ||
        "",
    );
    // Em contas WhatsApp recentes, `sender` pode vir como um identificador
    // `@lid`, que não é o telefone cadastrado. Em conversa privada, `chatId`
    // continua contendo o número real e deve ser a fonte canônica.
    const privateChatById = /@c\.us$/i.test(rawChatId);
    const senderPhone = privateChatById
      ? phone(rawChatId)
      : phone(sender.sender || sender.senderId || payload.sender);
    if (!senderPhone) return Response.json({ ignored: true });
    const isPrivateChat = privateChatById || phone(chatId) === senderPhone;
    const sourceMessageId = text(
      payload.idMessage ||
        payload.messageData?.idMessage ||
        payload.messageData?.stanzaId ||
        payload.id ||
        `${chatId}|${senderPhone}|${message}|${text(payload.timestamp || payload.messageData?.timestamp)}`,
    );
    const senderName = text(
      sender.senderName || sender.chatName || sender.senderContactName,
    );
    if (
      !isPrivateChat &&
      [ordersGroupId, receivedOrdersGroupId, barGroupId].includes(chatId) &&
      message
    ) {
      await forwardGroupMessageForTrace(
        chatId,
        senderName,
        senderPhone,
        message,
        sourceMessageId,
      );
    }
    const integrationCommand = normalized(message);
    if (senderPhone === organizerPhone && isPrivateChat &&
      /^(?:ATIVAR|DESATIVAR|STATUS)\s+INTEGRA(?:C|Ç)A(?:O|Ã)\s+VALIDADE$/.test(integrationCommand)) {
      const action = integrationCommand.startsWith("ATIVAR") ? "enable" :
        integrationCommand.startsWith("DESATIVAR") ? "disable" : "status";
      if (action === "status") {
        const { data: status, error: statusError } = await db.rpc("opeixeiro_validity_integration_status");
        if (statusError) throw statusError;
        await sendLogisticsGroupMessage(`🔗 *Integração Validade PT260*\nStatus: *${status?.enabled ? "ATIVA" : "INATIVA"}*\nExpira: *${text(status?.expires_at || "não definido")}*`);
        return Response.json({ sent: true, validity_integration: status });
      }
      const { data: status, error: toggleError } = await db.rpc("opeixeiro_set_validity_integration", {
        p_enabled: action === "enable",
        p_contract_closed: false,
        p_actor: `chatbot:${senderPhone}`,
      });
      if (toggleError) throw toggleError;
      await sendLogisticsGroupMessage(`🔗 *Integração Validade PT260*\nStatus: *${status?.enabled ? "ATIVA" : "INATIVA"}*\n${status?.enabled ? "Janela contratual renovada por 7 dias." : "Emissão de lotes integrados bloqueada."}`);
      return Response.json({ sent: true, validity_integration: status });
    }
    // Áudios privados também podem conter pedidos. Quando a mídia estiver
    // disponível no webhook, transcrevemos antes de interpretar a lista; se
    // não estiver, nada é publicado nem lançado como pedido incompleto.
    const privateAudio = payload.messageData?.audioMessageData || {};
    if (
      isPrivateChat &&
      text(payload.messageData?.typeMessage) === "audioMessage"
    ) {
      const transcript = text(privateAudio.downloadUrl)
        ? await transcribeOperationalAudio(
            text(privateAudio.downloadUrl),
            text(privateAudio.fileName || "audio.ogg"),
            text(privateAudio.mimeType || "audio/ogg"),
          )
        : "";
      if (transcript) {
        message = `[Áudio transcrito] ${transcript}`;
      } else {
        await db.from("opeixeiro_operational_events").insert({
          event_type: "offline_queued",
          actor_name: text(sender.senderName || sender.chatName || `colaborador final ${senderPhone.slice(-4)}`),
          occurred_at: new Date().toISOString(),
          metadata: {
            record_kind: "private_audio_without_transcript",
            source_phone_suffix: senderPhone.slice(-4),
            status: "aguardando reenvio em texto ou áudio disponível; nenhum pedido lançado",
          },
        });
      }
    }
    // Cadastro comercial iniciado pela área Beta do Validade PT260. O fluxo
    // permanece privado e coleta somente vínculo, estabelecimento, quantidade
    // de equipamentos e equipe autorizada.
    if (isPrivateChat) {
      const { data: betaRequest, error: betaRequestError } = await db
        .from("validity_beta_access_requests")
        .select("*")
        .eq("phone_e164", senderPhone)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (betaRequestError) {
        console.error("Unable to load Validade PT260 beta request", {
          phoneLast4: senderPhone.slice(-4),
          code: betaRequestError.code,
          message: betaRequestError.message,
        });
        return Response.json(
          { error: "beta_request_lookup_failed", detail: betaRequestError.code || "database_error" },
          { status: 500 },
        );
      }
      if (betaRequest) {
        temporaryDriverAccessOutboundPhones.add(senderPhone);
        const normalizedBetaMessage = normalized(message);
        const confirmation = normalizedBetaMessage.match(/^(?:CONFIRMAR\s*)?(\d{3})[- ]?(\d{3})$/);
        if (confirmation) {
          const code = confirmation[1] + confirmation[2];
          const validUntil = new Date(text(betaRequest.verification_expires_at)).getTime();
          if (validUntil > Date.now() &&
              await sha256Hex(code) === text(betaRequest.verification_code_hash)) {
            await db.from("validity_beta_access_requests").update({
              plan_status: "awaiting_plan_choice",
              updated_at: new Date().toISOString(),
            }).eq("id", betaRequest.id);
            await sendOfficialMessage(
              senderPhone + "@c.us",
              "✅ *Telefone confirmado.*\n\nAgora escolha *uma opção* e responda somente com o número:\n\n*1* — trabalho em empresa com plano anual\n*2* — trabalho em empresa com plano mensal\n*3* — represento um estabelecimento e quero contratar\n*4* — quero falar com A.Fabio.C.Silva\n\nExemplo: responda apenas *1*.",
            );
            return Response.json({ stored: true, validity_beta_phone_verified: true });
          }
          await sendOfficialMessage(
            senderPhone + "@c.us",
            "Código inválido ou expirado. Abra novamente a área Beta do app para receber um novo código.",
          );
          return Response.json({ stored: true, validity_beta_code_rejected: true });
        }
        if (text(betaRequest.plan_status) === "awaiting_plan_choice" && /^[1-4]$/.test(message.trim())) {
          const choices: Record<string, { relationship: string; plan: string }> = {
            "1": { relationship: "Funcionário de estabelecimento assinante", plan: "Plano anual completo" },
            "2": { relationship: "Funcionário de estabelecimento assinante", plan: "Plano mensal" },
            "3": { relationship: "Representante de estabelecimento interessado", plan: "Plano básico mensal — R$ 119" },
            "4": { relationship: "Solicitou atendimento de A.Fabio.C.Silva", plan: "Atendimento comercial" },
          };
          const choice = choices[message.trim()];
          await db.from("validity_beta_access_requests").update({
            relationship: choice.relationship,
            requested_plan: choice.plan,
            plan_status: "awaiting_establishment",
            updated_at: new Date().toISOString(),
          }).eq("id", betaRequest.id);
          await sendOfficialMessage(
            senderPhone + "@c.us",
            "Certo. Envie agora o *nome do estabelecimento e a cidade* em uma única mensagem.\n\nExemplo: *Padaria Central — Mauá/SP*.",
          );
          return Response.json({ stored: true, validity_beta_plan_selected: true });
        }
        const status = text(betaRequest.plan_status);
        const currentMetadata = betaRequest.metadata && typeof betaRequest.metadata === "object"
          ? betaRequest.metadata
          : {};
        if (status === "awaiting_establishment" && message.trim()) {
          await db.from("validity_beta_access_requests").update({
            metadata: { ...currentMetadata, establishment: safeConversationRecord(message) },
            establishment_name: safeConversationRecord(message).slice(0, 160),
            plan_status: "awaiting_machine_count",
            updated_at: new Date().toISOString(),
          }).eq("id", betaRequest.id);
          await sendOfficialMessage(
            senderPhone + "@c.us",
            "Quantas maquininhas Bluetooth serão usadas? O Plano Básico inclui *1 maquininha*.",
          );
          return Response.json({ stored: true, validity_beta_establishment_saved: true });
        }
        if (status === "awaiting_machine_count" && /^\d{1,3}$/.test(message.trim())) {
          const machines = Number(message.trim());
          await db.from("validity_beta_access_requests").update({
            metadata: { ...currentMetadata, machine_count: machines },
            machine_count: machines,
            plan_status: "awaiting_team",
            updated_at: new Date().toISOString(),
          }).eq("id", betaRequest.id);
          await sendOfficialMessage(
            senderPhone + "@c.us",
            "Informe os nomes dos colaboradores e o final dos telefones que usarão o app. O Plano Básico permite até *5 pessoas/dispositivos*.",
          );
          return Response.json({ stored: true, validity_beta_machine_count_saved: true });
        }
        if (status === "awaiting_team" && message.trim()) {
          await db.from("validity_beta_access_requests").update({
            metadata: { ...currentMetadata, team: safeConversationRecord(message) },
            plan_status: "completed_for_review",
            updated_at: new Date().toISOString(),
          }).eq("id", betaRequest.id);
          await sendOfficialMessage(
            senderPhone + "@c.us",
            "✅ Cadastro concluído para análise. Nenhuma cobrança foi criada. A.Fabio.C.Silva confirmará o plano e o contrato.",
          );
          if (senderPhone !== organizerPhone) {
            await sendOfficialMessage(
              organizerPhone + "@c.us",
              "✅ Cadastro Validade PT260 concluído.\nNome: " + text(betaRequest.user_name) +
                "\nTelefone: +" + senderPhone +
                "\nAparelho: " + text(betaRequest.device_model || betaRequest.metadata?.device_model || "não informado") +
                "\nPlano: " + text(betaRequest.requested_plan) +
                "\nRevise os dados no painel antes de liberar acesso.",
            );
          }
          return Response.json({ stored: true, validity_beta_onboarding_completed: true });
        }
      }
    }
    // Janela operacional do Tiago: pela manhã ele informa liberações e
    // separações. Nessa faixa, a mensagem não cria pedido novo; é registrada
    // como despacho e o acompanhamento é publicado somente na Logística.
    const saoPauloHour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Sao_Paulo",
        hour: "2-digit",
        hourCycle: "h23",
      }).format(new Date()),
    );
    if (
      senderPhone === "5512981276290" &&
      !isPrivateChat &&
      [observerGroupId, ordersGroupId, barGroupId].includes(chatId) &&
      saoPauloHour >= 6 && saoPauloHour < 10 &&
      message.trim().length > 0
    ) {
      const route = message.match(
        /\b(?:do|de)\s*(p\s*\d)\s*(?:para|pro)\s*(?:o\s*)?(p\s*\d)\b/i,
      );
      const destination = (message.match(/\bpedido\s*(p\s*\d)\b/i)?.[1] || route?.[2] || "destino a confirmar")
        .replace(/\s/g, "")
        .toUpperCase();
      const origin = (route?.[1] || "origem a confirmar")
        .replace(/\s/g, "")
        .toUpperCase();
      const normalizedDispatch = normalized(message);
      const separatedMarkers = (normalizedDispatch.match(/\b(?:ok|okk)\b/g) || []).length;
      // "x", "xx" e "xxx" representam pendências de separação. Nunca são
      // volumes, quantidades de itens ou baixa de estoque.
      const freeCheckMarkers = (normalizedDispatch.match(/[×x]{1,}/g) || []).length;
      await db.from("opeixeiro_operational_events").insert({
        event_type: "offline_queued",
        actor_name: "Tiago · final 6290",
        occurred_at: new Date().toISOString(),
        client_occurred_at: new Date().toISOString(),
        metadata: {
          record_kind: "morning_tiago_dispatch_report",
          dispatch_window: "06:00-10:00 America/Sao_Paulo",
          source_group: chatId,
          origin,
          destination,
          separated_markers: separatedMarkers,
          free_check_markers: freeCheckMarkers,
          marker_interpretation: "marcação livre; aguarda esclarecimento do conferente e não representa quantidade, falta ou entrega",
          source_text: safeConversationRecord(message),
        },
      });
      await sendOfficialMessage(
        `${logisticsGroupId}@g.us`,
        `📦 *Pedido separado — ${destination}*\n${separatedMarkers} confirmação(ões) · ${freeCheckMarkers} pendência(s)\nConferente: *Tiago · final 6290*\n\nAguardando coleta do motorista.`,
      );
      return Response.json({
        stored: true,
        tiago_morning_dispatch: true,
        destination,
      });
    }
    const nightChecklistIntent =
      /\b(?:checklist|rotina)\b.*\b(?:noturn[oa]|fechamento)\b|\b(?:noturn[oa]|fechamento)\b.*\b(?:checklist|rotina)\b/i.test(message);
    const nightChecklistPdfIntent =
      nightChecklistIntent && /\b(?:pdf|gerar|emitir|imprimir)\b/i.test(message);
    if (nightChecklistIntent) {
      if (nightChecklistPdfIntent) {
        const pdf = await generateNightClosingChecklistPdf(chatId);
        await db.from("opeixeiro_operational_events").insert({
          event_type: "offline_queued",
          actor_name: "Assistente O Peixeiro",
          occurred_at: new Date().toISOString(),
          metadata: {
            record_kind: "night_closing_checklist_pdf",
            storage_path: pdf.path,
            sent: pdf.sent,
            procedure_owner: "Kotian",
            audience: ["cumins", "salão", "garçons", "caixa"],
          },
        });
        await sendOfficialMessage(
          chatId,
          pdf.sent
            ? "✅ PDF do checklist noturno enviado para impressão."
            : "✅ PDF do checklist noturno foi gerado e guardado no sistema. O envio está pausado temporariamente por segurança.",
        );
      } else {
        await sendOfficialMessage(
          chatId,
          "🧹 *Checklist noturno cadastrado*\n\nCumins e salão devem seguir a rotina a partir das 22h: cadeiras, janelas, lixos, iluminação, geladeiras e saída após o fechamento do caixa.\n\nPara gerar o arquivo térmico, envie: *GERAR PDF CHECKLIST NOTURNO*.",
        );
      }
      return Response.json({ stored: true, night_closing_checklist: true });
    }
    const lowMovementIntent =
      /\b(?:baixo|pouco)\s+movimento\b.*\b(?:caixa|salao|salão)\b|\b(?:caixa|salao|salão)\b.*\b(?:baixo|pouco)\s+movimento\b/i.test(message);
    const lowMovementPdfIntent =
      lowMovementIntent && /\b(?:pdf|gerar|emitir|imprimir)\b/i.test(message);
    if (lowMovementIntent) {
      if (lowMovementPdfIntent) {
        const pdf = await generateSalonLowMovementChecklistPdf(chatId);
        await db.from("opeixeiro_operational_events").insert({
          event_type: "offline_queued",
          actor_name: "Assistente O Peixeiro",
          occurred_at: new Date().toISOString(),
          metadata: {
            record_kind: "salon_low_movement_checklist_pdf",
            storage_path: pdf.path,
            sent: pdf.sent,
            trigger: "baixo movimento de caixa/salão informado",
            tasks: 18,
          },
        });
        await sendOfficialMessage(
          chatId,
          pdf.sent
            ? "✅ PDF do checklist do salão enviado para impressão."
            : "✅ PDF do checklist do salão foi gerado e guardado. O envio está pausado temporariamente por segurança.",
        );
      } else {
        await sendOfficialMessage(
          chatId,
          "🧽 *Baixo movimento identificado*\n\nO checklist diário do salão está disponível para os cumins, sem atrapalhar atendimento ou segurança. Para gerar o arquivo térmico, envie: *GERAR PDF CHECKLIST BAIXO MOVIMENTO*.",
        );
      }
      return Response.json({ stored: true, salon_low_movement_checklist: true });
    }
    // Regra de moderação autorizada: a Lia não deve direcionar cobranças ao
    // Fabio no grupo de Pedidos. A ação é silenciosa e fica auditada; não
    // varre mensagens antigas nem remove alguém sem essa combinação exata.
    if (
      chatId === ordersGroupId &&
      senderPhone === "5512981315522" &&
      /\bf[aá]bio\b/i.test(message)
    ) {
      const idMessage = text(payload.idMessage || payload.id_message);
      const [removed, deleted] = await Promise.all([
        removeParticipantFromOrdersGroup(senderPhone),
        tryDeleteIncomingOrdersMessage(idMessage),
      ]);
      await sendGroupMessage(
        "🤝 *Lembrete de convivência — O Peixeiro*\n\nEste grupo existe para colaboração, organização dos pedidos e logística, ajudando Kotian e Simone a terem mais tempo com a família.\n\nQuestões pessoais ou atritos internos devem ser tratados em outro canal, com respeito e diretamente com os responsáveis. Obrigado por mantermos o grupo objetivo e colaborativo.",
      );
      await db.from("opeixeiro_operational_events").insert({
        event_type: "offline_queued",
        actor_name: "Assistente O Peixeiro",
        occurred_at: new Date().toISOString(),
        metadata: {
          record_kind: "orders_group_moderation",
          action: "lia_message_to_fabio",
          sender_phone_suffix: senderPhone.slice(-4),
          group: "O Peixeiro Pedidos",
          removal_requested: removed,
          deletion_requested: deleted,
          collaboration_reminder_sent: true,
          message_id: idMessage || null,
        },
      });
      return Response.json({
        moderated: true,
        removal_requested: removed,
        deletion_requested: deleted,
      });
    }
    if (isPrivateChat && message)
      await db
        .from("opeixeiro_chatbot_conversation_audit")
        .insert({
          phone_e164: senderPhone,
          participant_name: text(
            sender.senderName || sender.chatName || payload.senderName,
          ),
          channel: "whatsapp_private",
          direction: "incoming",
          intent: "private_collaborator_message",
          summary: safeConversationRecord(message),
          outcome: "Mensagem recebida para interpretação do assistente.",
        })
        .then(() => undefined)
        .catch(() => undefined);
    // Quando o responsável explica a própria marcação de conferência (por
    // exemplo x/xx/xxx) ou responde sobre um item específico de uma rota,
    // guarde a declaração literal. Ela só poderá complementar o relatório;
    // nunca vira quantidade, baixa ou entrega automática.
    if (
      isPrivateChat &&
      /(?:[x×]{1,3}\s*(?:=|significa|quer dizer)|(?:sardinha|item)\s*[:=-]?\s*(?:sim|n[aã]o|n[aã]o sei|voltei|voltou))/i.test(message)
    ) {
      await db.from("opeixeiro_operational_events").insert({
        event_type: "offline_queued",
        actor_name: text(sender.senderName || sender.chatName || `colaborador final ${senderPhone.slice(-4)}`),
        occurred_at: new Date().toISOString(),
        metadata: {
          record_kind: "private_dispatch_marker_or_item_clarification",
          responder_phone_suffix: senderPhone.slice(-4),
          response_text: safeConversationRecord(message),
          interpretation_rule: "declaração literal; requer revisão antes de alterar quantidades, status ou entrega",
        },
      });
      await sendOfficialMessage(
        `${senderPhone}@c.us`,
        "Obrigado pelo esclarecimento. Registrei sua resposta como informação de conferência; ela não altera quantidade ou entrega sem validação operacional.",
      );
      return Response.json({ stored: true, private_dispatch_clarification: true });
    }
    // Quem responde a uma tentativa de cobertura emergencial recebe uma
    // acolhida objetiva: a resposta é registrada, o grupo ganha somente o
    // status operacional e ninguém é pressionado a assumir uma compra/rota.
    // Vale para qualquer colaborador autorizado, não depende do nome de um
    // motorista específico.
    if (
      isPrivateChat &&
      /\b(?:compr(?:ei|ou|ar)|consegui|n[aã]o\s+consegui|n[aã]o\s+sei|pendente|falt(?:a|ou)|motorista)\b/i.test(message)
    ) {
      const { data: activeEmergency } = await db
        .from("opeixeiro_emergency_availability_sessions")
        .select("id,destination_code,requested_items")
        .eq("status", "awaiting_offers")
        .gt("expires_at", new Date().toISOString())
        .order("opened_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (activeEmergency) {
        const answer = normalized(message);
        const purchaseStatus = /n[aã]o\s+consegui|n[aã]o\s+sei|pendente|falt(?:a|ou)/.test(answer)
          ? "sem confirmação de compra"
          : /compr(?:ei|ou)|consegui/.test(answer)
            ? "compra/solução relatada"
            : "acompanhamento informado";
        const participant = text(
          sender.senderName || sender.chatName || `colaborador final ${senderPhone.slice(-4)}`,
        );
        await db.from("opeixeiro_operational_events").insert({
          event_type: "offline_queued",
          actor_name: participant,
          occurred_at: new Date().toISOString(),
          metadata: {
            record_kind: "private_emergency_followup_response",
            destination: activeEmergency.destination_code,
            status: purchaseStatus,
            responder_phone_suffix: senderPhone.slice(-4),
            response_text: safeConversationRecord(message),
            driver_identity: "aguardando confirmação",
            scheduled_next_day: /falt(?:a|ou)|pendente/.test(answer),
          },
        });
        const reportedMissing = /falt(?:a|ou)|pendente/.test(answer);
        if (reportedMissing) {
          const reportedItems = await catalogItemsFromMessage(message);
          await db.from("opeixeiro_operational_events").insert({
            event_type: "offline_queued",
            actor_name: "Assistente O Peixeiro",
            occurred_at: new Date().toISOString(),
            metadata: {
              record_kind: "private_missing_item_scheduled_next_day",
              destination: activeEmergency.destination_code,
              items: reportedItems,
              source_phone_suffix: senderPhone.slice(-4),
              source_text: safeConversationRecord(message),
              status: "pendência agendada para a próxima entrega; quantidade a confirmar",
            },
          });
        }
        await sendOfficialMessage(
          `${senderPhone}@c.us`,
          reportedMissing
            ? `Obrigado por avisar, ${participant}. O item faltante ficou agendado como pendência para a próxima entrega de ${text(activeEmergency.destination_code)}. Continue usando o aplicativo e o HTML de pedidos para lançar faltas ou novos itens; a quantidade será confirmada antes da saída.`
            : `Obrigado por avisar, ${participant}. Estamos acompanhando esta emergência e fazendo o possível para resolver o que falta para ${text(activeEmergency.destination_code)}. Sua resposta foi registrada; se souber, informe apenas se a compra foi feita e qual item ainda ficou pendente.`,
        );
        await sendLogisticsGroupMessage(
          `📌 Acompanhamento de emergência — ${text(activeEmergency.destination_code)}: recebemos retorno do colaborador final ${senderPhone.slice(-4)}. Situação: ${purchaseStatus}. A compra e a entrega continuam aguardando confirmação operacional; não houve baixa automática.`,
        );
        return Response.json({
          stored: true,
          private_emergency_followup: true,
          status: purchaseStatus,
        });
      }
    }
    // Escolha de rota pelo próprio motorista. Aceita a resposta no grupo ou
    // no privado, vincula-a ao telefone conhecido e confirma nos dois canais.
    // Isso é uma atribuição de coleta, não uma baixa: coleta/entrega seguem
    // exigindo QR ou confirmação operacional específica.
    const knownDriverName = trackedDriverPhones[senderPhone] || "";
    const assignmentMatch = message.match(
      /\b(?:eu\s*,?\s*)?(?:levo|vou\s+(?:levar|coletar)|fico\s+com)\s+(?:o\s+)?(?:pedido\s+(?:da\s+)?)?(?:(cozinha|bar|caixa)\s*)?(P[1-7])\b/i,
    );
    if (knownDriverName && assignmentMatch) {
      const area = normalized(text(assignmentMatch[1] || ""));
      const destinationMarker = text(assignmentMatch[2]).toUpperCase();
      const today = new Date().toLocaleDateString("en-CA", {
        timeZone: "America/Sao_Paulo",
      });
      const { data: dayOrders } = await db
        .from("opeixeiro_orders")
        .select(
          "id,status,opeixeiro_units!opeixeiro_orders_destination_unit_id_fkey(code,name),opeixeiro_order_items(requested_qty)",
        )
        .eq("delivery_date", today)
        .not("status", "in", "(delivered,cancelled)");
      const matches = (dayOrders || []).filter((order: any) => {
        const code = normalized(text(order.opeixeiro_units?.code));
        if (!code.includes(normalized(destinationMarker))) return false;
        return !area || code.includes(area);
      });
      if (matches.length !== 1) {
        if (!driverPrivateDeliveryOptOutPhones.has(senderPhone))
          await sendOfficialMessage(
            `${senderPhone}@c.us`,
            `🤖 *Assistente O Peixeiro*\n\n${knownDriverName}, encontrei mais de um pedido (ou nenhum) para *${destinationMarker}*. O aplicativo atual trabalha com uma consolidação por vez: escolha e registre apenas um pedido antes de iniciar o próximo. Responda com o setor completo, por exemplo: *EU, ${knownDriverName.toUpperCase()}, LEVO COZINHA P5* ou *EU, ${knownDriverName.toUpperCase()}, LEVO BAR P5*. Emergências devem ficar vinculadas ao pedido correspondente e não podem ser misturadas sem confirmação.`,
          );
        return Response.json({
          sent: true,
          driver_assignment_ambiguous: true,
          matches: matches.length,
        });
      }
      const order: any = matches[0];
      const itemTypes = (order.opeixeiro_order_items || []).length;
      const volumes = (order.opeixeiro_order_items || []).reduce(
        (total: number, item: any) =>
          total + (Number(item.requested_qty) || 0),
        0,
      );
      const destination = text(
        order.opeixeiro_units?.name || order.opeixeiro_units?.code,
      );
      await db.from("opeixeiro_operational_events").insert({
        order_id: order.id,
        event_type: "offline_queued",
        actor_name: knownDriverName,
        occurred_at: new Date().toISOString(),
        client_occurred_at: new Date().toISOString(),
        metadata: {
          record_kind: "driver_collection_assignment",
          driver_phone: senderPhone,
          driver_name: knownDriverName,
          destination,
          item_types: itemTypes,
          volumes,
          response_channel: isPrivateChat
            ? "whatsapp_private"
            : "whatsapp_logistics_group",
          source_text: safeConversationRecord(message),
        },
      });
      const confirmation = `🚚 *Coleta atribuída*\n\nMotorista: *${knownDriverName}*\nPedido: *${destination}*\nResumo: *${itemTypes} tipo(s) de item · ${volumes} volume(s)*\n\nA atribuição foi confirmada pelo próprio motorista. A coleta e a entrega devem ser registradas pelo aplicativo/QR.`;
      await sendGroupMessage(confirmation);
      if (!driverPrivateDeliveryOptOutPhones.has(senderPhone))
        await sendOfficialMessage(
          `${senderPhone}@c.us`,
          `✅ *Rota confirmada*\n\nVocê ficou responsável pelo pedido para *${destination}*: *${itemTypes} tipo(s) · ${volumes} volume(s)*.\n\nNo ponto de coleta, use o aplicativo para registrar a saída; no destino, finalize o recebimento.`,
        );
      await db.from("opeixeiro_chatbot_conversation_audit").insert({
        phone_e164: senderPhone,
        participant_name: knownDriverName,
        channel: "whatsapp_private",
        direction: "outgoing",
        intent: "driver_collection_assignment",
        summary: `Atribuição confirmada: ${destination}, ${itemTypes} tipos e ${volumes} volumes.`,
        outcome: "Motorista vinculado ao pedido; aguardando coleta pelo aplicativo/QR.",
        metadata: { order_id: order.id, item_types: itemTypes, volumes },
      });
      return Response.json({
        sent: true,
        driver_assignment_confirmed: true,
        order_id: order.id,
      });
    }
    // Motoristas identificados recebem atendimento privado e contextual. O
    // cadastro é interno: não publica telefone, rota nem PDF em nenhum grupo.
    // A baixa de uma rota continua exigindo identificação inequívoca do pedido
    // ou o fluxo do aplicativo/QR; uma frase solta nunca muda o estoque.
    const driverContact = isPrivateChat
      ? trackedDriverPhones[senderPhone] || ""
      : "";
    if (
      driverContact &&
      !driverPrivateDeliveryOptOutPhones.has(senderPhone) &&
      /\b(?:rota|rotas|colet(?:a|ei|ar)|em\s+(?:rota|transito|trânsito)|entreg(?:a|uei|ar)|pedido|volume|volumes|itens?|pdf|romaneio|ajuda)\b/i.test(
        message,
      )
    ) {
      const { data: routes } = await db
        .from("opeixeiro_observer_manual_routes")
        .select("order_id,origin_code,destination_code,status,started_at")
        .eq("driver_phone", senderPhone)
        .in("status", ["in_transit", "collected", "ready_for_delivery"])
        .order("started_at", { ascending: false })
        .limit(8);
      const orderIds = (routes || [])
        .map((route: any) => text(route.order_id))
        .filter(Boolean);
      const { data: routeOrders } = orderIds.length
        ? await db
            .from("opeixeiro_orders")
            .select("id,opeixeiro_order_items(requested_qty)")
            .in("id", orderIds)
        : { data: [] as any[] };
      const volumeByOrder = new Map(
        (routeOrders || []).map((order: any) => [
          text(order.id),
          (order.opeixeiro_order_items || []).reduce(
            (total: number, item: any) =>
              total + (Number(item.requested_qty) || 0),
            0,
          ),
        ]),
      );
      const routeLines = (routes || []).map((route: any, index: number) => {
        const volume = volumeByOrder.get(text(route.order_id));
        return `• Rota ${index + 1}: ${text(route.origin_code || "origem")} → ${text(route.destination_code || "destino")} · ${text(route.status || "em rota")}${volume !== undefined ? ` · ${volume} volume(s)` : ""}`;
      });
      const driverName = text(driverContact || "motorista");
      await sendOfficialMessage(
        `${senderPhone}@c.us`,
        `🤖 *Assistente O Peixeiro — motorista*\n\nOlá, ${driverName}. Identifiquei seu perfil de motorista. ${routeLines.length ? `Rotas em acompanhamento:\n${routeLines.join("\n")}` : "Não localizei rota ativa vinculada ao seu telefone neste momento."}\n\nPara registrar uma movimentação com segurança, envie pelo aplicativo ou informe: *pedido, origem, destino, situação e foto quando houver*. Para emitir o futuro romaneio/PDF, a rota precisará estar vinculada ao pedido e à documentação fiscal correspondente.`,
      );
      await db.from("opeixeiro_chatbot_conversation_audit").insert({
        phone_e164: senderPhone,
        participant_name: driverName,
        channel: "whatsapp_private",
        direction: "outgoing",
        intent: "driver_route_assistance",
        summary: `Assistência privada de motorista; ${routeLines.length} rota(s) ativa(s) encontrada(s).`,
        outcome:
          "Orientado a usar aplicativo/identificação completa antes de atualizar a rota.",
        metadata: { active_routes: routeLines.length },
      });
      return Response.json({
        sent: true,
        private_driver_assistance: true,
        active_routes: routeLines.length,
      });
    }
    // Quando a pergunta diária chega sem contexto, o assistente esclarece o
    // pedido exato da unidade, em vez de repetir uma mensagem genérica.
    if (
      isPrivateChat &&
      /\b(?:de\s+que\s+dia|qual\s+dia|sobre\s+(?:o\s+)?que|do\s+que\s+se\s+trata|que\s+pedido)\b/i.test(
        normalized(message),
      )
    ) {
      await db.from("opeixeiro_chatbot_conversation_audit").insert({
        phone_e164: senderPhone,
        direction: "incoming",
        intent: "order_context_question",
        summary:
          "Colaborador pediu esclarecimento sobre a data ou o assunto da confirmação.",
        outcome: "Consulta de pedido pendente iniciada.",
      });
      const { data: contact } = await db
        .from("opeixeiro_orders_group_contacts")
        .select("unit_id,display_name")
        .eq("phone_e164", senderPhone)
        .maybeSingle();
      const today = new Date().toLocaleDateString("en-CA", {
        timeZone: "America/Sao_Paulo",
      });
      const { data: orders } = contact?.unit_id
        ? await db
            .from("opeixeiro_orders")
            .select(
              "delivery_date,status,opeixeiro_units!opeixeiro_orders_destination_unit_id_fkey(name,code),opeixeiro_order_items(requested_qty,opeixeiro_products(canonical_name))",
            )
            .eq("destination_unit_id", contact.unit_id)
            .lte("delivery_date", today)
            .not("status", "in", "(delivered,cancelled)")
            .order("delivery_date", { ascending: false })
            .limit(1)
        : { data: [] as any[] };
      const order: any = orders?.[0];
      if (!order) {
        await sendOfficialMessage(
          `${senderPhone}@c.us`,
          "🤖 *Assistente O Peixeiro*\n\nNão localizei um pedido pendente de confirmação para sua unidade neste momento. Se quiser, informe o setor e o item para eu direcionar a pergunta correta.",
        );
        await db.from("opeixeiro_chatbot_conversation_audit").insert({
          phone_e164: senderPhone,
          participant_name: text(contact?.display_name),
          direction: "outgoing",
          intent: "order_context_answer",
          summary:
            "Esclarecimento solicitado, mas não havia pedido pendente para a unidade.",
          outcome: "Solicitado setor/item para nova consulta.",
        });
        return Response.json({ sent: true, pending_order_found: false });
      }
      const rows = order.opeixeiro_order_items || [];
      const volumes = rows.reduce(
        (sum: number, row: any) => sum + (Number(row.requested_qty) || 0),
        0,
      );
      const unit: any = order.opeixeiro_units || {};
      const currentItems = rows
        .map(
          (row: any) =>
            `• ${text(row.opeixeiro_products?.canonical_name || "Item")}: ${text(row.requested_qty)} ${text(row.unit || "unidade")}`,
        )
        .join("\n");
      await sendOfficialMessage(
        `${senderPhone}@c.us`,
        `🤖 *Esclarecimento do assistente*\n\nA pergunta é sobre o pedido para *${text(unit.name || unit.code || "sua unidade")}*, com entrega prevista para *${text(order.delivery_date)}*.\n\nEle tem *${rows.length} tipo(s) de item* e *${volumes} volume(s)* solicitados. Esta é a lista atual, já com as correções registradas:\n\n${currentItems}\n\nEstamos confirmando se você ainda precisa do pedido todo, se chegou completo, parcial, se faltou algo ou se veio a mais.`,
      );
      await db.from("opeixeiro_chatbot_conversation_audit").insert({
        phone_e164: senderPhone,
        participant_name: text(contact?.display_name),
        direction: "outgoing",
        intent: "order_context_answer",
        summary: `Enviado contexto do pedido: ${text(unit.name || unit.code)} em ${text(order.delivery_date)}, com lista atual corrigida.`,
        outcome:
          "Aguardando confirmação de necessidade, recebimento ou divergência.",
        metadata: {
          item_types: rows.length,
          volumes,
          destination: text(unit.name || unit.code),
        },
      });
      return Response.json({ sent: true, pending_order_found: true });
    }
    // Simone revisa preços do catálogo um item por vez. A resposta é apenas
    // uma preferência para futura integração: nunca altera o SAIPOS sozinha.
    if (
      isPrivateChat &&
      senderPhone === "5512981726846" &&
      /\b(?:vinho|pre[cç]o|r\$|pr[oó]xim[oa]|pular|avan[cç]ar|ignorar|\d+[,.]?\d*)\b/i.test(message)
    ) {
      const { data: catalogRows, error: catalogError } = await db
        .from("opeixeiro_wine_catalog_review")
        .select("id,sequence_no,display_name,description")
        .eq("active", true)
        .order("sequence_no", { ascending: true });
      if (catalogError) throw catalogError;
      const catalog = catalogRows || [];
      const { data: previousRows } = await db
        .from("opeixeiro_wine_price_preferences")
        .select("wine_catalog_id")
        .eq("responder_phone", senderPhone);
      const reviewed = new Set((previousRows || []).map((row: any) => text(row.wine_catalog_id)));
      const current = catalog.find((row: any) => !reviewed.has(text(row.id)));
      if (!current) {
        await sendOfficialMessage(
          `${senderPhone}@c.us`,
          "🍷 *Catálogo concluído por enquanto.* As escolhas ficaram registradas para revisão antes de qualquer integração com o SAIPOS. Quando houver outro vinho ou item, envie *PRÓXIMO* para continuar.",
        );
        return Response.json({ sent: true, wine_catalog_complete: true });
      }
      const normalizedWineReply = normalized(message);
      const skipped = /\b(?:pr[oó]xim[oa]|pular|avan[cç]ar|ignorar)\b/i.test(normalizedWineReply);
      const priceMatch = normalizedWineReply.match(/(?:r\$\s*)?(\d+(?:[,.]\d{1,2})?)/i);
      const price = priceMatch ? Number(priceMatch[1].replace(",", ".")) : null;
      if (skipped || (price !== null && Number.isFinite(price) && price > 0)) {
        const { error: preferenceError } = await db
          .from("opeixeiro_wine_price_preferences")
          .insert({
            wine_catalog_id: current.id,
            responder_phone: senderPhone,
            responder_name: "Simone",
            requested_price: skipped ? null : price,
            price_kind: skipped ? "skip" : "sale_price",
            response_text: safeConversationRecord(message),
          });
        if (preferenceError) throw preferenceError;
        const next = catalog.find((row: any) => row.id !== current.id && !reviewed.has(text(row.id)));
        await sendOfficialMessage(
          `${senderPhone}@c.us`,
          next
            ? `✅ Registrado.\n\n🍷 *Próximo item:* ${text(next.display_name)}\n${text(next.description)}\n\nEnvie somente o *preço de venda* (ex.: *R$ 39,90*) ou *PULAR*.`
            : "✅ Registrado. Este valor ficou apenas para revisão e mapeamento futuro; nada foi alterado no SAIPOS. Se quiser rever, envie o nome do vinho e o novo preço.",
        );
        return Response.json({ sent: true, wine_price_preference_recorded: true });
      }
      await sendOfficialMessage(
        `${senderPhone}@c.us`,
        `🍷 *${text(current.display_name)}*\n${text(current.description)}\n\nQual preço de venda você quer deixar como sugestão para o SAIPOS? Responda, por exemplo: *R$ 39,90*. Para não definir agora, responda *PULAR* e seguimos ao próximo item.`,
      );
      return Response.json({ sent: true, wine_price_prompt: true });
    }
    // Resposta individual dos dois despachantes de uma rota consolidada. Não
    // presume motorista: registra a informação, pede identificação quando
    // faltar e informa a Logística sem marcar coleta ou entrega como concluída.
    if (
      isPrivateChat &&
      ["5512981147680", "5512981276290"].includes(senderPhone) &&
      /\b(?:motorista|app|aplicativo|autoriza|autorizado|nao sei|não sei|ainda nao|ainda não|sim|nao|não)\b/i.test(message)
    ) {
      const dispatcherArea = senderPhone === "5512981147680" ? "bebidas" : "alimentos";
      const normalizedReply = normalized(message);
      const noDriverKnown = /\b(?:nao sei|ainda nao|sem motorista|nao definido)\b/i.test(normalizedReply);
      const appAuthorized = /\b(?:sim|autoriza|autorizado|pode usar|pode)\b/i.test(normalizedReply) && !/\b(?:nao|não)\b/i.test(normalizedReply);
      const appDenied = /\b(?:nao autoriza|não autoriza|nao pode|não pode|sem app)\b/i.test(normalizedReply);
      const driverMention = message
        .replace(/\b(?:sim|nao|não|o|a|motorista|app|aplicativo|autoriza(?:do)?|pode|usar|vai|ser[aá])\b/gi, "")
        .replace(/\s+/g, " ").trim();
      const status = noDriverKnown ? "driver_unknown" : appDenied ? "app_not_authorized" : appAuthorized ? "app_authorized" : "driver_reported_pending_authorization";
      await db.from("opeixeiro_operational_events").insert({
        event_type: "offline_queued",
        actor_name: senderPhone === "5512981147680" ? "Danilo · final 7680" : "Tiago · final 6290",
        occurred_at: new Date().toISOString(),
        client_occurred_at: new Date().toISOString(),
        metadata: {
          record_kind: "consolidated_route_driver_authorization_response",
          destination: "P5",
          dispatcher_area: dispatcherArea,
          status,
          driver_text: driverMention || null,
          source_text: safeConversationRecord(message),
        },
      });
      const groupSummary = noDriverKnown
        ? `🚚 Atualização da rota P5: o responsável pela parte de ${dispatcherArea} ainda não identificou o motorista. A coleta segue aguardando definição.`
        : appDenied
          ? `🚚 Atualização da rota P5: foi informado motorista para a parte de ${dispatcherArea}, mas o uso do aplicativo não foi autorizado. Manter rastreio manual e confirmar motorista.`
          : appAuthorized
            ? `🚚 Atualização da rota P5: o responsável pela parte de ${dispatcherArea} informou que o motorista autoriza usar o aplicativo. Falta confirmar nome e final do telefone antes de vincular a rota.`
            : `🚚 Atualização da rota P5: houve resposta sobre motorista para a parte de ${dispatcherArea}. Falta confirmar se ele autoriza usar o aplicativo e informar o final do telefone.`;
      await sendOfficialMessage(`${logisticsGroupId}@g.us`, groupSummary);
      if (noDriverKnown) {
        await sendOfficialMessage(`${senderPhone}@c.us`, "Certo. Quando souber, envie nome ou final do telefone do motorista e escreva se ele autoriza usar o aplicativo.");
      } else if (!appAuthorized && !appDenied) {
        await sendOfficialMessage(`${senderPhone}@c.us`, "Obrigado. Informe também se o motorista autoriza usar o aplicativo e o final do telefone dele.");
      }
      return Response.json({ stored: true, consolidated_route_driver_response: status });
    }
    // Resposta individual curta ao convite de PDF do Bar P4. O formato aprovado
    // pelo Lucas e pela operação é o PDF térmico simples de itens disponíveis.
    if (
      senderPhone === "5512981392438" &&
      isPrivateChat &&
      /^(?:sim|pode sim|quero|gerar(?:\s+o)?\s+pdf)\b/i.test(message)
    ) {
      const response = await fetch(
        `${supabaseUrl}/functions/v1/send-emergency-p4-pdf`,
        {
          method: "POST",
          headers: { "x-logistics-webhook-secret": logisticsWebhookSecret },
        },
      );
      if (!response.ok)
        throw new Error("Não foi possível gerar o PDF térmico do Bar P4");
      await db.from("opeixeiro_operational_events").insert({
        event_type: "offline_queued",
        actor_name: "Lucas Mendes",
        occurred_at: new Date().toISOString(),
        client_occurred_at: new Date().toISOString(),
        metadata: {
          record_kind: "individual_pdf_request",
          unit: "BAR_P4",
          response: message,
          template: "itens_disponiveis_simples",
        },
      });
      return Response.json({ stored: true, individual_pdf_generated: true });
    }
    // Este grupo é deliberadamente silencioso: só guarda a mensagem e o
    // telefone para organização posterior no grupo oficial de pedidos.
    if (chatId === observerGroupId || chatId === barGroupId) {
      const isBarSource = chatId === barGroupId;
      const incomingMessageType = text(payload.messageData?.typeMessage);
      const incomingFile =
        payload.messageData?.audioMessageData ||
        payload.messageData?.fileMessageData ||
        {};
      if (
        incomingMessageType === "audioMessage" &&
        text(incomingFile.downloadUrl)
      ) {
        const transcript = await transcribeOperationalAudio(
          text(incomingFile.downloadUrl),
          text(incomingFile.fileName || "audio.ogg"),
          text(incomingFile.mimeType || "audio/ogg"),
        );
        if (transcript) message = `[Áudio transcrito] ${transcript}`;
      }
      // O grupo do Bar entrou em teste hoje. Nunca importamos mensagens
      // anteriores às 05:00 (horário de São Paulo), evitando misturar o
      // histórico antigo com a operação atual.
      if (isBarSource) {
        const localDate = new Date().toLocaleDateString("en-CA", {
          timeZone: "America/Sao_Paulo",
        });
        const cutoff = new Date(`${localDate}T05:00:00-03:00`);
        const sourceDate =
          Number(payload.timestamp) > 0
            ? new Date(Number(payload.timestamp) * 1000)
            : new Date();
        if (sourceDate.getTime() < cutoff.getTime())
          return Response.json({
            ignored: true,
            reason: "bar_group_before_today_0500",
          });
      }
      const { data: observation, error: observerError } = await db
        .from("opeixeiro_observer_group_messages")
        .insert({
          group_chat_id: isBarSource ? barGroupId : observerGroupId,
          phone_e164: senderPhone,
          display_name: text(
            sender.senderName || sender.chatName || payload.senderName,
          ),
          message_text: message || "[mensagem sem texto]",
          green_message_id:
            text(payload.idMessage || payload.id_message) || null,
          raw_payload: payload,
        })
        .select("id")
        .maybeSingle();
      if (observerError) {
        if (/duplicate key/i.test(observerError.message))
          return Response.json({
            observed: true,
            duplicate: true,
            replied: false,
          });
        throw observerError;
      }
      // BAR Peixeiro e Pedidos/Recebidos são as duas fontes autorizadas de
      // conversa/fotos para o relatório. Preservamos a mensagem e, quando o
      // WhatsApp disponibilizar a mídia, arquivamos uma cópia privada. Foto
      // isolada é evidência: nunca baixa uma entrega sem confirmação humana.
      const observerMessageType = text(payload.messageData?.typeMessage);
      const observerFile =
        payload.messageData?.imageMessageData ||
        payload.messageData?.stickerMessageData ||
        payload.messageData?.fileMessageData ||
        {};
      const reportDate = new Date().toLocaleDateString("en-CA", {
        timeZone: "America/Sao_Paulo",
      });
      // Emergência é tratada como um fluxo próprio. Conversas de
      // disponibilidade (por exemplo "quem tem taça?") nunca viram pedido.
      const emergencyRoute = message.match(
        /\b(?:do|da|de)\s+(peixaria|p[1-7])\s+(?:para|pro|pra)\s+(?:o\s+)?p([1-7])\b/i,
      );
      const emergencyAvailabilityDiscussion =
        /\b(?:quem\s+tem|tem\s+ta[cç]a|n[aã]o\s+tem\s+ta[cç]a|ta[cç]a\s+de\s+(?:vidro|acr[ií]lica))\b/i.test(message);
      const emergencyIntent =
        /\b(?:emerg[eê]ncia|emergencial|urgente|urg[eê]ncia)\b/i.test(message) &&
        !emergencyAvailabilityDiscussion;
      const emergencyMediaEvidence =
        ["imageMessage", "stickerMessage"].includes(observerMessageType) &&
        /\b(?:emerg[eê]ncia|emergencial|urgente|urg[eê]ncia)\b/i.test(message);
      const quantifiedEmergency =
        /\b\d+(?:[.,]\d+)?\s*(?:cx|caixa|pct|pacote|unid(?:ade)?|pe[cç]a|kg|quilo|fardo|balde)\b/i.test(message);
      let reportMediaPath: string | null = null;
      if (
        ["imageMessage", "stickerMessage"].includes(observerMessageType) &&
        text(observerFile.downloadUrl)
      ) {
        try {
          const mediaResponse = await fetch(text(observerFile.downloadUrl));
          if (mediaResponse.ok) {
            const mediaBytes = new Uint8Array(
              await mediaResponse.arrayBuffer(),
            );
            if (mediaBytes.byteLength <= 10 * 1024 * 1024) {
              const mimeType = text(observerFile.mimeType || "image/jpeg");
              reportMediaPath = `whatsapp-live/${isBarSource ? "bar" : "pedidos-recebidos"}/${reportDate}/${text(payload.idMessage || crypto.randomUUID())}.${mimeType.includes("png") ? "png" : "jpg"}`;
              const { error: mediaError } = await db.storage
                .from("opeixeiro-report-media")
                .upload(reportMediaPath, mediaBytes, {
                  contentType: mimeType,
                  upsert: true,
                });
              if (mediaError) {
                console.error("report media upload error", mediaError);
                reportMediaPath = null;
              }
            }
          }
        } catch (mediaError) {
          console.error("report media download error", mediaError);
        }
      }
      const routeCaption =
        /^\s*(?:indo\s+)?(?:d[oa]\s+)?(?:P[1-7]|peixaria)\s+(?:para|pro|pra)\s+(?:o\s+)?P[1-7](?:\s+.*)?$/i.test(
          message,
        );
      const reportInterpretation =
        observerMessageType === "imageMessage"
          ? routeCaption
            ? "Foto de rota/possível recebimento detectada; aguarda confirmação do responsável antes de concluir a entrega."
            : "Foto operacional detectada; preservada para conferência e relatório diário."
          : looksLikeObservedOrder(message)
            ? "Lista ou solicitação operacional detectada; itens/quantidades serão organizados para conferência."
            : emergencyMediaEvidence
              ? "Figurinha/foto de emergência preservada como evidência; itens e quantidades aguardam confirmação."
              : "Mensagem operacional preservada como contexto da implantação.";
      const reportLearning =
        observerMessageType === "imageMessage"
          ? "O chatbot agora vincula a imagem ao relatório e solicita confirmação quando origem, destino, coletor ou recebimento não estiverem claros."
          : "O chatbot registra a conversa para auditoria e não conclui baixa sem confirmação operacional.";
      await db.from("opeixeiro_whatsapp_report_imports").insert({
        report_date: reportDate,
        source_message_id:
          text(payload.idMessage || payload.id_message) || null,
        source_name: isBarSource
          ? "WhatsApp — BAR Peixeiro (captura automática)"
          : "WhatsApp — Pedidos/Recebidos (captura automática)",
        message_at:
          Number(payload.timestamp) > 0
            ? new Date(Number(payload.timestamp) * 1000).toISOString()
            : new Date().toISOString(),
        sender_name:
          text(sender.senderName || sender.chatName || payload.senderName) ||
          null,
        message_text: message || "[mensagem sem texto]",
        media_path: reportMediaPath,
        media_type: reportMediaPath
          ? text(observerFile.mimeType || "image/jpeg")
          : null,
        chatbot_interpretation: reportInterpretation,
        correction_or_learning: reportLearning,
        dispatcher_name:
          text(sender.senderName || sender.chatName || payload.senderName) ||
          null,
      });
      // Foto marcada como recebida no P2, especialmente quando traz caixas
      // fechadas, é somente prova de chegada física. O conteúdo pode ser
      // compra, insumo ou pescado; não inferimos o produto pela embalagem e
      // priorizamos a conferência de quem estiver trabalhando no P2.
      if (
        observation &&
        observerMessageType === "imageMessage" &&
        /\bentregue\s+(?:no|ao)\s*p2\b/i.test(message)
      ) {
        const reporter = text(
          sender.senderName || sender.chatName || `telefone final ${senderPhone.slice(-4)}`,
        );
        const { data: p2Unit } = await db
          .from("opeixeiro_units")
          .select("id")
          .eq("code", "P2")
          .maybeSingle();
        const { data: p2Contacts } = p2Unit?.id
          ? await db
              .from("opeixeiro_orders_group_contacts")
              .select("display_name,role_label,is_group_member")
              .eq("unit_id", p2Unit.id)
              .eq("is_group_member", true)
              .limit(30)
          : { data: [] as Array<any> };
        const checker = (p2Contacts || []).find((candidate: any) =>
          /confer|despach|cozinha|bar|caixa/i.test(text(candidate.role_label)),
        );
        await db.from("opeixeiro_operational_events").insert({
          event_type: "offline_queued",
          actor_name: "Assistente O Peixeiro",
          occurred_at: new Date().toISOString(),
          metadata: {
            record_kind: "p2_inbound_photo_requires_internal_check",
            source_phone_suffix: senderPhone.slice(-4),
            reporter: reporter,
            destination: "P2",
            observer_message_id: observation.id,
            status: "emergência em conferência interna",
            suggested_checker: checker?.display_name || null,
            rule: "não identificar conteúdo, não dar baixa e não contabilizar desvio antes de abertura e conferência interna",
          },
        });
        await sendLogisticsGroupMessage(
          "📌 Conferência interna pendente no P2. Um contato elegível foi identificado; informe apenas quem ficará responsável pela conferência.",
        );
        await sendGroupMessage(
          "Pessoal da cozinha do P2: chegou algum item dessa movimentação que ainda não foi conferido? Se sim, informem item, quantidade e, se possível, uma foto. Se não houver pendência, respondam apenas: SEM PENDÊNCIA.",
        );
      }
      if (observation && (emergencyIntent || emergencyMediaEvidence)) {
        const originFromText = emergencyRoute?.[1] ||
          message.match(/\b(?:origem|coleta|retirar|retira)\s*(?:no|na|em|do|da)?\s*(peixaria|p[1-7])\b/i)?.[1] || "";
        const destinationFromText = emergencyRoute?.[2] ||
          message.match(/\b(?:destino|para|pro|pra)\s+(?:o\s+)?p([1-7])\b/i)?.[1] || "";
        const emergencyItems = await catalogItemsFromMessage(message);
        const missing: string[] = [];
        if (!originFromText) missing.push("origem/coleta");
        if (!destinationFromText) missing.push("destino");
        if (!quantifiedEmergency || !emergencyItems.length)
          missing.push("itens e quantidades");
        await db.from("opeixeiro_operational_events").insert({
          event_type: "emergency_pickup_alerted",
          actor_name: text(sender.senderName || sender.chatName || "Colaborador"),
          occurred_at: new Date().toISOString(),
          metadata: {
            record_kind: missing.length
              ? "emergency_request_incomplete"
              : "explicit_emergency_from_group_message",
            origin: originFromText ? originFromText.toUpperCase() : null,
            destination: destinationFromText ? `P${destinationFromText}` : null,
            items: emergencyItems,
            evidence: emergencyMediaEvidence ? "foto/figurinha com legenda de emergência" : "mensagem textual",
            raw_text: message,
            missing_fields: missing,
            requires_separation_confirmation: !missing.length,
            requires_receipt_confirmation: !missing.length,
          },
        });
        if (missing.length) {
          await sendGroupMessage(
            `🚨 Pedido emergencial registrado para organização. Para liberar sem erro, informe: ${missing.join(", ")}. Exemplo: “2 caixas de item, coleta no P2, destino P5; responsável pela separação: nome”.`,
          );
          return Response.json({ observed: true, emergency_pending_details: missing });
        }
        const originLabel = originFromText.toUpperCase();
        const destinationLabel = `P${destinationFromText}`;
        const itemSummary = emergencyItems
          .map((item) => `${item.qty} ${item.unit || itemUnitFor(item.name)} de ${item.name}`)
          .join("; ");
        await sendLogisticsGroupMessage(
          `🚨 Emergência registrada: ${originLabel} → ${destinationLabel}. Itens: ${itemSummary}. Solicitante final ${senderPhone.slice(-4)}. Aguardando responsável pela separação, coletor/motorista e confirmação de recebimento; a foto, quando houver, ficará apenas como evidência.`,
        );
        await sendGroupMessage(
          `🚨 Pedido emergencial em acompanhamento para ${destinationLabel}: ${itemSummary}. Quando separar, informe quem liberou e quem fará a coleta. No recebimento, confirme completo, parcial ou faltante.`,
        );
        return Response.json({
          observed: true,
          emergency_registered: true,
          origin: originLabel,
          destination: destinationLabel,
        });
      }
      // Pedido curto de falta (“se alguém tiver X, estou zerado”) é uma
      // solicitação de disponibilidade, não uma confirmação de saída. O
      // destino vem do cadastro do colaborador; origem, quantidade e coleta
      // permanecem pendentes até alguém oferecer o item.
      const stockOutRequest = message.match(
        /\bse\s+algu[eé]m\s+tiver\s+(.+?)(?:\s+e\s+puder\s+(?:mandar|enviar))?\s*,?\s+estou\s+(?:zerado|sem)\b/i,
      );
      if (observation && stockOutRequest && !emergencyIntent) {
        const { data: requesterContact } = await db
          .from("opeixeiro_orders_group_contacts")
          .select("opeixeiro_units!opeixeiro_orders_group_contacts_unit_id_fkey(code,name)")
          .eq("phone_e164", senderPhone)
          .maybeSingle();
        const requesterUnit = requesterContact?.opeixeiro_units as {
          code?: string;
          name?: string;
        } | null;
        const requestedDescription = text(stockOutRequest[1])
          .replace(/\s+e\s+puder\s+(?:mandar|enviar).*$/i, "")
          .trim();
        if (requestedDescription && text(requesterUnit?.code)) {
          await db.from("opeixeiro_operational_events").insert({
            event_type: "offline_queued",
            actor_name: text(sender.senderName || sender.chatName || "Colaborador"),
            occurred_at: new Date().toISOString(),
            metadata: {
              record_kind: "stockout_emergency_availability_request",
              destination: text(requesterUnit.code),
              item_description: requestedDescription,
              quantity: "não informada",
              origin: "não informada",
              status: "aguardando disponibilidade",
              source_text: message,
            },
          });
          await sendLogisticsGroupMessage(
            `🚨 Disponibilidade emergencial solicitada: ${requestedDescription} para ${text(requesterUnit.code)}. Quantidade, origem e coleta ainda não foram informadas; confirmar disponibilidade antes de montar rota.`,
          );
          return Response.json({
            observed: true,
            stockout_emergency_request: true,
            destination: requesterUnit.code,
          });
        }
      }
      // Rafaela pode enviar uma sequência de fotos antes de digitar a lista.
      // Uma foto com “indo P6” prova apenas a saída visual: ela não cria nem
      // conclui pedido sozinha. A lista/checklist posterior é que detalha os
      // itens; até lá o registro permanece pendente de conferência.
      const rafaelaPhotoDestination =
        senderPhone === "5512996761977" &&
        observerMessageType === "imageMessage"
          ? message.match(/\bindo\s*(?:para\s*)?p([1-7])\b/i)?.[1] || ""
          : "";
      if (observation && rafaelaPhotoDestination) {
        await db.from("opeixeiro_operational_events").insert({
          event_type: "offline_queued",
          actor_name: "Rafaela · Conferente",
          occurred_at: new Date().toISOString(),
          metadata: {
            record_kind: "rafaela_photo_evidence_awaiting_checklist",
            source_group: observerGroupId,
            observer_message_id: observation.id,
            destination: `P${rafaelaPhotoDestination}`,
            source_caption: message || null,
            media_path: reportMediaPath,
            reporter_role: "conferente",
            driver: "não informado",
            inventory_effect: "none_until_checklist_and_receipt_confirmation",
          },
        });
      }
      // No BAR Peixeiro, apenas persistimos o payload completo (inclusive
      // fotos, legenda, remetente e horário). O grupo continua silencioso:
      // quando a lista tiver itens reconhecidos, somente a Logística recebe
      // o resumo para organização, sem resposta ou link no grupo do Bar.
      if (isBarSource) {
        const recognizedItems = refineBarCatalogItems(
          message,
          await catalogItemsFromMessage(message),
        );
        // Evita avisos precipitados como "Coca e mais itens": somente uma
        // lista identificada ou uma mensagem com várias linhas é encaminhada.
        const looksLikeCompleteBarList =
          /\blista\b/i.test(message) ||
          message.split(/\r?\n/).filter((line) => text(line)).length >= 4;
        if (recognizedItems.length && looksLikeCompleteBarList) {
          const requester = text(
            sender.senderName || sender.chatName || "Colaborador do Bar",
          );
          await sendLogisticsGroupMessage(
            `📋 *Pedido do Bar — itens reconhecidos para organização*\n\nSolicitante: *${requester}* · telefone final *${senderPhone.slice(-4)}*\n\n${recognizedItems.map((item) => `• ${item.name}: ${item.qty} ${item.unit || itemUnitFor(item.name)}`).join("\n")}\n\nItens reconhecidos no catálogo foram encaminhados para conferência de origem e separação. Itens não reconhecidos permanecem em organização.`,
          );
          await db.from("opeixeiro_chatbot_conversation_audit").insert({
            phone_e164: senderPhone,
            participant_name: requester,
            channel: "whatsapp_group",
            direction: "system",
            intent: "bar_catalog_items_forwarded_to_logistics",
            summary: `${recognizedItems.length} item(ns) reconhecido(s) no pedido do Bar e encaminhado(s) à Logística.`,
            outcome: "Aguardando conferência de origem e separação.",
            metadata: { items: recognizedItems },
          });
        }
        return Response.json({
          observed: true,
          stored: true,
          replied: false,
          forwarded: recognizedItems.length > 0 && looksLikeCompleteBarList,
          source: "bar_group_silent",
        });
      }
      if (
        !isBarSource &&
        observation &&
        senderPhone === "5511989346164" &&
        observerMessageType === "imageMessage"
      ) {
        const downloadUrl = text(observerFile.downloadUrl);
        const mimeType = text(observerFile.mimeType || "image/jpeg");
        if (!/\b(?:vinho|wine)\b/i.test(message)) {
          return Response.json({
            observed: true,
            wine_test_ignored: true,
            reason: "caption_without_wine",
            replied_in_observer: false,
          });
        }
        const declared = message.match(
          /\b(\d{1,4})\s*(?:unidade(?:s)?|und(?:s)?|un\.?|garrafa(?:s)?|vinho(?:s)?)?\b/i,
        );
        const declaredQuantity = declared ? Number(declared[1]) : null;
        const record = {
          green_message_id: text(payload.idMessage || payload.id_message),
          group_chat_id: observerGroupId,
          sender_phone: senderPhone,
          sender_name: text(sender.senderName || sender.chatName || "Fabio"),
          caption_text: message || null,
          declared_quantity:
            declaredQuantity && declaredQuantity > 0 ? declaredQuantity : null,
          wine_description:
            message
              .replace(
                /^\s*\d+\s*(?:unidade(?:s)?|und(?:s)?|un\.?|garrafa(?:s)?)?\s*/i,
                "",
              )
              .trim() || null,
          image_download_url: downloadUrl || null,
          mime_type: mimeType,
          ocr_status: downloadUrl && openAiApiKey ? "pending" : "not_available",
          updated_at: new Date().toISOString(),
        };
        const { data: wineRow, error: wineInsertError } = await db
          .from("opeixeiro_wine_photo_observations")
          .upsert(record, { onConflict: "green_message_id" })
          .select("id")
          .maybeSingle();
        if (wineInsertError) throw wineInsertError;
        if (!downloadUrl) {
          await sendObserverGroupMessage(
            "Fabio, recebi a foto, mas o WhatsApp não disponibilizou o arquivo para leitura. Envie novamente como foto e escreva na legenda: *VINHO + quantidade + sabor/descrição*.",
          );
          return Response.json({
            observed: true,
            wine_photo_collected: true,
            ocr_started: false,
            replied_in_observer: true,
          });
        }
        if (!photoVisionEnabled || !openAiApiKey) {
          await sendObserverGroupMessage(
            "Fabio, a foto foi salva para o teste, mas o serviço de leitura ainda não está configurado.",
          );
          return Response.json({
            observed: true,
            wine_photo_collected: true,
            ocr_started: false,
            replied_in_observer: true,
          });
        }
        try {
          const imageResponse = await fetch(downloadUrl);
          if (!imageResponse.ok)
            throw new Error(
              `download da imagem falhou (${imageResponse.status})`,
            );
          const imageBytes = new Uint8Array(await imageResponse.arrayBuffer());
          if (imageBytes.byteLength > 15 * 1024 * 1024)
            throw new Error("imagem maior que 15 MB");
          const storagePath = `tests/${new Date().toISOString().slice(0, 10)}/${text(payload.idMessage || crypto.randomUUID())}.${mimeType.includes("png") ? "png" : "jpg"}`;
          const { error: uploadError } = await db.storage
            .from("opeixeiro-wine-labels")
            .upload(storagePath, imageBytes, {
              contentType: mimeType,
              upsert: true,
            });
          if (uploadError) throw uploadError;
          const visionResponse = await fetch(
            "https://api.openai.com/v1/responses",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${openAiApiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "gpt-4.1-mini",
                store: false,
                max_output_tokens: 500,
                instructions:
                  "Analise rótulos de vinho. Responda somente JSON válido, sem markdown. Não invente texto ilegível.",
                input: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "input_text",
                        text: `Legenda informada: ${message}\nExtraia o texto visível e devolva: {\"suggested_name\":\"nome comercial completo ou Vinho a identificar\",\"brand\":\"marca ou vazio\",\"wine_type\":\"tipo/cor ou vazio\",\"grape_or_flavor\":\"uva, sabor ou vazio\",\"vintage\":\"safra ou vazio\",\"quantity\":numero inteiro da legenda ou null,\"visible_text\":\"texto importante lido\",\"confidence\":numero entre 0 e 1}.`,
                      },
                      {
                        type: "input_image",
                        image_url: `data:${mimeType};base64,${encodeBase64(imageBytes)}`,
                        detail: "high",
                      },
                    ],
                  },
                ],
              }),
            },
          );
          const visionPayload = await visionResponse.json();
          if (!visionResponse.ok)
            throw new Error(
              text(
                visionPayload?.error?.message ||
                  `OpenAI respondeu ${visionResponse.status}`,
              ),
            );
          const rawResult = responseOutputText(visionPayload).replace(
            /^```json\s*|\s*```$/g,
            "",
          );
          const result = JSON.parse(rawResult);
          const finalQuantity =
            declaredQuantity && declaredQuantity > 0
              ? declaredQuantity
              : Number(result.quantity) > 0
                ? Number(result.quantity)
                : null;
          const suggestedName = text(
            result.suggested_name || "Vinho a identificar",
          );
          await db
            .from("opeixeiro_wine_photo_observations")
            .update({
              declared_quantity: finalQuantity,
              ocr_status: "processed",
              ocr_text: text(result.visible_text),
              ocr_suggested_name: suggestedName,
              ocr_confidence: Math.max(
                0,
                Math.min(1, Number(result.confidence) || 0),
              ),
              image_storage_path: storagePath,
              raw_vision_result: result,
              updated_at: new Date().toISOString(),
            })
            .eq("id", wineRow?.id);
          await sendObserverGroupMessage(
            `🍷 *Teste de cadastro do vinho*\n\nNome identificado: *${suggestedName}*\n${text(result.brand) ? `Marca: *${text(result.brand)}*\n` : ""}${text(result.wine_type) ? `Tipo: *${text(result.wine_type)}*\n` : ""}${text(result.grape_or_flavor) ? `Uva/sabor: *${text(result.grape_or_flavor)}*\n` : ""}${text(result.vintage) ? `Safra: *${text(result.vintage)}*\n` : ""}Quantidade informada: *${finalQuantity || "não identificada"}*\n\nFoto e leitura salvas no Supabase como demonstração. Confira o resultado; ele ainda não altera estoque nem envia nada aos outros grupos.`,
          );
          return Response.json({
            observed: true,
            wine_photo_collected: true,
            ocr_processed: true,
            replied_in_observer: true,
          });
        } catch (wineOcrError) {
          console.error("Wine OCR test error", wineOcrError);
          await db
            .from("opeixeiro_wine_photo_observations")
            .update({
              ocr_status: "failed",
              updated_at: new Date().toISOString(),
            })
            .eq("id", wineRow?.id);
          await sendObserverGroupMessage(
            "Fabio, a foto foi salva, mas não consegui concluir a leitura do rótulo desta vez. Tente novamente com a frente da garrafa bem iluminada e sem reflexo.",
          );
          return Response.json({
            observed: true,
            wine_photo_collected: true,
            ocr_processed: false,
            replied_in_observer: true,
          });
        }
      }
      const manualRouteMatch = message.match(
        /^\s*(?:indo\s+)?(?:d[oa]\s+)?(P[1-7]|peixaria)\s+(?:para|pro|pra)\s+(?:o\s+)?(P[1-7]|peixaria)(?:\s+.*)?$/i,
      );
      const trustedPhotoDispatcher = [
        "5512974010671",
        "5512988770102",
        "5512981147680",
        "5512997985997",
        "5512981276290",
      ].includes(senderPhone);
      if (
        !isBarSource &&
        observation &&
        manualRouteMatch &&
        observerMessageType === "imageMessage" &&
        !trustedPhotoDispatcher
      ) {
        const destinationShort = `P${manualRouteMatch[2]}`;
        await db.from("opeixeiro_operational_events").insert({
          event_type: "offline_queued",
          actor_name: text(
            sender.senderName ||
              sender.chatName ||
              `telefone final ${senderPhone.slice(-4)}`,
          ),
          occurred_at: new Date().toISOString(),
          metadata: {
            record_kind: "photo_receipt_evidence",
            origin: /^peixaria$/i.test(manualRouteMatch[1])
              ? "PEIXARIA"
              : manualRouteMatch[1].toUpperCase(),
            destination: destinationShort,
            observer_message_id: observation.id,
            inventory_effect: "none_until_receipt_confirmation",
          },
        });
        await sendGroupMessage(
          `📷 *Foto de possível recebimento — ${destinationShort}*\n\nPessoal da cozinha do destino: a foto indica rota/recebimento, mas não baixa itens automaticamente. Confirmem: *CHEGOU*, *CHEGOU EM PARTES* ou *NÃO CHEGOU*. Se houver diferença, informem item e quantidade; se não houver pendência, respondam *SEM PENDÊNCIA*.`,
        );
        return Response.json({
          observed: true,
          photo_receipt_evidence: true,
          awaiting_receipt_confirmation: true,
        });
      }
      const routeHasRequiredEvidence =
        !isBarSource || observerMessageType === "imageMessage";
      if (
        observation &&
        manualRouteMatch &&
        routeHasRequiredEvidence &&
        (isBarSource || trustedPhotoDispatcher)
      ) {
        const originCode = /^peixaria$/i.test(manualRouteMatch[1])
          ? "PEIXARIA"
          : manualRouteMatch[1].toUpperCase();
        const destinationShort = /^peixaria$/i.test(manualRouteMatch[2])
          ? "PEIXARIA"
          : manualRouteMatch[2].toUpperCase();
        const dispatcherIdentity =
          senderPhone === "5512988911534"
            ? "Despachante final 1534"
            : text(sender.senderName || sender.chatName || "Despachante");
        const collectorMatch = message.match(
          /\b(?:motorista|cumim|coletor)\s*[:\-]?\s*([\p{L}][\p{L}\s.'-]{1,60})/iu,
        );
        const collectorName = collectorMatch
          ? text(collectorMatch[1])
              .replace(/\s+(?:para|pro|pra)\s+.*$/i, "")
              .trim()
          : "";
        const today = new Date().toLocaleDateString("en-CA", {
          timeZone: "America/Sao_Paulo",
        });
        const candidateCodes = [
          destinationShort,
          `COZINHA - ${destinationShort}`,
          `CAIXA - ${destinationShort}`,
          `BAR - ${destinationShort}`,
        ];
        const { data: units } = await db
          .from("opeixeiro_units")
          .select("id,code")
          .in("code", candidateCodes);
        const unitIds = (units || []).map((unit: any) => unit.id);
        const { data: candidateOrders } = unitIds.length
          ? await db
              .from("opeixeiro_orders")
              .select("id,destination_unit_id")
              .in("destination_unit_id", unitIds)
              .eq("delivery_date", today)
          : { data: [] };
        const confirmedOrders: any[] = [];
        for (const candidate of candidateOrders || []) {
          const [{ data: contributions }, { data: contacts }] =
            await Promise.all([
              db
                .from("opeixeiro_order_contributions")
                .select("requester_name")
                .eq("order_id", candidate.id),
              db
                .from("opeixeiro_orders_group_contacts")
                .select("display_name,opeixeiro_panel_users(display_name)")
                .eq("unit_id", candidate.destination_unit_id)
                .eq("is_group_member", true),
            ]);
          const names = new Set(
            (contacts || [])
              .flatMap((contact: any) => [
                normalized(text(contact.display_name)),
                normalized(text(contact.opeixeiro_panel_users?.display_name)),
              ])
              .filter(Boolean),
          );
          if (
            (contributions || []).some((contribution: any) =>
              names.has(normalized(text(contribution.requester_name))),
            )
          )
            confirmedOrders.push(candidate);
        }
        const confirmedOrder =
          confirmedOrders.length === 1 ? confirmedOrders[0] : null;
        // Para fotos de despachantes conhecidos, a leitura visual só grava os
        // itens que o modelo considerar nítidos; dados incertos permanecem fora
        // do saldo até a conferência humana no destino.
        const photoItems =
          observerMessageType === "imageMessage"
            ? await itemsClearlyVisibleInDispatchPhoto(
                text(observerFile.downloadUrl),
                text(observerFile.mimeType || "image/jpeg"),
                message,
              )
            : [];
        // Polenta e mandioca têm origem padrão na Peixaria. Quando a legenda
        // registra P2 como ponto de coleta durante uma rota, isso é apenas
        // uma transferência/coleta em percurso e não muda a origem do item.
        if (
          originCode === "P2" &&
          /\b(?:polenta|mandioca)\b/i.test(message)
        )
          await db.from("opeixeiro_operational_events").insert({
            order_id: confirmedOrder?.id || null,
            event_type: "offline_queued",
            actor_name: dispatcherIdentity,
            occurred_at: new Date().toISOString(),
            metadata: {
              record_kind: "p2_in_route_pickup_of_peixaria_items",
              items_mentioned: message.match(/\bpolenta\b/i) && message.match(/\bmandioca\b/i)
                ? ["Polenta", "Mandioca"]
                : message.match(/\bpolenta\b/i) ? ["Polenta"] : ["Mandioca"],
              default_origin: "PEIXARIA",
              operational_pickup_point: "P2",
              destination: destinationShort,
              source: "legenda de rota/foto",
            },
          });
        if (photoItems.length)
          await db.from("opeixeiro_operational_events").insert({
            order_id: confirmedOrder?.id || null,
            event_type: "offline_queued",
            actor_name: dispatcherIdentity,
            occurred_at: new Date().toISOString(),
            metadata: {
              record_kind: "photo_dispatch_item_detection",
              origin: originCode,
              destination: destinationShort,
              observer_message_id: observation.id,
              items: photoItems,
              inventory_effect: "none_until_receipt_confirmation",
            },
          });
        const { data: manualDispatch } = await db
          .from("opeixeiro_observer_dispatch_reports")
          .select("id,status,destination_code,separated_items")
          .in("destination_code", candidateCodes)
          .in("status", ["separated", "partially_separated"])
          .gte("confirmed_at", `${today}T00:00:00-03:00`)
          .order("confirmed_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const { error: routeError } = await db
          .from("opeixeiro_observer_manual_routes")
          .upsert(
            {
              observer_message_id: observation.id,
              order_id: confirmedOrder?.id || null,
              driver_phone: senderPhone,
              driver_name: null,
              origin_code: originCode,
              destination_code: destinationShort,
              status: "in_transit",
              confirmation_method: "manual_whatsapp_photo",
              qr_used: false,
              source_text: message,
              started_at: new Date().toISOString(),
            },
            { onConflict: "observer_message_id" },
          );
        if (routeError) throw routeError;
        await db
          .from("opeixeiro_whatsapp_report_imports")
          .update({
            order_id: confirmedOrder?.id || null,
            origin_code: originCode,
            destination_code: destinationShort,
            dispatcher_name: dispatcherIdentity,
            collector_name: driverGroupLabel(senderPhone),
            route_status: "em trânsito — confirmação manual por foto",
          })
          .eq(
            "source_message_id",
            text(payload.idMessage || payload.id_message),
          );
        // Uma emergência pendente para o mesmo destino pode acompanhar uma
        // foto de rota posterior. Isso cria somente um vínculo candidato para
        // a lista de conferência: nunca confirma que o item estava na foto,
        // nem encerra o recebimento antes da confirmação no aplicativo.
        const { data: pendingEmergencyItems } = await db
          .from("opeixeiro_operational_events")
          .select("id,metadata")
          .eq("event_type", "offline_queued")
          .eq("metadata->>record_kind", "standalone_emergency_item_request")
          .gte("occurred_at", `${today}T00:00:00-03:00`)
          .limit(50);
        const sameDestinationEmergencies = (pendingEmergencyItems || []).filter(
          (event: any) =>
            text(event.metadata?.destination).toUpperCase() ===
              text(destinationShort).toUpperCase() &&
            !text(event.metadata?.request_status).includes("recebido"),
        );
        for (const emergency of sameDestinationEmergencies) {
          await db.from("opeixeiro_operational_events").insert({
            event_type: "offline_queued",
            actor_name: "Assistente O Peixeiro",
            occurred_at: new Date().toISOString(),
            metadata: {
              record_kind: "emergency_item_candidate_route_link",
              emergency_event_id: emergency.id,
              item: emergency.metadata?.item || "item emergencial",
              route_items_visually_identified: photoItems,
              origin: originCode,
              destination: destinationShort,
              observer_message_id: observation.id,
              status: "emergência consolidada com rota do mesmo destino; itens visuais e item emergencial aguardam confirmação de recebimento",
              receipt_flow: "recebedor pode confirmar normalmente pelo aplicativo",
            },
          });
        }
        if (confirmedOrder) {
          await sendLogisticsGroupMessage(
            `🚚 *Saída confirmada para entrega — ${destinationShort}*\n\n*${driverGroupLabel(senderPhone)}* enviou uma foto indicando saída do *${originCode}* para *${destinationShort}*.\n\nA separação anterior permanece vinculada ao pedido. Status: *em rota para entrega*; o recebimento será confirmado no destino.`,
          );
          await sendGroupMessage(
            `🚚 *Atualização do pedido — ${destinationShort}*\n\nSeu pedido saiu para entrega e está a caminho. Quando chegar, confirme se recebeu tudo, em partes ou se houve alguma diferença.`,
          );
        } else if (manualDispatch) {
          await sendLogisticsGroupMessage(
            `🚚 *Saída confirmada para entrega — ${destinationShort}*\n\n*${driverGroupLabel(senderPhone)}* enviou uma foto indicando saída do *${originCode}* para *${destinationShort}*.\n\nHá uma separação anterior registrada pelo conferente. Status: *em rota para entrega*; o recebimento será confirmado no destino.`,
          );
          await sendGroupMessage(
            `🚚 *Atualização do pedido — ${destinationShort}*\n\nSeu pedido saiu para entrega e está a caminho. Quando chegar, confirme se recebeu tudo, em partes ou se houve alguma diferença.`,
          );
        } else {
          await sendLogisticsGroupMessage(
            `🚚 *Saída confirmada — ${destinationShort}*\nOrigem: *${originCode}*\nMotorista: *${driverGroupLabel(senderPhone)}*\n\nAguardando recebedor no destino.`,
          );
        }
        return Response.json({
          observed: true,
          manual_route: true,
          linked_to_order: Boolean(confirmedOrder),
          linked_to_manual_dispatch: Boolean(manualDispatch),
          notified_orders: Boolean(confirmedOrder || manualDispatch),
          replied_in_observer: false,
        });
      }
      // Em listas manuais, x/xx/xxx é uma marcação livre do conferente. Até
      // que o autor explique o significado, tratamos como indisponibilidade
      // inicial/provisória; nunca como quantidade separada ou entrega.
      const dispatchUnitMatch = message.match(/\bP([1-7])\b/i);
      const genericSeparated =
        isBarSource &&
        Boolean(dispatchUnitMatch) &&
        /\bseparad[oa]\b/i.test(message);
      if (observation && genericSeparated) {
        const unitNumber = dispatchUnitMatch![1];
        const destinationCode = /\bbar\b/i.test(message)
          ? `BAR - P${unitNumber}`
          : /\bsal[aã]o\b/i.test(message)
            ? `CAIXA - P${unitNumber}`
            : `COZINHA - P${unitNumber}`;
        const partial = /\b(?:parte|partes|parcial|parcialmente)\b/i.test(
          message,
        );
        const status = partial ? "partially_separated" : "separated";
        const dispatcherName = text(
          sender.senderName ||
            sender.chatName ||
            `telefone final ${senderPhone.slice(-4)}`,
        );
        const { error: genericReportError } = await db
          .from("opeixeiro_observer_dispatch_reports")
          .upsert(
            {
              observer_message_id: observation.id,
              destination_code: destinationCode,
              dispatcher_phone: senderPhone,
              dispatcher_name: dispatcherName,
              status,
              unavailable_items: [],
              separated_items: [],
              raw_text: message,
            },
            { onConflict: "observer_message_id" },
          );
        if (genericReportError) throw genericReportError;
        const statusText = partial
          ? "separado em partes"
          : "separado para despacho";
        const receiverText = /\bmanuel\b/i.test(message)
          ? "Solicitante provável: *Manuel* — telefone ainda pendente de confirmação.\n\n"
          : "Responsável pelo recebimento: *ainda não identificado*.\n\n";
        await sendLogisticsGroupMessage(
          `📦 *Confirmação manual de separação — P${unitNumber}*\n\nO pedido foi informado como *${statusText}*.\n\n${receiverText}Registro realizado fora do aplicativo; os itens não serão listados neste aviso.`,
        );
        await sendGroupMessage(
          `📦 *Atualização do pedido — P${unitNumber}*\n\nO pedido foi informado como *${statusText}*.\n\n${receiverText}Quando receber, o responsável poderá confirmar se chegou completo ou em partes.`,
        );
        return Response.json({
          observed: true,
          generic_manual_dispatch: true,
          status,
          notified_logistics: true,
          notified_orders: true,
          replied_in_bar_group: false,
        });
      }
      const isRafaelaManualDispatch =
        senderPhone === "5512996761977" &&
        /\b(?:pedido|lista)\b/i.test(message) &&
        Boolean(dispatchUnitMatch) &&
        /(?:\bok\b|[x×]{1,}|vai\s+depois|falt(?:a|ou)|sem\s+)/i.test(message);
      if (observation && isRafaelaManualDispatch) {
        const unitNumber = dispatchUnitMatch![1];
        const destinationCode = /\bbar\b/i.test(message)
          ? `BAR - P${unitNumber}`
          : /\bsal[aã]o\b/i.test(message)
            ? `CAIXA - P${unitNumber}`
            : `COZINHA - P${unitNumber}`;
        const destinationLabel =
          destinationCode
            .replace("COZINHA - ", "")
            .replace("CAIXA - ", "")
            .replace("BAR - ", "") || `P${unitNumber}`;
        const separatedItems = message
          .split(/\r?\n/)
          .map((line) => text(line).replace(/^\*+\s*/, ""))
          // Os checklists da Rafaela chegam tanto com bolinhas quanto em
          // linhas simples (“Arroz 1 fardo”, “Goiabada ××”). Não exigir
          // marcador evita marcar uma lista incompleta como completa.
          .filter((line) => {
            const clean = line.trim();
            if (!clean || /^(?:lista|pedido)\b/i.test(clean)) return false;
            return /^\s*(?:[-•*])\s*/.test(clean) ||
              /(?:\bok\b|[x×]{1,}|\d)/i.test(clean);
          })
          .map((line) => {
            const marks = line.match(/([x×]+)\s*$/i)?.[1] || "";
            return {
              description: line
                .replace(/^\s*(?:[-•*])\s*/, "")
                .replace(/\s*[x×]+\s*$/i, "")
                .trim(),
              // "ok" confirma a linha. Já x/xx/xxx fica como marcação de
              // indisponibilidade inicial até esclarecimento do conferente.
              quantity: null,
              initial_unavailability_mark: Boolean(marks),
            };
          });
        const deferredItems = separatedItems
          .filter((item) => /\bvai\s+depois\b/i.test(item.description))
          .map((item) => item.description);
        const pendingItems = separatedItems
          .filter((item) => {
            if (item.initial_unavailability_mark) return true;
            if (/\b(?:falt(?:a|ou)|sem\s+|n[aã]o\s+tem)\b/i.test(item.description)) return true;
            // Ex.: "10 unid (4 unid)" ou "2 pct (1)": a Rafaela
            // informou uma quantidade entregue menor que a solicitada.
            const requested = item.description.match(/(?:^|\s)(\d+(?:[.,]\d+)?)\s*(?:cx|caixa|pct|pacote|unid(?:ade)?|uni|balde|ma[cç]o|pe[cç]a|kg|kl)\b/i);
            const checked = item.description.match(/\(\s*(\d+(?:[.,]\d+)?)/);
            return Boolean(requested && checked && Number(checked[1].replace(",", ".")) < Number(requested[1].replace(",", ".")));
          })
          .map((item) => item.description);
        const checklistStatus = pendingItems.length
          ? "partially_separated"
          : "separated";
        const today = new Date().toLocaleDateString("en-CA", {
          timeZone: "America/Sao_Paulo",
        });
        const { data: destination } = await db
          .from("opeixeiro_units")
          .select("id")
          .eq("code", destinationCode)
          .maybeSingle();
        const { data: origin } = await db
          .from("opeixeiro_units")
          .select("id")
          .eq("code", "P2")
          .maybeSingle();
        const { data: candidateOrder } = destination
          ? await db
              .from("opeixeiro_orders")
              .select("id")
              .eq("destination_unit_id", destination.id)
              .eq("delivery_date", today)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle()
          : { data: null };
        // Só associa e divulga quando o pedido nasceu no sistema com uma
        // contribuição identificada e o solicitante está vinculado ao mesmo
        // setor no grupo oficial. Pedidos antigos/externos ficam para revisão.
        let order: { id: string } | null = null;
        if (candidateOrder?.id && destination?.id) {
          const [{ data: contributions }, { data: destinationContacts }] =
            await Promise.all([
              db
                .from("opeixeiro_order_contributions")
                .select("requester_name")
                .eq("order_id", candidateOrder.id),
              db
                .from("opeixeiro_orders_group_contacts")
                .select("display_name,opeixeiro_panel_users(display_name)")
                .eq("unit_id", destination.id)
                .eq("is_group_member", true),
            ]);
          const knownNames = new Set(
            (destinationContacts || [])
              .flatMap((contact: any) => [
                normalized(text(contact.display_name)),
                normalized(text(contact.opeixeiro_panel_users?.display_name)),
              ])
              .filter(Boolean),
          );
          const requesterConfirmed = (contributions || []).some(
            (contribution: any) =>
              knownNames.has(normalized(text(contribution.requester_name))),
          );
          if (requesterConfirmed) order = candidateOrder;
        }
        const { error: reportError } = await db
          .from("opeixeiro_observer_dispatch_reports")
          .upsert(
            {
              observer_message_id: observation.id,
              order_id: order?.id || null,
              destination_code: destinationCode,
              dispatcher_phone: senderPhone,
              dispatcher_name: "Rafaela",
              status: checklistStatus,
              unavailable_items: pendingItems,
              separated_items: separatedItems,
              raw_text: message,
            },
            { onConflict: "observer_message_id" },
          );
        if (reportError) throw reportError;
        if (order?.id && origin?.id) {
          const { error: checkError } = await db
            .from("opeixeiro_stock_separation_checks")
            .upsert(
              {
                order_id: order.id,
                check_date: today,
                origin_unit_id: origin.id,
                assigned_phone: senderPhone,
                assigned_name: "Rafaela",
                status: checklistStatus,
                respondent_phone: senderPhone,
                respondent_name: "Rafaela",
                responded_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
              { onConflict: "order_id,check_date,origin_unit_id" },
            );
          if (checkError) throw checkError;
        }
        const itemSummary = separatedItems.length
          ? separatedItems
              .slice(0, 30)
              .map((item) => `• ${item.description}${item.quantity ? ` — ${item.quantity} marcado(s)` : " — confirmado"}`)
              .join("\n")
          : "• Checklist sem linhas identificáveis.";
        const pendingSummary = pendingItems.length
          ? `\n\n*Pendências/faltas informadas:*\n${pendingItems.map((item) => `• ${item}`).join("\n")}`
          : "\n\n*Nenhuma falta foi declarada no checklist.*";
        const deferredSummary = deferredItems.length
          ? `\n\n*Agendado para amanhã:*\n${deferredItems.map((item) => `• ${item}`).join("\n")}`
          : "";
        const linkedOrderNote = order?.id
          ? "O checklist foi vinculado ao pedido em sistema."
          : "O checklist foi registrado; o vínculo com o pedido será concluído quando a origem/destino for conciliada.";
        const statusLabel = deferredItems.length && !pendingItems.length
          ? "agendado para amanhã"
          : checklistStatus === "separated"
          ? "separado completo"
          : "separado parcial";
        const notice = `📦 *Checklist de despacho — ${destinationLabel}*\n\nRafaela informou *${statusLabel}* para conferência.\n\n*Itens conferidos:*\n${itemSummary}${pendingSummary}${deferredSummary}\n\n${linkedOrderNote}`;
        await sendLogisticsGroupMessage(notice);
        await sendGroupMessage(
          `📦 *Atualização de separação — ${destinationLabel}*\n\nO checklist da Rafaela indica pedido *${statusLabel}*.${pendingItems.length ? `\n\nHá pendências informadas: ${pendingItems.join("; ")}.` : deferredItems.length ? `\n\nItens agendados para amanhã: ${deferredItems.join("; ")}.` : "\n\nNenhuma falta foi declarada."}`,
        );
        return Response.json({
          observed: true,
          manual_dispatch_checklist: true,
          status: checklistStatus,
          notified_logistics: true,
          notified_orders: true,
          replied_in_observer: false,
        });
      }
      if (!isBarSource && observation && looksLikeObservedOrder(message)) {
        const unitMatch = message.match(/\bP([1-7])\b/i);
        const requester = text(
          sender.senderName ||
            sender.chatName ||
            "Colaborador não identificado",
        );
        const originNote = observedKnownItems(message).length
          ? "📌 Origem confirmada: *coleta no P2*. O grupo de observação não recebe respostas do robô."
          : "📌 Origens dos itens: *aguardando organização do Fabio*. O grupo de observação não recebe respostas do robô.";
        await sendGroupMessage(
          `🧾 *Pedido observado para organização — P${unitMatch?.[1] || "?"}*\n📅 Entrega: *${observedDeliveryDate(message)}*\n\nSolicitante: *${requester}* · telefone final *${senderPhone.slice(-4)}*\n\n${organizedObservedText(message)}\n\n${originNote}`,
        );
        await sendLogisticsGroupMessage(
          `🧾 *Pedido observado — O Peixeiro Logística*\nDestino: *P${unitMatch?.[1] || "?"}*\nEntrega: *${observedDeliveryDate(message)}*\nSolicitante: *${requester}* · final *${senderPhone.slice(-4)}*\n\n${organizedObservedText(message)}\n\nOrigem e responsável pela separação: confirmar.`,
        );
        const saoPauloHour = Number(
          new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Sao_Paulo",
            hour: "2-digit",
            hourCycle: "h23",
          }).format(new Date()),
        );
        // Entre meia-noite e o corte das 05h, listas novas entram em
        // organização: não são confirmadas até que o solicitante esclareça
        // origem, quantidade e apresentação de cada item.
        if (saoPauloHour >= 0 && saoPauloHour < 5) {
          const clarification = `Olá, ${requester}! 😊 Antes de confirmar este pedido, informe para cada item a *origem/estoque*, a *quantidade* e a *apresentação* (unidade, caixa, pacote, maço, quilo, saco ou outra). Informe também quem será o *responsável pela separação/despacho*. Exemplo: “Mussarela: P2, 2 caixas. Despacho: João”. Assim o Assistente organiza corretamente antes de enviar à Logística.`;
          await sendGroupMessage(
            `📝 *Informação necessária para confirmar o pedido — P${unitMatch?.[1] || "?"}*\n\n${clarification}`,
          );
          await sendOfficialMessage(`${senderPhone}@c.us`, clarification);
          await db.from("opeixeiro_chatbot_conversation_audit").insert({
            phone_e164: senderPhone,
            participant_name: requester,
            channel: "whatsapp_private",
            direction: "system",
            intent: "overnight_order_origin_quantity_request",
            summary:
              "Pedido novo recebido para organização; solicitadas origem, quantidade e apresentação dos itens.",
            outcome: "Aguardando esclarecimentos antes da confirmação.",
            metadata: { destination_hint: unitMatch?.[0] || null },
          });
        }
      }
      return Response.json({
        observed: true,
        replied: false,
        source: isBarSource ? "bar_group" : "observer_group",
        forwarded_to_orders: Boolean(
          !isBarSource && observation && looksLikeObservedOrder(message),
        ),
        forwarded_to_logistics: Boolean(
          !isBarSource && observation && looksLikeObservedOrder(message),
        ),
      });
    }
    if (chatId === logisticsGroupId) {
      // Os donos acompanham o grupo, mas nunca participam da operação. Mesmo
      // que respondam SIM/NÃO/MAIS TARDE, a mensagem é ignorada por completo:
      // não há resposta do robô e não há qualquer alteração no sistema.
      const { data: silentOwners, error: silentOwnersError } = await db
        .from("opeixeiro_orders_bot_silent_phone_suffixes")
        .select("phone_suffix")
        .eq("active", true);
      if (silentOwnersError) throw silentOwnersError;
      if (
        (silentOwners || []).some((row: any) =>
          senderPhone.endsWith(text(row.phone_suffix)),
        )
      ) {
        return Response.json({ ignored: true, owner_silent: true });
      }
      const answer = message
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase();
      const status = /^SIM\b/.test(answer)
        ? "separated"
        : /^(NAO|NÃO)\b/.test(answer)
          ? "nothing_available"
          : /^MAIS\s*TARDE\b/.test(answer)
            ? "later"
            : "";
      if (!status) return Response.json({ ignored: true });
      const { data: checks, error: checksError } = await db
        .from("opeixeiro_stock_separation_checks")
        .select(
          "order_id,origin_unit_id,assigned_phone,opeixeiro_orders!inner(opeixeiro_units!opeixeiro_orders_destination_unit_id_fkey(code,name)),opeixeiro_units!opeixeiro_stock_separation_checks_origin_unit_id_fkey(code,name)",
        )
        .eq(
          "check_date",
          new Date().toLocaleDateString("en-CA", {
            timeZone: "America/Sao_Paulo",
          }),
        )
        .eq("status", "pending");
      if (checksError) throw checksError;
      const candidates = (checks || []).filter((check: any) => {
        const unit = check.opeixeiro_orders?.opeixeiro_units || {};
        const origin = check.opeixeiro_units || {};
        const destinationMatches =
          answer.includes(text(unit.code).toUpperCase()) ||
          answer.includes(
            text(unit.name)
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .toUpperCase(),
          );
        const originMatches =
          !check.origin_unit_id ||
          answer.includes(text(origin.code).toUpperCase()) ||
          answer.includes(
            text(origin.name)
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .toUpperCase(),
          );
        return destinationMatches && originMatches;
      });
      // Emergência pontual: Danilo confirmou as vodkas do Bar P1 no P2. A
      // resposta curta "SIM — 2 vodkas separadas" é suficiente para esse
      // único aviso, sem exigir que ele repita P1/P2.
      const vodkaEmergency =
        senderPhone === "5512981147680" && /\bvodka\b/.test(answer);
      const selected = vodkaEmergency
        ? (checks || []).find(
            (check: any) =>
              text(check.assigned_phone) === senderPhone &&
              text(
                check.opeixeiro_orders?.opeixeiro_units?.code,
              ).toUpperCase() === "BAR_P1" &&
              text(check.opeixeiro_units?.code).toUpperCase() === "P2",
          ) || null
        : candidates.length === 1
          ? candidates[0]
          : (checks || []).length === 1
            ? checks![0]
            : null;
      if (!selected)
        return Response.json({ ignored: true, reason: "unit_required" });
      // SIM/NÃO só vale quando veio do telefone autorizado para o estoque que
      // atende ao pedido. Uma resposta de outro membro do grupo é ignorada.
      const { data: authorizedContact, error: contactError } = await db
        .from("opeixeiro_logistics_stock_contacts")
        .select("display_name,unit_id")
        .eq("phone_e164", senderPhone)
        .eq("active", true)
        .maybeSingle();
      if (contactError) throw contactError;
      if (!authorizedContact && text(selected.assigned_phone) !== senderPhone)
        return Response.json({
          ignored: true,
          reason: "unauthorized_stock_contact",
        });
      // Pode haver mais de um responsável ativo pelo mesmo estoque. A
      // confirmação vale quando o telefone pertence a qualquer responsável
      // ativo da origem; pessoas de outros setores continuam ignoradas.
      const { data: pickupItems, error: pickupError } = await db
        .from("opeixeiro_order_items")
        .select("opeixeiro_order_item_pickups(origin_unit_id)")
        .eq("order_id", selected.order_id);
      if (pickupError) throw pickupError;
      const isAuthorizedForOrder =
        text(selected.assigned_phone) === senderPhone ||
        (pickupItems || []).some((item: any) =>
          (item.opeixeiro_order_item_pickups || []).some(
            (pickup: any) =>
              pickup.origin_unit_id === authorizedContact.unit_id,
          ),
        );
      if (!isAuthorizedForOrder)
        return Response.json({
          ignored: true,
          reason: "stock_contact_not_assigned_to_order",
        });
      const { error: responseError } = await db.rpc(
        "opeixeiro_record_stock_separation_response",
        {
          p_order_id: selected.order_id,
          p_origin_unit_id: selected.origin_unit_id,
          p_phone: senderPhone,
          p_name: text(sender.senderName || sender.chatName),
          p_status: status,
        },
      );
      if (responseError) throw responseError;
      if (status === "separated") {
        const { error: pendingError } = await db.rpc(
          "opeixeiro_open_missing_qr_recipient_confirmation",
          { p_order_id: selected.order_id },
        );
        if (pendingError) throw pendingError;
      }
      return Response.json({ stored: true, stock_separation: status });
    }
    // Conversas privadas também entram no fluxo: elas são usadas para
    // confirmação individual e para o organizador confirmar listas revisadas.
    if (chatId !== ordersGroupId && !isPrivateChat)
      return Response.json({ ignored: true });
    const { error } = await db.rpc("opeixeiro_orders_group_ingest_message", {
      p_group_chat_id: chatId,
      p_phone_e164: senderPhone,
      p_display_name: text(
        sender.senderName || sender.chatName || payload.senderName,
      ),
      p_message_text: message,
      p_green_message_id: text(payload.idMessage || payload.id_message),
      p_raw_payload: payload,
    });
    if (error) throw error;
    // Fotos de vinho publicadas pelo Fabio no grupo oficial entram somente na
    // coleta privada. Não geram resposta, estoque, pedido ou aviso ao grupo.
    const messageType = text(payload.messageData?.typeMessage);
    const isAdministrativeTimeSheet =
      /\b(?:folha|cartao|espelho|registro)\s+(?:de\s+)?ponto\b|\bponto\s+(?:dos?\s+)?funcionarios?\b/i.test(
        normalized(message),
      ) ||
      (["imageMessage", "documentMessage", "fileMessage"].includes(
        messageType,
      ) &&
        /\b(?:ponto|folha de pagamento|rh|horario de entrada|horario de saida)\b/i.test(
          normalized(message),
        ));
    if (isAdministrativeTimeSheet) {
      // O payload já foi preservado pelo ingest acima para auditoria. A partir
      // daqui ele não participa de catálogo, pedido, disponibilidade, despacho
      // nem confirmação e o robô não responde no grupo.
      return Response.json({
        stored: true,
        administrative_document: "time_sheet",
        ignored_by_orders_bot: true,
        replied: false,
      });
    }
    const isWinePhoto =
      messageType === "imageMessage" &&
      senderPhone === "5511989346164" &&
      /\b(vinho|wine)\b/i.test(message);
    if (isWinePhoto) {
      const declared = message.match(
        /\b(\d{1,4})\s*(?:unidade(?:s)?|und(?:s)?|un\.?|vinho)/i,
      );
      const quantity = declared ? Number(declared[1]) : null;
      const { error: wineError } = await db
        .from("opeixeiro_wine_photo_observations")
        .upsert(
          {
            green_message_id: text(payload.idMessage || payload.id_message),
            group_chat_id: ordersGroupId,
            sender_phone: senderPhone,
            sender_name: text(
              sender.senderName || sender.chatName || payload.senderName,
            ),
            caption_text: message || null,
            declared_quantity:
              Number.isFinite(quantity) && quantity && quantity > 0
                ? quantity
                : null,
            wine_description:
              message
                .replace(/^\s*\d+\s*(?:unidade(?:s)?|und(?:s)?|un\.?)?\s*/i, "")
                .trim() || null,
            image_download_url:
              text(payload.messageData?.fileMessageData?.downloadUrl) || null,
            mime_type:
              text(payload.messageData?.fileMessageData?.mimeType) || null,
            ocr_status: text(payload.messageData?.fileMessageData?.downloadUrl)
              ? "pending"
              : "not_available",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "green_message_id" },
        );
      if (wineError) throw wineError;
      return Response.json({
        stored: true,
        wine_photo_collected: true,
        replied: false,
      });
    }
    const { data: silentSuffixes, error: silentError } = await db
      .from("opeixeiro_orders_bot_silent_phone_suffixes")
      .select("phone_suffix")
      .eq("active", true);
    if (silentError) throw silentError;
    if (
      (silentSuffixes || []).some((row: any) =>
        senderPhone.endsWith(text(row.phone_suffix)),
      )
    ) {
      return Response.json({
        stored: true,
        owner_observed: true,
        replied: false,
      });
    }
    const { data: discovery } = await db
      .from("opeixeiro_bar_unit_discovery_sessions")
      .select("id,contact_id,proposed_unit_code")
      .eq("phone_e164", senderPhone)
      .eq("status", "awaiting")
      .order("opened_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (discovery) {
      const statedUnit = message.match(
        /\b(?:estou\s+(?:no|na)\s+)?p([1-7])\b/i,
      );
      const confirmedProposed =
        /^sim[.! ]*$/i.test(message) && text(discovery.proposed_unit_code);
      const targetCode = statedUnit
        ? `BAR_P${statedUnit[1]}`
        : confirmedProposed
          ? text(discovery.proposed_unit_code)
          : "";
      if (targetCode) {
        const { data: targetUnit, error: targetError } = await db
          .from("opeixeiro_units")
          .select("id,name,code")
          .eq("code", targetCode)
          .maybeSingle();
        if (targetError || !targetUnit)
          throw targetError || new Error("Bar informado não encontrado");
        const { error: linkError } = await db
          .from("opeixeiro_orders_group_contacts")
          .update({
            unit_id: targetUnit.id,
            role_label: `Representante do ${targetUnit.name}`,
            is_group_member: true,
            updated_at: new Date().toISOString(),
          })
          .eq("id", discovery.contact_id)
          .eq("phone_e164", senderPhone);
        if (linkError) throw linkError;
        await db
          .from("opeixeiro_bar_unit_discovery_sessions")
          .update({
            status: "confirmed",
            proposed_unit_code: targetCode,
            response_text: message,
            responded_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", discovery.id);
        await sendGroupMessage(
          `✅ Obrigado! Seu telefone final *${senderPhone.slice(-4)}* foi vinculado ao *${targetUnit.name}*. Agora o assistente poderá relacionar suas conferências somente a esse Bar.`,
        );
        return Response.json({
          stored: true,
          bar_unit_discovered: true,
          unit: targetCode,
        });
      }
    }
    const resolvedSenderName = text(
      sender.senderName || sender.chatName || payload.senderName,
    );
    const { data: contact } = await db
      .from("opeixeiro_orders_group_contacts")
      .select(
        "id,unit_id,panel_user_id,display_name,role_label,admission_status,opeixeiro_panel_users(display_name,default_unit_code),opeixeiro_units!opeixeiro_orders_group_contacts_unit_id_fkey(name,code)",
      )
      .eq("phone_e164", senderPhone)
      .maybeSingle();
    const profile = contact?.opeixeiro_panel_users as {
      display_name?: string;
      default_unit_code?: string;
    } | null;
    const linkedUnit = contact?.opeixeiro_units as {
      name?: string;
      code?: string;
    } | null;
    const personName = text(
      profile?.display_name ||
        contact?.display_name ||
        resolvedSenderName ||
        "pessoa responsável",
    );
    // O link de convite é apenas para a rede. Um número que entre por ele sem
    // cadastro prévio fica registrado como pendente e não consegue criar,
    // confirmar ou alterar pedidos até que o organizador valide o perfil.
    if (chatId === ordersGroupId && text(contact?.admission_status) !== "approved") {
      const { data: audit } = await db
        .from("opeixeiro_group_admission_audit")
        .select("id,created_at")
        .eq("group_chat_id", ordersGroupId)
        .eq("phone_e164", senderPhone)
        .maybeSingle();
      const justArrived = !audit || Date.now() - new Date(text(audit.created_at)).getTime() < 60_000;
      if (justArrived) {
        await sendGroupMessage(
          `🔒 ${personName}, seu número foi registrado para validação. O grupo é exclusivo da rede O Peixeiro; informe seu nome e unidade ao responsável. Enquanto a validação não for concluída, pedidos e confirmações deste telefone não serão processados.`,
        );
      }
      return Response.json({
        stored: true,
        admission_pending: true,
        phone_suffix: senderPhone.slice(-4),
      });
    }
    // Oferta de cobertura para emergência em aberto: não libera mercadoria
    // automaticamente. Registra quem tem o item e encaminha para definição
    // de separação/coleta, preservando o motorista como não informado até ele
    // se identificar no aplicativo ou no grupo.
    if (
      chatId === ordersGroupId &&
      /\b(?:tenho|temos|dispon[ií]vel|consigo\s+separar|posso\s+separar)\b/i.test(message)
    ) {
      const { data: emergencySession } = await db
        .from("opeixeiro_emergency_availability_sessions")
        .select("id,destination_code,requested_items")
        .eq("status", "awaiting_offers")
        .gt("expires_at", new Date().toISOString())
        .order("opened_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (emergencySession) {
        const parsedItems = await catalogItemsFromMessage(message);
        const requestedNames = Array.isArray(emergencySession.requested_items)
          ? emergencySession.requested_items.map((value: any) => normalized(text(value)))
          : [];
        const offeredItems = parsedItems.filter((item) =>
          requestedNames.some((requested) =>
            requested.includes(normalized(item.name)) || normalized(item.name).includes(requested)
          ),
        );
        if (offeredItems.length) {
          await db.from("opeixeiro_emergency_availability_offers").insert({
            session_id: emergencySession.id,
            phone_e164: senderPhone,
            display_name: personName,
            offered_items: offeredItems,
            source_text: message,
          });
          await db.from("opeixeiro_operational_events").insert({
            event_type: "offline_queued",
            actor_name: personName,
            occurred_at: new Date().toISOString(),
            metadata: {
              record_kind: "emergency_item_availability_offer",
              destination: text(emergencySession.destination_code),
              items: offeredItems,
              source_phone_suffix: senderPhone.slice(-4),
              status: "oferta registrada; aguardando atribuição",
            },
          });
          const offeredText = offeredItems
            .map((item) => `${item.qty} ${item.unit || itemUnitFor(item.name)} de ${item.name}`)
            .join("; ");
          await sendLogisticsGroupMessage(
            `🚨 Cobertura emergencial informada para ${text(emergencySession.destination_code)}: ${personName}, final ${senderPhone.slice(-4)}, relatou disponibilidade de ${offeredText}. Aguardar definição de separação e coleta antes de considerar em rota.`,
          );
          await sendGroupMessage(
            `✅ Disponibilidade registrada para ${text(emergencySession.destination_code)}: ${offeredText}. Informe se consegue separar agora e quem fará a coleta.`,
          );
          return Response.json({
            stored: true,
            emergency_availability_offer: true,
            destination: emergencySession.destination_code,
          });
        }
      }
    }
    // Compra adicional durante uma emergência: só é orientada após o
    // motorista/colaborador ser identificado e a fonte da verba ser citada.
    // O registro não substitui nota fiscal nem conclui a entrega.
    if (
      [ordersGroupId, logisticsGroupId].includes(chatId) &&
      /\b(?:verba|dinheiro|valor)\b/i.test(message) &&
      /\b(?:dona|maria|kotian)\b/i.test(message) &&
      /\b(?:comprar|compra|mercado|emerg[eê]ncia)\b/i.test(message)
    ) {
      const fundingSource = message.match(/\b(dona|maria|kotian)\b/i)?.[1] || "não informado";
      const offeredItems = await catalogItemsFromMessage(message);
      await db.from("opeixeiro_operational_events").insert({
        event_type: "offline_queued",
        actor_name: personName,
        occurred_at: new Date().toISOString(),
        metadata: {
          record_kind: "emergency_market_purchase_authorization",
          driver_or_collector_phone_suffix: senderPhone.slice(-4),
          funding_source: fundingSource,
          items: offeredItems,
          status: "aguardando compra, nota fiscal e confirmação de recebimento",
        },
      });
      await sendLogisticsGroupMessage(
        `🧾 Compra emergencial em acompanhamento: colaborador final ${senderPhone.slice(-4)} foi identificado para possível coleta/compra. Verba informada: ${fundingSource}. Itens: ${offeredItems.length ? offeredItems.map((item) => `${item.qty} ${item.unit || itemUnitFor(item.name)} de ${item.name}`).join("; ") : "a detalhar"}. Após comprar, anexar a nota fiscal no APK e confirmar o destino; a entrega não será baixada antes disso.`,
      );
      return Response.json({ stored: true, emergency_market_purchase_authorized: true });
    }
    const p2ReleaseAuthorized =
      temporaryP2DessertReleasePhones.has(senderPhone) ||
      (/\bp2\b/i.test(text(linkedUnit?.code || profile?.default_unit_code)) &&
        (/(?:confer|despach|bar|caixa)/i.test(text(contact?.role_label)) ||
          /(?:bar|caixa)/i.test(text(linkedUnit?.code))));
    if (
      chatId === ordersGroupId &&
      p2ReleaseAuthorized &&
      /^\s*(?:liberar|n[aã]o\s+liberar)\s+sobremesas\s*[.!]*\s*$/i.test(message)
    ) {
      const approved = !/^\s*n[aã]o\s+liberar/i.test(message);
      const { data: mousseAlertSession } = await db
        .from("opeixeiro_mousse_expiry_alert_sessions")
        .select("alert_date,removed_options")
        .eq("status", "awaiting_review")
        .order("alert_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      await db.from("opeixeiro_operational_events").insert({
        event_type: "offline_queued",
        actor_name: personName,
        occurred_at: new Date().toISOString(),
        metadata: {
          record_kind: "p2_dessert_dispatch_authorization",
          decision: approved ? "released" : "not_released",
          role: text(contact?.role_label),
          unit: text(linkedUnit?.code || profile?.default_unit_code),
          required_checks: [
            "quantidade física",
            "tempo de preparo",
            "tempo de geladeira",
            "produto gelado para transporte",
        ],
        removed_mousse_products: mousseAlertSession?.removed_options || [],
        },
      });
      if (mousseAlertSession) {
        const { error: sessionError } = await db
          .from("opeixeiro_mousse_expiry_alert_sessions")
          .update({
            status: approved ? "confirmed" : "cancelled",
            updated_at: new Date().toISOString(),
          })
          .eq("alert_date", mousseAlertSession.alert_date);
        if (sessionError) throw sessionError;
      }
      const removedNames = (mousseAlertSession?.removed_options || [])
        .map((item: any) => text(item.name))
        .filter(Boolean);
      const remainingNames = mousseAlertSession
        ? (Array.isArray(mousseAlertSession.removed_options)
            ? mousseAlertSession.removed_options
            : [])
        : [];
      await sendGroupMessage(
        approved
          ? `✅ *Liberação registrada — sobremesas P2*\n\n${personName} liberou o despacho.${removedNames.length ? `\n\nRetirados da conferência por já terem sido vendidos: ${removedNames.join(", ")}.` : ""}${remainingNames.length ? "\n\nOs demais itens permanecem na conferência física." : ""}\n\nAntes da coleta, confirmem quantidade física, tempo de preparo e de geladeira, e que os produtos estão *gelados para transporte*.`
          : `⛔ *Liberação não autorizada — sobremesas P2*\n\n${personName} informou que o despacho não deve seguir por enquanto.`,
      );
      return Response.json({
        stored: true,
        p2_dessert_dispatch_authorization: approved ? "released" : "not_released",
      });
    }
    if (chatId === ordersGroupId && /^\s*\d+(?:\s*[,;]\s*\d+)*\s*[.!]*\s*$/.test(message)) {
      const { data: alertSession } = await db
        .from("opeixeiro_mousse_expiry_alert_sessions")
        .select("alert_date,options,removed_options,status")
        .eq("status", "awaiting_review")
        .order("alert_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (alertSession) {
        const selected = [...new Set(
          message.split(/[,;]+/).map((value) => Number(value.trim())).filter(Number.isInteger),
        )];
        const options = Array.isArray(alertSession.options) ? alertSession.options : [];
        const validIndexes = selected.filter((value) => value >= 1 && value <= options.length);
        if (validIndexes.length) {
          const removed = Array.isArray(alertSession.removed_options)
            ? alertSession.removed_options
            : [];
          const nextRemoved = [
            ...removed,
            ...validIndexes.map((value) => options[value - 1]),
          ].filter((item, index, all) =>
            all.findIndex((candidate) => normalized(text(candidate.name)) === normalized(text(item.name))) === index,
          );
          await db
            .from("opeixeiro_mousse_expiry_alert_sessions")
            .update({
              removed_options: nextRemoved,
              updated_at: new Date().toISOString(),
            })
            .eq("alert_date", alertSession.alert_date);
          await sendGroupMessage(
            `✅ Retirei da conferencia: ${validIndexes.map((value) => text(options[value - 1].name)).join(", ")}.\n\nQuando terminar, responda *LIBERAR SOBREMESAS* ou *NAO LIBERAR SOBREMESAS*.`,
          );
          return Response.json({ stored: true, mousse_alert_items_removed: validIndexes });
        }
      }
    }
    // O organizador pode fechar a organização de uma lista já revisada pelo
    // privado, sem confundir isso com a separação física do estoque.
    if (
      isPrivateChat &&
      senderPhone === "5511989346164" &&
      /\b(?:confirm(?:ar|ado|a)|corrigir)\b/i.test(message)
    ) {
      const unitMatch = message.match(/\bP([1-7])\b/i);
      const suffixMatch = message.match(/\b(\d{4})\b/);
      let targetUnitId = "";
      if (suffixMatch) {
        const { data: receiverContact } = await db
          .from("opeixeiro_orders_group_contacts")
          .select("unit_id")
          .like("phone_e164", `%${suffixMatch[1]}`)
          .not("unit_id", "is", null)
          .limit(1)
          .maybeSingle();
        targetUnitId = text(receiverContact?.unit_id);
      }
      if (!targetUnitId && unitMatch) {
        const unitNumber = unitMatch[1];
        const { data: matchingUnits } = await db
          .from("opeixeiro_units")
          .select("id,code")
          .in("code", [
            `P${unitNumber}`,
            `COZINHA - P${unitNumber}`,
            `BAR - P${unitNumber}`,
            `BAR_P${unitNumber}`,
          ])
          .limit(10);
        const candidateUnitIds = (matchingUnits || []).map((unit: any) =>
          text(unit.id),
        );
        const todayForUnit = new Date().toLocaleDateString("en-CA", {
          timeZone: "America/Sao_Paulo",
        });
        const { data: pendingCandidate } = candidateUnitIds.length
          ? await db
              .from("opeixeiro_orders")
              .select("destination_unit_id")
              .in("destination_unit_id", candidateUnitIds)
              .gte("delivery_date", todayForUnit)
              .in("status", ["submitted", "scheduled_next_day"])
              .order("delivery_date", { ascending: true })
              .limit(1)
              .maybeSingle()
          : { data: null };
        targetUnitId = text(
          pendingCandidate?.destination_unit_id ||
            (matchingUnits || []).find(
              (unit: any) => unit.code === `P${unitNumber}`,
            )?.id ||
            (matchingUnits || [])[0]?.id,
        );
      }
      const today = new Date().toLocaleDateString("en-CA", {
        timeZone: "America/Sao_Paulo",
      });
      const { data: order } = targetUnitId
        ? await db
            .from("opeixeiro_orders")
            .select(
              "id,delivery_date,status,origin_unit_id,opeixeiro_units!opeixeiro_orders_destination_unit_id_fkey(name,code),opeixeiro_order_contributions(requester_name),opeixeiro_order_items(id,requested_qty,unit,opeixeiro_products(canonical_name,default_origin_unit_id))",
            )
            .eq("destination_unit_id", targetUnitId)
            .gte("delivery_date", today)
            .in("status", ["submitted", "scheduled_next_day"])
            .order("delivery_date", { ascending: true })
            .limit(1)
            .maybeSingle()
        : { data: null };
      if (order) {
        const items = order.opeixeiro_order_items || [];
        const volumes = items.reduce(
          (sum: number, item: any) => sum + (Number(item.requested_qty) || 0),
          0,
        );
        const unit: any = order.opeixeiro_units || {};
        const destinationLabel = text(unit.name || unit.code || "destino");
        const { data: originUnit } = order.origin_unit_id
          ? await db
              .from("opeixeiro_units")
              .select("name,code")
              .eq("id", order.origin_unit_id)
              .maybeSingle()
          : { data: null };
        const originLabel = text(
          originUnit?.name || originUnit?.code || "a confirmar",
        );
        const originIds = [
          ...new Set(
            items
              .map((item: any) =>
                text(item.opeixeiro_products?.default_origin_unit_id),
              )
              .filter(Boolean),
          ),
        ];
        const { data: itemOrigins } = originIds.length
          ? await db
              .from("opeixeiro_units")
              .select("id,name,code")
              .in("id", originIds)
          : { data: [] as any[] };
        const originById = new Map(
          (itemOrigins || []).map((item: any) => [
            text(item.id),
            text(item.code) === "CAIXA - P2"
              ? "Caixa P2"
              : text(item.name || item.code),
          ]),
        );
        // Correção de origem pelo organizador, por exemplo:
        // CORRIGIR P5 P2: mussarela, massa de pastel, presunto
        if (/\bcorrigir\b/i.test(message) && /\bp2\b/i.test(message)) {
          const correctionTerms = [
            ["mussarela", "Mussarela"],
            ["massa de pastel", "Massa de Pastel"],
            ["presunto", "Presunto"],
          ] as const;
          const requestedNames = correctionTerms
            .filter(([term]) => normalized(message).includes(term))
            .map(([, name]) => name);
          const correctionItems = items.filter((item: any) =>
            requestedNames.includes(
              text(item.opeixeiro_products?.canonical_name),
            ),
          );
          if (!correctionItems.length) {
            await sendOfficialMessage(
              `${senderPhone}@c.us`,
              "Não identifiquei os itens para corrigir. Use: *CORRIGIR P5 P2: mussarela, massa de pastel, presunto*.",
            );
            return Response.json({
              stored: true,
              organizer_origin_correction: false,
            });
          }
          const { data: p2Unit } = await db
            .from("opeixeiro_units")
            .select("id,name,code")
            .eq("code", "P2")
            .maybeSingle();
          if (!p2Unit) throw new Error("Unidade P2 não encontrada");
          const itemIds = correctionItems.map((item: any) => text(item.id));
          await db
            .from("opeixeiro_order_item_pickups")
            .delete()
            .in("order_item_id", itemIds)
            .neq("origin_unit_id", p2Unit.id);
          for (const item of correctionItems) {
            await db.from("opeixeiro_order_item_pickups").upsert(
              {
                order_item_id: item.id,
                origin_unit_id: p2Unit.id,
                planned_qty: item.requested_qty,
                checker_name: "Origem corrigida pelo organizador",
              },
              { onConflict: "order_item_id,origin_unit_id" },
            );
          }
          const correctedLines = correctionItems
            .map(
              (item: any) =>
                `• ${text(item.opeixeiro_products?.canonical_name)}: ${text(item.requested_qty)} ${text(item.unit)}`,
            )
            .join("\n");
          const correctionNotice = `✏️ *Correção de origem — ${destinationLabel}*\n\nO organizador corrigiu a coleta para *P2*:\n${correctedLines}\n\nA Peixaria não deve separar estes itens.`;
          await sendOfficialMessage(
            `${senderPhone}@c.us`,
            `✅ Corrigi a origem para *P2*:\n${correctedLines}`,
          );
          await sendGroupMessage(correctionNotice);
          await sendLogisticsGroupMessage(correctionNotice);
          await db.from("opeixeiro_operational_events").insert({
            order_id: order.id,
            event_type: "offline_queued",
            actor_name: "Fabio — Organizador",
            metadata: {
              record_kind: "organizer_origin_correction",
              corrected_origin: "P2",
              items: correctionItems.map((item: any) => ({
                name: text(item.opeixeiro_products?.canonical_name),
                qty: item.requested_qty,
                unit: item.unit,
              })),
            },
          });
          return Response.json({
            stored: true,
            organizer_origin_correction: "P2",
          });
        }
        const requestedOrigin = /\bpeixaria\b/i.test(message)
          ? "Peixaria"
          : /\balbatroz\b/i.test(message)
            ? "Albatroz — Estoque"
            : /\bcaixa\s*p2\b/i.test(message)
              ? "Caixa P2"
              : /\bconfirm(?:ar|ado|a)\s+p[1-7]\s+p2\b/i.test(message)
                ? "P2"
                : "";
        const scopedItems = requestedOrigin
          ? items.filter(
              (item: any) =>
                originById.get(
                  text(item.opeixeiro_products?.default_origin_unit_id),
                ) === requestedOrigin,
            )
          : items;
        if (requestedOrigin && !scopedItems.length) {
          await sendOfficialMessage(
            `${senderPhone}@c.us`,
            `Não localizei itens de *${requestedOrigin}* neste pedido para ${destinationLabel}.`,
          );
          return Response.json({
            stored: true,
            organizer_origin_not_found: true,
          });
        }
        const scopedVolumes = scopedItems.reduce(
          (sum: number, item: any) => sum + (Number(item.requested_qty) || 0),
          0,
        );
        const requester = text(
          order.opeixeiro_order_contributions?.[0]?.requester_name ||
            "não identificado",
        );
        const itemLines = scopedItems
          .map((item: any) => {
            const product = item.opeixeiro_products || {};
            const collectionOrigin =
              originById.get(text(product.default_origin_unit_id)) ||
              originLabel;
            return `• ${text(product.canonical_name || "Item")}: ${text(item.requested_qty)} ${text(item.unit || "unidade")} — coleta: ${collectionOrigin}`;
          })
          .join("\n");
        await db
          .from("opeixeiro_orders")
          .update({ status: "submitted", updated_at: new Date().toISOString() })
          .eq("id", order.id);
        await db.from("opeixeiro_operational_events").insert({
          order_id: order.id,
          event_type: "offline_queued",
          actor_name: "Fabio — Organizador",
          metadata: {
            record_kind: "organizer_order_confirmed",
            confirmation_channel: "whatsapp_private",
            item_types: items.length,
            volumes,
          },
        });
        const announcement = requestedOrigin
          ? `✅ *Origem confirmada pelo organizador — ${requestedOrigin} → ${destinationLabel}*\n\n*Data de entrega:* ${text(order.delivery_date)}\n*Solicitante:* ${requester}\n*Confirmador:* Fabio — organizador, via chatbot privado\n\n*Itens desta origem para separação:*\n${itemLines}\n\n*Total desta origem:* ${scopedItems.length} tipo(s) de item · ${scopedVolumes} volume(s).\n*Próxima etapa:* separação destes itens pela origem informada.`
          : `✅ *Pedido organizado e confirmado — ${destinationLabel}*\n\n*Data de entrega:* ${text(order.delivery_date)}\n*Solicitante:* ${requester}\n*Confirmador:* Fabio — organizador, via chatbot privado\n*Origem de coleta:* indicada em cada item abaixo\n\n*Itens para separação:*\n${itemLines}\n\n*Total:* ${items.length} tipo(s) de item · ${volumes} volume(s).\n*Próxima etapa:* separação pelo estoque; o pedido ainda não está marcado como separado.`;
        await sendOfficialMessage(
          `${senderPhone}@c.us`,
          requestedOrigin
            ? `✅ Origem *${requestedOrigin}* do pedido para *${destinationLabel}* confirmada por você. São ${scopedItems.length} tipo(s) de item e ${scopedVolumes} volume(s) para esta separação.`
            : `✅ Pedido para *${destinationLabel}* confirmado por você como organizador. São ${items.length} tipo(s) de item e ${volumes} volume(s). Ele segue agora para a separação do estoque.`,
        );
        await sendGroupMessage(announcement);
        await sendLogisticsGroupMessage(announcement);
        await db.from("opeixeiro_chatbot_conversation_audit").insert({
          phone_e164: senderPhone,
          participant_name: "Fabio — Organizador",
          channel: "whatsapp_private",
          direction: "system",
          intent: "organizer_order_confirmation",
          order_id: order.id,
          summary: `Pedido de ${destinationLabel} confirmado manualmente pelo organizador no privado.`,
          outcome: "Pedido organizado; grupos Pedidos e Logística avisados.",
          metadata: { item_types: items.length, volumes },
        });
        return Response.json({
          stored: true,
          organizer_confirmed_order: order.id,
        });
      }
      await sendOfficialMessage(
        `${senderPhone}@c.us`,
        "Não localizei um pedido pendente com essa referência. Envie, por exemplo, *CONFIRMAR P5* ou *CONFIRMAR 3895*.",
      );
      return Response.json({
        stored: true,
        organizer_confirmation_not_found: true,
      });
    }
    // Confirmação privada em linguagem natural: não exige que a pessoa repita
    // comandos exatos. "recebi tudo", "chegou certinho" e equivalentes
    // encerram somente o pedido pendente da própria unidade; relatos parciais
    // continuam abertos até a descrição das diferenças.
    const naturalReceipt = normalized(message);
    // "OK", "sim" ou "isso" isolados são confirmação ambígua: não mudam
    // entrega, saldo nem agendamento. O chatbot pede a opção explícita e
    // registra a necessidade de conferência para o relatório.
    if (
      isPrivateChat &&
      contact?.unit_id &&
      /^(?:ok|sim|isso|certo)$/i.test(naturalReceipt)
    ) {
      await db.from("opeixeiro_operational_events").insert({
        event_type: "offline_queued",
        actor_name: personName,
        occurred_at: new Date().toISOString(),
        metadata: {
          record_kind: "ambiguous_private_receipt_confirmation",
          responder_phone_suffix: senderPhone.slice(-4),
          response_text: safeConversationRecord(message),
          status: "aguardando confirmação objetiva: chegou tudo, parcial ou não chegou",
        },
      });
      await sendOfficialMessage(
        `${senderPhone}@c.us`,
        "Obrigado. Para eu registrar corretamente, responda apenas: CHEGOU TUDO, CHEGOU PARCIAL ou NÃO CHEGOU. Se foi parcial, diga o que faltou; a pendência será organizada para o próximo dia.",
      );
      return Response.json({ stored: true, ambiguous_receipt_confirmation: true });
    }
    // Emergências vinculadas apenas por rota/foto ainda não possuem pedido
    // formal. O recebedor pode confirmar pelo privado sem depender de QR: a
    // resposta cria a trilha de acompanhamento, mas não inventa itens.
    if (isPrivateChat && contact?.unit_id) {
      const destinationCode = text(linkedUnit?.code || profile?.default_unit_code).toUpperCase();
      const emergencyArrivalAnswer =
        /\b(?:chegou\s+tudo|chegou\s+completo|recebi\s+tudo|chegou\s+parcial|faltou|ainda\s+n[aã]o\s+veio\s+motorista|n[aã]o\s+veio\s+motorista)\b/.test(naturalReceipt);
      if (destinationCode && emergencyArrivalAnswer) {
        const { data: routeEmergency } = await db
          .from("opeixeiro_operational_events")
          .select("id,metadata")
          .eq("event_type", "offline_queued")
          .in("metadata->>record_kind", [
            "emergency_item_candidate_route_link",
            "p3_emergency_consolidated_with_photo_route",
          ])
          .eq("metadata->>destination", destinationCode)
          .order("occurred_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (routeEmergency) {
          const arrivalStatus = /ainda\s+n[aã]o\s+veio\s+motorista|n[aã]o\s+veio\s+motorista/.test(naturalReceipt)
            ? "motorista ainda não chegou"
            : /parcial|faltou/.test(naturalReceipt)
              ? "recebimento parcial informado"
              : "recebimento completo informado";
          await db.from("opeixeiro_operational_events").insert({
            event_type: "offline_queued",
            actor_name: personName,
            occurred_at: new Date().toISOString(),
            metadata: {
              record_kind: "emergency_route_receiver_response",
              route_emergency_event_id: routeEmergency.id,
              destination: destinationCode,
              status: arrivalStatus,
              responder_phone_suffix: senderPhone.slice(-4),
              response_text: safeConversationRecord(message),
              receipt_flow: "confirmação privada do recebedor; aplicativo permanece disponível",
            },
          });
          await sendOfficialMessage(
            `${senderPhone}@c.us`,
            arrivalStatus === "motorista ainda não chegou"
              ? "Obrigado. Registrei que o motorista ainda não chegou. Quando receber, confirme pelo aplicativo ou responda aqui se chegou tudo ou em partes."
              : "Obrigado pela confirmação. Sua resposta foi registrada; se houver diferença, envie os itens e as quantidades para a conferência.",
          );
          await sendLogisticsGroupMessage(
            arrivalStatus === "motorista ainda não chegou"
              ? `📌 Emergência para ${destinationCode}: recebedor informou que o motorista ainda não chegou. Acompanhamento segue aberto.`
              : `📌 Emergência para ${destinationCode}: recebimento informado pelo responsável. Conferência registrada para acompanhamento.`,
          );
          return Response.json({ stored: true, emergency_route_receiver_response: arrivalStatus });
        }
      }
    }
    if (isPrivateChat && contact?.unit_id) {
      const confirmsComplete =
        /\b(?:chegou\s+(?:tudo|completo|certinho)|recebi\s+(?:tudo|completo)|recebemos\s+(?:tudo|completo)|tudo\s+(?:chegou|certo|ok)|sem\s+falta)\b/.test(
          naturalReceipt,
        );
      const confirmsPartial =
        /\b(?:chegou\s+(?:parcial|em\s+partes)|faltou|falta|veio\s+a\s+mais|veio\s+mais|nao\s+chegou|não\s+chegou)\b/.test(
          naturalReceipt,
        );
      if (confirmsComplete || confirmsPartial) {
        const today = new Date().toLocaleDateString("en-CA", {
          timeZone: "America/Sao_Paulo",
        });
        const { data: pendingOrder } = await db
          .from("opeixeiro_orders")
          .select(
            "id,delivery_date,opeixeiro_units!opeixeiro_orders_destination_unit_id_fkey(name,code),opeixeiro_order_items(requested_qty,unit,opeixeiro_products(canonical_name))",
          )
          .eq("destination_unit_id", contact.unit_id)
          .lte("delivery_date", today)
          .not("status", "in", "(delivered,cancelled)")
          .order("delivery_date", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (pendingOrder) {
          const unit: any = pendingOrder.opeixeiro_units || {};
          const destinationLabel = text(unit.name || unit.code || "destino");
          if (confirmsComplete) {
            const receivedItems = pendingOrder.opeixeiro_order_items || [];
            const totalVolumes = receivedItems.reduce(
              (sum: number, item: any) =>
                sum + (Number(item.requested_qty) || 0),
              0,
            );
            const itemLines = receivedItems
              .map(
                (item: any) =>
                  `• ${text(item.opeixeiro_products?.canonical_name || "Item")}: ${text(item.requested_qty)} ${text(item.unit || "unidade")}`,
              )
              .join("\n");
            await db
              .from("opeixeiro_orders")
              .update({
                status: "delivered",
                updated_at: new Date().toISOString(),
              })
              .eq("id", pendingOrder.id);
            await sendOfficialMessage(
              `${senderPhone}@c.us`,
              `Obrigada pela confirmação, ${personName}! 😊 Registrei que o pedido para *${destinationLabel}* chegou completo. Quando precisar, pode enviar um novo pedido por aqui; estou à disposição para ajudar.`,
            );
            await sendLogisticsGroupMessage(
              `✅ *Recebimento confirmado — ${destinationLabel}*\n\n${personName} confirmou pelo chatbot, em conversa privada, que o pedido chegou *completo*.\n\n*Confirmado:* ${receivedItems.length} tipo(s) de item · ${totalVolumes} volume(s)\n${itemLines}\n\nRegistro concluído no sistema.`,
            );
            await sendGroupMessage(
              `✅ *Atualização de pedido — ${destinationLabel}*\n\n${personName} confirmou pelo chatbot, em conversa privada, que recebeu o pedido *completo*.\n\n*Confirmado:* ${receivedItems.length} tipo(s) de item · ${totalVolumes} volume(s)\n${itemLines}`,
            );
            await db.from("opeixeiro_chatbot_conversation_audit").insert({
              phone_e164: senderPhone,
              participant_name: personName,
              channel: "whatsapp_private",
              direction: "system",
              intent: "natural_complete_receipt_confirmation",
              order_id: pendingOrder.id,
              summary:
                "Confirmação completa reconhecida em linguagem natural no privado.",
              outcome: "Pedido concluído e Logística avisada.",
              metadata: {
                destination: destinationLabel,
                item_types: receivedItems.length,
                volumes: totalVolumes,
                items: receivedItems,
              },
            });
            return Response.json({ stored: true, natural_receipt: "complete" });
          }
          await sendOfficialMessage(
            `${senderPhone}@c.us`,
            `Entendi, ${personName}. Deixei o pedido para *${destinationLabel}* em conferência. Fique à vontade para informar o que faltou: a pendência será organizada para o próximo dia. Por favor, me diga quais itens faltaram ou quais vieram a mais, com as quantidades. Se tiver dúvida sobre algum item, pode me dizer também de qual *origem/estoque* ele veio e se é *caixa, pacote ou unidade*; eu organizo para você.`,
          );
          await sendLogisticsGroupMessage(
            `⚠️ *Recebimento com divergência — ${destinationLabel}*\n\n${personName} respondeu pelo chatbot privado que há conferência parcial/diferença. O assistente solicitou os itens e quantidades antes de concluir o pedido.`,
          );
          await sendGroupMessage(
            `⚠️ *Atualização de pedido — ${destinationLabel}*\n\n${personName} respondeu ao chatbot no privado que o recebimento foi *parcial ou teve divergência*. A conferência dos itens e quantidades está em andamento.`,
          );
          return Response.json({ stored: true, natural_receipt: "partial" });
        }
      }
    }
    // Confirmações de recebimento do P1 podem vir da Laura ou de um
    // conferente substituto (por exemplo, Nunes). Só encerra a entrega com
    // uma confirmação inequívoca de que chegou tudo; relatos de falta ou a
    // simples identificação de quem conferiu mantêm o pedido em acompanhamento.
    const receiptAnswer = normalized(message);
    const namesP1Checker =
      /\b(?:laura|nunes)\b/.test(receiptAnswer) ||
      /\b(?:laura|nunes)\b/.test(normalized(personName));
    const mentionsP1Receipt =
      /\b(?:p1|cozinha\s*(?:do|da)?\s*p1|peixe|peixes|recebi|recebemos|chegou|chegaram|conferi|conferido|faltou|falta)\b/.test(
        receiptAnswer,
      );
    if (namesP1Checker && mentionsP1Receipt) {
      const today = new Date().toLocaleDateString("en-CA", {
        timeZone: "America/Sao_Paulo",
      });
      const { data: kitchenP1 } = await db
        .from("opeixeiro_units")
        .select("id,name")
        .eq("code", "COZINHA_P1")
        .maybeSingle();
      const { data: p1Order } = kitchenP1
        ? await db
            .from("opeixeiro_orders")
            .select("id,status")
            .eq("destination_unit_id", kitchenP1.id)
            .eq("delivery_date", today)
            .in("status", [
              "submitted",
              "separated",
              "partially_separated",
              "in_transit",
            ])
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()
        : { data: null };
      if (p1Order) {
        const saysComplete =
          /\b(?:chegou\s+(?:tudo|completo)|recebi\s+(?:tudo|completo)|recebemos\s+(?:tudo|completo)|tudo\s+(?:chegou|certo|ok)|sem\s+falta)\b/.test(
            receiptAnswer,
          );
        const saysMissing =
          /\b(?:faltou|falta|em\s+falta|nao\s+chegou|não\s+chegou|parcial)\b/.test(
            receiptAnswer,
          );
        const checker = /\blaura\b/.test(receiptAnswer)
          ? "Laura"
          : /\bnunes\b/.test(receiptAnswer)
            ? "Nunes"
            : personName;
        const update: Record<string, unknown> = {
          checker_name: checker,
          recipient_name: checker,
          updated_at: new Date().toISOString(),
        };
        if (saysComplete && !saysMissing) update.status = "delivered";
        await db.from("opeixeiro_orders").update(update).eq("id", p1Order.id);
        await db.from("opeixeiro_operational_events").insert({
          event_type: "offline_queued",
          actor_name: checker,
          occurred_at: new Date().toISOString(),
          metadata: {
            record_kind: "p1_receipt_chat_confirmation",
            order_id: p1Order.id,
            checker,
            response: message,
            result:
              saysComplete && !saysMissing
                ? "complete"
                : saysMissing
                  ? "missing_or_partial"
                  : "checker_identified",
          },
        });
        if (saysComplete && !saysMissing) {
          await sendGroupMessage(
            `✅ *Recebimento confirmado — Cozinha P1*\n\n${checker} confirmou que o pedido chegou completo.`,
          );
          await sendLogisticsGroupMessage(
            `✅ *Pedido concluído — Cozinha P1*\n\nConferente: *${checker}*. Recebimento completo confirmado no grupo de Pedidos.`,
          );
        } else if (saysMissing) {
          await sendGroupMessage(
            `⚠️ *Conferência registrada — Cozinha P1*\n\nConferente: *${checker}*. Foram informadas faltas ou entrega parcial. Descreva os itens e quantidades para concluir o checklist.`,
          );
          await sendLogisticsGroupMessage(
            `⚠️ *Acompanhamento — Cozinha P1*\n\n${checker} informou falta ou recebimento parcial. Pedido permanece em acompanhamento.`,
          );
        } else {
          await sendGroupMessage(
            `📌 *Conferente identificado — Cozinha P1*\n\n${checker} ficou registrado como responsável pela conferência. Informe agora se chegou tudo ou quais itens faltaram.`,
          );
        }
        return Response.json({
          stored: true,
          p1_receipt_confirmation:
            saysComplete && !saysMissing
              ? "complete"
              : saysMissing
                ? "partial_or_missing"
                : "checker_identified",
        });
      }
    }
    const { data: manualPending } = await db
      .from("opeixeiro_manual_collection_pending_confirmations")
      .select("id,product_name,pending_qty,unit,status")
      .eq("contact_phone", senderPhone)
      .eq("status", "awaiting")
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (manualPending) {
      const pendingAnswer = normalized(message);
      const needsIt = /^(?:sim\b|precis|ainda\s+precis|quero\b)/.test(
        pendingAnswer,
      );
      const doesNotNeedIt = /^(?:nao\b|n[aã]o\s+precis|dispens)/.test(
        pendingAnswer,
      );
      if (needsIt || doesNotNeedIt) {
        const status = needsIt ? "confirmed_needed" : "not_needed";
        await db
          .from("opeixeiro_manual_collection_pending_confirmations")
          .update({
            status,
            response_text: message,
            responded_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", manualPending.id);
        const notice = needsIt
          ? `✅ ${personName} confirmou: ainda precisa de *${manualPending.pending_qty} ${manualPending.unit}* de *${manualPending.product_name}* para amanhã.`
          : `✅ ${personName} confirmou: não precisa mais da pendência de *${manualPending.product_name}* para amanhã.`;
        await sendGroupMessage(notice);
        await sendLogisticsGroupMessage(
          `📌 *Atualização automática de pendência*\n\n${notice}\n\nOrigem: resposta individual no grupo de Pedidos.`,
        );
        return Response.json({
          stored: true,
          manual_collection_pending_confirmation: status,
        });
      }
    }
    const isAntonio = personName.toLocaleLowerCase("pt-BR").includes("antonio");
    const isDanilo = personName.toLocaleLowerCase("pt-BR").includes("danilo");
    const destination = text(
      linkedUnit?.name ||
        linkedUnit?.code ||
        profile?.default_unit_code ||
        "unidade ainda não vinculada",
    );
    const role = text(contact?.role_label)
      ? `Identifiquei você como *${text(contact?.role_label)}* de *${destination}*.`
      : `Seu setor identificado é *${destination}*.`;
    const isOrganizer = normalized(text(contact?.role_label)).includes(
      "organizador",
    );
    // Fabio pode preencher manualmente a conferência da Maria (Cozinha P2).
    // Essa autorização é interna: nenhuma mensagem explicando a permissão é enviada ao grupo.
    if (isOrganizer && senderPhone === "5511989346164") {
      const today = new Date().toLocaleDateString("en-CA", {
        timeZone: "America/Sao_Paulo",
      });
      const { data: maria } = await db
        .from("opeixeiro_orders_group_contacts")
        .select(
          "id,unit_id,display_name,opeixeiro_units!opeixeiro_orders_group_contacts_unit_id_fkey(name,code)",
        )
        .eq("phone_e164", "5512996505842")
        .maybeSingle();
      const mariaUnit = maria?.opeixeiro_units as {
        name?: string;
        code?: string;
      } | null;
      if (maria?.id && text(mariaUnit?.code).includes("P2")) {
        const { data: manualSession } = await db
          .from("opeixeiro_kitchen_availability_check_sessions")
          .select("id,status,unit_id,proposed_items")
          .eq("contact_id", maria.id)
          .eq("check_date", today)
          .in("status", ["awaiting", "awaiting_confirmation"])
          .maybeSingle();
        if (
          manualSession?.status === "awaiting_confirmation" &&
          /^sim[.! ]*$/i.test(message)
        ) {
          const items = Array.isArray(manualSession.proposed_items)
            ? manualSession.proposed_items
            : [];
          for (const item of items)
            await db.from("opeixeiro_portion_availability_reports").upsert(
              {
                unit_id: manualSession.unit_id,
                contact_id: maria.id,
                product_id: item.id,
                availability: item.availability,
                reported_at: new Date().toISOString(),
              },
              { onConflict: "unit_id,product_id" },
            );
          await db
            .from("opeixeiro_kitchen_availability_check_sessions")
            .update({
              status: "confirmed",
              confirmed_at: new Date().toISOString(),
              response_text: `Preenchido manualmente por Fabio (${senderPhone})`,
              updated_at: new Date().toISOString(),
            })
            .eq("id", manualSession.id);
          const available = items
            .filter((item: any) => item.availability === "available")
            .map((item: any) => item.name);
          const unavailable = items
            .filter((item: any) => item.availability === "unavailable")
            .map((item: any) => item.name);
          await sendGroupMessage(
            `✅ *Disponibilidade confirmada — ${text(mariaUnit?.name || "Cozinha P2")}*\n${available.length ? `Tem: ${available.join(", ")}.\n` : ""}${unavailable.length ? `Não tem: ${unavailable.join(", ")}.` : ""}`,
          );
          await sendKitchenAvailabilityPrintout(
            manualSession.id,
            "Cozinha P2",
            unavailable,
            today,
          );
          return Response.json({
            stored: true,
            kitchen_availability_confirmed_by_organizer: true,
          });
        }
        if (manualSession?.status === "awaiting") {
          const items = await kitchenAvailabilityFromMessage(message);
          if (items.length) {
            await db
              .from("opeixeiro_kitchen_availability_check_sessions")
              .update({
                status: "awaiting_confirmation",
                proposed_items: items,
                response_text: `Preenchido manualmente por Fabio (${senderPhone}): ${message}`,
                updated_at: new Date().toISOString(),
              })
              .eq("id", manualSession.id);
            const available = items
              .filter((item) => item.availability === "available")
              .map((item) => item.name);
            const unavailable = items
              .filter((item) => item.availability === "unavailable")
              .map((item) => item.name);
            await sendGroupMessage(
              `Para a *${text(mariaUnit?.name || "Cozinha P2")}*, identifiquei:\n${available.length ? `• *Tem:* ${available.join(", ")}\n` : ""}${unavailable.length ? `• *Não tem:* ${unavailable.join(", ")}\n` : ""}\nVocê confirma estas informações? Responda *SIM* ou envie a correção.`,
            );
            return Response.json({
              stored: true,
              kitchen_availability_proposed_by_organizer: true,
            });
          }
        }
      }
      // Mensagens administrativas livres continuam para o assistente privado.
      // As confirmações específicas da Maria já retornaram acima.
      if (!(isPrivateChat && senderPhone === "5511989346164"))
        return Response.json({ stored: true, organizer_observed: true });
    }
    if (isOrganizer && isPrivateChat && senderPhone === "5511989346164") {
      const reply = await organizerPrivateAssistantReply(message);
      await sendOfficialMessage(`${senderPhone}@c.us`, reply);
      return Response.json({
        stored: true,
        organizer_private_assistant: true,
      });
    }
    if (isOrganizer)
      return Response.json({ stored: true, organizer_observed: true });
    if (!message) return Response.json({ stored: true });
    if (contact?.id) {
      const today = new Date().toLocaleDateString("en-CA", {
        timeZone: "America/Sao_Paulo",
      });
      const isBarContact = /^BAR(?:_|\s*-\s*)P[1-7]$/i.test(
        text(linkedUnit?.code),
      );
      if (isBarContact) {
        const { data: barSession } = await db
          .from("opeixeiro_bar_availability_sessions")
          .select("id,status,unit_id,proposed_items")
          .eq("contact_id", contact.id)
          .eq("check_date", today)
          .in("status", ["awaiting", "awaiting_confirmation"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (
          barSession?.status === "awaiting_confirmation" &&
          /^sim[.! ]*$/i.test(message)
        ) {
          const items = Array.isArray(barSession.proposed_items)
            ? barSession.proposed_items
            : [];
          for (const item of items)
            await db.from("opeixeiro_bar_availability_reports").upsert(
              {
                unit_id: barSession.unit_id,
                contact_id: contact.id,
                product_id: item.id,
                availability: item.availability,
                reported_at: new Date().toISOString(),
              },
              { onConflict: "unit_id,product_id" },
            );
          await db
            .from("opeixeiro_bar_availability_sessions")
            .update({
              status: "confirmed",
              confirmed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", barSession.id);
          const unavailable = items
            .filter((item: any) => item.availability === "unavailable")
            .map((item: any) => item.name);
          const available = items
            .filter((item: any) => item.availability === "available")
            .map((item: any) => item.name);
          await sendGroupMessage(
            `✅ *Disponibilidade confirmada — ${destination}*\n${available.length ? `Tem: ${available.join(", ")}.\n` : ""}${unavailable.length ? `Não tem: ${unavailable.join(", ")}.` : ""}`,
          );
          await sendBarAvailabilityPrintout(
            barSession.id,
            destination,
            personName,
            unavailable,
            today,
          );
          return Response.json({
            stored: true,
            bar_availability_confirmed: true,
          });
        }
        const barItems = await barAvailabilityFromMessage(message);
        if (barItems.length) {
          const sessionResult = barSession
            ? await db
                .from("opeixeiro_bar_availability_sessions")
                .update({
                  status: "awaiting_confirmation",
                  proposed_items: barItems,
                  response_text: message,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", barSession.id)
            : await db.from("opeixeiro_bar_availability_sessions").insert({
                unit_id: contact.unit_id,
                contact_id: contact.id,
                check_date: today,
                status: "awaiting_confirmation",
                proposed_items: barItems,
                response_text: message,
              });
          const sessionError = sessionResult.error;
          if (sessionError) throw sessionError;
          const unavailable = barItems
            .filter((item: any) => item.availability === "unavailable")
            .map((item: any) => item.name);
          const available = barItems
            .filter((item: any) => item.availability === "available")
            .map((item: any) => item.name);
          await sendGroupMessage(
            `${personName}, para o *${destination}* identifiquei:\n${available.length ? `• *Tem:* ${available.join(", ")}\n` : ""}${unavailable.length ? `• *Não tem:* ${unavailable.join(", ")}\n` : ""}\nVocê confirma? Responda *SIM* ou envie a lista corrigida.`,
          );
          return Response.json({
            stored: true,
            bar_availability_proposed: true,
          });
        }
      }
      const { data: availabilitySession } = await db
        .from("opeixeiro_kitchen_availability_check_sessions")
        .select("id,status,unit_id,proposed_items")
        .eq("contact_id", contact.id)
        .eq("check_date", today)
        .in("status", ["awaiting", "awaiting_confirmation"])
        .maybeSingle();
      if (
        availabilitySession?.status === "awaiting_confirmation" &&
        /^sim[.! ]*$/i.test(message)
      ) {
        const items = Array.isArray(availabilitySession.proposed_items)
          ? availabilitySession.proposed_items
          : [];
        for (const item of items)
          await db.from("opeixeiro_portion_availability_reports").upsert(
            {
              unit_id: availabilitySession.unit_id,
              contact_id: contact.id,
              product_id: item.id,
              availability: item.availability,
              reported_at: new Date().toISOString(),
            },
            { onConflict: "unit_id,product_id" },
          );
        await db
          .from("opeixeiro_kitchen_availability_check_sessions")
          .update({
            status: "confirmed",
            confirmed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", availabilitySession.id);
        const available = items
          .filter((item: any) => item.availability === "available")
          .map((item: any) => item.name);
        const unavailable = items
          .filter((item: any) => item.availability === "unavailable")
          .map((item: any) => item.name);
        await sendGroupMessage(
          `✅ *Disponibilidade confirmada — ${personName}*\n${available.length ? `Tem: ${available.join(", ")}.\n` : ""}${unavailable.length ? `Não tem: ${unavailable.join(", ")}.` : ""}`,
        );
        // A lista é enviada apenas após a confirmação explícita do cozinheiro.
        // Não há disparo retroativo nem mensagem de teste neste deploy.
        await sendKitchenAvailabilityPrintout(
          availabilitySession.id,
          personName,
          unavailable,
          today,
        );
        return Response.json({
          stored: true,
          kitchen_availability_confirmed: true,
        });
      }
      if (availabilitySession?.status === "awaiting") {
        const items = await kitchenAvailabilityFromMessage(message);
        if (items.length) {
          await db
            .from("opeixeiro_kitchen_availability_check_sessions")
            .update({
              status: "awaiting_confirmation",
              proposed_items: items,
              response_text: message,
              updated_at: new Date().toISOString(),
            })
            .eq("id", availabilitySession.id);
          const available = items
            .filter((item) => item.availability === "available")
            .map((item) => item.name);
          const unavailable = items
            .filter((item) => item.availability === "unavailable")
            .map((item) => item.name);
          await sendGroupMessage(
            `${personName}, identifiquei:\n${available.length ? `• *Tem:* ${available.join(", ")}\n` : ""}${unavailable.length ? `• *Não tem:* ${unavailable.join(", ")}\n` : ""}\nVocê confirma estas informações? Responda *SIM* ou envie a correção.`,
          );
          return Response.json({
            stored: true,
            kitchen_availability_proposed: true,
          });
        }
      }
    }
    const keepCarryoverAnswer =
      /^(sim\b.*(quero|pode mandar)?|quero ainda|pode mandar)/i.test(
        message.trim(),
      );
    if (isDanilo && keepCarryoverAnswer) {
      const { data: reviews } = await db
        .from("opeixeiro_orders_group_carryover_reviews")
        .select("id,recipient_phone")
        .eq("recipient_name", personName)
        .eq("status", "awaiting")
        .order("created_at", { ascending: false })
        .limit(1);
      const review = reviews?.[0];
      if (
        review &&
        (!review.recipient_phone || review.recipient_phone === senderPhone)
      ) {
        await db
          .from("opeixeiro_orders_group_carryover_reviews")
          .update({
            status: "keep",
            recipient_phone: senderPhone,
            responded_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", review.id);
        await sendGroupMessage(
          `✅ Perfeito, Danilo. Os itens continuam agendados para a próxima entrega.\n\nVocê quer fazer um novo pedido? Envie os itens aqui no grupo ou responda *SISTEMA* para lançar manualmente.\n\n${operationalGreeting()}! Obrigado por confirmar e ajudar a manter o pedido atualizado. 🙏`,
        );
        return Response.json({ stored: true, carryover_kept: true });
      }
    }
    let recipientUnitId = text(contact?.unit_id);
    if (isDanilo) {
      const { data: barUnit } = await db
        .from("opeixeiro_units")
        .select("id")
        .eq("code", "BAR_P2")
        .maybeSingle();
      recipientUnitId = text(barUnit?.id);
      if (recipientUnitId && contact?.id) {
        await db
          .from("opeixeiro_orders_group_contacts")
          .update({
            unit_id: recipientUnitId,
            display_name: personName,
            updated_at: new Date().toISOString(),
          })
          .eq("id", contact.id);
        await db
          .from("opeixeiro_missing_qr_recipient_confirmations")
          .update({
            recipient_phone: senderPhone,
            updated_at: new Date().toISOString(),
          })
          .eq("unit_id", recipientUnitId)
          .eq("status", "awaiting")
          .eq("recipient_name", personName);
      }
    }
    if (recipientUnitId) {
      const { data: emergencyRows } = await db
        .from("opeixeiro_orders_group_emergency_receipts")
        .select("id,status,report_mode,recipient_phone,recipient_name,order_id")
        .eq("recipient_name", personName)
        .in("status", [
          "awaiting_answer",
          "awaiting_method",
          "awaiting_items",
          "awaiting_missing_confirmation",
        ])
        .order("requested_at", { ascending: false })
        .limit(20);
      const emergency = (emergencyRows || []).find(
        (row: any) =>
          text(row.recipient_phone) === senderPhone ||
          (!row.recipient_phone &&
            normalized(text(row.recipient_name)) === normalized(personName)),
      );
      const emergencyAnswer = normalized(message);
      if (emergency && !emergency.recipient_phone) {
        await db
          .from("opeixeiro_orders_group_emergency_receipts")
          .update({
            recipient_phone: senderPhone,
            updated_at: new Date().toISOString(),
          })
          .eq("id", emergency.id);
      }
      if (
        emergency &&
        emergency.status === "awaiting_answer" &&
        /\b(nao chegou|chegou em partes|chegou em parte|chegou parcial|chegou)\b/.test(
          emergencyAnswer,
        )
      ) {
        const emergencyStatus = /nao chegou/.test(emergencyAnswer)
          ? "not_received"
          : "awaiting_method";
        await db
          .from("opeixeiro_orders_group_emergency_receipts")
          .update({
            status: emergencyStatus,
            response_text: message,
            responded_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", emergency.id);
        if (emergencyStatus === "not_received") {
          await sendGroupMessage(
            `Registro de emergência: *não chegou*, Danilo. A informação foi anexada ao sistema.`,
          );
        } else {
          await sendGroupMessage(
            `Certo, Danilo. O que é mais fácil informar: *o que veio* ou *o que faltou*? Se faltou algo, já pode escrever os itens na resposta.`,
          );
        }
        return Response.json({
          stored: true,
          emergency_receipt_answer: emergencyStatus,
        });
      }
      if (emergency && emergency.status === "awaiting_method") {
        const mode = /faltou|falta/.test(emergencyAnswer)
          ? "missing"
          : /veio|chegou/.test(emergencyAnswer)
            ? "came"
            : "";
        const items = await catalogItemsFromMessage(message);
        if (mode === "missing" && items.length) {
          await db
            .from("opeixeiro_orders_group_emergency_receipts")
            .update({
              status: "awaiting_missing_confirmation",
              report_mode: "missing",
              response_text: message,
              updated_at: new Date().toISOString(),
            })
            .eq("id", emergency.id);
          await sendGroupMessage(
            await missingItemsConfirmation(text(emergency.order_id), items),
          );
          return Response.json({ stored: true, emergency_missing_items: true });
        }
        if (mode) {
          await db
            .from("opeixeiro_orders_group_emergency_receipts")
            .update({
              status: "awaiting_items",
              report_mode: mode,
              response_text: message,
              updated_at: new Date().toISOString(),
            })
            .eq("id", emergency.id);
          await sendGroupMessage(
            mode === "missing"
              ? "Informe os itens que faltaram e as quantidades."
              : "Informe os itens que vieram e as quantidades.",
          );
          return Response.json({
            stored: true,
            emergency_receipt_method: mode,
          });
        }
      }
      if (
        emergency &&
        emergency.status === "awaiting_missing_confirmation" &&
        /^sim[.! ]*$/i.test(message)
      ) {
        await db
          .from("opeixeiro_orders_group_emergency_receipts")
          .update({
            status: "partial",
            responded_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", emergency.id);
        await sendGroupMessage(
          "✅ Faltas confirmadas e anexadas ao sistema. Obrigado, Danilo.",
        );
        return Response.json({
          stored: true,
          emergency_missing_confirmed: true,
        });
      }
      if (emergency && emergency.status === "awaiting_items") {
        const emergencyItems = await catalogItemsFromMessage(message);
        if (emergencyItems.length) {
          if (emergency.report_mode === "missing") {
            await db
              .from("opeixeiro_orders_group_emergency_receipts")
              .update({
                status: "awaiting_missing_confirmation",
                response_text: message,
                updated_at: new Date().toISOString(),
              })
              .eq("id", emergency.id);
            await sendGroupMessage(
              await missingItemsConfirmation(
                text(emergency.order_id),
                emergencyItems,
              ),
            );
            return Response.json({
              stored: true,
              emergency_missing_items: true,
            });
          }
          await db
            .from("opeixeiro_orders_group_emergency_receipts")
            .update({
              status: "partial",
              response_text: message,
              responded_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", emergency.id);
          await sendGroupMessage(
            `✅ Itens recebidos registrados: ${emergencyItems.map((item) => `${item.qty} caixa(s) de ${item.name}`).join(", ")}. A informação foi anexada ao sistema.`,
          );
          return Response.json({ stored: true, emergency_receipt_items: true });
        }
      }
      const { data: pendingRows } = await db
        .from("opeixeiro_missing_qr_recipient_confirmations")
        .select("id,recipient_phone,recipient_name")
        .eq("unit_id", recipientUnitId)
        .eq("status", "awaiting")
        .order("opened_at", { ascending: false })
        .limit(20);
      const pending = (pendingRows || []).find(
        (row: any) =>
          text(row.recipient_phone) === senderPhone ||
          (!row.recipient_phone &&
            normalized(text(row.recipient_name)) === normalized(personName)),
      );
      const answer = normalized(message);
      if (
        pending &&
        /\b(nao chegou|chegou em partes|chegou em parte|chegou parcial|chegou)\b/.test(
          answer,
        )
      ) {
        const receiptStatus = /nao chegou/.test(answer)
          ? "not_received"
          : /chegou em partes|chegou em parte|chegou parcial/.test(answer)
            ? "partial"
            : "received";
        const { error: receiptError } = await db
          .from("opeixeiro_missing_qr_recipient_confirmations")
          .update({
            status: receiptStatus,
            response_text: message,
            recipient_phone: senderPhone,
            recipient_name: personName,
            responded_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", pending.id);
        if (receiptError) throw receiptError;
        const acknowledgement =
          receiptStatus === "received"
            ? "Recebimento confirmado."
            : receiptStatus === "partial"
              ? "Recebimento parcial registrado."
              : "Ausência de recebimento registrada.";
        await sendGroupMessage(
          `✅ ${acknowledgement} Obrigado, ${personName}. A pendência foi anexada ao sistema e o agendamento da próxima entrega para ${destination} está liberado.`,
        );
        return Response.json({
          stored: true,
          receipt_confirmation: receiptStatus,
        });
      }
    }
    if (/^refazer[.! ]*$/i.test(message)) {
      const { error: resetError } = await db
        .from("opeixeiro_orders_group_draft_sessions")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("phone_e164", senderPhone)
        .eq("group_chat_id", ordersGroupId)
        .eq("status", "active");
      if (resetError) throw resetError;
      await sendGroupMessage(
        `Certo, ${personName}. Zerei os itens temporários deste pedido. Envie a nova lista do começo quando quiser.`,
      );
      return Response.json({ stored: true, draft_reset: true });
    }
    if (/^sim[.! ]*$/i.test(message)) {
      const { data: drafts } = await db
        .from("opeixeiro_orders_group_draft_sessions")
        .select("id,items,destination")
        .eq("phone_e164", senderPhone)
        .eq("group_chat_id", ordersGroupId)
        .eq("status", "active")
        .gt("expires_at", new Date().toISOString())
        .limit(1);
      const draft = drafts?.[0] as any;
      if (draft) {
        await db
          .from("opeixeiro_orders_group_draft_sessions")
          .update({ status: "confirmed", updated_at: new Date().toISOString() })
          .eq("id", draft.id);
        const lines = (draft.items || [])
          .map(
            (item: any) =>
              `• ${item.name}: ${item.qty} ${item.unit || itemUnitFor(item.name)}${Number(item.qty) === 1 ? "" : "s"}`,
          )
          .join("\n");
        await sendGroupMessage(
          `✅ *Pedido confirmado, ${personName}!*\n\nItens para ${draft.destination}:\n${lines}\n\n${operationalGreeting()} e obrigado!`,
        );
        return Response.json({ stored: true, draft_confirmed: true });
      }
      if (contact?.unit_id) {
        const today = new Date().toLocaleDateString("en-CA", {
          timeZone: "America/Sao_Paulo",
        });
        const { data: existingOrder } = await db
          .from("opeixeiro_orders")
          .select(
            "id,delivery_date,status,opeixeiro_order_items(requested_qty,unit,opeixeiro_products(canonical_name)),opeixeiro_order_keywords(keyword_label,expires_at)",
          )
          .eq("destination_unit_id", contact.unit_id)
          // Um pedido pendente de dia anterior também precisa ser consolidado
          // antes do corte; ignorá-lo criava uma segunda lista para o mesmo
          // setor, como ocorreu no Bar P2.
          .lte("delivery_date", today)
          .in("status", ["submitted", "scheduled_next_day"])
          .order("delivery_date", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (existingOrder) {
          const orderItems = (existingOrder.opeixeiro_order_items || [])
            .map(
              (item: any) =>
                `• ${text(item.opeixeiro_products?.canonical_name)}: ${item.requested_qty} ${text(item.unit)}`,
            )
            .join("\n");
          const keyword = Array.isArray(existingOrder.opeixeiro_order_keywords)
            ? existingOrder.opeixeiro_order_keywords[0]
            : existingOrder.opeixeiro_order_keywords;
          await sendGroupMessage(
            `✅ *Pedido pendente localizado, ${personName}!*\n\nEntrega registrada: *${text(existingOrder.delivery_date)}*\nDestino: *${destination}*\n\n${orderItems}\n\nAntes das *05h*, o assistente mantém esta lista como base de consolidação: novos itens devem ser somados aqui, e não enviados como um segundo pedido. ${text(keyword?.keyword_label) ? `Palavra-chave deste ciclo: *${text(keyword.keyword_label)}*.` : "A palavra-chave deste ciclo está sendo preparada."}`,
          );
          return Response.json({
            stored: true,
            existing_order_confirmed: true,
            order_id: existingOrder.id,
          });
        }
      }
      await sendGroupMessage(
        `✅ *Simulação confirmada, ${personName}!*\n\nRecebi sua confirmação para ${destination}. Nesta primeira etapa de teste, o bot registrou a simulação e ainda não criou o pedido automaticamente no sistema.`,
      );
      return Response.json({ stored: true, simulated_confirmation: true });
    }
    if (
      /^(sistema|manual|pedido manual|usar o sistema|usar sistema)[.! ]*$/i.test(
        message,
      )
    ) {
      await sendGroupMessage(
        `Tudo bem, ${personName}! Você pode lançar ou ajustar o pedido manualmente pelo aplicativo do O Peixeiro. Se necessário, o arquivo de acesso individual será enviado no privado.\n\nAo concluir o lançamento, ele seguirá o fluxo normal do sistema.`,
      );
      return Response.json({ stored: true, manual_system_requested: true });
    }
    // Dúvidas sobre o fluxo temporário de emergência: a versão atual não
    // exige QR no início desse cenário. A prova é foto/conferência, e a
    // conciliação de dois emergenciais com um consolidado fica planejada para
    // a próxima atualização — nunca é anunciada como recurso já liberado.
    if (
      [ordersGroupId, logisticsGroupId].includes(chatId) &&
      /\b(?:qr\s*code|qrcode|dois\s+emergencia|emerg[eê]ncia.*consolid|consolid.*emerg[eê]ncia|foto.*confer[eê]ncia)\b/i.test(message)
    ) {
      await sendOfficialMessage(
        `${chatId}@g.us`,
        "📌 Nesta fase da emergência, o aplicativo não exige QR Code no início: a conferência é feita por foto no Pedidos/Recebidos e a entrega só é finalizada após compra, comprovante, foto e confirmação do destino. A conciliação de até dois pedidos emergenciais junto a um consolidado está planejada para a próxima atualização do aplicativo.",
      );
      return Response.json({ stored: true, emergency_app_phase_explained: true });
    }
    if (message.includes("?")) {
      await sendGroupMessage(
        `Olá, ${personName}! Sou o chatbot de assistência do O Peixeiro. Use a senha enviada para selecionar seu perfil e acessar o sistema; registre nele os itens separados. Quando o motorista chegar, peça que ele use o aplicativo do motorista para registrar coleta e entrega — assim não será necessário guardar fotos no WhatsApp. No início, ele ainda deve fotografar somente o local de saída para o local de entrega, como de costume.`,
      );
      return Response.json({ stored: true, answered_question: true });
    }
    const items = await catalogItemsFromMessage(message);
    if (!items.length) {
      await sendGroupMessage(
        `Olá, ${personName}! Não encontrei itens do catálogo nessa mensagem. Frases como “boa noite” e “para amanhã” não entram no pedido. Envie os nomes dos produtos; quando não houver quantidade, considerarei *1 caixa*.`,
      );
      return Response.json({ stored: true, no_catalog_items: true });
    }
    const { data: drafts } = await db
      .from("opeixeiro_orders_group_draft_sessions")
      .select("id,items")
      .eq("phone_e164", senderPhone)
      .eq("group_chat_id", ordersGroupId)
      .eq("status", "active")
      .gt("expires_at", new Date().toISOString())
      .limit(1);
    const draft = drafts?.[0] as any;
    const draftItems = mergeDraftItems(
      Array.isArray(draft?.items) ? draft.items : [],
      items,
    );
    if (draft) {
      await db
        .from("opeixeiro_orders_group_draft_sessions")
        .update({
          items: draftItems,
          destination,
          expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", draft.id);
    } else {
      await db.from("opeixeiro_orders_group_draft_sessions").insert({
        phone_e164: senderPhone,
        group_chat_id: ordersGroupId,
        destination,
        items: draftItems,
      });
    }
    const corrected = draftItems
      .map(
        (item) =>
          `• ${item.name}: ${item.qty} ${item.unit || itemUnitFor(item.name)}${item.qty === 1 ? "" : "s"}`,
      )
      .join("\n");
    await sendGroupMessage(
      [
        `Olá, ${personName}! ${role}`,
        "",
        `*Itens adicionados ao pedido temporário para ${destination}:*`,
        corrected,
        "",
        "Envie mais itens quando quiser. Quando terminar, responda *SIM* para confirmar tudo, *EDITAR* para corrigir ou *SISTEMA* para lançar manualmente.",
      ].join("\n"),
    );
    return Response.json({ stored: true });
  } catch (error) {
    console.error("Orders group webhook error", error);
    return Response.json(
      {
        stored: false,
        error: text(error instanceof Error ? error.message : error),
      },
      { status: 500 },
    );
  }
});
