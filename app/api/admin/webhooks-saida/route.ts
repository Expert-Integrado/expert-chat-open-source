import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil, ehAdmin } from "@/lib/perfil";
import { msgDb } from "@/lib/mensageria";
import {
  EVENTOS,
  derrubarCacheWebhooks,
  getAssinantes,
  validarAssinantes,
  type Assinante,
} from "@/lib/webhooks-saida";
import {
  CAMINHOS,
  MODOS_FORMATO,
  TIPOS_CONTEUDO,
  descreverFormato,
  formatoFoiRebaixado,
} from "@/lib/webhook-formato";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Destinos do webhook de SAIDA (docs/webhooks-saida.md) — so super admin.
//
// Rota propria em vez de mais uma chave em /api/admin/config por UM motivo: aqui
// tem SEGREDO. A config e devolvida inteira pro cliente; o segredo do destino
// nunca pode ir junto. Aqui o GET manda `segredo_definido: true` e mais nada.

/** Recorte publico: tudo menos o segredo. */
function semSegredo(a: Assinante) {
  const { segredo, ...resto } = a;
  return {
    ...resto,
    segredo_definido: !!segredo,
    // frase pronta pra tela: formato e a coisa mais facil de configurar errado
    // aqui, e o erro so aparece do outro lado, dias depois, como cenario que
    // parou de rodar sem ninguem ver
    formato_descricao: descreverFormato(a.formato),
  };
}

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!ehAdmin(await getPerfil(user.id))) {
    return NextResponse.json({ error: "somente super admin" }, { status: 403 });
  }
  return NextResponse.json(
    {
      eventos: EVENTOS,
      destinos: (await getAssinantes()).map(semSegredo),
      // vocabulario do formato de compatibilidade, DERIVADO das constantes: a
      // tela montada em cima de lista escrita a mao e a tela que esquece o
      // proximo modo (a licao que a prova de papeis ja cobra)
      formato: { modos: MODOS_FORMATO, tipos_conteudo: TIPOS_CONTEUDO, caminhos: CAMINHOS },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!ehAdmin(await getPerfil(user.id))) {
    return NextResponse.json({ error: "somente super admin" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  if (!Array.isArray(body?.destinos)) {
    return NextResponse.json({ error: "destinos precisa ser uma lista" }, { status: 400 });
  }

  // O GET nunca devolveu o segredo, entao a tela nao tem como reenvia-lo: item
  // que chega SEM o campo `segredo` mantem o que ja estava gravado pra aquela
  // URL. Mandar "" e o jeito EXPLICITO de apagar o segredo.
  const atuais = new Map((await getAssinantes()).map((a) => [a.url, a.segredo]));
  const comSegredo = body.destinos.map((d: any) => {
    if (!d || typeof d !== "object") return d;
    if (typeof d.segredo === "string") return d;
    return { ...d, segredo: atuais.get(String(d?.url ?? "").trim()) ?? "" };
  });

  // URL repetida entrega DUAS vezes: o Map acima colapsa o segredo, mas
  // `destinosDoEvento` devolve as duas linhas e cada uma faz o seu POST. Recusar
  // e melhor que deduplicar em silencio — quem digitou duas vezes provavelmente
  // queria dois destinos diferentes.
  const urls = comSegredo.map((d: any) => String(d?.url ?? "").trim());
  if (new Set(urls).size !== urls.length) {
    return NextResponse.json({ error: "a mesma URL aparece em dois destinos" }, { status: 400 });
  }

  // FORMATO REBAIXADO EM SILENCIO E A ARMADILHA DESTA ROTA (mesma classe do
  // `normalizarAlertas` da frente M): `validarFormato` e tolerante de proposito —
  // config torta cai no envelope de sempre em vez de derrubar a entrega. Mas na
  // GRAVACAO isso viraria "salvei" pra uma compatibilidade que nao existe, e o
  // cliente descobriria dias depois, pelo cenario que parou de ler os campos.
  // Entao aqui a tolerancia e recusa, com o nome do destino.
  const rebaixados = comSegredo
    .filter((d: any) => d && typeof d === "object" && formatoFoiRebaixado(d.formato))
    .map((d: any) => String(d?.nome || d?.url || "sem nome"));
  if (rebaixados.length) {
    return NextResponse.json(
      {
        error: `formato "mapa" sem nenhum campo declarado em: ${rebaixados.join(
          ", "
        )}. O mapa e o que diz ao destino quais chaves mandar — vazio, ele receberia um corpo vazio com HTTP 200 e ninguem notaria.`,
      },
      { status: 400 }
    );
  }

  const destinos = validarAssinantes(comSegredo);
  // recusa em vez de gravar pela metade: destino descartado em silencio viraria
  // "salvei" na tela e nenhuma entrega na pratica
  if (destinos.length !== body.destinos.length) {
    return NextResponse.json(
      { error: "algum destino e invalido (a URL precisa ser https, com dominio de verdade e sem usuario:senha)" },
      { status: 400 }
    );
  }

  const { error } = await msgDb()
    .from("config")
    .upsert({ chave: "webhooks_saida", valor: destinos, updated_at: new Date().toISOString() }, { onConflict: "chave" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  derrubarCacheWebhooks();
  return NextResponse.json({ ok: true, destinos: destinos.map(semSegredo) });
}
