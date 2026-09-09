import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getConfig } from "@/lib/config";
import { getPerfil } from "@/lib/perfil";
import { msgDb } from "@/lib/mensageria";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Seletor de visao (BU, 16/08/2026): lista os contextos do widget embutido pra
// quem esta logado na tela cheia poder restringir a PROPRIA visao a um deles
// (embed_contextos reusado — mesma fonte do widget). Some quando o admin nao
// ligou o toggle `seletor_visao`.
//
// Permissao por BU (16/08/2026): usuario com vinculo em perfil_contextos (e
// que nao e super admin) SEMPRE ve a propria lista aqui — independe do toggle
// seletor_visao, porque o vinculo e restricao DURA do admin (imposta no
// servidor em toda rota via restricaoEfetiva), nao a auto-restricao opcional
// que o toggle liga/desliga. `vinculado:true` avisa o front pra trocar o
// rotulo "Todas" por "Minhas" e travar o select quando so ha 1 BU.
export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const perfil = await getPerfil(user.id);
  if (perfil.papel !== "super_admin") {
    const { data: vinculos } = await msgDb()
      .from("perfil_contextos")
      .select("contexto_id")
      .eq("user_id", user.id);
    if (vinculos?.length) {
      const ids = Array.from(new Set(vinculos.map((v) => v.contexto_id)));
      const { data } = await msgDb()
        .from("embed_contextos")
        .select("id,nome")
        .eq("ativo", true)
        .in("id", ids)
        .order("nome");
      return NextResponse.json(
        { habilitado: true, contextos: data ?? [], vinculado: true },
        { headers: { "Cache-Control": "no-store, max-age=0" } }
      );
    }
  }

  const cfg = await getConfig();
  if (!cfg.seletor_visao) {
    return NextResponse.json(
      { habilitado: false, contextos: [], vinculado: false },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }

  const { data } = await msgDb()
    .from("embed_contextos")
    .select("id,nome")
    .eq("ativo", true)
    .order("nome");

  return NextResponse.json(
    { habilitado: true, contextos: data ?? [], vinculado: false },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
