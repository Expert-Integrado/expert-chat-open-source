import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { ehAdmin, getPerfil, permitido } from "@/lib/perfil";
import { editaPropriaAutorizacao } from "@/lib/permissoes";
import { msgDb } from "@/lib/mensageria";
import {
  derrubarCacheDispositivos,
  erroDeSchemaAusente,
  ligarPoliticaDeAcesso,
} from "@/lib/acesso";
import { ipPrivado } from "@/lib/dispositivo-ua";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// DISPOSITIVOS E SESSOES (card 86ak85917) — permissao `gerenciar_usuarios`.
//
//   GET    /api/admin/dispositivos[?user_id=...]  -> de onde cada pessoa acessa
//   POST   /api/admin/dispositivos                -> revoga / devolve um dispositivo
//                                                    { id, revogar: true|false }
//   POST   /api/admin/dispositivos                -> revoga TODOS de alguem
//                                                    { user_id, revogar: true }
//   DELETE /api/admin/dispositivos?id=...         -> apaga a LINHA do inventario
//
// O QUE ISTO E, E O QUE NAO E (a tela precisa dizer com estas palavras):
//
// NAO e "as sessoes do Supabase Auth". VERIFY de 31/08/2026 na superficie
// inteira de `GoTrueAdminApi` do @supabase/auth-js 2.112.3 deste repo: existem
// signOut, inviteUserByEmail, generateLink, createUser, listUsers, getUserById,
// updateUserById, deleteUser e mfa.listFactors — e NENHUM listador de sessoes.
// `signOut` ainda exige o JWT do proprio usuario (que o admin nao tem) e, no
// default, e GLOBAL: revoga TODOS os refresh tokens da pessoa em TODOS os apps
// do pool de login. Esse foi o gotcha pago pela Frente G na troca de senha
// (`signOut({scope:"local"})`), e e por isso que **esta rota nunca chama signOut**:
// revogar acesso ao Expert Chat nao pode derrubar ninguem do Meeting Hub.
//
// Entao o inventario e NOSSO: a porta (`lib/auth-server.ts`) carimba
// (pessoa + navegador + sistema) a cada request autenticado, com primeiro
// acesso, ultimo acesso e ultimo IP real (antes do proxy).

const AVISO_SEM_TABELA =
  "inventario de dispositivos indisponivel nesta instalacao — rode a migration 0019_seguranca_conta.sql";

// LIMITE HONESTO, em duas partes, e as duas precisam aparecer na tela.
//
// (1) a impressao sai do `user-agent`, texto que o CLIENTE escolhe: revogar faz
//     ESTE painel recusar quem chega com aquela assinatura — tranca de porta,
//     nao criptografia;
// (2) "dispositivo" aqui e a CLASSE (navegador + sistema), nao a maquina. Foi
//     escolha deliberada — usar o user-agent cru criaria uma linha nova a cada
//     atualizacao do Chrome —, mas o preco e este: duas maquinas com
//     Chrome/Windows colapsam na MESMA linha, e revogar uma revoga as duas.
const LIMITE_HONESTO =
  "Duas coisas sobre revogar: (1) vale so pra este painel e depende do navegador se identificar do mesmo jeito — pra cortar o acesso de vez, desative a pessoa na aba Usuarios, que bloqueia o login em todos os sistemas que usam este mesmo acesso; (2) cada linha aqui e um TIPO de acesso (navegador + sistema), nao uma maquina: se a pessoa usa Chrome no Windows em dois computadores, os dois aparecem como a mesma linha e revogar corta os dois.";

const semTabela = erroDeSchemaAusente;

async function autorizado(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return { erro: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const perfil = await getPerfil(user.id);
  if (!permitido(perfil, "gerenciar_usuarios")) {
    return { erro: NextResponse.json({ error: "sem permissao pra gerenciar usuarios" }, { status: 403 }) };
  }
  return { user, atorEhAdmin: ehAdmin(perfil) };
}

export async function GET(req: NextRequest) {
  const a = await autorizado(req);
  if (a.erro) return a.erro;
  const userId = req.nextUrl.searchParams.get("user_id");
  let q = msgDb()
    .from("usuario_dispositivos")
    .select(
      "id,user_id,impressao,navegador,sistema,rotulo,robo,ip_ultimo,primeiro_acesso_em,visto_em,revogado_em,revogado_por_nome"
    )
    .order("visto_em", { ascending: false })
    .limit(500);
  if (userId) q = q.eq("user_id", userId);
  const { data, error } = await q;
  if (error) {
    if (semTabela(error)) {
      return NextResponse.json(
        { dispositivos: [], disponivel: false, aviso: AVISO_SEM_TABELA, limite_honesto: LIMITE_HONESTO },
        { headers: { "Cache-Control": "no-store, max-age=0" } }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const dispositivos = (data ?? []).map((d: any) => ({
    ...d,
    // a impressao inteira nao serve pra tela e e material de spoof: sai so o
    // prefixo, o bastante pra distinguir duas linhas parecidas
    impressao: String(d.impressao || "").slice(0, 8),
    // IP de rede interna nao rastreia ninguem. A ferramenta antiga registrava o
    // endereco do proprio proxy (10.244.x.x) nos 41 dispositivos e a coluna
    // nasceu inutil — aqui a tela pode avisar em vez de dar falsa precisao.
    ip_interno: ipPrivado(d.ip_ultimo),
    revogado: !!d.revogado_em,
  }));
  return NextResponse.json(
    { dispositivos, disponivel: true, limite_honesto: LIMITE_HONESTO },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(req: NextRequest) {
  const a = await autorizado(req);
  if (a.erro) return a.erro;
  const user = a.user!;
  const body = await req.json().catch(() => ({}));
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const alvoUser = typeof body?.user_id === "string" ? body.user_id.trim() : "";
  // operacao destrutiva por POST com corpo explicito, NUNCA por GET. A
  // ferramenta que este painel substitui remove usuario por link
  // (`/users/remove/...`), e foi esse padrao que fez uma varredura de LEITURA
  // arquivar 20 campanhas de producao em 29/08 (docs/mapa, secao 6).
  const revogar = body?.revogar !== false;
  if (!id && !alvoUser) {
    return NextResponse.json({ error: "informe `id` (um dispositivo) ou `user_id` (todos os dele)" }, { status: 400 });
  }

  // Quem e o DONO do que vai ser mexido — resolvido ANTES de escrever.
  //
  // A primeira versao disto revogava e depois desfazia se tivesse pego a si
  // mesmo. Alem de feio, abria uma janela em que o proprio dispositivo ficava
  // revogado. E deixava passar o caminho inverso: DES-revogar o proprio
  // dispositivo (revogar:false em si mesmo) tambem e mexer na propria
  // autorizacao, e a versao antiga liberava.
  let dono = alvoUser;
  if (id) {
    const { data: linha, error } = await msgDb()
      .from("usuario_dispositivos")
      .select("user_id,revogado_em")
      .eq("id", id)
      .maybeSingle();
    if (error) {
      if (semTabela(error)) return NextResponse.json({ error: AVISO_SEM_TABELA }, { status: 400 });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!linha) return NextResponse.json({ error: "dispositivo nao encontrado" }, { status: 404 });
    dono = linha.user_id as string;
  }

  // NINGUEM MEXE NO PROPRIO ACESSO — nos dois sentidos. Mesma funcao canonica
  // que fecha o furo nas permissoes (lib/permissoes.ts). Super admin e isento
  // pela funcao, e a porta ja nao o barra por dispositivo revogado — entao pra
  // ele isto nunca seria mais que uma linha inerte no inventario.
  if (
    editaPropriaAutorizacao({
      atorEhAdmin: a.atorEhAdmin!,
      atorId: user.id,
      alvoId: dono,
      mexeEmAutorizacao: true,
    })
  ) {
    return NextResponse.json(
      { error: "voce nao pode mexer no acesso dos seus proprios dispositivos — peca a um super admin" },
      { status: 403 }
    );
  }
  // e o super admin tambem nao se revoga por acidente: seria linha inerte, e a
  // tela ficaria mentindo que o acesso dele foi cortado
  if (revogar && dono === user.id) {
    return NextResponse.json({ error: "nao da pra revogar os seus proprios dispositivos" }, { status: 400 });
  }

  const patch = revogar
    ? { revogado_em: new Date().toISOString(), revogado_por_id: user.id, revogado_por_nome: user.nome }
    : { revogado_em: null, revogado_por_id: null, revogado_por_nome: null };

  let q = msgDb().from("usuario_dispositivos").update(patch);
  if (id) q = q.eq("id", id);
  else q = q.eq("user_id", alvoUser);
  const { data, error } = await q.select("id,user_id");
  if (error) {
    if (semTabela(error)) return NextResponse.json({ error: AVISO_SEM_TABELA }, { status: 400 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  derrubarCacheDispositivos();
  // primeira revogacao desta instalacao LIGA a politica de acesso (o marcador
  // `politica_acesso_ativa`): sem ele a porta nem consulta o inventario, e a
  // revogacao nao pegaria.
  const avisoPolitica = revogar ? await ligarPoliticaDeAcesso() : null;
  return NextResponse.json({
    ok: true,
    afetados: data?.length ?? 0,
    revogado: revogar,
    limite_honesto: LIMITE_HONESTO,
    aviso: avisoPolitica ?? undefined,
  });
}

export async function DELETE(req: NextRequest) {
  const a = await autorizado(req);
  if (a.erro) return a.erro;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id obrigatorio" }, { status: 400 });
  // apagar a LINHA e limpeza de inventario, nao revogacao: o dispositivo volta a
  // ser registrado no proximo acesso.
  //
  // POR ISSO apagar linha REVOGADA e recusado (achado de revisao): seria
  // levantar a revogacao em silencio — o admin acha que limpou a lista e na
  // verdade devolveu o acesso. Quem quer devolver usa POST { revogar: false },
  // que e explicito e fica na trilha.
  const { data: linha, error: erroLeitura } = await msgDb()
    .from("usuario_dispositivos")
    .select("revogado_em")
    .eq("id", id)
    .maybeSingle();
  if (erroLeitura) {
    if (semTabela(erroLeitura)) return NextResponse.json({ error: AVISO_SEM_TABELA }, { status: 400 });
    return NextResponse.json({ error: erroLeitura.message }, { status: 500 });
  }
  if (!linha) return NextResponse.json({ error: "dispositivo nao encontrado" }, { status: 404 });
  if (linha.revogado_em) {
    return NextResponse.json(
      {
        error:
          "este dispositivo esta REVOGADO — apagar a linha devolveria o acesso em silencio. Use POST { revogar: false } se e isso que voce quer",
      },
      { status: 400 }
    );
  }
  const { error } = await msgDb().from("usuario_dispositivos").delete().eq("id", id);
  if (error) {
    if (semTabela(error)) return NextResponse.json({ error: AVISO_SEM_TABELA }, { status: 400 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  derrubarCacheDispositivos();
  return NextResponse.json({ ok: true, apagado: id });
}
