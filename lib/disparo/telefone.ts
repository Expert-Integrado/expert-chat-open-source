// Telefone do publico de disparo — validacao DURA e chave de deduplicacao.
//
// PURO de proposito: nao importa nada. Roda no Next e em node solto (e o que a
// prova `scripts/prova-disparo.ts` exercita, sem rede e sem banco).
//
// Por que validacao dura: num disparo, telefone torto nao vira "uma mensagem
// que nao chegou" — vira erro do provedor no meio do lote, e o operador so
// descobre depois. Aqui o destino invalido e barrado ANTES de a campanha sair
// do rascunho, com motivo legivel pra pessoa corrigir a planilha.

// Mesmo formato aceito pelo /api/send (DESTINO_VALIDO): telefone com DDI ou id
// de grupo do WhatsApp. Regra em dois lugares diverge — se aquela mudar, esta
// tem que mudar junto (por isso o comentario, e por isso a prova cobre as duas).
const TELEFONE_RE = /^\d{10,15}$/;
const GRUPO_RE = /^\d{15,25}-group$/;

export type DestinoValido = {
  ok: true;
  /** chave de roteamento no painel: telefone so-digitos ou "<id>-group" */
  chat_id: string;
  /** o telefone normalizado (vazio quando o destino e grupo) */
  telefone: string;
  grupo: boolean;
};
export type DestinoInvalido = { ok: false; motivo: string };
export type Destino = DestinoValido | DestinoInvalido;

/**
 * Normaliza um telefone/identificador vindo de planilha, filtro ou lista salva.
 * Aceita mascara ("+55 (11) 91234-5678"), id de grupo do WhatsApp (com sufixo
 * "-group" ou "@g.us") e o chat_id cru do painel.
 */
export function normalizarTelefone(bruto: unknown): Destino {
  if (typeof bruto !== "string" && typeof bruto !== "number") {
    return { ok: false, motivo: "vazio" };
  }
  const txt = String(bruto).trim();
  if (!txt) return { ok: false, motivo: "vazio" };

  // grupo: o painel usa o formato Z-API ("<id>-group"); o ChatGuru exporta
  // "<id>@g.us". Os dois viram a mesma chave.
  const g = txt.replace(/@g\.us$/i, "-group");
  if (GRUPO_RE.test(g)) return { ok: true, chat_id: g, telefone: "", grupo: true };

  const digitos = txt.replace(/\D/g, "");
  // Letra no campo quase sempre e coluna trocada na planilha (o nome caiu na
  // coluna do telefone). Este teste vem ANTES do "sem digitos" de proposito:
  // "sem telefone" e "-" sao os dois sem digitos, mas so o primeiro tem um
  // motivo que ajuda a pessoa a achar o erro na planilha.
  if (/\p{L}/u.test(txt) && digitos.length < 10) {
    return { ok: false, motivo: "nao parece telefone (tem letras)" };
  }
  if (!digitos) return { ok: false, motivo: "sem digitos" };
  if (digitos.length < 10) return { ok: false, motivo: `curto demais (${digitos.length} digitos)` };
  if (digitos.length > 15) return { ok: false, motivo: `longo demais (${digitos.length} digitos)` };
  if (!TELEFONE_RE.test(digitos)) return { ok: false, motivo: "formato invalido" };

  return { ok: true, chat_id: digitos, telefone: digitos, grupo: false };
}

/**
 * Chave de deduplicacao: os ULTIMOS 8 digitos.
 *
 * Motivo (padrao ja usado no motor do Meeting Hub): a mesma pessoa aparece na
 * base ora com DDI, ora sem, ora com o nono digito do celular e ora sem. Casar
 * pelo numero inteiro deixa passar duplicata; casar pelos ultimos digitos une
 * as variantes. Grupo nao tem essa ambiguidade: a chave e o proprio id.
 */
export function chaveDedupe(d: DestinoValido): string {
  if (d.grupo) return d.chat_id;
  return d.telefone.slice(-8);
}
