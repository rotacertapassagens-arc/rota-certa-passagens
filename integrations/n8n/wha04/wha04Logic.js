// WHA-04 (Criar e Vincular Orçamentos) - lógica pura, sem I/O.
//
// Fonte única do código embutido nos Code nodes do workflow n8n "WHA-04 — Criar e Vincular
// Orçamentos" (ver ../build-wha-site-handoff.mjs). Sem import/export de propósito: o build cola este
// arquivo no início de cada Code node, e os testes carregam o mesmo texto com node:vm.
//
// Contrato canônico (2026-10-01), aplicado igualmente às origens WHA-01 e SITE_FORM:
//   tipoViagem: "so_ida" | "ida_e_volta"          (aceita "somente_ida", "ida", "one_way", "round_trip"...)
//   cabine:     "economica" | "premium_economica" | "executiva" | "primeira"
//               (aceita "premium economica", "primeira_classe", "business", "first"...)
//   bagagem:    "item_pessoal" | "bagagem_de_mao" | "bagagem_despachada" | texto livre do WHA-01 | null
//   escalas:    preferenciaEscalas "somente_direto" | "aceita_escalas" | "sem_preferencia"
//               (vooDireto/aceitaEscalas continuam true/false/null; ausência nunca vira aceitação)
//   origem/destino: WHA-01 exige IATA de 3 letras; SITE_FORM aceita a cidade/aeroporto digitado no
//               site (texto validado), porque o site não converte cidade em IATA.

const ALLOWED_SOURCES = new Set(["WHA-01", "SITE_FORM"]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

// Número do WhatsApp só com dígitos. Celular brasileiro no formato antigo (55 + DDD + 8 dígitos
// começando por 6-9) ganha o 9: é o mesmo número escrito de duas formas, e o WhatsApp ainda entrega
// contas antigas sem o 9. A comparação continua sendo do número inteiro.
function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) fail("INVALID_PHONE", "Telefone inválido para o WHA-04.");
  if (digits.length === 12 && digits.startsWith("55") && /[6-9]/.test(digits[4])) {
    return `${digits.slice(0, 4)}9${digits.slice(4)}`;
  }
  return digits;
}

function normalizeIata(value, field) {
  const code = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) fail("INVALID_IATA", `${field} deve ser um código IATA de três letras.`);
  return code;
}

// Formulário do site: cidade ou aeroporto como a pessoa digitou. Código IATA puro vira maiúsculo.
function normalizePlaceText(value, field) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length < 2 || text.length > 160 || /[\u0000-\u001f<>]/.test(text)) {
    fail("INVALID_PLACE", `${field} deve ser uma cidade ou aeroporto válido.`);
  }
  return /^[A-Za-z]{3}$/.test(text) ? text.toUpperCase() : text;
}

function normalizeDate(value, field, required = true) {
  if ((value === null || value === undefined || value === "") && !required) return null;
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    fail("INVALID_DATE", `${field} deve estar em AAAA-MM-DD.`);
  }
  return text;
}

function normalizeCount(value, field, minimum = 0) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > 20) {
    fail("INVALID_PASSENGER_COUNT", `${field} possui quantidade inválida.`);
  }
  return number;
}

function normalizeOptionalText(value, max = 200) {
  if (value === null || value === undefined || value === "") return null;
  return String(value).trim().slice(0, max) || null;
}

function aliasKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\s-]+/g, "_")
    .trim();
}

const TRIP_TYPE_ALIASES = {
  so_ida: "so_ida",
  somente_ida: "so_ida",
  apenas_ida: "so_ida",
  ida: "so_ida",
  one_way: "so_ida",
  oneway: "so_ida",
  ida_e_volta: "ida_e_volta",
  ida_volta: "ida_e_volta",
  round_trip: "ida_e_volta",
  roundtrip: "ida_e_volta",
};

function normalizeTripType(value) {
  const canonical = TRIP_TYPE_ALIASES[aliasKey(value)];
  if (!canonical) fail("UNSUPPORTED_TRIP_TYPE", "O WHA-04 aceita viagens só de ida ou ida e volta.");
  return canonical;
}

const CABIN_ALIASES = {
  economica: "economica",
  economy: "economica",
  premium_economica: "premium_economica",
  premium_economy: "premium_economica",
  premium: "premium_economica",
  executiva: "executiva",
  business: "executiva",
  primeira: "primeira",
  primeira_classe: "primeira",
  first: "primeira",
  first_class: "primeira",
};

function normalizeCabin(value) {
  if (value === null || value === undefined || value === "") return null;
  const canonical = CABIN_ALIASES[aliasKey(value)];
  if (!canonical) fail("UNSUPPORTED_CABIN", "Classe de cabine não reconhecida.");
  return canonical;
}

const BAGGAGE_CODES = new Set(["item_pessoal", "bagagem_de_mao", "bagagem_despachada"]);

// Códigos do site ficam canônicos; texto livre do WHA-01 ("só de mão", "23kg despachada") é preservado.
function normalizeBaggage(value) {
  if (value === null || value === undefined || value === "") return null;
  const key = aliasKey(value);
  if (BAGGAGE_CODES.has(key)) return key;
  return normalizeOptionalText(value);
}

const BAGGAGE_LABELS = {
  item_pessoal: "Somente item pessoal",
  bagagem_de_mao: "Bagagem de mão",
  bagagem_despachada: "Bagagem despachada",
};

function optionalBoolean(value) {
  return value === true ? true : value === false ? false : null;
}

// Três estados, sem converter ausência em aceitação:
// vooDireto true ou aceitaEscalas false -> somente_direto; aceitaEscalas true ou vooDireto false ->
// aceita_escalas; nenhum dos dois informado (ou contraditório) -> sem_preferencia.
function normalizeStops(raw) {
  const vooDireto = optionalBoolean(raw.vooDireto);
  const aceitaEscalas = optionalBoolean(raw.aceitaEscalas);
  const direct = vooDireto === true || aceitaEscalas === false;
  const stops = aceitaEscalas === true || vooDireto === false;
  if (direct && !stops) return { preferenciaEscalas: "somente_direto", vooDireto: true, aceitaEscalas: false };
  if (stops && !direct) return { preferenciaEscalas: "aceita_escalas", vooDireto: false, aceitaEscalas: true };
  return { preferenciaEscalas: "sem_preferencia", vooDireto: null, aceitaEscalas: null };
}

function normalizeCollected(raw, { source = "WHA-01" } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("MISSING_COLLECTED", "Dados estruturados da viagem ausentes.");
  const tipoViagem = normalizeTripType(raw.tipoViagem);
  const dataIda = normalizeDate(raw.dataIda, "dataIda");
  const dataVolta = tipoViagem === "ida_e_volta" ? normalizeDate(raw.dataVolta, "dataVolta") : null;
  // O site aceita ida e volta no mesmo dia (bate e volta); o WHA-01 mantém a regra estrita de antes.
  if (dataVolta && (source === "SITE_FORM" ? dataVolta < dataIda : dataVolta <= dataIda)) {
    fail("INVALID_DATE_ORDER", "A volta deve ser posterior à ida.");
  }
  if (raw.consentimento !== true) fail("CONSENT_REQUIRED", "Consentimento explícito é obrigatório.");

  const adultos = normalizeCount(raw.adultos, "adultos", 1);
  const criancas = normalizeCount(raw.criancas ?? 0, "criancas");
  const bebes = normalizeCount(raw.bebes ?? 0, "bebes");
  const idadesCriancas = Array.isArray(raw.idadesCriancas)
    ? raw.idadesCriancas.map((idade) => normalizeCount(idade, "idadesCriancas")).slice(0, criancas + bebes)
    : [];
  const place = source === "SITE_FORM" ? normalizePlaceText : normalizeIata;

  return {
    nome: normalizeOptionalText(raw.nome, 100),
    origem: place(raw.origem, "origem"),
    destino: place(raw.destino, "destino"),
    tipoViagem,
    dataIda,
    dataVolta,
    datasFlexiveis: raw.datasFlexiveis === true,
    adultos,
    criancas,
    idadesCriancas,
    bebes,
    ...normalizeStops(raw),
    bagagem: normalizeBaggage(raw.bagagem),
    cabine: normalizeCabin(raw.cabine),
    prioridade: normalizeOptionalText(raw.prioridade, 50),
    companhiaPreferida: normalizeOptionalText(raw.companhiaPreferida, 100),
    maxEscalas: raw.maxEscalas === null || raw.maxEscalas === undefined ? null : normalizeCount(raw.maxEscalas, "maxEscalas"),
    consentimento: true,
  };
}

function normalizeWha04Input(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("INVALID_INPUT", "Entrada do WHA-04 inválida.");
  const source = String(input.source || "").trim().toUpperCase();
  if (!ALLOWED_SOURCES.has(source)) fail("INVALID_SOURCE", "Origem do pedido não autorizada.");
  const phone = normalizePhone(input.phone);
  const contactName = normalizeOptionalText(input.contactName, 100);

  if (source === "SITE_FORM") {
    const protocol = String(input.protocol || "").trim().toUpperCase();
    if (!/^RC-\d{4}-\d{5,}$/.test(protocol)) fail("INVALID_PROTOCOL", "Protocolo do formulário inválido.");
    const base = {
      source,
      requestId: `SITE-${protocol}`,
      submissionId: `site:${protocol}`,
      protocol,
      phone,
      contactName,
    };
    if (!input.collected) return { ...base, needsSiteLookup: true, collected: null, classificacao: null };
    return { ...base, needsSiteLookup: false, collected: normalizeCollected(input.collected, { source }), classificacao: input.classificacao || null };
  }

  const requestId = String(input.requestId || "").trim();
  if (!/^WHA-[A-Za-z0-9._:-]{3,120}$/.test(requestId)) fail("INVALID_REQUEST_ID", "requestId do WHA-01 inválido.");
  return {
    source,
    requestId,
    submissionId: `wha04:${requestId}`,
    protocol: null,
    phone,
    contactName,
    needsSiteLookup: false,
    collected: normalizeCollected(input.collected, { source }),
    classificacao: input.classificacao || null,
  };
}

function mergeSiteProposal(normalized, proposal) {
  if (!normalized || normalized.source !== "SITE_FORM") fail("INVALID_SITE_CONTEXT", "Contexto do formulário inválido.");
  if (!proposal || typeof proposal !== "object") fail("SITE_PROPOSAL_NOT_FOUND", "Proposta do site não encontrada.");
  const responseProtocol = String(proposal.protocol || "").trim().toUpperCase();
  if (responseProtocol !== normalized.protocol) fail("SITE_PROTOCOL_MISMATCH", "O protocolo retornado pelo site não confere.");
  const responsePhone = normalizePhone(proposal.phone);
  if (responsePhone !== normalized.phone) fail("SITE_PHONE_MISMATCH", "O telefone não corresponde ao protocolo informado.");
  return {
    ...normalized,
    contactName: normalized.contactName || normalizeOptionalText(proposal.contactName || proposal.name, 100),
    needsSiteLookup: false,
    collected: normalizeCollected(
      { ...proposal.collected, nome: proposal.name || null, consentimento: proposal.collected?.consentimento === true },
      { source: "SITE_FORM" },
    ),
    classificacao: proposal.classificacao || null,
  };
}

const CLASS_TO_NOTION = {
  economica: "Económica",
  premium_economica: "Premium Economy",
  executiva: "Executiva",
  primeira: "Primeira Classe",
};

function buildNotionDraft(normalized) {
  if (!normalized || normalized.needsSiteLookup || !normalized.collected) fail("UNRESOLVED_INPUT", "Pedido ainda não foi resolvido.");
  const c = normalized.collected;
  const nome = c.nome || normalized.contactName || "Cliente WhatsApp";
  const classificationMap = { quente: "Quente", morno: "Morno", frio: "Frio" };
  const classificacaoObj = normalized.classificacao && typeof normalized.classificacao === "object" ? normalized.classificacao : null;
  return {
    ...normalized,
    title: `${normalized.source === "SITE_FORM" ? "Site" : "WhatsApp"} — ${nome} — ${c.origem}→${c.destino}`,
    notion: {
      origem: c.origem,
      destino: c.destino,
      dataIda: c.dataIda,
      dataVolta: c.dataVolta,
      adultos: c.adultos,
      criancas: c.criancas,
      bebes: c.bebes,
      classe: CLASS_TO_NOTION[c.cabine] || null,
      bagagem: BAGGAGE_LABELS[c.bagagem] || c.bagagem || "",
      // Checkbox não tem "vazio": sem preferência fica com os dois desmarcados, e o estado real
      // (preferenciaEscalas) vai no Pedido JSON.
      vooDireto: c.preferenciaEscalas === "somente_direto",
      aceitaEscalas: c.preferenciaEscalas === "aceita_escalas",
      companhiaPreferida: c.companhiaPreferida || "",
      maxEscalas: c.maxEscalas,
      classificacao: classificationMap[classificacaoObj?.classificacao] || null,
      estado: "Novo",
      tipoPesquisa: "Dinheiro + Milhas",
      worker: "WHA-04",
      pedidoJson: JSON.stringify({
        source: normalized.source,
        protocol: normalized.protocol,
        requestId: normalized.requestId,
        collected: c,
        classificacao: normalized.classificacao,
      }).slice(0, 1990),
    },
  };
}

function buildSafeResult(draft, pageId, duplicate = false) {
  if (!draft?.requestId || !pageId) fail("PERSISTENCE_NOT_CONFIRMED", "Persistência do pedido não confirmada.");
  return {
    accepted: true,
    requestId: draft.requestId,
    submissionId: draft.submissionId,
    protocol: draft.protocol,
    notionPageId: pageId,
    duplicate: Boolean(duplicate),
  };
}
