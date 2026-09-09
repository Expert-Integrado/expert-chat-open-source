// Referencias de um backup do ChatGuru — quem aponta pra quem, e como isso resolve.
//
// Camada que sabe as FORMAS do backup (onde mora cada catalogo, como cada
// referencia e escrita) e delega a regra de casamento pro modulo puro
// `resolver.mjs`. Serve dois consumidores:
//
//   1. `chatguru.mjs`, que ja le indice + config + todas as anotacoes: importa
//      daqui os indices e o placar, e o relatorio da importacao sai com a tabela
//      de taxas por tipo de referencia;
//   2. a linha de comando abaixo, pra medir um backup SEM importar nada:
//
//        node scripts/importar/referencias.mjs --pasta <backup> [--com-anotacoes]
//
// A regra da casa vale igual nos dois: ambiguo ou morto = RESSALVA declarada.
//
// Nao abre conexao com banco nenhum, em nenhum modo. Nada aqui grava.

import fs from "node:fs";
import path from "node:path";
import { novoIndice, novoPlacar, resolver, tabelaMarkdown, idDeOrigem, normalizar } from "./resolver.mjs";
// O fatiador de acoes vem do conversor de fluxos, que ja paga a armadilha do
// formulario: o ChatGuru renderiza os 21 tipos de acao MESMO SEM USO, e acao
// real e a que tem `action_id` preenchido. Contar o campo cru 
// `dialog_id_to_execute` da o triplo (medido: 1.409 cru x 414 reais na conta da
// Expert) e afunda a taxa com falso positivo.
import { acoesDoDialogo } from "../fluxo/converter-chatguru.mjs";

const lerJson = (p, padrao = null) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return padrao;
  }
};

// O backup vem com o config ora numa subpasta `config/`, ora solto na raiz
// (medido nos 33: a conta da Expert tem os dois, os clientes so a subpasta).
// Procurar nos dois lugares e o que evita "catalogo vazio" silencioso.
export function acharConfig(pasta, nome) {
  for (const p of [path.join(pasta, "config", nome), path.join(pasta, nome)]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ─── A URL DO ARQUIVO DE UMA MENSAGEM ────────────────────────────────────────
// Mora AQUI, e num lugar so, porque e uma FORMA do backup: `path_relative` +
// `name` e o caminho normal, mas parte dos anexos (medido: 79 de 9.705 na amostra)
// so tem `path_absolute` — e quando esse ja vem em https, e uma URL boa. Sem o
// fallback, essa midia virava "sem URL", que no painel e mensagem sem arquivo.
//
// Estava DUPLICADA em `chatguru.mjs` e `midia.mjs`, que precisam concordar byte a
// byte: o importador grava `media_url` a partir dela e a re-hospedagem procura a
// linha por `media_url=eq.<a mesma url>`. Duas copias divergindo = arquivo subido
// pro storage e endereco nunca reescrito, sem erro em lugar nenhum.
export function urlDoArquivo(a) {
  if (!a) return null;
  const rel = a.path_relative && a.name ? `${String(a.path_relative).replace(/\/$/, "")}/${a.name}` : null;
  if (rel && /^https:\/\//.test(rel)) return rel;
  const abs = a.path_absolute ? String(a.path_absolute) : "";
  return /^https:\/\//.test(abs) ? abs : null;
}

// ─── INDICES ─────────────────────────────────────────────────────────────────
// Cada indice recebe o ESCOPO certo, e o escopo e o que impede o falso "unico":
//   etapa de funil  -> escopo = o funil (duas etapas "Fechado" em funis diferentes)
//   dialogo         -> escopo = o chatbot (medida da frente C: e dentro da conta
//                      que o nome repete)
//   etiqueta/usuario/departamento -> escopo unico da conta (sem escopo)
export function indicesDoBackup(pasta, { dialogos = true } = {}) {
  const tags = lerJson(acharConfig(pasta, "chatlist_tags.json"), []) || [];
  const funis = lerJson(acharConfig(pasta, "chatlist_funnels.json"), []) || [];
  const ug = lerJson(acharConfig(pasta, "users_and_groups.json"), {}) || {};

  const etiquetas = novoIndice(
    (Array.isArray(tags) ? tags : []).map((t) => ({
      // etiqueta NAO TEM id na origem: a unica chave e o texto. Por isso o id do
      // indice e o proprio texto — assim `resolver` acha por id quando o texto
      // vem identico e por nome normalizado quando veio com acento/espaco a mais.
      id_origem: typeof t === "string" ? t : t.text || t.name || null,
      nome: typeof t === "string" ? t : t.text || t.name || "",
      cor: t?.color ?? null,
      fundo: t?.bg ?? null,
    }))
  );

  const usuarios = novoIndice(
    (ug.users || []).map((u) => ({
      id_origem: idDeOrigem(u._id ?? u.id),
      nome: u.name || u.email || "",
      email: u.email || null,
    }))
  );

  const departamentos = novoIndice(
    (ug.groups || []).map((g) => ({
      id_origem: idDeOrigem(g._id ?? g.id),
      nome: g.name || "",
    }))
  );

  const listaFunis = (Array.isArray(funis) ? funis : []).map((f) => ({
    id_origem: idDeOrigem(f.id ?? f._id),
    nome: f.name || "",
  }));
  const indiceFunis = novoIndice(listaFunis);

  const listaEtapas = [];
  for (const f of Array.isArray(funis) ? funis : []) {
    const idFunil = idDeOrigem(f.id ?? f._id);
    (f.steps || []).forEach((s, i) => {
      listaEtapas.push({
        id_origem: idDeOrigem(s.id ?? s._id),
        nome: s.name || "",
        escopo: idFunil,
        ordem: i + 1,
        funil_nome: f.name || "",
      });
    });
  }
  const etapas = novoIndice(listaEtapas);

  const listaDialogos = dialogos ? lerDialogos(pasta) : [];
  const indiceDialogos = novoIndice(listaDialogos);

  return {
    etiquetas,
    usuarios,
    departamentos,
    funis: indiceFunis,
    etapas,
    dialogos: indiceDialogos,
    // catalogos crus, pra quem precisa dos nomes (relatorio, importacao)
    catalogos: { etiquetas: etiquetas.todos, usuarios: usuarios.todos, funis: listaFunis, etapas: listaEtapas },
  };
}

// automacao/dialogos/<chatbot>_<dialogo>.json — o titulo vive no campo "title"
// do formulario, nao numa propriedade de topo.
export function lerDialogos(pasta) {
  const dir = path.join(pasta, "automacao", "dialogos");
  if (!fs.existsSync(dir)) return [];
  const fora = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const j = lerJson(path.join(dir, f), null);
    if (!j) continue;
    const titulo = (j.campos || []).find((c) => c?.nome === "title")?.valor || j.nome || "";
    fora.push({
      id_origem: idDeOrigem(j.dialogo_id),
      nome: String(titulo),
      escopo: idDeOrigem(j.chatbot),
      arquivo: f,
    });
  }
  return fora;
}

// ─── RESOLUCAO POR TIPO ──────────────────────────────────────────────────────
// Assinatura unica: (indices, placar, valor bruto) -> resultado do resolver.
// O placar e do CHAMADOR de proposito: a importacao acumula no mesmo placar as
// referencias das 19.992 conversas e das 108.885 anotacoes.

export const resolverEtiqueta = (ix, placar, texto) =>
  placar.resolverE("etiqueta", ix.etiquetas, texto);

export const resolverUsuario = (ix, placar, valor, tipo = "usuario_delegado") =>
  placar.resolverE(tipo, ix.usuarios, valor);

export const resolverDepartamento = (ix, placar, valor) =>
  placar.resolverE("departamento_delegado", ix.departamentos, valor);

// Etapa vem pelo id dentro de `funnel_steps_ids`, sem dizer de que funil e — e
// por isso a consulta e SEM escopo: o proprio indice descobre o funil junto.
export const resolverEtapa = (ix, placar, valor) => placar.resolverE("etapa_funil", ix.etapas, valor);

// Etapa reencontrada por POSICAO: caminho de reimportacao, quando o nome da
// etapa foi editado no painel depois da primeira carga. So e tentado com o funil
// (escopo) resolvido — sem isso, "a 2a etapa" nao quer dizer nada.
export const resolverEtapaPorPosicao = (ix, placar, valor, funilId, posicao) =>
  placar.resolverE("etapa_funil_posicao", ix.etapas, valor, { escopo: funilId, porPosicao: posicao });

// Autor que NAO E GENTE. Medido na conta da Expert: das 108.879 anotacoes, 100.676
// (92%) sao assinadas por "Chatbot" — nao ha usuario nenhum pra casar, e nunca
// houve. Tratar isso como "alvo morto" afundaria a taxa de 48% pra 5% e enterraria
// o achado que importa: quem ficou de fora sao as PESSOAS que sairam da conta
// (4.277 anotacoes na Expert), e e esse numero que vira usuario historico com
// revisao humana. Entao autor de sistema conta como "sem alvo na origem", igual
// placeholder — nao e perda, e nao e ressalva.
export const AUTOR_DE_SISTEMA = new Set(
  ["chatbot", "bot", "robo", "robot", "sistema", "system", "chatguru", "automacao", "api", "webhook"].map(normalizar)
);
export const ehAutorDeSistema = (a) => AUTOR_DE_SISTEMA.has(normalizar(idDeOrigem(a)));

// Autor de anotacao e TEXTO LIVRE (nunca id) — o casamento e por nome
// normalizado, e o que nao casa e a pessoa que saiu da conta antes do backup.
export const resolverAutorNota = (ix, placar, autor) =>
  ehAutorDeSistema(autor)
    ? placar.registrar("autor_anotacao", { estado: "vazio", item: null, candidatos: [] }, autor)
    : placar.resolverE("autor_anotacao", ix.usuarios, autor);

// Alvo de acao DIALOGO: nome do dialogo dentro do chatbot.
export const resolverDialogo = (ix, placar, nome, chatbotId) =>
  placar.resolverE("dialogo", ix.dialogos, nome, { escopo: chatbotId });

// ─── LINHA DE COMANDO ────────────────────────────────────────────────────────
const executadoDireto =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/importar/referencias.mjs");

if (executadoDireto) {
  const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
  };
  const flag = (n) => process.argv.includes(`--${n}`);
  const pasta = arg("pasta");
  if (!pasta || flag("help") || flag("ajuda")) {
    console.log(`uso: node scripts/importar/referencias.mjs --pasta <backup> [--com-anotacoes] [--saida <arq.json>]

  --pasta <dir>       pasta do backup (obrigatoria)
  --com-anotacoes     tambem mede o autor das anotacoes (le messages/ inteiro; passada longa)
  --saida <arq>       grava o resultado em json (o terminal mostra so contagem)`);
    process.exit(pasta ? 0 : 2);
  }
  if (!fs.existsSync(pasta)) {
    console.error(`pasta nao encontrada: ${pasta}`);
    process.exit(2);
  }

  const ix = indicesDoBackup(pasta);
  const placar = novoPlacar();
  const indice = lerJson(path.join(pasta, "chats_index.json"), null);
  const chats = indice && Array.isArray(indice.chats) ? indice.chats : [];

  for (const c of chats) {
    for (const t of c.tags || []) resolverEtiqueta(ix, placar, typeof t === "string" ? t : t.text || t.name || "");
    for (const u of c.users_delegated_ids || []) resolverUsuario(ix, placar, u);
    for (const g of c.groups_delegated_ids || []) resolverDepartamento(ix, placar, g);
    for (const s of c.funnel_steps_ids || []) resolverEtapa(ix, placar, s);
  }

  if (flag("com-anotacoes")) {
    const dir = path.join(pasta, "messages");
    const arquivos = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
    for (const f of arquivos) {
      const bruto = lerJson(path.join(dir, f), null);
      if (!bruto) continue;
      for (const item of bruto.messages_and_notes || []) {
        if (item.type !== "note") continue;
        const autor = item.n?.author;
        if (autor === undefined || autor === null || autor === "") continue;
        resolverAutorNota(ix, placar, autor);
      }
    }
  }

  // dialogos: alvo da acao DIALOGO dentro do chatbot
  for (const d of lerDialogos(pasta)) {
    const j = lerJson(path.join(pasta, "automacao", "dialogos", d.arquivo), null);
    if (!j) continue;
    for (const acao of acoesDoDialogo(j.campos || [])) {
      if (acao.tipo !== "DIALOGO") continue;
      resolverDialogo(ix, placar, acao.params.dialog_id_to_execute, d.escopo);
    }
  }

  const tabela = placar.tabela();
  console.log(`\nREFERENCIAS — ${path.basename(pasta)}\n`);
  console.log(tabelaMarkdown(tabela));
  const ressalvas = placar.ressalvas();
  const totalRessalvas = Object.values(ressalvas).reduce((a, r) => a + r.ambiguo + r.morto, 0);
  console.log(`ressalvas declaradas: ${totalRessalvas}`);
  const saida = arg("saida");
  if (saida) {
    // O nome de pessoa e dado de cliente: vai pro ARQUIVO (que fica na maquina
    // de quem roda), nunca pro terminal.
    fs.writeFileSync(saida, JSON.stringify({ pasta, tabela, ressalvas }, null, 2));
    console.log(`detalhe (com nomes) em ${saida}`);
  }
}

export { novoPlacar, tabelaMarkdown, resolver, normalizar };
