// OS ADAPTADORES do construtor de ficha (Frente X, card 86ak85nxn) — a peca que
// liga o corpo das rotas (`executarArquivamento`, `executarFichaConfig`, em
// lib/campos.ts) ao banco.
//
// POR QUE ELES SAIRAM DO ARQUIVO DE ROTA (4a rodada da re-revisao cega,
// 01/09/2026). As rodadas anteriores tiraram a DECISAO da rota e depois o CORPO
// da rota; sobrou o que a re-revisao chamou de "zona sem guarda nenhuma": os
// efeitos injetados. Rota importa `next/server`, entao rota nenhuma prova
// consegue IMPORTAR — e o que ficava escrito ali so alcancava varredura. Duas
// mutacoes plausiveis (nao evasivas: sao o que um dev escreve achando que esta
// sendo tolerante) passavam com a bateria inteira verde:
//
//   * `lerNomes: async () => ({ data: data ?? [], erro: null })` — o adaptador
//     engole o erro do SELECT. `decidirColisaoNoCatalogo` passa a ler "catalogo
//     vazio", o campo nasce SEM conferencia de colisao, `acharCampo` fica ambiguo
//     e toda escrita naquele campo e recusada na conta inteira. O 503 fail-closed
//     morre em silencio.
//   * `medirImpacto: async (n) => ({...await impactoDoCampo(n), conversas: 0,
//     por_canal: []})` — a previa do arquivamento diz "0 conversas afetadas" e o
//     dono arquiva achando que nao perde nada. Essa forma deixou de EXISTIR: o
//     efeito do arquivamento passou a ser a contagem de UM canal, e quem soma e
//     quem decide `incompleto` e o `medirImpacto` PURO — ver o verbete de
//     `EfeitosDeArquivamento` em lib/campos.ts.
//
// ESTE ARQUIVO NAO IMPORTA VALOR NENHUM — so `import type` de `./campos.ts`, que
// o type-stripping apaga. E o que permite a prova montar os efeitos com um banco
// FAKE, rodar a rota inteira de mentira e conferir o DESFECHO — inclusive que o
// erro do banco CHEGA na decisao.
//
// A FRONTEIRA: o que sobra no arquivo de rota e `porta -> montar efeito ->
// executar -> NextResponse`, sem uma linha de logica de adaptacao. Adaptador com
// logica e adaptador que pode mentir pra decisao pura.
import type {
  EfeitosDeArquivamento,
  EfeitosDeFichaConfig,
  GravacaoDeCampo,
} from "./campos.ts";

/**
 * O MINIMO do cliente do banco que estes adaptadores usam.
 *
 * `any` no construtor de consulta e deliberado: o encadeamento do supabase-js
 * (`.select().order().limit()`, `.upsert(...).select().single()`) tem tipo
 * generico que nao se escreve estruturalmente sem arrastar o pacote inteiro pra
 * dentro de um arquivo que existe justamente pra rodar sem ele. O que importa
 * aqui e a forma da RESPOSTA (`{ data, error }`), e essa a prova confere
 * EXECUTANDO com um fake.
 */
export type PortaDoBanco = { from: (tabela: string) => any };

/**
 * OS EFEITOS DA ROTA ANTIGA DE CATALOGO (`/api/admin/ficha-config`).
 *
 * `lerNomes` devolve a resposta CRUA — `data` e `erro` como o banco mandou. Nao
 * tem `?? []`, nao tem `erro: null`: quem decide o que "sem resposta" e "com erro"
 * significam e `decidirColisaoNoCatalogo`, que FALHA FECHADO em 503. Adaptador que
 * "normaliza" a resposta esta decidindo, e decidindo no unico lugar onde nenhuma
 * prova enxergava.
 *
 * As quatro consultas sao as MESMAS que estavam no handler, expressao por
 * expressao (inclusive `onConflict: "nome"` no upsert e `motivo: error.message`):
 * esta mudanca move o codigo pra onde a prova alcanca, e nao muda o que a rota
 * responde.
 */
export function efeitosDeFichaConfig(db: PortaDoBanco): EfeitosDeFichaConfig {
  return {
    atualizar: async (tabela, alvo, patch) => {
      const { error } = await db.from(tabela).update(patch).eq("id", alvo);
      return error ? { ok: false as const, motivo: error.message } : { ok: true as const };
    },
    lerNomes: async () => {
      const { data, error } = await db.from("campos_personalizados").select("nome,ativo");
      return { data, erro: error };
    },
    proximaOrdem: async () => {
      const { data: max } = await db
        .from("campos_personalizados")
        .select("ordem")
        .order("ordem", { ascending: false })
        .limit(1);
      return (max?.[0]?.ordem ?? 0) + 1;
    },
    inserir: async (tabela, linha) => {
      const { data, error } = await db.from(tabela).upsert(linha, { onConflict: "nome" }).select().single();
      return error ? { ok: false as const, motivo: error.message } : { ok: true as const, item: data };
    },
  };
}

/**
 * OS EFEITOS DO ARQUIVAMENTO (`POST /api/campos`, acoes `arquivar`/`reativar`).
 *
 * `contar` e a contagem de UM canal — o menor pedaco que precisa de banco — e ela
 * atravessa daqui pra decisao SEM normalizacao: `null` do executor tem que chegar
 * `null` em `medirImpacto`, senao `incompleto` nunca acende e a remocao/o
 * arquivamento decidem contra uma contagem que nao houve. Um `?? 0` nesta linha e
 * a mutacao plausivel, e ela morre por desfecho: a prova monta este efeito com um
 * `contar` que devolve `null` num canal e cobra veredito `recusar`.
 *
 * `tiposDisponiveis` viaja PRA DENTRO do adaptador (e nao como argumento solto no
 * call site) porque e ele que decide se `atualizado_em` entra no UPDATE: com a
 * 0025 pendente, gravar a coluna derruba o arquivamento com erro de coluna
 * inexistente.
 *
 * `agora` tem default aqui e nao na decisao: a decisao PURA nao pode ter relogio
 * proprio (a prova precisa carimbar o que quiser), e a rota nao tem que saber que
 * o carimbo existe.
 */
export function efeitosDeArquivamento(io: {
  canais: readonly string[];
  contar: (canal: string, nome: string) => Promise<number | null>;
  gravarCampo: (id: string, patch: Record<string, unknown>, comColunasNovas: boolean) => Promise<GravacaoDeCampo>;
  tiposDisponiveis: boolean;
  agora?: () => string;
}): EfeitosDeArquivamento {
  return {
    canais: io.canais,
    contar: io.contar,
    gravar: (id, patch) => io.gravarCampo(id, patch, io.tiposDisponiveis),
    agora: io.agora ?? (() => new Date().toISOString()),
  };
}
