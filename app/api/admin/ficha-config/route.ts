import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil, permitido } from "@/lib/perfil";
import { msgDb } from "@/lib/mensageria";
import { executarFichaConfig } from "@/lib/campos";
import { efeitosDeFichaConfig } from "@/lib/campos-efeitos";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Catalogos PADRAO da ficha (campos personalizados e etiquetas) — so super admin
// cria/desativa; o atendente apenas preenche valor / aplica etiqueta existente.
export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!permitido(await getPerfil(user.id), "gerenciar_etiquetas")) {
    return NextResponse.json({ error: "sem permissao pra gerenciar etiquetas e ficha" }, { status: 403 });
  }
  const db = msgDb();
  const [campos, etiquetas] = await Promise.all([
    db.from("campos_personalizados").select("id,nome,ordem,ativo").order("ordem"),
    db.from("etiquetas_catalogo").select("id,nome,ativo").order("nome"),
  ]);
  return NextResponse.json(
    { campos: campos.data ?? [], etiquetas: etiquetas.data ?? [] },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

// FRENTE X — OS DOIS CAMINHOS DE PERDA SILENCIOSA QUE SAIAM POR AQUI.
//
// Renomear e DESATIVAR campo por esta rota escondiam valor de cliente sem uma
// linha de aviso (ela faz UPDATE direto e nao varre canal nenhum). O porque de
// cada um, e por que REATIVAR continua passando, estao nos verbetes de
// `decidirPatchDeCatalogo`, `decidirNomeDeCampoNovo` e `decidirColisaoNoCatalogo`
// em lib/campos.ts.
//
// E O CORPO DESTE HANDLER TAMBEM MORA LA (`executarFichaConfig`), com os efeitos
// injetados: handler importa `next/server`, entao so alcanca prova de varredura —
// e varredura pega a REMOCAO da linha, nunca o DESLIGAMENTO dela. Medido na 3a
// rodada da re-revisao cega (31/08/2026): um `update({ativo:false})` inserido
// ANTES da decisao, um `if (!vcol.ok && false)` e uma reatribuicao do nome DEPOIS
// do saneamento passavam os tres com a bateria inteira verde. Aqui sobrou o
// ADAPTADOR: pedido -> efeitos do banco -> `NextResponse`.
export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!permitido(await getPerfil(user.id), "gerenciar_etiquetas")) {
    return NextResponse.json({ error: "sem permissao pra gerenciar etiquetas e ficha" }, { status: 403 });
  }
  const { tipo, id, nome, ativo } = await req.json().catch(() => ({}));

  // OS QUATRO EFEITOS SAIRAM DAQUI (4a rodada da re-revisao cega): eles moram em
  // `efeitosDeFichaConfig` (lib/campos-efeitos.ts), que a prova IMPORTA e executa
  // com um banco fake. O que sobrevivia aqui era o adaptador do `lerNomes`: um
  // `data ?? []` com `erro: null` — a forma "tolerante" — engolia o erro do SELECT,
  // `decidirColisaoNoCatalogo` lia "catalogo vazio" e o 503 fail-closed morria em
  // silencio, com a bateria inteira verde.
  //
  // RESSALVA: `msgDb()` e chamado ANTES da validacao de `tipo` (ele ja era, na
  // linha do `const db`). Com env presente e no-op; sem env, um pedido com `tipo`
  // invalido passa a estourar antes do 400. Nao mudou nesta rodada e nao vale
  // trocar a ordem sem medir o GET, que faz o mesmo.
  const r = await executarFichaConfig({ tipo, id, nome, ativo }, efeitosDeFichaConfig(msgDb()));
  return NextResponse.json(r.corpo, { status: r.status });
}
