import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUser } from "@/lib/auth-server";
import { getPerfil, podeVerConversa, idsInativos } from "@/lib/perfil";
import { canalDeBody, tabelas } from "@/lib/canal";
import { prepararEstadoExterno } from "@/lib/estado-externo";
import { msgDb } from "@/lib/mensageria";
import { restricaoEfetiva } from "@/lib/embed";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

// Anotacao interna na conversa (nao vai pro WhatsApp). @Nome marca um usuario
// do painel e dispara notificacao (sininho). Mesmo formato das notas importadas
// do ChatGuru: mensagens com direcao='interna'.
export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });
  const bodyN = await req.json().catch(() => ({}));
  const { chat_id, texto } = bodyN;
  const canal = canalDeBody(bodyN);
  const T = tabelas(canal);
  if (!chat_id || typeof texto !== "string" || !texto.trim()) {
    return NextResponse.json({ error: "chat_id e texto sao obrigatorios" }, { status: 400 });
  }
  if (texto.length > 4000) return NextResponse.json({ error: "anotacao muito longa" }, { status: 400 });

  if (!(await podeVerConversa(String(chat_id), user, perfil, canal))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }
  if (emb && !emb.permite(String(chat_id))) {
    return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
  }

  // fonte externa: a nota mora na tabela de mensagens do painel — o canal do
  // agente ganha a linha de conversa aqui; o instagram-agent (sem estado) segue 403
  const bloqueio = await prepararEstadoExterno(canal, String(chat_id), "anotacao interna");
  if (bloqueio) return bloqueio;

  const db = msgDb();
  const now = new Date().toISOString();
  const { data: nota, error } = await db
    .from(T.mensagens)
    .insert({
      chat_id: String(chat_id),
      direcao: "interna",
      tipo: "nota",
      conteudo: texto.trim(),
      sender_name: user.nome,
      enviado_por_id: user.id,
      enviado_por_nome: user.nome,
      status: "sent",
      criada_em: now,
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // @mencoes: procura "@<nome do usuario>" no texto (nome completo com qualquer
  // numero de palavras; primeiro nome vale quando e unico entre os OUTROS usuarios).
  const mencionados: string[] = [];
  const textoNorm = norm(texto);
  if (textoNorm.includes("@")) {
    const admin = createClient(process.env.MSG_SUPABASE_URL!, process.env.MSG_SUPABASE_SERVICE_KEY!, {
      auth: { persistSession: false },
      global: { fetch: (u: any, i: any) => fetch(u, { ...i, cache: "no-store" }) },
    });
    const [lista, inativos] = await Promise.all([
      admin.auth.admin.listUsers({ page: 1, perPage: 200 }),
      idsInativos(),
    ]);
    const usuarios = (lista.data?.users || [])
      .filter((u) => u.email && !u.email.startsWith("teste-painel-") && !inativos.has(u.id))
      .map((u) => ({
        id: u.id,
        nome:
          (u.user_metadata?.nome as string) ||
          (u.user_metadata?.name as string) ||
          (u.user_metadata?.full_name as string) ||
          u.email!.split("@")[0],
      }));

    const { data: conversa } = await db.from(T.conversas).select("nome").eq("chat_id", String(chat_id)).maybeSingle();
    const outros = usuarios.filter((u) => u.id !== user.id);
    for (const u of outros) {
      const n = norm(u.nome);
      const primeiro = n.split(" ")[0];
      const nomeCompletoNoTexto = textoNorm.includes(`@${n}`);
      // primeiro nome so vale quando nenhum OUTRO usuario compartilha ele
      const primeiroUnico = outros.filter((x) => norm(x.nome).split(" ")[0] === primeiro).length === 1;
      const primeiroNoTexto =
        primeiroUnico && new RegExp(`@${primeiro.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$|[^\\p{L}0-9])`, "u").test(textoNorm + " ");
      if (!nomeCompletoNoTexto && !primeiroNoTexto) continue;
      mencionados.push(u.nome);
      await db.from("notificacoes").insert({
        user_id: u.id,
        chat_id: String(chat_id),
        titulo: `${user.nome} marcou voce em ${conversa?.nome || String(chat_id)}`,
        texto: texto.trim().slice(0, 200),
        autor_nome: user.nome,
      });
    }
  }

  return NextResponse.json({ ok: true, id: nota.id, mencionados });
}
