import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil, ehAdmin, podeVerConversa } from "@/lib/perfil";
import { msgDb } from "@/lib/mensageria";
import { canalDe, tabelas } from "@/lib/canal";
import { canalPorId, fonteExterna } from "@/lib/canais";
import { restricaoEfetiva } from "@/lib/embed";
import { getConfig, fusoDaConfig } from "@/lib/config";
import { horaNoFuso } from "@/lib/fuso";
import { lerContexto } from "@/lib/fluxo/contexto-db";
import {
  catalogoDeVariaveis, saudacaoDaHora, substituirVariaveis, variaveisDoTexto,
  type ValoresVariavel,
} from "@/lib/fluxo/variaveis";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const ATALHO_RE = /^[a-z0-9_-]{1,30}$/;

// Respostas rapidas: atalho "/" no compositor. Globais (dono_id null, so admin
// gerencia) + pessoais de cada atendente.
//
// VARIAVEIS (card 86ak86jw9): quando o GET vem com `canal` e `chat_id`, cada
// resposta volta tambem RESOLVIDA (`texto_resolvido`) — `!nome`, `!primeiro_nome`,
// `!telefone`, `!atendente`, `!campo.<x>` e `$variavel` trocados pelo valor real
// daquela conversa. A regra de substituicao e PURA e mora em
// `lib/fluxo/variaveis.ts` (mesma sintaxe do motor de automacao; doc unica em
// `docs/variaveis.md`); aqui so se le o banco e se monta o mapa de valores.
//
// Sem `chat_id` a rota responde como sempre respondeu (lista crua) — e assim que
// a tela de cadastro continua mostrando o TEMPLATE, com as variaveis a vista.
//
// COSTURA DE UI DECLARADA: quem renderiza o compositor e `app/home.tsx`, que tem
// outro dono nesta onda (Frente S). O que esta pronto e provado aqui e a lib + a
// rota; plugar e passar `canal`/`chat_id` no fetch que a tela ja faz e usar
// `texto_resolvido` em vez de `texto` ao inserir na caixa — o atendente edita
// depois, porque o texto entra no rascunho, nao no envio.

type Linha = {
  id: string;
  atalho: string;
  texto: string;
  dono_id: string | null;
  origem_ferramenta?: string | null;
};

// Colunas de origem sao da migration 0020. Sem ela o PostgREST devolve 42703 e a
// leitura e refeita sem elas: some o rotulo de "veio da importacao" (e com ele o
// tratamento do formato antigo), nunca a resposta rapida. Mesmo padrao de
// degradacao em duas camadas de /api/fluxos.
const COLS_BASE = "id,atalho,texto,dono_id";
const COLS_0020 = `${COLS_BASE},origem_ferramenta`;
const COL_INEXISTENTE = "42703";
let marcaSem0020 = 0;
const sem0020 = () => Date.now() - marcaSem0020 < 60_000;

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = msgDb();
  const monta = (cols: string) =>
    db
      .from("respostas_rapidas")
      .select(cols)
      .or(`dono_id.is.null,dono_id.eq.${user.id}`)
      .order("atalho");

  let usou0020 = !sem0020();
  let { data, error } = await monta(usou0020 ? COLS_0020 : COLS_BASE);
  if (error && (error as any).code === COL_INEXISTENTE && usou0020) {
    marcaSem0020 = Date.now();
    usou0020 = false;
    ({ data, error } = await monta(COLS_BASE));
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const linhas = (data ?? []) as unknown as Linha[];
  const chatId = req.nextUrl.searchParams.get("chat_id");
  const canal = canalDe(req);

  // Sem conversa nao ha o que resolver: lista crua, com o catalogo de ajuda.
  if (!chatId) {
    const { data: campos } = await db
      .from("campos_personalizados")
      .select("nome")
      .eq("ativo", true)
      .order("ordem");
    return NextResponse.json(
      {
        respostas: linhas.map((r) => ({
          id: r.id,
          atalho: r.atalho,
          texto: r.texto,
          dono_id: r.dono_id,
          global: r.dono_id === null,
          importada: !!r.origem_ferramenta,
          variaveis: variaveisDoTexto(r.texto, { legado: !!r.origem_ferramenta }).map((u) => u.token),
        })),
        catalogo_variaveis: catalogoDeVariaveis((campos ?? []).map((c: any) => c.nome)),
        origem_disponivel: usou0020,
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }

  // COM conversa: o gate e o MESMO da conversa. Resolver variavel devolve NOME,
  // TELEFONE e CAMPOS DA FICHA de um contato — quem nao pode abrir a conversa nao
  // pode ler isso por uma porta lateral.
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });
  if (!(await podeVerConversa(chatId, user, perfil, canal))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }
  if (emb && !emb.permite(chatId)) {
    return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
  }

  const cfg = await getConfig();
  const fuso = fusoDaConfig(cfg);
  const valores: ValoresVariavel = {
    telefone: chatId.replace(/\D/g, "") || chatId,
    atendente: user.nome,
    saudacao: saudacaoDaHora(horaNoFuso(new Date(), fuso)),
  };
  const avisos: string[] = [];

  const def = canalPorId(canal);
  if (def && !fonteExterna(def)) {
    const T = tabelas(canal);
    const { data: conv } = await db
      .from(T.conversas)
      .select("nome,ficha")
      .eq("chat_id", chatId)
      .maybeSingle();
    valores.nome = (conv as any)?.nome ?? null;
    valores.campos = ((conv as any)?.ficha ?? null) as Record<string, unknown> | null;
  } else {
    // canal de fonte externa: o painel nao tem a linha da conversa, entao nome e
    // ficha nao existem pra ler. As variaveis desses campos saem VAZIAS (a regra
    // do card) e a resposta diz por que — a tela nao pode fingir que leu.
    avisos.push("canal de fonte externa: nome e campos da ficha nao existem no painel, essas variaveis saem vazias");
  }

  // Contexto so e buscado se ALGUMA resposta usar `$variavel` — a rota do
  // compositor e chamada a cada conversa aberta e nao vai pagar um SELECT que
  // ninguem consome.
  const usaContexto = linhas.some((r) =>
    variaveisDoTexto(r.texto, { legado: !!r.origem_ferramenta }).some((u) => u.forma === "contexto")
  );
  if (usaContexto) {
    const ctx = await lerContexto(canal, chatId);
    if (ctx.ok) valores.contexto = ctx.dados;
    else avisos.push(ctx.aviso);
  }

  return NextResponse.json(
    {
      respostas: linhas.map((r) => {
        // O formato do sistema ANTIGO (`{CHAVE}`) so e interpretado em resposta
        // que VEIO de importacao. Texto escrito na tela do painel usa a sintaxe
        // daqui, e olhar `{...}` nele transformaria chave de JSON colada no texto
        // em variavel sem ninguem pedir.
        const legado = !!r.origem_ferramenta;
        const s = substituirVariaveis(r.texto, valores, { legado });
        return {
          id: r.id,
          atalho: r.atalho,
          texto: r.texto,
          texto_resolvido: s.texto,
          dono_id: r.dono_id,
          global: r.dono_id === null,
          importada: legado,
          variaveis_preenchidas: s.preenchidas,
          variaveis_vazias: s.vazias,
          variaveis_nao_resolvidas: s.nao_resolvidos,
        };
      }),
      canal,
      chat_id: chatId,
      origem_disponivel: usou0020,
      ...(avisos.length ? { avisos } : {}),
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { atalho, texto, global } = await req.json().catch(() => ({}));
  const a = String(atalho || "").trim().toLowerCase().replace(/^\//, "");
  const t = String(texto || "").trim();
  if (!ATALHO_RE.test(a)) {
    return NextResponse.json({ error: "atalho invalido (letras, numeros, - e _, ate 30)" }, { status: 400 });
  }
  if (!t || t.length > 2000) return NextResponse.json({ error: "texto obrigatorio (ate 2000)" }, { status: 400 });
  const ehGlobal = global === true;
  if (ehGlobal && !ehAdmin(await getPerfil(user.id))) {
    return NextResponse.json({ error: "resposta global e so do super admin" }, { status: 403 });
  }
  const db = msgDb();
  // sem duplicar atalho no mesmo escopo
  const dup = ehGlobal
    ? await db.from("respostas_rapidas").select("id").eq("atalho", a).is("dono_id", null).maybeSingle()
    : await db.from("respostas_rapidas").select("id").eq("atalho", a).eq("dono_id", user.id).maybeSingle();
  if (dup.data) return NextResponse.json({ error: `ja existe /${a} nesse escopo` }, { status: 409 });

  const { data, error } = await db
    .from("respostas_rapidas")
    .insert({ atalho: a, texto: t, dono_id: ehGlobal ? null : user.id })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // As variaveis do texto voltam pra tela poder CONFIRMAR o que entendeu. Elas
  // NAO barram a gravacao: texto e do usuario, e recusar por causa de um `!`
  // qualquer transformaria a caixa de texto em campo com sintaxe obrigatoria.
  return NextResponse.json({ ok: true, id: data.id, variaveis: variaveisDoTexto(t).map((u) => u.token) });
}

export async function DELETE(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id obrigatorio" }, { status: 400 });
  const db = msgDb();
  const { data: alvo } = await db.from("respostas_rapidas").select("dono_id").eq("id", id).maybeSingle();
  if (!alvo) return NextResponse.json({ error: "nao encontrada" }, { status: 404 });
  const souAdmin = ehAdmin(await getPerfil(user.id));
  if (alvo.dono_id !== user.id && !souAdmin) {
    return NextResponse.json({ error: "essa resposta nao e sua" }, { status: 403 });
  }
  const { error } = await db.from("respostas_rapidas").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
