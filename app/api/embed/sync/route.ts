import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { derrubarCacheEmbed } from "@/lib/embed";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
// fonte pipedrive varre ~90 paginas de API (19k pessoas + 3.7k deals) — 60s nao da
export const maxDuration = 300;

// Sync da allowlist de um contexto embed (widget F2+): busca a fonte externa
// do contexto (ex: listar-telefones-alunos do portal, ou direto na API do
// Conexa) e SUBSTITUI a allowlist correspondente em mensageria.embed_allowlist.
// Mesmo Bearer de /api/sync-chatguru (CHATGURU_SYNC_SECRET), comparado em
// tempo constante como em /api/embed/token. Chamado pelo pg_cron (30min) ou
// manual. fonte.tipo "http" (default, retrocompativel) chama endpoint proprio
// com x-cs-secret; fonte.tipo "conexa" consulta a API do Conexa direto
// (clientes ativos de fonte.company_id). fonte.extras e uma lista estatica
// que entra sempre na uniao, qualquer que seja o tipo.

type FonteSync = {
  tipo?: "http" | "conexa" | "pipedrive";
  url?: string;
  secret_env?: string;
  company_id?: number;
  // tipo "pipedrive": regra decide o recorte (definicao do Eric, 16/08) —
  // "comercial" = pessoa com deal ABERTO (lead ou cliente com deal novo) +
  // pessoa com atividade pendente atribuida aos users de atividades_user_ids;
  // "financeiro" = pessoa com deal GANHO (ja comprou) ou deal aberto em etapa
  // de Formalizacao (qualquer funil).
  regra?: "comercial" | "financeiro";
  atividades_user_ids?: number[];
  extras?: string[];
  // uniao de fontes: quando presente, cada item e coletado e somado
  fontes?: FonteSync[];
};
type FiltroSync = { tipo?: string; fonte?: FonteSync };

const LOTE_UPSERT = 1000; // mesma pagina do range de leitura em lib/embed.ts

function digitsOnly(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

// --- fonte tipo "conexa": API v2 do Conexa (conexa.app), replicando o que o
// pacote npm conexa-mcp faz (client.js): base URL
// https://<subdominio>.conexa.app/index.php/api/v2, header
// "Authorization: Bearer <token>". Listagem /customers pagina com
// limit/offset (limit max 100) e devolve { data: [...], hasNext }; paramos
// em hasNext=false ou pagina vazia (o pacote nao documenta o "hasNext" no
// codigo — so o parametro limit/offset generico — entao tratamos pagina
// vazia como parada valida mesmo se hasNext vier ausente).
type ClienteConexa = { isActive?: boolean; phones?: unknown[]; cellNumber?: unknown };

const CONEXA_LOTE = 100; // limite maximo aceito pela API por pagina
const CONEXA_TIMEOUT_MS = 15_000;
const CONEXA_MAX_PAGINAS = 200; // trava de seguranca contra hasNext preso em true

async function buscarTelefonesConexa(
  companyId: number,
  subdomain: string,
  token: string
): Promise<string[]> {
  const baseUrl = `https://${subdomain}.conexa.app/index.php/api/v2`;
  const unicos = new Set<string>();
  let offset = 0;
  for (let pagina = 0; pagina < CONEXA_MAX_PAGINAS; pagina++) {
    // a API exige companyId como ARRAY (companyId[]=N) — testado ao vivo 16/08
    const url = `${baseUrl}/customers?companyId%5B%5D=${encodeURIComponent(companyId)}&limit=${CONEXA_LOTE}&offset=${offset}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONEXA_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (e) {
      const abortou = (e as Error)?.name === "AbortError";
      throw new Error(abortou ? "timeout na API do Conexa" : "falha de rede na API do Conexa");
    } finally {
      clearTimeout(timeoutId);
    }
    if (!resp.ok) {
      throw new Error(`Conexa respondeu ${resp.status}`);
    }
    const corpo = await resp.json().catch(() => null);
    if (!corpo || !Array.isArray(corpo.data)) {
      throw new Error("resposta da Conexa fora do formato esperado");
    }
    const paginaClientes: ClienteConexa[] = corpo.data;
    if (paginaClientes.length === 0) break;
    for (const cliente of paginaClientes) {
      if (cliente?.isActive !== true) continue;
      const brutos: unknown[] = [
        ...(Array.isArray(cliente.phones) ? cliente.phones : []),
        cliente.cellNumber,
      ];
      for (const t of brutos) {
        let d = digitsOnly(t);
        // Conexa grava telefone BR sem o codigo do pais (DDD+numero, 10-11
        // digitos); o chat_id do painel e 55+DDD+numero — prefixa pra casar
        if (d.length === 10 || d.length === 11) d = `55${d}`;
        if (d && d.length >= 12) unicos.add(d);
      }
    }
    // resposta real da API envelopa a paginacao: { data: [...], pagination: { hasNext } }
    if (corpo.hasNext === false || corpo?.pagination?.hasNext === false) break;
    offset += CONEXA_LOTE;
  }
  return [...unicos];
}

// --- fonte tipo "pipedrive": API v1 (api.pipedrive.com), token em
// PIPEDRIVE_API_KEY. Endpoints /collection usam cursor (limit max 500);
// /activities usa start/limit. Volumes medidos 16/08: 19k pessoas (39 pag),
// 3.7k deals abertos (8 pag), 327 ganhos — varredura completa ~40s.
const PD_LOTE = 500;
const PD_TIMEOUT_MS = 20_000;
const PD_MAX_PAGINAS = 200; // trava contra cursor preso

async function pdGet(path: string, token: string): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `https://api.pipedrive.com/v1${path}${sep}api_token=${encodeURIComponent(token)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PD_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, { signal: controller.signal, cache: "no-store" });
  } catch (e) {
    const abortou = (e as Error)?.name === "AbortError";
    throw new Error(abortou ? "timeout na API do Pipedrive" : "falha de rede na API do Pipedrive");
  } finally {
    clearTimeout(timeoutId);
  }
  if (!resp.ok) throw new Error(`Pipedrive respondeu ${resp.status}`);
  const corpo = await resp.json().catch(() => null);
  if (!corpo?.success) throw new Error("resposta do Pipedrive fora do formato esperado");
  return corpo;
}

// pagina um endpoint /collection (cursor) inteiro, chamando cb por item
async function pdCollection(path: string, token: string, cb: (item: any) => void) {
  let cursor = "";
  for (let pagina = 0; pagina < PD_MAX_PAGINAS; pagina++) {
    const corpo = await pdGet(`${path}${path.includes("?") ? "&" : "?"}limit=${PD_LOTE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, token);
    const itens: any[] = Array.isArray(corpo.data) ? corpo.data : [];
    for (const it of itens) cb(it);
    cursor = corpo?.additional_data?.next_cursor || "";
    if (!cursor || itens.length === 0) break;
  }
}

async function buscarTelefonesPipedrive(
  regra: "comercial" | "financeiro",
  atividadesUserIds: number[],
  token: string
): Promise<string[]> {
  const pessoasAlvo = new Set<number>();

  if (regra === "comercial") {
    await pdCollection("/deals/collection?status=open", token, (d) => {
      if (typeof d?.person_id === "number") pessoasAlvo.add(d.person_id);
    });
    // atividade pendente atribuida ao(s) user(s) tambem libera a pessoa
    for (const userId of atividadesUserIds) {
      for (let start = 0, pagina = 0; pagina < PD_MAX_PAGINAS; pagina++) {
        const corpo = await pdGet(`/activities?user_id=${userId}&done=0&start=${start}&limit=${PD_LOTE}`, token);
        const itens: any[] = Array.isArray(corpo.data) ? corpo.data : [];
        for (const a of itens) {
          if (typeof a?.person_id === "number") pessoasAlvo.add(a.person_id);
        }
        const pag = corpo?.additional_data?.pagination;
        if (!pag?.more_items_in_collection) break;
        start = typeof pag.next_start === "number" ? pag.next_start : start + PD_LOTE;
      }
    }
  } else {
    // financeiro: ja comprou (won) OU esta em formalizacao (etapa cujo nome
    // contem "formaliza"/"fornaliza" — ha um funil com o typo — em qualquer funil)
    const stages = await pdGet("/stages", token);
    const etapasFormalizacao = new Set<number>(
      (Array.isArray(stages.data) ? stages.data : [])
        .filter((s: any) => /formaliza|fornaliza/i.test(String(s?.name || "")))
        .map((s: any) => Number(s.id))
    );
    await pdCollection("/deals/collection?status=won", token, (d) => {
      if (typeof d?.person_id === "number") pessoasAlvo.add(d.person_id);
    });
    await pdCollection("/deals/collection?status=open", token, (d) => {
      if (typeof d?.person_id === "number" && etapasFormalizacao.has(Number(d?.stage_id))) {
        pessoasAlvo.add(d.person_id);
      }
    });
  }

  // varre TODAS as pessoas uma vez (39 pag) e pega telefone so das alvo —
  // mais barato que 3.7k GETs individuais
  const unicos = new Set<string>();
  await pdCollection("/persons/collection", token, (p) => {
    if (typeof p?.id !== "number" || !pessoasAlvo.has(p.id)) return;
    for (const ph of Array.isArray(p?.phone) ? p.phone : []) {
      let d = digitsOnly(ph?.value);
      // mesmo criterio da fonte conexa: numero local BR ganha o 55
      if (d.length === 10 || d.length === 11) d = `55${d}`;
      if (d && d.length >= 12) unicos.add(d);
    }
  });
  return [...unicos];
}

export async function POST(req: NextRequest) {
  const segredo = process.env.CHATGURU_SYNC_SECRET;
  if (!segredo) {
    return NextResponse.json({ error: "CHATGURU_SYNC_SECRET nao configurado" }, { status: 501 });
  }
  const auth = req.headers.get("authorization") || "";
  const recebido = Buffer.from(auth.startsWith("Bearer ") ? auth.slice(7) : "");
  const esperado = Buffer.from(segredo);
  const bearerOk = recebido.length === esperado.length && timingSafeEqual(recebido, esperado);
  if (!bearerOk) {
    return NextResponse.json({ error: "bearer invalido" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const contexto = typeof body?.contexto === "string" ? body.contexto.trim() : "";
  if (!contexto) {
    return NextResponse.json({ error: "contexto obrigatorio" }, { status: 400 });
  }

  const db = msgDb();
  // carrega mesmo se ativo=false: sync nao depende do contexto estar ligado
  const { data: linha } = await db
    .from("embed_contextos")
    .select("id,filtro")
    .eq("id", contexto)
    .maybeSingle();
  if (!linha) {
    return NextResponse.json({ error: "contexto inexistente" }, { status: 404 });
  }

  const filtro = (linha.filtro || {}) as FiltroSync;
  const fonte = filtro.fonte;
  // uma fonte simples OU uniao de varias (fonte.fontes: [...]) — cada uma
  // coleta no mesmo conjunto; erro em QUALQUER fonte aborta o sync inteiro
  // (melhor manter a allowlist antiga do que substituir por uniao pela metade)
  const fontesLista: FonteSync[] =
    Array.isArray(fonte?.fontes) && fonte.fontes.length ? fonte.fontes : fonte ? [fonte] : [];
  if (!fontesLista.length) {
    return NextResponse.json({ error: "contexto sem fonte de sync" }, { status: 400 });
  }

  const unicos = new Set<string>();

  for (const f of fontesLista) {
    const tipoFonte: "http" | "conexa" | "pipedrive" =
      f?.tipo === "conexa" ? "conexa" : f?.tipo === "pipedrive" ? "pipedrive" : "http";

    if (tipoFonte === "pipedrive") {
      const regra = f?.regra;
      if (regra !== "comercial" && regra !== "financeiro") {
        return NextResponse.json({ error: "fonte.regra obrigatoria para tipo pipedrive (comercial|financeiro)" }, { status: 400 });
      }
      // PIPEDRIVE_API_TOKEN e o nome que o resto do codigo e o instalador usam;
      // este handler lia PIPEDRIVE_API_KEY (que nao existe em instalacao nenhuma)
      // e respondia 501 sempre — achado da varredura open source de 02/09/2026.
      const tokenPd = process.env.PIPEDRIVE_API_TOKEN ?? process.env.PIPEDRIVE_API_KEY;
      if (!tokenPd) {
        return NextResponse.json({ error: "env PIPEDRIVE_API_TOKEN nao configurada" }, { status: 501 });
      }
      const userIds = (Array.isArray(f?.atividades_user_ids) ? f.atividades_user_ids : []).filter(
        (n): n is number => typeof n === "number"
      );
      let telefonesPd: string[];
      try {
        telefonesPd = await buscarTelefonesPipedrive(regra, userIds, tokenPd);
      } catch (e) {
        return NextResponse.json(
          { error: `falha ao chamar fonte pipedrive: ${(e as Error)?.message || "erro"}` },
          { status: 502 }
        );
      }
      for (const t of telefonesPd) unicos.add(t);
    } else if (tipoFonte === "conexa") {
      const companyId = f?.company_id;
      if (typeof companyId !== "number") {
        return NextResponse.json({ error: "fonte.company_id obrigatorio para tipo conexa" }, { status: 400 });
      }
      const subdomain = process.env.CONEXA_SUBDOMAIN;
      if (!subdomain) {
        return NextResponse.json({ error: "env CONEXA_SUBDOMAIN nao configurada" }, { status: 501 });
      }
      const token = process.env.CONEXA_TOKEN;
      if (!token) {
        return NextResponse.json({ error: "env CONEXA_TOKEN nao configurada" }, { status: 501 });
      }
      let telefonesConexa: string[];
      try {
        telefonesConexa = await buscarTelefonesConexa(companyId, subdomain, token);
      } catch (e) {
        return NextResponse.json(
          { error: `falha ao chamar fonte conexa: ${(e as Error)?.message || "erro"}` },
          { status: 502 }
        );
      }
      for (const t of telefonesConexa) unicos.add(t);
    } else {
      if (!f?.url || !f?.secret_env) {
        return NextResponse.json({ error: "fonte http sem url/secret_env" }, { status: 400 });
      }

      const secretFonte = process.env[f.secret_env];
      if (!secretFonte) {
        return NextResponse.json({ error: `env ${f.secret_env} nao configurada` }, { status: 501 });
      }

      let resp: Response;
      try {
        resp = await fetch(f.url, {
          method: "POST",
          headers: { "x-cs-secret": secretFonte },
          cache: "no-store",
        });
      } catch (e) {
        return NextResponse.json(
          { error: `falha ao chamar fonte: ${(e as Error)?.message || "erro"}` },
          { status: 502 }
        );
      }
      if (!resp.ok) {
        return NextResponse.json({ error: `fonte respondeu ${resp.status}` }, { status: 502 });
      }
      const corpo = await resp.json().catch(() => null);
      if (!corpo || !Array.isArray(corpo.telefones)) {
        return NextResponse.json({ error: "resposta da fonte fora do formato esperado" }, { status: 502 });
      }

      for (const t of corpo.telefones) {
        const d = digitsOnly(t);
        if (d) unicos.add(d);
      }
    }

    // extras declarados dentro de uma fonte da uniao tambem contam
    if (Array.isArray(f?.extras)) {
      for (const t of f.extras) {
        const d = digitsOnly(t);
        if (d) unicos.add(d);
      }
    }
  }

  // fonte.extras: lista estatica de telefones digits, entra sempre na uniao
  // (qualquer tipo de fonte) — serve pra enxertar cadastros de outro sistema
  // enquanto nao ha fonte automatica.
  if (Array.isArray(fonte?.extras)) {
    for (const t of fonte.extras) {
      const d = digitsOnly(t);
      if (d) unicos.add(d);
    }
  }

  const telefones = [...unicos];

  // protecao contra apagao acidental: fonte vazia NAO mexe na allowlist existente
  if (telefones.length === 0) {
    return NextResponse.json({ ok: false, erro: "fonte devolveu lista vazia" });
  }

  // marca-e-varre: upsert SEM ignoreDuplicates refresca atualizado_em de TODO
  // numero da rodada; depois um delete unico tira quem ficou com timestamp
  // velho. (O "not in" encadeado antigo estourava a URL do PostgREST com
  // allowlist grande — 3k+ numeros do comercial = Bad Request.)
  const { count: antes } = await db
    .from("embed_allowlist")
    .select("*", { count: "exact", head: true })
    .eq("contexto_id", contexto);

  const agora = new Date().toISOString();
  for (let i = 0; i < telefones.length; i += LOTE_UPSERT) {
    const lote = telefones.slice(i, i + LOTE_UPSERT).map((telefone_digits) => ({
      contexto_id: contexto,
      telefone_digits,
      atualizado_em: agora,
    }));
    const { error } = await db
      .from("embed_allowlist")
      .upsert(lote, { onConflict: "contexto_id,telefone_digits" });
    if (error) {
      return NextResponse.json({ error: `falha ao inserir allowlist: ${error.message}` }, { status: 500 });
    }
  }

  const { data: removidosData, error: erroDelete } = await db
    .from("embed_allowlist")
    .delete()
    .eq("contexto_id", contexto)
    .lt("atualizado_em", agora)
    .select("telefone_digits");
  if (erroDelete) {
    return NextResponse.json({ error: `falha ao remover allowlist: ${erroDelete.message}` }, { status: 500 });
  }
  const removidos = removidosData?.length ?? 0;
  const inseridos = telefones.length - ((antes ?? 0) - removidos);

  derrubarCacheEmbed(contexto);

  return NextResponse.json({ ok: true, contexto, total: telefones.length, inseridos, removidos });
}
