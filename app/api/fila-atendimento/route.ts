import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil, ehAdmin, permitido } from "@/lib/perfil";
import { msgDb } from "@/lib/mensageria";
import { getModulosDetalhado, moduloAtivo } from "@/lib/modulos";
import {
  contarFila,
  ehAcaoFila,
  estadoPadrao,
  frasePropria,
  motivoAcaoInerte,
  painelDaFila,
  situacao,
  ACOES_FILA,
  type EstadoFila,
} from "@/lib/fila-atendimento";
import { aplicarGesto, lerFila, lerFilaDe } from "@/lib/fila-atendimento-db";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// FILA DE ATENDIMENTO (Frente S, card 86ak85nxx).
//
//   GET   -> o MEU estado (sempre) + o painel do time (so pra quem gerencia)
//   POST  -> { acao: "entrar" | "sair" | "pular" | "voltar" } no MEU estado
//
// ESTA ROTA NAO FALA DE CANAL, de proposito, e por isso ela NAO entra na
// `CANAL_PADRAO_EM` de lib/escopo-chave.ts: a disponibilidade e da PESSOA, nao
// do numero. Quem esta fora da fila esta fora dela em todos os canais — dizer
// "estou disponivel no numero A e nao no B" seria uma feature diferente, que
// ninguem pediu, e o card e explicito ("o atendente entra e sai da fila").
// (O verbete de RECURSO existe: `conta`, ver o mapa em lib/escopo-chave.ts.)
//
// PERMISSAO — as duas metades sao diferentes de proposito:
//
//  * MEXER NO PROPRIO ESTADO nao exige permissao nomeada nenhuma. E
//    autoatendimento, como tema, foto e senha em /api/perfil: dizer "nao posso
//    atender agora" e sobre a pessoa, nao sobre a instalacao. Exigir `enviar`
//    aqui criaria o caso absurdo de alguem preso na fila por nao ter permissao
//    de sair dela.
//  * VER O TIME exige `gerenciar_usuarios` (ou super admin). O painel diz o nome
//    de quem esta fora da fila — informacao de gestao, e o card pede exatamente
//    isso ("o gestor ve quem esta na fila, quem esta fora e quem pulou").
//    Sem a permissao, a resposta traz SO o proprio estado; a lista nem e lida.
//
// NINGUEM MEXE NO ESTADO DE OUTRO por esta rota, nem o super admin. Nao e
// esquecimento: "entrei na fila" e uma afirmacao sobre a disponibilidade de uma
// PESSOA, e um gestor marcando "fulano esta disponivel" pelo painel colocaria
// conversa de cliente na mao de quem foi ao medico. Se um dia isso for pedido,
// o gesto tem que aparecer na trilha COM o autor (as colunas
// `atualizado_por_*` da 0021 ja existem justamente pra esse dia).

const semCache = { "Cache-Control": "no-store, max-age=0" } as const;

/** Minutos de "online" — o mesmo corte que lib/rodizio.ts usa pra candidato. */
const JANELA_ONLINE_MS = 5 * 60_000;

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  // a leitura DETALHADA (nao o booleano): o campo `fila_indisponivel` abaixo
  // precisa saber se a flag FALHOU, nao so o que ela diz.
  const flag = await getModulosDetalhado();
  const ativo = flag.mapa.fila_atendimento === true;
  const agora = Date.now();

  // MODULO DESLIGADO responde 200 dizendo isso, nunca 403. Motivo: quem chama
  // esta rota e a propria tela, pra saber se DESENHA o controle da fila. Um 403
  // aqui viraria erro no console de toda instalacao que nao ligou o modulo — e
  // barulho no log e o que faz ninguem mais ler o log.
  if (!ativo) {
    return NextResponse.json(
      { modulo_ativo: false, acoes: ACOES_FILA, eu: null, painel: null },
      { headers: semCache }
    );
  }

  const podeVerTime = ehAdmin(perfil) || permitido(perfil, "gerenciar_usuarios");

  const meu = await lerFilaDe([user.id]);
  const estadoMeu: EstadoFila = meu.ok ? meu.estados.get(user.id) ?? estadoPadrao(user.id) : estadoPadrao(user.id);
  const aviso = meu.ok ? null : meu.aviso;
  const migrationPendente = meu.ok ? false : meu.migration_pendente;

  // FREIO ENGATADO? — campo PROPRIO, separado do `aviso` (correcao da 2a revisao).
  //
  // O `aviso` e compartilhado: uma falha ao listar o TIME tambem o preenche, e a
  // tela usava ele pra pintar "a distribuicao parou" — alarme falso, porque
  // listar o painel nao tem nada a ver com distribuir conversa. Este campo olha SO
  // a leitura da tabela da fila (a MESMA que lib/rodizio.ts faz antes de
  // distribuir), e exclui migration pendente, que nao freia nada.
  // AS DUAS CAUSAS, nao uma (achado da 3a revisao): o rodizio recusa tanto por
  // tabela ilegivel QUANTO por flag ilegivel com o modulo ligado. Calculando so a
  // primeira, uma falha SO na flag invertia o sinal — o rodizio recusava enquanto
  // a tela dizia "voce esta na fila e pode receber conversa nova" e nenhuma faixa
  // aparecia. Sinal que contradiz o comportamento e pior que sinal nenhum.
  const filaIndisponivel = (!meu.ok && !meu.migration_pendente) || (flag.falhou && ativo);

  const base = {
    modulo_ativo: true,
    acoes: ACOES_FILA,
    migration_pendente: migrationPendente,
    fila_indisponivel: filaIndisponivel,
    aviso,
    eu: {
      user_id: user.id,
      situacao: situacao(estadoMeu, agora),
      pulou_desde: estadoMeu.pular_desde,
      frase: frasePropria(situacao(estadoMeu, agora)),
    },
    pode_ver_time: podeVerTime,
  };

  if (!podeVerTime) return NextResponse.json({ ...base, painel: null }, { headers: semCache });

  // O painel lista PESSOAS ATIVAS, nao linhas da tabela da fila: quem nunca
  // mexeu na fila esta DENTRO dela, e nao aparecer daria a impressao oposta.
  const { data: pessoas, error: erroPessoas } = await msgDb()
    .from("perfis")
    .select("user_id,nome,ativo,visto_em")
    .order("nome");
  if (erroPessoas) {
    console.error("fila-atendimento (perfis):", erroPessoas.code, erroPessoas.message);
    return NextResponse.json(
      { ...base, painel: null, aviso: aviso ?? "nao deu pra listar o time agora" },
      { headers: semCache }
    );
  }
  // FRENTE S — NOME DE VERDADE no painel (correcao da revisao cega).
  //
  // `perfis.nome` costuma estar VAZIO nesta base (a linha de perfil nasce no 1o
  // acesso e o nome mora no metadata do auth), e o painel caia no rotulo generico
  // "Atendente" pra TODO MUNDO — uma lista de seis "Atendente" nao serve pra
  // decidir nada. Resolucao pelo MESMO caminho canonico do /api/users: metadata
  // do auth, com o local do e-mail como ultimo recurso; `perfis.nome`, quando
  // tem conteudo, VENCE (e o apelido que a instalacao escolheu).
  const nomeDoAuth = new Map<string, string>();
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const admin = createClient(process.env.MSG_SUPABASE_URL!, process.env.MSG_SUPABASE_SERVICE_KEY!, {
      auth: { persistSession: false },
    });
    const { data: lista } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    for (const u of lista?.users ?? []) {
      const n =
        (u.user_metadata?.nome as string) ||
        (u.user_metadata?.name as string) ||
        (u.user_metadata?.full_name as string) ||
        (u.email ? u.email.split("@")[0] : "");
      if (n) nomeDoAuth.set(u.id, n);
    }
  } catch (e) {
    // sem os nomes o painel ainda FUNCIONA (situacao e contagem estao corretas):
    // degrada pro que `perfis` tiver, nunca derruba a tela.
    console.error("fila-atendimento (nomes do auth):", e);
  }

  const todas = await lerFila();
  const estados = todas.ok ? todas.estados : new Map<string, EstadoFila>();
  const corte = agora - JANELA_ONLINE_MS;
  const linhas = painelDaFila(
    (pessoas ?? [])
      .filter((p: any) => p.ativo !== false)
      .map((p: any) => ({
        user_id: p.user_id,
        nome: String(p.nome ?? "").trim() || nomeDoAuth.get(p.user_id) || "",
        online: !!p.visto_em && Date.parse(p.visto_em) >= corte,
      })),
    estados,
    agora
  );
  return NextResponse.json(
    {
      ...base,
      aviso: aviso ?? (todas.ok ? null : todas.aviso),
      migration_pendente: migrationPendente || (!todas.ok && todas.migration_pendente),
      painel: { linhas, contagem: contarFila(linhas) },
    },
    { headers: semCache }
  );
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await moduloAtivo("fila_atendimento"))) {
    return NextResponse.json(
      { error: "fila de atendimento desligada nesta instalacao" },
      { status: 403 }
    );
  }
  const body = await req.json().catch(() => ({} as any));
  const acao = body?.acao;
  if (!ehAcaoFila(acao)) {
    return NextResponse.json({ error: "acao invalida" }, { status: 400 });
  }
  // O corpo NAO aceita user_id: ver o cabecalho. Recusar EXPLICITAMENTE em vez
  // de ignorar em silencio — quem manda o campo esta esperando outro efeito, e
  // um 200 faria parecer que o estado do colega mudou.
  if (body?.user_id !== undefined && body.user_id !== user.id) {
    return NextResponse.json(
      { error: "esta rota so mexe na SUA disponibilidade — ninguem entra ou sai da fila no lugar de outro" },
      { status: 403 }
    );
  }

  const antes = await lerFilaDe([user.id]);
  const estadoAntes = antes.ok ? antes.estados.get(user.id) ?? estadoPadrao(user.id) : estadoPadrao(user.id);
  // Gesto que nao muda nada responde 200 com o motivo (nao 400): o estado final
  // e o que a pessoa pediu, e um erro faria a tela mostrar falha pra um clique
  // que chegou ao resultado certo.
  const inerte = antes.ok ? motivoAcaoInerte(estadoAntes, acao, Date.now()) : null;

  const r = await aplicarGesto({ id: user.id, nome: user.nome }, acao);
  if (!r.ok) {
    return NextResponse.json(
      { error: r.aviso, migration_pendente: r.migration_pendente },
      { status: r.migration_pendente ? 503 : 500 }
    );
  }
  const s = situacao(r.estado, Date.now());
  return NextResponse.json(
    {
      ok: true,
      eu: { user_id: user.id, situacao: s, pulou_desde: r.estado.pular_desde, frase: frasePropria(s) },
      ...(inerte ? { nada_mudou: inerte } : {}),
    },
    { headers: semCache }
  );
}
