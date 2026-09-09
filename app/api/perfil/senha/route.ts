import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { usuarioPorSessao } from "@/lib/auth-server";
import { validarTrocaDeSenha } from "@/lib/perfil-conta";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Troca da PROPRIA senha, exigindo a senha atual (reautenticacao).
//
// Por que a senha atual: sem ela, qualquer sessao esquecida aberta no
// computador do escritorio troca a senha da pessoa e toma a conta — e a senha
// deste painel vale pro pool de login inteiro (Meeting Hub etc.). Fail-closed:
// senha atual errada, faltando ou ilegivel = nada e gravado.
//
// Identidade SO por sessao de login (nunca x-api-key), mesma regra da gestao de
// chaves: chave de agente vazada nao pode trocar a senha do dono.
//
// A sessao ATUAL do navegador continua valendo depois da troca, e nenhum outro
// app do pool de auth e deslogado — ver o comentario do `descartarEfemera`.
//
// LIMITE CONHECIDO (honesto): o endpoint de auth do Supabase continua alcancavel
// direto do navegador com a anon key — quem ja tem a sessao pode trocar a senha
// por fora deste painel. A exigencia daqui protege o FLUXO do painel; travar o
// caminho direto seria decisao do projeto de auth, nao deste repo.

// Freio de forca-bruta na senha atual: 5 erros por usuario a cada 15 min.
// Memoria da instancia (o painel nao tem rate limit proprio ainda, divida
// declarada no CLAUDE.md) — segura tentativa em rajada, nao ataque distribuido.
const TETO_ERROS = 5;
const JANELA_MS = 15 * 60_000;
const erros = new Map<string, { qtd: number; desde: number }>();

function bloqueado(userId: string): boolean {
  const e = erros.get(userId);
  if (!e) return false;
  if (Date.now() - e.desde > JANELA_MS) {
    erros.delete(userId);
    return false;
  }
  return e.qtd >= TETO_ERROS;
}

function contarErro(userId: string) {
  const e = erros.get(userId);
  if (!e || Date.now() - e.desde > JANELA_MS) erros.set(userId, { qtd: 1, desde: Date.now() });
  else e.qtd += 1;
}

export async function POST(req: NextRequest) {
  const user = await usuarioPorSessao(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!user.email) {
    return NextResponse.json(
      { error: "Esta conta nao tem e-mail — a troca de senha precisa de e-mail." },
      { status: 400 }
    );
  }
  if (bloqueado(user.id)) {
    return NextResponse.json(
      { error: "Muitas tentativas com a senha atual errada. Espere 15 minutos e tente de novo." },
      { status: 429 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const senhaAtual = body?.senha_atual;
  const senhaNova = body?.senha_nova;
  const problema = validarTrocaDeSenha(senhaAtual, senhaNova);
  if (problema) return NextResponse.json({ error: problema }, { status: 400 });

  // 1. REAUTENTICACAO: confere a senha atual num cliente EFEMERO (persistSession
  //    false) — a sessao do navegador nao e tocada, entao quem usa 2FA nao cai
  //    de aal2 pra aal1 no meio da troca.
  const anon = createClient(process.env.NEXT_PUBLIC_AUTH_URL!, process.env.NEXT_PUBLIC_AUTH_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u: any, i: any) => fetch(u, { ...i, cache: "no-store" }) },
  });
  const { data: login, error: erroLogin } = await anon.auth.signInWithPassword({
    email: user.email,
    password: senhaAtual as string,
  });
  if (erroLogin || !login?.user || login.user.id !== user.id) {
    contarErro(user.id);
    return NextResponse.json({ error: "Senha atual incorreta." }, { status: 400 });
  }
  erros.delete(user.id);

  // Descarte da sessao EFEMERA que a conferencia acabou de criar.
  // `scope: "local"` NAO e detalhe: o default do auth-js e GLOBAL, que revoga
  // TODOS os refresh tokens do usuario — trocar a senha aqui deslogaria a pessoa
  // de todos os apps do pool de auth (Meeting Hub etc.) e, no caminho de erro,
  // deslogaria sem nem ter trocado a senha. Local derruba so este token.
  // Roda DEPOIS da gravacao (nos dois desfechos): falha de escrita nao pode
  // custar sessao nenhuma.
  const descartarEfemera = () => anon.auth.signOut({ scope: "local" }).catch(() => {});

  // 2. GRAVACAO: pelo admin do mesmo projeto (o pool de login e o mesmo BD que o
  //    painel ja administra em /api/users e /api/admin/usuarios). Vale pro
  //    auth inteiro — todos os apps que usam este login.
  const admin = createClient(process.env.MSG_SUPABASE_URL!, process.env.MSG_SUPABASE_SERVICE_KEY!, {
    auth: { persistSession: false },
    global: { fetch: (u: any, i: any) => fetch(u, { ...i, cache: "no-store" }) },
  });
  const { error } = await admin.auth.admin.updateUserById(user.id, { password: senhaNova as string });
  await descartarEfemera();
  if (error) {
    // mensagem do provedor pode ser tecnica; devolvemos uma legivel e nao vazamos detalhe
    return NextResponse.json(
      { error: "Nao consegui salvar a nova senha. Tente de novo em alguns instantes." },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
