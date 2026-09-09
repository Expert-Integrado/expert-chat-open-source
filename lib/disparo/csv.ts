// Leitura do CSV do publico — PURO (nao importa nada alem de telefone.ts, que
// tambem e puro). Roda no Next e em node solto; a prova exercita sem rede.
//
// O arquivo vem do computador de quem opera: separador `,` ou `;` (Excel BR
// exporta com `;`), BOM do Excel, aspas com virgula dentro, cabecalho em
// portugues ou ingles. Nada disso pode virar "erro ao importar" sem explicacao.

// especificador COM extensao de proposito: `scripts/prova-disparo.ts` roda em
// node solto (type stripping) e o node so resolve relativo com extensao
import { normalizarTelefone, chaveDedupe, type DestinoValido } from "./telefone.ts";

export type ItemPublico = {
  chat_id: string;
  telefone: string;
  nome: string;
  /** colunas extras da planilha viram variaveis da mensagem */
  variaveis?: Record<string, string>;
};

export type LinhaRejeitada = { linha: number; valor: string; motivo: string };

export type PublicoLido = {
  itens: ItemPublico[];
  invalidos: LinhaRejeitada[];
  duplicados: LinhaRejeitada[];
  colunas: string[];
  /** nome da coluna usada como telefone e como nome (pra tela confirmar) */
  coluna_telefone: string | null;
  coluna_nome: string | null;
  total_linhas: number;
};

const NOMES_TELEFONE = ["telefone", "celular", "whatsapp", "whats", "fone", "numero", "número", "phone", "msisdn"];
const NOMES_NOME = ["nome", "name", "contato", "cliente", "nome completo"];

// tira acento pra casar cabecalho/variavel escritos de qualquer jeito
// ("Nome", "nome", "TELEFONE", "Número")
const semAcento = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/** Detecta o separador olhando a primeira linha: vence quem aparece mais. */
export function detectarSeparador(texto: string): string {
  const linha = texto.split(/\r?\n/, 1)[0] ?? "";
  const conta = (c: string) => linha.split(c).length - 1;
  const candidatos = [";", ",", "\t", "|"];
  let melhor = ",";
  let max = 0;
  for (const c of candidatos) {
    const n = conta(c);
    if (n > max) {
      max = n;
      melhor = c;
    }
  }
  return max ? melhor : ";";
}

/**
 * Parser de CSV com aspas. Nao usa biblioteca de proposito: dependencia nova
 * neste repo tem custo (a fundacao do motor tomou a mesma decisao), e o dialeto
 * que precisamos ler cabe em 30 linhas.
 */
export function parseCsv(texto: string, sep?: string): string[][] {
  const limpo = texto.replace(/^﻿/, ""); // BOM do Excel
  const s = sep || detectarSeparador(limpo);
  const linhas: string[][] = [];
  let campo = "";
  let linha: string[] = [];
  let aspas = false;
  for (let i = 0; i < limpo.length; i++) {
    const c = limpo[i];
    if (aspas) {
      if (c === '"') {
        if (limpo[i + 1] === '"') {
          campo += '"';
          i++;
        } else aspas = false;
      } else campo += c;
      continue;
    }
    if (c === '"') {
      aspas = true;
      continue;
    }
    if (c === s) {
      linha.push(campo);
      campo = "";
      continue;
    }
    if (c === "\n") {
      linha.push(campo);
      linhas.push(linha);
      linha = [];
      campo = "";
      continue;
    }
    if (c === "\r") continue;
    campo += c;
  }
  if (campo !== "" || linha.length) {
    linha.push(campo);
    linhas.push(linha);
  }
  return linhas.filter((l) => l.some((c) => c.trim() !== ""));
}

function acharColuna(cabecalho: string[], nomes: string[]): number {
  for (let i = 0; i < cabecalho.length; i++) {
    if (nomes.includes(semAcento(cabecalho[i]))) return i;
  }
  return -1;
}

/**
 * Le o CSV do publico. Regras:
 *  - cabecalho identifica telefone e nome; sem cabecalho reconhecivel, a 1a
 *    coluna e o telefone e a 2a o nome (o formato que a tela pede);
 *  - telefone invalido NAO derruba o arquivo: vira linha rejeitada com motivo;
 *  - duplicata e detectada pelos ultimos digitos e contada em separado — quem
 *    opera precisa saber que 500 linhas viraram 480 destinos, e por que.
 */
export function lerPublicoCsv(texto: string): PublicoLido {
  const linhas = parseCsv(texto);
  const vazio: PublicoLido = {
    itens: [],
    invalidos: [],
    duplicados: [],
    colunas: [],
    coluna_telefone: null,
    coluna_nome: null,
    total_linhas: 0,
  };
  if (!linhas.length) return vazio;

  const cabecalho = linhas[0].map((c) => c.trim());
  let iTel = acharColuna(cabecalho, NOMES_TELEFONE);
  let iNome = acharColuna(cabecalho, NOMES_NOME);
  // sem cabecalho reconhecivel: a 1a linha ja e dado (posicional)
  const temCabecalho = iTel >= 0 || iNome >= 0;
  const corpo = temCabecalho ? linhas.slice(1) : linhas;
  if (!temCabecalho) {
    iTel = 0;
    iNome = 1;
  }

  const colunas = temCabecalho ? cabecalho : cabecalho.map((_, i) => `coluna_${i + 1}`);
  const itens: ItemPublico[] = [];
  const invalidos: LinhaRejeitada[] = [];
  const duplicados: LinhaRejeitada[] = [];
  const vistos = new Set<string>();

  corpo.forEach((celulas, idx) => {
    const numeroLinha = idx + (temCabecalho ? 2 : 1);
    const bruto = (celulas[iTel] ?? "").trim();
    const d = normalizarTelefone(bruto);
    if (!d.ok) {
      invalidos.push({ linha: numeroLinha, valor: bruto, motivo: d.motivo });
      return;
    }
    const chave = chaveDedupe(d as DestinoValido);
    if (vistos.has(chave)) {
      duplicados.push({ linha: numeroLinha, valor: bruto, motivo: "ja aparece antes na planilha" });
      return;
    }
    vistos.add(chave);

    const variaveis: Record<string, string> = {};
    colunas.forEach((col, i) => {
      if (i === iTel || i === iNome) return;
      const v = (celulas[i] ?? "").trim();
      if (v) variaveis[col] = v;
    });

    itens.push({
      chat_id: d.chat_id,
      telefone: d.telefone,
      nome: (celulas[iNome] ?? "").trim(),
      ...(Object.keys(variaveis).length ? { variaveis } : {}),
    });
  });

  return {
    itens,
    invalidos,
    duplicados,
    colunas,
    coluna_telefone: temCabecalho ? cabecalho[iTel] ?? null : null,
    coluna_nome: temCabecalho ? cabecalho[iNome] ?? null : null,
    total_linhas: corpo.length,
  };
}

/**
 * Aplica as variaveis na mensagem: {{nome}} e as colunas extras da planilha.
 * Variavel sem valor vira string vazia — NUNCA deixa "{{nome}}" cru sair pro
 * cliente final (e o erro classico de disparo, e da pra ver de longe).
 */
/** Teto de uma variavel isolada e do texto final (limite do WhatsApp: 4096). */
export const TETO_VARIAVEL = 500;
export const TETO_MENSAGEM = 4096;

export function aplicarVariaveis(mensagem: string, item: ItemPublico): string {
  const mapa: Record<string, string> = {
    nome: item.nome || "",
    telefone: item.telefone || "",
    ...(item.variaveis || {}),
  };
  const normalizado: Record<string, string> = {};
  // TETO POR VARIAVEL: a planilha vem de fora e uma celula gigante (um texto
  // colado inteiro numa coluna) transformaria a mensagem em outra coisa, ou
  // faria o provedor recusar o lote todo. Cortar aqui e melhor que descobrir no
  // meio do disparo.
  for (const [k, v] of Object.entries(mapa)) {
    normalizado[semAcento(k)] = String(v ?? "").slice(0, TETO_VARIAVEL);
  }
  const texto = mensagem.replace(/\{\{\s*([\wÀ-ſ ]+?)\s*\}\}/g, (_todo, chave: string) => {
    const v = normalizado[semAcento(chave)];
    return v === undefined ? "" : v;
  });
  // TETO DO TEXTO FINAL: a mensagem e validada antes da substituicao; sao as
  // variaveis que podem estourar o limite DEPOIS. Sem este corte, uma campanha
  // aprovada com mensagem curta falharia destino a destino no provedor.
  return texto.length > TETO_MENSAGEM ? texto.slice(0, TETO_MENSAGEM) : texto;
}

/** Variaveis citadas na mensagem que NENHUM item do publico preenche. */
export function variaveisSemValor(mensagem: string, itens: ItemPublico[]): string[] {
  const citadas = new Set<string>();
  for (const m of mensagem.matchAll(/\{\{\s*([\wÀ-ſ ]+?)\s*\}\}/g)) {
    citadas.add(semAcento(m[1]));
  }
  if (!citadas.size) return [];
  const disponiveis = new Set<string>(["nome", "telefone"]);
  for (const it of itens) {
    for (const k of Object.keys(it.variaveis || {})) disponiveis.add(semAcento(k));
  }
  return Array.from(citadas).filter((c) => !disponiveis.has(c));
}
