import { msgDb } from "@/lib/mensageria";
import { dentroDaJanela, fusoValido, resolverFuso } from "@/lib/fuso";
import { normalizarAlertas, type AlertaSla } from "@/lib/alertas-sla";
import { MINUTOS_REINICIO_MAX, MINUTOS_REINICIO_PADRAO } from "@/lib/conversa-automatica";
import { POR_PAGINA_MAX, POR_PAGINA_MIN, POR_PAGINA_PADRAO } from "@/lib/anexos";

// Configuracao global do painel (tela do super admin). Defaults = automacoes
// ligadas, resto desligado ate o admin configurar.
export type ConfigAutomacao = {
  auto_arquivar_concluida: boolean;
  auto_desarquivar_recebida: boolean;
  auto_atendimento_ao_responder: boolean;
  // ---- conversa REINICIADA (Frente N): o cliente voltou depois de a conversa
  // ficar parada. Regras puras e o "porque" de cada uma: lib/conversa-automatica.ts.
  // minutos sem atividade ate considerar a conversa reiniciada; 0 = desligado
  reinicio_minutos: number;
  // conversa reiniciada volta pra "aberto" (nao mexe em conversa concluida —
  // reabrir concluida e do auto_desarquivar_recebida)
  reinicio_marcar_aberto: boolean;
  // conversa reiniciada volta pro rodizio automatico (exige auto_distribuir)
  reinicio_redelegar: boolean;
  // ao reiniciar, tira os responsaveis atuais ANTES de redelegar (so vale com
  // reinicio_redelegar ligado — soltar sem redelegar deixaria a conversa orfa)
  reinicio_remover_delegados: boolean;
  // o BOT/automacao responder tambem move pra "em atendimento". Nasce DESLIGADO:
  // robo marcando atendimento tira a conversa da fila humana sem ninguem ter
  // olhado nela. O equivalente pra GENTE e auto_atendimento_ao_responder (acima).
  //
  // COSTURA FEITA no merge (31/08/2026): lib/fluxo/executar.ts decide por
  // statusAoResponder com `origem` do ContextoExecucao ("manual" = atendente
  // disparou o macro, conta como gente; "gatilho" = automacao, conta como robo).
  // AINDA ESCONDIDA DA TELA de proposito: hoje NENHUM caminho dispara fluxo por
  // gatilho (v2 do motor) — o unico chamador e /api/macros (gente). Interruptor
  // sem efeito na tela e mentira; expor junto com o gatilho v2, que ja nasce
  // obedecendo esta chave.
  auto_atendimento_bot: boolean;
  // minutos sem usar ate deslogar sozinho; 0 = nunca
  auto_logout_minutos: number;
  // APROVACAO PENDENTE NA FILA DE AUTOMACAO (decisao do Eric, 03/09/2026: "a
  // pessoa configura no painel se expira ou nao"): horas que uma cadeia parada em
  // `aguardando_aprovacao` espera aval antes de EXPIRAR (a execucao e cancelada,
  // registrada como expirada, e nada e enviado). 0 = nunca expira — o default,
  // que e o comportamento que existia antes desta chave. Quem aplica e a passada
  // de paradas em aval do tick (lib/fluxo/fila.ts).
  aprovacao_expira_horas: number;
  // true = ninguem entra sem verificacao em duas etapas (cadastro forcado no login)
  exigir_2fa: boolean;
  // MARCADOR mantido pelo CODIGO, nao interruptor de tela (Frente Q, 31/08/2026).
  //
  // Fica `true` quando a primeira janela de acesso, restricao de funil/canal ou
  // revogacao de dispositivo nasce nesta instalacao (as rotas de gravacao
  // chamam `ligarPoliticaDeAcesso`). Com ele em `false`, a PORTA
  // (lib/auth-server.ts) nao consulta nenhuma das tres tabelas.
  //
  // POR QUE ELE EXISTE — achado de revisao: sem ele, a instalacao que ainda nao
  // rodou a 0019 (ou que esta com o banco fora num cold start) dependia de
  // acertar o CODIGO de erro do PostgREST pra saber "a tabela nao existe".
  // Errar esse codigo transformava fail-closed em APAGAO: 403 pra todo mundo, no
  // painel inteiro. Com o marcador, o caminho normal nem chega la — sem politica
  // configurada nao existe como trancar ninguem.
  //
  // A contrapartida, declarada: se a config nao puder ser lida, `getConfig` cai
  // no default (`false`) e a politica fica desligada por ate 30s. E fail-open de
  // proposito, e o limite dele e estreito — com o banco fora nao ha conversa pra
  // vazar (toda leitura do painel falha junto).
  //
  // NAO entra na lista de interruptores da tela (mesmo motivo do
  // `auto_atendimento_bot`): quem liga e desliga isto e o codigo.
  politica_acesso_ativa: boolean;
  // distribuicao automatica de conversa nova sem responsavel (rodizio entre ativos)
  auto_distribuir: boolean;
  // teto de conversas abertas por atendente no rodizio; 0 = sem teto
  teto_por_atendente: number;
  // FUSO da instalacao (IANA, ex: "America/Recife"). Vazio = nao definido aqui:
  // vale a env FUSO_INSTALACAO e, sem ela, o default de fabrica de lib/fuso.ts.
  // E dele que dependem todo horario exibido e toda janela de automacao.
  fuso: string;
  // horario de atendimento: dias da semana (0=dom..6=sab) e janela HH:MM,
  // interpretados no FUSO DA INSTALACAO (acima)
  horario_dias: number[];
  horario_inicio: string;
  horario_fim: string;
  // mensagens automaticas do canal central; vazio = desligada
  msg_saudacao: string;
  msg_ausencia: string;
  // pesquisa de satisfacao ao concluir atendimento
  csat_ativo: boolean;
  csat_msg: string;
  // time pode restringir a PROPRIA visao a um contexto do widget (embed_contextos)
  seletor_visao: boolean;
  // vigia do canal (rota /api/vigia, disparada pelo pg_cron): liga/desliga e
  // destino do alerta pela tela; chat_id vazio = cai no env VIGIA_ALERTAS
  vigia_ativo: boolean;
  vigia_tg_chat_id: string;
  vigia_assinatura: string;
  // BIBLIOTECA DE ANEXOS (Frente W): quantos itens do acervo a tela pede por
  // vez. A conta de referencia da migracao pagina de 50 em 50, e esse e o
  // default; a instalacao com acervo grande sobe, a com conexao ruim desce.
  // Os limites (POR_PAGINA_MIN..POR_PAGINA_MAX) vivem em lib/anexos.ts — a
  // rota clampeia o ?por_pagina= da querystring pelos MESMOS limites.
  anexos_por_pagina: number;
  // alertas agendados de SLA: consulta salva + horarios fixos + destino
  // (formato e validacao em lib/alertas-sla.ts; disparo em /api/relatorios/sla).
  // Vazio = nenhum alerta; cada item nasce com ativo:false.
  alertas_sla: AlertaSla[];
};

export const CONFIG_PADRAO: ConfigAutomacao = {
  auto_arquivar_concluida: true,
  auto_desarquivar_recebida: true,
  auto_atendimento_ao_responder: true,
  // defaults do card 86ak858zu: 30 min de janela, marcar aberto SIM, redelegar
  // NAO, remover delegados NAO, robo mexendo em status NAO.
  reinicio_minutos: MINUTOS_REINICIO_PADRAO,
  reinicio_marcar_aberto: true,
  reinicio_redelegar: false,
  reinicio_remover_delegados: false,
  auto_atendimento_bot: false,
  auto_logout_minutos: 0,
  aprovacao_expira_horas: 0,
  exigir_2fa: false,
  politica_acesso_ativa: false,
  auto_distribuir: false,
  teto_por_atendente: 0,
  // vazio de proposito: "nao definido na config" e diferente de "escolheram Sao
  // Paulo". Assim a env FUSO_INSTALACAO ainda vale, e a regra e config > env >
  // fabrica (lib/fuso.ts).
  fuso: "",
  horario_dias: [1, 2, 3, 4, 5],
  horario_inicio: "09:00",
  horario_fim: "18:00",
  msg_saudacao: "",
  msg_ausencia: "",
  csat_ativo: false,
  csat_msg: "De 1 a 5, como voce avalia este atendimento? Responda so com o numero.",
  seletor_visao: false,
  vigia_ativo: true,
  vigia_tg_chat_id: "",
  vigia_assinatura: "vigia expert-chat (supabase)",
  anexos_por_pagina: POR_PAGINA_PADRAO,
  alertas_sla: [],
};

export const CHAVES_CONFIG = Object.keys(CONFIG_PADRAO) as (keyof ConfigAutomacao)[];

const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// valida e normaliza um valor vindo do admin (ou do banco) pra chave dada;
// devolve undefined quando invalido
export function validarConfig(chave: keyof ConfigAutomacao, valor: unknown): any {
  const padrao = CONFIG_PADRAO[chave];
  if (typeof padrao === "boolean") return typeof valor === "boolean" ? valor : undefined;
  if (chave === "alertas_sla") {
    // item malformado e DESCARTADO (nao derruba os outros nem o painel); um
    // alerta que dispara sozinho por config torta seria pior que nenhum
    return Array.isArray(valor) ? normalizarAlertas(valor) : undefined;
  }
  if (chave === "anexos_por_pagina") {
    // Branch PROPRIO, antes do branch dos inteiros que aceitam 0: aqui zero nao
    // existe (pagina de zero item = tela vazia). Fora da faixa e RECUSADO
    // (undefined -> cai no default), nao clampeado: este e o valor que o admin
    // GRAVA, e salvar 300 quando ele digitou 5000 mente pra ele. O clamp existe
    // do outro lado, na leitura do ?por_pagina= que vem do cliente.
    const n = Number(valor);
    if (!Number.isFinite(n)) return undefined;
    const inteiro = Math.round(n);
    return inteiro >= POR_PAGINA_MIN && inteiro <= POR_PAGINA_MAX ? inteiro : undefined;
  }
  if (
    chave === "auto_logout_minutos" ||
    chave === "teto_por_atendente" ||
    chave === "reinicio_minutos" ||
    chave === "aprovacao_expira_horas"
  ) {
    const n = Number(valor);
    // aprovacao_expira_horas: teto de 720h (30 dias) — acima disso e "nunca", e
    // "nunca" se escreve 0
    const teto =
      chave === "teto_por_atendente" ? 100
      : chave === "reinicio_minutos" ? MINUTOS_REINICIO_MAX
      : chave === "aprovacao_expira_horas" ? 720
      : 1440;
    return Number.isFinite(n) && n >= 0 && n <= teto ? Math.round(n) : undefined;
  }
  if (chave === "horario_dias") {
    if (!Array.isArray(valor)) return undefined;
    const dias = Array.from(new Set(valor.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)));
    return dias.sort();
  }
  if (chave === "horario_inicio" || chave === "horario_fim") {
    return typeof valor === "string" && HORA_RE.test(valor) ? valor : undefined;
  }
  if (chave === "fuso") {
    // "" = limpar (volta pra env/fabrica). Fuso que o runtime nao conhece e
    // RECUSADO na entrada: config errada aqui erraria todo horario do painel.
    const s = typeof valor === "string" ? valor.trim() : "";
    if (!s) return "";
    return fusoValido(s) ? s : undefined;
  }
  if (chave === "vigia_tg_chat_id") {
    return typeof valor === "string" && /^-?\d{0,20}$/.test(valor.trim()) ? valor.trim() : undefined;
  }
  if (chave === "vigia_assinatura") {
    return typeof valor === "string" ? valor.slice(0, 120) : undefined;
  }
  // textos (mensagens automaticas)
  return typeof valor === "string" ? valor.slice(0, 1000) : undefined;
}

// cache curto: o /api/chats (polling 6s de todo mundo) tambem le a config
let cache: { cfg: ConfigAutomacao; ts: number } | null = null;
// O ultimo valor BOM, separado do cache de frescura de proposito (3a revisao):
// `derrubarCacheConfig()` existe pra dizer "acabei de gravar, releia" — ela
// invalida FRESCURA, nao o fallback. Zerando os dois juntos, uma gravacao
// seguida de um soluco de rede caia no default, e `politica_acesso_ativa`
// voltava a `false` — o mesmo fail-open que a correcao abaixo fechou, reaberto
// pela porta dos fundos. Ele nunca vence: valor velho e melhor que desligar a
// politica de acesso.
let ultimoBom: ConfigAutomacao | null = null;

export async function getConfig(): Promise<ConfigAutomacao> {
  if (cache && Date.now() - cache.ts < 30_000) return cache.cfg;
  const { data, error } = await msgDb().from("config").select("chave,valor");
  // Erro de leitura NAO cacheia o default (correcao da 2a revisao da Frente Q):
  // servir o ULTIMO valor bom, mesmo vencido, e o padrao da casa (`getPapeis` em
  // lib/perfil.ts, as janelas em lib/acesso.ts). Antes, um soluco de rede
  // gravava CONFIG_PADRAO no cache por 30s — e com a Frente Q isso ficou caro:
  // `politica_acesso_ativa` voltava a `false` e a politica de acesso inteira
  // (janela, dispositivo revogado, restricao) desligava em silencio por meio
  // minuto. Sem cache bom nenhum, segue o default, que e o comportamento de uma
  // instalacao nova.
  if (error) {
    console.error("config:", error.message);
    if (ultimoBom) return ultimoBom;
    return { ...CONFIG_PADRAO };
  }
  const cfg = { ...CONFIG_PADRAO };
  for (const row of data ?? []) {
    if (!(CHAVES_CONFIG as string[]).includes(row.chave)) continue;
    const v = validarConfig(row.chave as keyof ConfigAutomacao, row.valor);
    if (v !== undefined) (cfg as any)[row.chave] = v;
  }
  cache = { cfg, ts: Date.now() };
  ultimoBom = cfg;
  return cfg;
}

/** Invalida a FRESCURA (releia na proxima). O ultimo valor bom fica de pe — ele
 *  e o fallback de erro de leitura, nao um cache de performance. */
export function derrubarCacheConfig() {
  cache = null;
}

/** O fuso desta instalacao: config > env FUSO_INSTALACAO > default de fabrica. */
export function fusoDaConfig(cfg: ConfigAutomacao): string {
  return resolverFuso(cfg.fuso);
}

/**
 * Horario de atendimento no FUSO DA INSTALACAO.
 * Era UTC-3 aritmetico ("BRT fixo"): errava em qualquer instalacao fora do
 * Brasil e em qualquer fuso com horario de verao. Agora quem sabe converter e
 * lib/fuso.ts — inclusive pra escala que vira a meia-noite.
 */
export function dentroDoHorario(cfg: ConfigAutomacao, agora = new Date()): boolean {
  return dentroDaJanela(agora, fusoDaConfig(cfg), cfg.horario_dias, cfg.horario_inicio, cfg.horario_fim);
}
