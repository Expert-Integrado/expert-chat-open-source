// Predicado de visibilidade de conversa — a peca mais critica de seguranca do
// painel. Extraido de lib/perfil.ts em 31/08/2026 SEM alterar uma linha da
// logica: o motivo unico da mudanca e que aqui o arquivo e PURO (nenhum import
// de valor, so `import type`, que o type stripping do Node apaga) e portanto da
// pra prova-lo em node solto — `node scripts/prova-permissoes.ts`.
//
// Antes disso o predicado morava ao lado do client do Supabase e so podia ser
// exercitado com o banco na frente, ou seja: nao era exercitado.
//
// lib/perfil.ts re-exporta tudo daqui, entao as rotas seguem importando de
// "@/lib/perfil" como sempre. Quem mexer nesta funcao ATUALIZA a matriz da
// prova junto — regra da casa.

import type { UsuarioLogado } from "@/lib/auth-server";

// Responsaveis de uma conversa (N:N — varias pessoas E departamentos juntos).
export type Responsavel = { tipo: "usuario" | "departamento"; ref_id: string };

// Contexto do escopo "departamento": pessoa pode estar em VARIOS departamentos.
// meusDeps = deps do usuario; colegas = quem divide pelo menos um dep com ele.
export type ContextoVisao = { meusDeps: Set<string>; colegas: Set<string> };

// Entrada da ACL fixa por chat (F9, 17/08): quem PODE ver, independente de
// quem esta atendendo. 'contexto' = BU (embed_contextos.id).
export type VisibilidadeEntry = { tipo: "usuario" | "departamento" | "contexto"; ref_id: string };

// ————————————————————————————————————————————————————————————————
// RESTRICAO POR FUNIL E POR CANAL (numero) — card 86ak85zm4, 31/08/2026.
//
// VERIFY do que existia antes: a visibilidade tinha DUAS dimensoes, as duas
// GLOBAIS quanto a funil e a numero — (a) o ESCOPO de visao
// (proprias/departamento/todas), que fala de RESPONSAVEL, e (b) a ACL por
// conversa (`conversa_visibilidade`), que e uma trava dura por chat, cadastrada
// uma conversa por vez. Nao havia como dizer "o time do comercial ve o funil de
// vendas e o numero da loja, e mais nada": pra conseguir isso era preciso
// cadastrar a ACL de cada conversa, uma a uma, pra sempre.
//
// O QUE ENTRA: uma linha por usuario com as listas do que ele alcanca. Lista
// VAZIA = dimensao sem restricao. Usuario SEM linha = comportamento identico ao
// de antes — e o estado de toda instalacao existente, entao nada muda no deploy.
//
// FAIL-CLOSED, e o que isso quer dizer aqui, exatamente:
//  - restricao presente e o ALVO nao pode ser avaliado (o chamador nao trouxe
//    canal/funil da conversa) = NEGA. Chamador que esquecer de trazer o alvo
//    perde acesso; nunca ganha. Foi essa escolha que permitiu deixar o
//    parametro opcional sem abrir buraco em quem ainda nao passa por aqui.
//  - conversa SEM nenhum funil, pra quem esta restrito a funis = NEGA por
//    padrao. `sem_funil` liberado e um "sim" explicito do admin, porque essa
//    escolha decide se a pessoa ve ou nao a maior parte da caixa (conversa nao
//    entra em funil sozinha).
//  - a restricao NAO tem a valvula do "responsavel sempre ve" que a ACL tem.
//    Restringir alguem a um numero e dizer que ele nao le os OUTROS numeros —
//    inclusive um em que alguem o marcou como responsavel por engano.
export type RestricaoUsuario = {
  /** ids de canal que a pessoa alcanca. Vazio = todos. */
  canais: string[];
  /** ids de funil que a pessoa alcanca. Vazio = todos. */
  funis: string[];
  /** com restricao de funil, conversa sem funil nenhum tambem aparece? */
  sem_funil: boolean;
};

/** O que se sabe da conversa que esta sendo avaliada. */
export type AlvoConversa = {
  canal: string;
  /** funis a que a conversa esta vinculada (mensageria.conversa_funil). */
  funilIds: string[];
};

/** O par que o chamador entrega ao predicado. `alvo: null` = nao deu pra saber. */
export type RestricaoAplicada = {
  restricao: RestricaoUsuario | null;
  alvo: AlvoConversa | null;
};

/** Nao restringe nada — o estado de quem nao tem linha. */
export function restricaoVazia(r: RestricaoUsuario | null | undefined): boolean {
  return !r || (!r.canais.length && !r.funis.length);
}

/**
 * A restricao permite esta conversa? Puro, e o unico lugar da regra.
 * `motivo` existe pro relato de admin; a decisao e o booleano.
 */
export function restricaoPermite(
  r: RestricaoUsuario | null | undefined,
  alvo: AlvoConversa | null | undefined
): boolean {
  if (restricaoVazia(r)) return true;
  // restricao existe e o alvo nao veio: NEGA (ver cabecalho)
  if (!alvo) return false;
  const rr = r as RestricaoUsuario;
  if (rr.canais.length && !rr.canais.includes(alvo.canal)) return false;
  if (rr.funis.length) {
    const ids = alvo.funilIds ?? [];
    if (!ids.length) return rr.sem_funil;
    if (!ids.some((f) => rr.funis.includes(f))) return false;
  }
  return true;
}

// So o que o predicado realmente le do perfil. Deixar estreito de proposito:
// permissao nomeada NAO entra aqui — visibilidade continua governada por
// papel + escopo_visao, e o papel age antes, como TETO do escopo (lib/permissoes.ts).
export type PerfilVisao = {
  papel: "super_admin" | "normal";
  escopo_visao: "proprias" | "departamento" | "todas";
};

// Predicado unico de visibilidade, em camadas:
// 1. super_admin ve tudo.
// 2. ACL fixa (conversa_visibilidade): lista NAO-vazia = so ve quem casa uma
//    entrada (usuario=eu; departamento=um dos meus; contexto=BU que tenho
//    vinculada — ou sou irrestrito, sem vinculo nenhum, mesma semantica do
//    1:1 por telefone). O RESPONSAVEL atual sempre ve (senao nao atende).
//    Vale ate pra escopo "todas": ACL e trava dura do cadastro.
// 2b. RESTRICAO por funil/canal (31/08): trava dura por PESSOA, sem valvula de
//    responsavel. Vem depois do super admin e antes de tudo o mais — quem esta
//    restrito a um numero nao le outro numero por nenhum caminho.
// 3. Escopo: "todas" ve; ENCERRADA (concluido) e pool de todo mundo (Eric,
//    16/08 — quem responder assume, troca de posse no /api/send); sem
//    responsavel e de todo mundo; senao a regra proprias/departamento.
export function conversaVisivel(
  responsaveis: Responsavel[],
  user: UsuarioLogado,
  perfil: PerfilVisao,
  ctx: ContextoVisao,
  status?: string | null,
  visibilidade?: VisibilidadeEntry[] | null,
  // ids de BUs vinculadas ao usuario (perfil_contextos); null = SEM vinculo
  vinculosBuIds?: string[] | null,
  // restricao por funil/canal + o alvo. Ausente = SEM restricao (o estado de
  // toda instalacao existente, e o que mantem os chamadores antigos intactos).
  restr?: RestricaoAplicada | null
): boolean {
  if (perfil.papel === "super_admin") return true;
  if (restr && !restricaoPermite(restr.restricao, restr.alvo)) return false;
  if (visibilidade?.length) {
    const naLista = visibilidade.some((v) =>
      v.tipo === "usuario"
        ? v.ref_id === user.id
        : v.tipo === "departamento"
          ? ctx.meusDeps.has(v.ref_id)
          : vinculosBuIds == null || vinculosBuIds.includes(v.ref_id)
    );
    const ehDono = responsaveis.some((r) => r.tipo === "usuario" && r.ref_id === user.id);
    if (!naLista && !ehDono) return false;
  }
  if (perfil.escopo_visao === "todas") return true;
  if (status === "concluido") return true;
  if (!responsaveis.length) return true;
  if (perfil.escopo_visao === "proprias") {
    return responsaveis.some((r) => r.tipo === "usuario" && r.ref_id === user.id);
  }
  return responsaveis.some((r) =>
    r.tipo === "departamento"
      ? ctx.meusDeps.has(r.ref_id)
      : r.ref_id === user.id || ctx.colegas.has(r.ref_id)
  );
}
