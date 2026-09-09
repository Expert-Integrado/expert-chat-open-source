// REGRA DAS TELAS DE ACESSO E SEGURANCA (Frente Q, telas dos cards 86ak858x0,
// 86ak85917, 86ak85zm4 e 86ak85899). Arquivo PURO — importa so outros modulos
// puros deste repo, por caminho relativo com extensao — e por isso roda em `node`
// solto: `node scripts/prova-tela-acesso.ts`.
//
// POR QUE A LOGICA DA TELA NAO MORA NO .tsx (padrao que a Frente M deixou no
// repo com `lib/relatorios-tela.ts`): componente React so se testa com
// navegador, e navegador nao entra na bateria. Aqui ficam as conversoes e os
// avisos — a GRADE que o admin edita virando `JanelaAcesso` e voltando, o que
// conta como grade invalida, o rotulo do dispositivo, o tempo relativo e o texto
// que explica o efeito de uma restricao. O .tsx fica sendo so marcacao e estado.
//
// O QUE ESTE ARQUIVO NAO FAZ: decidir acesso. Quem decide e
// `lib/janela-acesso.ts` (dentro/fora), `lib/visibilidade.ts` (ve/nao ve) e
// `lib/escopo-chave.ts` (a chave alcanca), todos ja provados. Aqui so se
// PREPARA o que vai pra rota e se TRADUZ o que voltou — a tela nunca e a
// autoridade, ela reflete (mesma nota do cabecalho de relatorios-tela.ts).
import {
  MAX_PERIODOS_POR_DIA,
  NOME_DIA,
  horaValida,
  janelaBloqueiaSempre,
  resumoJanela,
  validarJanela,
  type JanelaAcesso,
} from "./janela-acesso.ts";
import { restricaoVazia, type RestricaoUsuario } from "./visibilidade.ts";
import { escopoAberto, resumoEscopo, type EscopoChave, type Recurso } from "./escopo-chave.ts";

// ————————————————————————————————————————————————————— A GRADE DA JANELA
//
// A grade tem SEMPRE 7 linhas e SEMPRE `MAX_PERIODOS_POR_DIA` campos por linha,
// mesmo vazios: campo de formulario nao pode nascer e morrer conforme o dado
// (input que aparece do nada perde o foco e embaralha o cursor). O banco guarda
// o contrario — so o que esta preenchido. A conversao nos dois sentidos e aqui.

export type CampoPeriodo = { de: string; ate: string };
export type LinhaGrade = { marcado: boolean; periodos: CampoPeriodo[] };
/** 7 posicoes; o indice E o dia da semana do JS (0 = domingo). */
export type Grade = LinhaGrade[];

export const DIAS_SEMANA = [0, 1, 2, 3, 4, 5, 6] as const;
export const DIAS_UTEIS = [1, 2, 3, 4, 5] as const;

/** "segunda" -> "Segunda". O NOME_DIA canonico e minusculo (lib/janela-acesso.ts). */
export function nomeDoDia(dia: number): string {
  const n = NOME_DIA[dia];
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : "?";
}

function linhaVazia(): LinhaGrade {
  return {
    marcado: false,
    periodos: Array.from({ length: MAX_PERIODOS_POR_DIA }, () => ({ de: "", ate: "" })),
  };
}

export function gradeVazia(): Grade {
  return DIAS_SEMANA.map(linhaVazia);
}

/** O que veio da rota -> o que a tela edita. */
export function janelaParaGrade(bruto: unknown): Grade {
  const j = validarJanela(bruto);
  const grade = gradeVazia();
  for (const dia of DIAS_SEMANA) {
    const periodos = j.dias[dia] ?? [];
    if (!periodos.length) continue;
    grade[dia].marcado = true;
    periodos.slice(0, MAX_PERIODOS_POR_DIA).forEach((p, i) => {
      grade[dia].periodos[i] = { de: p.de, ate: p.ate };
    });
  }
  return grade;
}

/**
 * O que a tela edita -> o corpo do POST.
 *
 * DESCARTA silenciosamente periodo pela metade (so `de`, so `ate`) e linha
 * desmarcada. E de proposito: o admin que digitou 08:00 e ainda nao digitou o
 * fim nao deve receber erro a cada tecla — quem cobra e `errosDaGrade`, chamada
 * no SALVAR. `validarJanela` no fim garante que o corpo sai no formato canonico
 * (ordenado, sem duplicata, sem lixo), o mesmo que a rota vai revalidar.
 */
export function gradeParaJanela(grade: Grade, ativo: boolean): JanelaAcesso {
  const dias: Record<number, CampoPeriodo[]> = {};
  for (const dia of DIAS_SEMANA) {
    const linha = grade[dia];
    if (!linha?.marcado) continue;
    const bons = linha.periodos.filter((p) => horaValida(p.de) && horaValida(p.ate));
    if (bons.length) dias[dia] = bons.map((p) => ({ de: p.de, ate: p.ate }));
  }
  return validarJanela({ ativo, dias });
}

/**
 * O que impede de salvar. Lista de frases prontas pra tela (vazia = pode salvar).
 *
 * NAO reprova `de` maior que `ate`: periodo que VIRA A MEIA-NOITE e legitimo
 * (turno da noite, 22:00-02:00) e a regra o suporta — reprovar aqui quebraria o
 * caso que a prova da janela cobre desde o comeco.
 */
export function errosDaGrade(grade: Grade, ativo: boolean): string[] {
  const erros: string[] = [];
  for (const dia of DIAS_SEMANA) {
    const linha = grade[dia];
    if (!linha?.marcado) continue;
    const preenchidos = linha.periodos.filter((p) => p.de.trim() || p.ate.trim());
    const metade = preenchidos.filter((p) => !horaValida(p.de) || !horaValida(p.ate));
    if (metade.length) {
      erros.push(`${nomeDoDia(dia)}: horario incompleto ou invalido (use HH:MM, ex 08:00)`);
      continue;
    }
    if (!preenchidos.length) erros.push(`${nomeDoDia(dia)}: marcado, mas sem horario`);
  }
  // LOCKOUT: a rota recusa este estado (400) e a tela nao deve nem deixar tentar
  if (!erros.length && janelaBloqueiaSempre(gradeParaJanela(grade, ativo))) {
    erros.push("Janela ligada sem nenhum dia com horario barra a pessoa 24 horas por dia — marque um dia ou desligue a janela");
  }
  return erros;
}

/** Copia os horarios de um dia pros outros (o "aplicar em todos os dias uteis"). */
export function copiarLinha(grade: Grade, origem: number, destinos: readonly number[]): Grade {
  const fonte = grade[origem];
  if (!fonte) return grade;
  return grade.map((linha, dia) =>
    destinos.includes(dia) && dia !== origem
      ? { marcado: fonte.marcado, periodos: fonte.periodos.map((p) => ({ ...p })) }
      : linha
  );
}

/** O resumo que a tela mostra ao lado do titulo — a MESMA frase que a rota devolve. */
export function resumoDaGrade(grade: Grade, ativo: boolean): string {
  return resumoJanela(gradeParaJanela(grade, ativo));
}

// ————————————————————————————————————————————————————— DISPOSITIVOS
export type DispositivoTela = {
  navegador?: string | null;
  sistema?: string | null;
  rotulo?: string | null;
  robo?: boolean | null;
};

/**
 * O nome que aparece na linha. NAO e a maquina — e a CLASSE (navegador +
 * sistema), e o `limite_honesto` da rota explica isso na tela. Sem nada
 * reconhecido, "Desconhecido" em vez de string vazia: linha sem rotulo parece
 * bug de renderizacao.
 */
export function rotuloDispositivo(d: DispositivoTela | null | undefined): string {
  if (!d) return "Desconhecido";
  if (d.rotulo && d.rotulo.trim()) return d.rotulo.trim();
  const partes = [d.navegador, d.sistema].map((x) => (x || "").trim()).filter(Boolean);
  const base = partes.length ? partes.join(" / ") : "Desconhecido";
  return d.robo ? `${base} (robo)` : base;
}

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

/**
 * "ha 5 min", pra lista de acesso. Data ausente ou ilegivel devolve null — a
 * tela escreve "nunca" ou "—", nunca "Invalid Date" e nunca "ha 56 anos"
 * (que e o que sai quando um epoch 0 vaza pro formatador).
 */
export function tempoRelativo(iso: unknown, agora: Date = new Date()): string | null {
  if (typeof iso !== "string" || !iso.trim()) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const ms = agora.getTime() - t;
  if (ms < 0) return "agora mesmo"; // relogio do servidor adiantado: nao inventa futuro
  if (ms < 2 * MIN) return "agora mesmo";
  if (ms < HORA) return `ha ${Math.floor(ms / MIN)} min`;
  if (ms < DIA) {
    const h = Math.floor(ms / HORA);
    return `ha ${h} ${h === 1 ? "hora" : "horas"}`;
  }
  const d = Math.floor(ms / DIA);
  return `ha ${d} ${d === 1 ? "dia" : "dias"}`;
}

// ————————————————————————————————————————————————————— RESTRICAO (canal/funil)

/** Liga/desliga um id numa lista de selecao, sempre ordenada (igual a rota grava). */
export function alternar(lista: readonly string[], id: string): string[] {
  const tem = lista.includes(id);
  return (tem ? lista.filter((x) => x !== id) : [...lista, id]).slice().sort();
}

/**
 * O que ESTA restricao faz, em portugues, pra tela dizer antes de salvar.
 *
 * Espelha `restricaoPermite` (lib/visibilidade.ts) sem reimplementar a decisao:
 * lista vazia numa dimensao = dimensao livre; as duas dimensoes se somam (E, nao
 * OU); e funil escolhido sem `sem_funil` esconde conversa que ainda nao entrou
 * em funil nenhum — que e a pegadinha desta tela, porque numa base real isso e
 * muita conversa.
 */
export function explicarRestricao(
  r: RestricaoUsuario,
  nomes: { canais?: Record<string, string>; funis?: Record<string, string> } = {}
): string {
  if (restricaoVazia(r)) return "Sem recorte: esta pessoa segue as regras normais de visibilidade do painel.";
  const nome = (mapa: Record<string, string> | undefined, id: string) => mapa?.[id] || id;
  const partes: string[] = [];
  if (r.canais.length) {
    partes.push(`so os numeros ${r.canais.map((c) => nome(nomes.canais, c)).join(", ")}`);
  }
  if (r.funis.length) {
    partes.push(`so os funis ${r.funis.map((f) => nome(nomes.funis, f)).join(", ")}`);
    partes.push(
      r.sem_funil
        ? "e tambem as conversas que ainda nao estao em funil nenhum"
        : "e NAO ve conversa fora desses funis, inclusive a que ainda nao entrou em funil nenhum"
    );
  }
  return `Esta pessoa vai ver ${partes.join(", ")}.`;
}

/**
 * Aviso de pe no chao: `sem_funil` marcado sem nenhum funil escolhido nao faz
 * nada (a dimensao funil esta livre, entao a conversa sem funil ja aparece). Sem
 * este aviso a caixa parece ligada e ignorada — o pior tipo de controle de tela.
 */
export function avisoSemFunilInerte(r: RestricaoUsuario): string | null {
  if (r.sem_funil && !r.funis.length) {
    return 'A caixa "conversas sem funil" so tem efeito quando voce escolhe pelo menos um funil — sem funil escolhido, a pessoa ja ve todas.';
  }
  return null;
}

// ————————————————————————————————————————————————————— ESCOPO DE CHAVE

/** O rotulo curto do escopo — a MESMA frase da rota (lib/escopo-chave.ts). */
export function rotuloEscopo(e: EscopoChave): string {
  return resumoEscopo(e);
}

/** Escopo aberto merece aviso na tela: a chave vale tudo o que o dono vale. */
export function avisoEscopoAberto(e: EscopoChave): string | null {
  return escopoAberto(e)
    ? "Esta chave alcanca tudo o que voce alcanca. Marque recursos ou numeros pra apertar."
    : null;
}

/**
 * O corpo do PATCH/POST de escopo, montado do estado da tela.
 * `ignorar_janela` NAO sai daqui: e a unica dimensao que AFROUXA, vive so no
 * caminho de super admin (/api/admin/api-keys) e o autoatendimento a zera de
 * todo jeito (`escopoSemPrivilegio`). Mandar `false` seria pedir pra rota
 * decidir sobre um campo que esta tela nao governa.
 */
export function corpoDoEscopo(sel: {
  somente_leitura: boolean;
  recursos: readonly string[];
  canais: readonly string[];
}): { somente_leitura: boolean; recursos: string[]; canais: string[] } {
  return {
    somente_leitura: !!sel.somente_leitura,
    recursos: sel.recursos.slice().sort(),
    canais: sel.canais.slice().sort(),
  };
}

/**
 * O corpo do escopo no caminho de SUPER ADMIN (/api/admin/api-keys), onde
 * `ignorar_janela` existe.
 *
 * ELE VAI EXPLICITO, SEMPRE — e o motivo e uma armadilha real: a rota sanea o
 * corpo com `validarEscopoChave`, que trata campo AUSENTE como `false`. Se a
 * tela mandasse so `{somente_leitura, recursos, canais}`, mexer no canal de uma
 * chave de robo noturno APAGARIA o `ignorar_janela` em silencio — o robo pararia
 * de trabalhar de madrugada e nada na tela teria dito isso. Por isso o campo
 * tambem e uma caixa VISIVEL na tela de admin: privilegio que se perde sem
 * aparecer e pior que privilegio negado.
 */
export function corpoDoEscopoAdmin(sel: {
  somente_leitura: boolean;
  recursos: readonly string[];
  canais: readonly string[];
  ignorar_janela: boolean;
}): { somente_leitura: boolean; recursos: string[]; canais: string[]; ignorar_janela: boolean } {
  return { ...corpoDoEscopo(sel), ignorar_janela: !!sel.ignorar_janela };
}

export type RecursoTela = { id: Recurso; descricao: string };
