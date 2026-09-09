// Relatorios operacionais — o miolo PURO (Frente J, 31/08/2026).
//
// Este arquivo NAO importa nada de proposito: roda no Next e em node solto,
// que e a prova (`node scripts/prova-relatorios.ts`). Tudo que toca banco,
// sessao ou permissao mora nas rotas e em lib/relatorios-acesso.ts.
//
// Divisao de trabalho com o banco (supabase/migrations/0013_relatorios.sql):
// o banco AGREGA (group by, medias, segundos uteis) e devolve linha crua; aqui
// se pivota a matriz, filtra balde de fim de semana, acumula serie e serializa
// CSV. Regra de exibicao num lugar so, e testavel sem Postgres.

// ---------------------------------------------------------------------------
// Fuso da instalacao
// ---------------------------------------------------------------------------
// TROCA FEITA (31/08/2026, frente M): quem resolve o fuso e a ROTA, com
// `fusoDaConfig(await getConfig())` de lib/config.ts — config `fuso` > env
// FUSO_INSTALACAO > fabrica (lib/fuso.ts, frente F). As tres rotas de relatorio
// (`/api/relatorio`, `/api/relatorios/serie`, `/api/relatorios/sla`) usam isso.
//
// O `fusoInstalacao()` desta frente FOI REMOVIDO junto com o `FUSO_PADRAO`: ele
// lia SO a env, entao numa instalacao que definiu o fuso PELA TELA a serie era
// agrupada num fuso e o grafico rotulado com outro, e o alerta das 08:00 era
// avaliado no relogio errado. Funcao morta com aviso de "provisorio, troque no
// merge" e pior que funcao ausente — o proximo copia. NAO recriar: nao existe
// um terceiro helper de fuso neste repo.
//
// O que SOBRA aqui e o que lib/fuso.ts nao tem (e por isso continua nesta lib):
// `inicioDoDiaLocal`, `diaDaSemanaDaData` e `segundosUteis`. O resto tem par la
// (`diaLocal` -> `diaNoFuso`, `horaLocal` -> `horaMinutoNoFuso`,
// `diaDaSemanaLocal` -> `partesNoFuso().diaSemana`) e segue duplicado de
// proposito: este arquivo nao importa NADA, e e isso que deixa a prova rodar em
// node solto.
export function fusoValido(fuso: string): boolean {
  if (!fuso) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: fuso });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Dias da semana ignorados (0 = domingo .. 6 = sabado)
// ---------------------------------------------------------------------------
export const DOM = 0;
export const SAB = 6;

// Le os parametros da query: `ignorar_sabado` e `ignorar_domingo` sao
// INDEPENDENTES (criterio do card); `ignorar_fds=1` e o atalho pros dois.
export function diasIgnorados(params: URLSearchParams): number[] {
  const lig = (k: string) => ["1", "true", "sim"].includes((params.get(k) || "").toLowerCase());
  const fds = lig("ignorar_fds");
  const pular = new Set<number>();
  if (fds || lig("ignorar_sabado")) pular.add(SAB);
  if (fds || lig("ignorar_domingo")) pular.add(DOM);
  return Array.from(pular).sort();
}

// ---------------------------------------------------------------------------
// Datas no fuso da instalacao (Intl puro, sem dependencia)
// ---------------------------------------------------------------------------
type PartesLocais = { ano: number; mes: number; dia: number; hora: number; min: number; seg: number };

function partesLocais(d: Date, fuso: string): PartesLocais {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: fuso,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(d)
    .reduce<Record<string, string>>((acc, x) => ((acc[x.type] = x.value), acc), {});
  return {
    ano: Number(p.year),
    mes: Number(p.month),
    dia: Number(p.day),
    // en-US com hour12:false emite "24" na meia-noite em alguns runtimes
    hora: Number(p.hour) % 24,
    min: Number(p.minute),
    seg: Number(p.second),
  };
}

// Quantos ms o fuso esta a frente do UTC NESTE instante.
function offsetMs(d: Date, fuso: string): number {
  const p = partesLocais(d, fuso);
  const comoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.min, p.seg);
  return comoUtc - Math.floor(d.getTime() / 1000) * 1000;
}

// Instante da meia-noite LOCAL do dia em que `d` cai.
export function inicioDoDiaLocal(d: Date, fuso: string): Date {
  const p = partesLocais(d, fuso);
  const meiaNoiteLocal = Date.UTC(p.ano, p.mes - 1, p.dia);
  // 2 passadas: a 1a usa o offset do instante d, a 2a corrige se a meia-noite
  // cair do outro lado de uma virada de horario de verao
  let t = meiaNoiteLocal - offsetMs(d, fuso);
  t = meiaNoiteLocal - offsetMs(new Date(t), fuso);
  return new Date(t);
}

// Dia da semana LOCAL (0 = domingo .. 6 = sabado).
export function diaDaSemanaLocal(d: Date, fuso: string): number {
  const p = partesLocais(d, fuso);
  return new Date(Date.UTC(p.ano, p.mes - 1, p.dia)).getUTCDay();
}

// Data local no formato YYYY-MM-DD (a mesma chave que o banco devolve).
export function diaLocal(d: Date, fuso: string): string {
  const p = partesLocais(d, fuso);
  return `${p.ano}-${String(p.mes).padStart(2, "0")}-${String(p.dia).padStart(2, "0")}`;
}

// Dia da semana de uma data JA LOCAL ("2026-08-29"). Nao converte fuso nenhum:
// a string veio do banco ja no fuso da instalacao, e reinterpretar como
// instante daria o dia errado nos fusos longe de UTC.
export function diaDaSemanaDaData(dia: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dia);
  if (!m) return -1;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

// Hora local HH:MM (usada pelo agendamento dos alertas de SLA).
export function horaLocal(d: Date, fuso: string): string {
  const p = partesLocais(d, fuso);
  return `${String(p.hora).padStart(2, "0")}:${String(p.min).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// segundosUteis — duracao IGNORANDO os dias da semana pedidos
// ---------------------------------------------------------------------------
// ESPELHO de `mensageria.segundos_uteis` (0013_relatorios.sql). Esta versao e a
// SPEC: e a que o prova-relatorios.ts exercita. MUDOU AQUI, MUDA LA.
//
// Por que existe: conversa que chega sexta 18h e e respondida segunda 9h nao
// esperou 63h — esperou 15h uteis. Contar o fim de semana produz numero
// mentiroso em toda operacao que nao atende no sabado.
export function segundosUteis(ini: Date, fim: Date, fuso: string, pular: number[]): number {
  const a = ini.getTime();
  const b = fim.getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  const set = new Set(pular ?? []);
  if (!set.size) return (b - a) / 1000;
  // intervalo absurdo (dado sujo): nao varre 10 mil dias, devolve o cru
  if (b - a > 400 * 86_400_000) return (b - a) / 1000;

  let soma = 0;
  let cursor = inicioDoDiaLocal(ini, fuso);
  while (cursor.getTime() < b) {
    // +36h a partir da meia-noite local cai no meio do dia seguinte mesmo com
    // virada de horario de verao (23h ou 25h)
    const prox = inicioDoDiaLocal(new Date(cursor.getTime() + 36 * 3_600_000), fuso);
    if (!set.has(diaDaSemanaLocal(cursor, fuso))) {
      const ini2 = Math.max(a, cursor.getTime());
      const fim2 = Math.min(b, prox.getTime());
      if (fim2 > ini2) soma += fim2 - ini2;
    }
    cursor = prox;
  }
  return soma / 1000;
}

// ---------------------------------------------------------------------------
// Matriz departamento/usuario x status
// ---------------------------------------------------------------------------
export type LinhaBruta = { tipo: string; ref_id: string; nome: string | null; status: string; n: number };
export type ContagemStatus = { status: string; n: number };

export type LinhaMatriz = {
  tipo: "departamento" | "usuario" | "sem_dono";
  ref_id: string;
  nome: string;
  contagens: Record<string, number>;
  total: number;
};

export type Matriz = {
  // ordem canonica das colunas + qualquer status extra que apareca no dado
  status: string[];
  // a linha que o gestor procura primeiro: trabalho sem responsavel
  sem_dono: LinhaMatriz;
  linhas: LinhaMatriz[];
  totais: Record<string, number>;
  total_geral: number;
};

const ORDEM_STATUS = ["aberto", "atendimento", "aguardando", "concluido"];

function ordenarStatus(vistos: Iterable<string>): string[] {
  const set = new Set(vistos);
  const extras = Array.from(set).filter((s) => !ORDEM_STATUS.includes(s)).sort();
  return [...ORDEM_STATUS, ...extras];
}

function somar(contagens: Record<string, number>): number {
  return Object.values(contagens).reduce((a, b) => a + b, 0);
}

// Pivota o group-by cru do banco. Conversa com N responsaveis conta em CADA
// linha (igual a matriz da ferramenta de origem) — por isso a soma das linhas
// pode passar do total do cabecalho, e o cabecalho e que e a verdade.
export function montarMatriz(bruto: {
  linhas?: LinhaBruta[] | null;
  sem_dono?: ContagemStatus[] | null;
  totais?: ContagemStatus[] | null;
}): Matriz {
  const linhasBrutas = bruto.linhas ?? [];
  const semDonoBruto = bruto.sem_dono ?? [];
  const totaisBruto = bruto.totais ?? [];

  const vistos = new Set<string>();
  for (const l of linhasBrutas) vistos.add(l.status);
  for (const t of totaisBruto) vistos.add(t.status);
  for (const s of semDonoBruto) vistos.add(s.status);
  const status = ordenarStatus(vistos);

  const zerado = () => Object.fromEntries(status.map((s) => [s, 0])) as Record<string, number>;

  const porChave = new Map<string, LinhaMatriz>();
  for (const l of linhasBrutas) {
    if (l.tipo !== "departamento" && l.tipo !== "usuario") continue;
    const chave = `${l.tipo}:${l.ref_id}`;
    let linha = porChave.get(chave);
    if (!linha) {
      linha = { tipo: l.tipo, ref_id: l.ref_id, nome: l.nome || "(sem nome)", contagens: zerado(), total: 0 };
      porChave.set(chave, linha);
    }
    linha.contagens[l.status] = (linha.contagens[l.status] ?? 0) + l.n;
  }
  const linhas = Array.from(porChave.values());
  for (const l of linhas) l.total = somar(l.contagens);
  // departamento antes de usuario; dentro do grupo, maior carga primeiro
  linhas.sort((a, b) =>
    a.tipo === b.tipo ? b.total - a.total || a.nome.localeCompare(b.nome) : a.tipo === "departamento" ? -1 : 1
  );

  const semDono: LinhaMatriz = {
    tipo: "sem_dono",
    ref_id: "",
    nome: "Sem responsavel",
    contagens: zerado(),
    total: 0,
  };
  for (const s of semDonoBruto) semDono.contagens[s.status] = (semDono.contagens[s.status] ?? 0) + s.n;
  semDono.total = somar(semDono.contagens);

  const totais = zerado();
  for (const t of totaisBruto) totais[t.status] = (totais[t.status] ?? 0) + t.n;

  return { status, sem_dono: semDono, linhas, totais, total_geral: somar(totais) };
}

// ---------------------------------------------------------------------------
// Series temporais
// ---------------------------------------------------------------------------
export type PontoDia = { dia: string; dow: number } & Record<string, unknown>;

// Tira os baldes dos dias ignorados. O banco devolve a serie inteira (com o
// `dow` de cada dia) e o corte acontece aqui — regra de exibicao num lugar so.
export function filtrarDias<T extends { dow?: number; dia?: string }>(
  serie: T[] | null | undefined,
  pular: number[]
): T[] {
  const set = new Set(pular ?? []);
  if (!set.size) return serie ?? [];
  return (serie ?? []).filter((p) => {
    // `dow` vem do banco; se faltar, deriva da propria data (que ja e local)
    const dow = typeof p.dow === "number" ? p.dow : p.dia ? diaDaSemanaDaData(p.dia) : -1;
    return !set.has(dow);
  });
}

// Total de chats ACUMULADO, partindo do que existia antes do periodo
// (`acumulado_base`, contado no banco).
//
// ORDEM IMPORTA: acumule sobre a serie COMPLETA e so depois descarte os baldes
// de fim de semana. Acumular sobre a serie ja filtrada produz um total que
// nunca existiu — os chats que entraram no sabado somem da soma, e a curva de
// "total acumulado" passa a contradizer o proprio contador de chats do painel.
// Por isso a funcao PRESERVA os campos da entrada (o `dow` inclusive): o
// filtro roda depois, sobre o resultado.
export function acumular<T extends { dia: string; n: number }>(serie: T[], base: number): T[] {
  let corrente = base;
  return (serie ?? []).map((p) => ({ ...p, n: (corrente += p.n) }));
}

// ---------------------------------------------------------------------------
// Erro de RPC
// ---------------------------------------------------------------------------
// So estes codigos significam "a funcao nao existe" — ou seja, migration nao
// aplicada. 42883 e do proprio Postgres; PGRST202 e o PostgREST nao achando a
// funcao no schema cache. Qualquer OUTRO erro (permissao, timeout, tipo,
// divisao por zero) mapeado pra "ja rodou a migration?" manda o operador
// procurar no lugar errado — foi assim que estas rotas comecaram.
const CODIGOS_FUNCAO_AUSENTE = new Set(["42883", "PGRST202"]);

export function funcaoAusente(error: { code?: string | null } | null | undefined): boolean {
  return !!error?.code && CODIGOS_FUNCAO_AUSENTE.has(String(error.code));
}

// Mensagem de erro pro cliente. NUNCA devolve o texto do Postgres: ele carrega
// SQL, nome de coluna e as vezes valor de linha. O codigo basta pra diagnostico.
export function erroSeguro(error: { code?: string | null } | null | undefined): string {
  return `falha ao consultar o relatorio${error?.code ? ` (codigo ${error.code})` : ""}`;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
// Escapa e NEUTRALIZA formula: valor de terceiro (nome de contato, texto de
// mensagem) comecando com = + - @ vira comando quando o gestor abre no
// Excel/Sheets. Exportacao de dado de cliente nao pode carregar isso.
export function csvCampo(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  const seguro = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",;\n\r]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
}

export function csvLinha(valores: unknown[]): string {
  return valores.map(csvCampo).join(",") + "\r\n";
}

export type ColunaCsv<T> = { titulo: string; valor: (linha: T) => unknown };

// Gera o CSV inteiro em memoria — usar so pra tabela pequena (matriz, serie).
export function paraCsv<T>(colunas: ColunaCsv<T>[], linhas: T[]): string {
  let out = csvLinha(colunas.map((c) => c.titulo));
  for (const l of linhas) out += csvLinha(colunas.map((c) => c.valor(l)));
  return out;
}

// Sanitiza o nome do arquivo do Content-Disposition (nome de canal vem de env).
export function nomeArquivoCsv(base: string, sufixo: string): string {
  const limpo = base.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "relatorio";
  return `${limpo}-${sufixo}.csv`;
}
