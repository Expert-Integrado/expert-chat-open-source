import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { fusoDaConfig, getConfig } from "@/lib/config";
import { getUser } from "@/lib/auth-server";
import { getPerfil, ehAdmin } from "@/lib/perfil";
import { canalPorId, canaisAtivos, somenteLeitura } from "@/lib/canais";
import { destinosDaInstalacao, enviarAlerta } from "@/lib/alertas";
import {
  alertasDevidos,
  esperaLegivel,
  podarEstado,
  textoAlerta,
  type AlertaSla,
  type EstadoAlertas,
} from "@/lib/alertas-sla";
import { acessoRelatorios } from "@/lib/relatorios-acesso";
import { diaLocal, erroSeguro, funcaoAusente, horaLocal } from "@/lib/relatorios";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

// ALERTAS AGENDADOS DE SLA (Frente J, 31/08/2026).
//
// Nao e relatorio que alguem abre: e o aviso que PROCURA a pessoa. Um alerta e
// uma consulta salva (o mesmo filtro da caixa de entrada) + horarios fixos +
// destino. Configuracao em mensageria.config, chave `alertas_sla`
// (formato e validacao em lib/alertas-sla.ts).
//
// POST = TICK, no padrao do vigia: bearer do cron (CHATGURU_SYNC_SECRET) OU
//        super admin de sessao. Roda de N em N minutos; dispara o que venceu.
//        ?dry=1  avalia e devolve o que SAIRIA, sem enviar nada.
//        ?teste=1&nome=<alerta> dispara UM alerta agora, fora do horario, pra
//        validar o canal de destino antes de ligar (igual /api/vigia?teste=1).
// GET  = pre-visualizacao pra quem tem relatorio: os alertas configurados e
//        quantas conversas cada filtro pega AGORA.
//
// Destino: o do proprio alerta, se tiver; senao o destino padrao da instalacao
// (tela Configuracoes -> Vigia, ou env VIGIA_ALERTAS). Token do Telegram vem de
// TELEGRAM_BOT_TOKEN. Sem destino ou sem token = alerta DESLIGADO com aviso na
// resposta — nunca destino chutado, nunca dado de cliente pra canal errado.
//
// Fuso: `fusoDaConfig(cfg)` — config `fuso` > env FUSO_INSTALACAO > fabrica
// (lib/fuso.ts, frente F). "08:00" e no relogio de quem opera; horario fixo em
// UTC dispararia na hora errada pro time inteiro, e ler so a env erraria em
// instalacao que definiu o fuso pela TELA.

const CHAVE_ESTADO = "alertas_sla_estado";
const AVISO_MIGRATION =
  "consulta de SLA indisponivel (a migration 0013_relatorios.sql ja foi aplicada nesta instalacao?)";

function bearerOk(req: NextRequest): boolean {
  const segredo = process.env.CHATGURU_SYNC_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (!segredo || !auth.startsWith("Bearer ")) return false;
  const recebido = Buffer.from(auth.slice(7));
  const esperado = Buffer.from(segredo);
  return recebido.length === esperado.length && timingSafeEqual(recebido, esperado);
}

type Resultado = { canal: string; total: number; conversas: any[]; erro?: string };

// Roda a consulta salva num canal. Agregacao/filtro no banco (0013).
async function consultar(alerta: AlertaSla, canalId: string): Promise<Resultado> {
  const def = canalPorId(canalId);
  if (!def || somenteLeitura(canalId)) {
    return { canal: canalId, total: 0, conversas: [], erro: "canal de fonte externa" };
  }
  const { data, error } = await msgDb().rpc("sla_conversas", {
    p_canal: canalId,
    p_tabela: def.tabelas.conversas,
    p_status: alerta.filtro.status,
    p_departamento: alerta.filtro.departamento,
    p_idade_min: alerta.filtro.idade_min,
    p_limite: alerta.limite,
  });
  // so "funcao nao existe" e falta de migration; o resto e erro real
  if (error) {
    return {
      canal: canalId,
      total: 0,
      conversas: [],
      erro: funcaoAusente(error) ? AVISO_MIGRATION : erroSeguro(error),
    };
  }
  if (data?.erro) return { canal: canalId, total: 0, conversas: [], erro: String(data.erro) };
  return { canal: canalId, total: Number(data?.total ?? 0), conversas: data?.conversas ?? [] };
}

function canaisDoAlerta(alerta: AlertaSla): string[] {
  if (alerta.canal) return canalPorId(alerta.canal) ? [alerta.canal] : [];
  return canaisAtivos()
    .filter((c) => !somenteLeitura(c.id))
    .map((c) => c.id);
}

async function lerEstado(): Promise<EstadoAlertas> {
  const { data } = await msgDb().from("config").select("valor").eq("chave", CHAVE_ESTADO).maybeSingle();
  const v = data?.valor;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as EstadoAlertas) : {};
}

async function gravarEstado(estado: EstadoAlertas, fuso: string) {
  const agora = new Date();
  // guarda so hoje e ontem: a config nao pode virar log infinito
  const vivos = [diaLocal(agora, fuso), diaLocal(new Date(agora.getTime() - 86_400_000), fuso)];
  await msgDb()
    .from("config")
    .upsert(
      { chave: CHAVE_ESTADO, valor: podarEstado(estado, vivos), updated_at: agora.toISOString() },
      { onConflict: "chave" }
    );
}

export async function POST(req: NextRequest) {
  // pg_cron entra pelo bearer; o botao de teste da tela entra como super admin.
  // 401 = nao se identificou; 403 = se identificou e nao pode. Colapsar os dois
  // em 401 faz a UI mandar o usuario logar de novo por um problema de permissao.
  if (!bearerOk(req)) {
    const user = await getUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!ehAdmin(await getPerfil(user.id))) {
      return NextResponse.json({ error: "sem permissao de relatorios" }, { status: 403 });
    }
  }

  const cfg = await getConfig();
  const alertas = cfg.alertas_sla ?? [];
  // config > env > fabrica (lib/fuso.ts, frente F): "08:00" tem que ser no
  // relogio que a instalacao configurou, nao no da env que ninguem revisou
  const fuso = fusoDaConfig(cfg);
  const agora = new Date();
  const q = req.nextUrl.searchParams;
  const dry = ["1", "true"].includes((q.get("dry") || "").toLowerCase());
  const teste = q.get("teste") === "1";

  const padrao = destinosDaInstalacao(cfg);
  const semToken = !process.env.TELEGRAM_BOT_TOKEN;

  // modo teste: um alerta, agora, fora do horario — valida o canal de destino
  if (teste) {
    const nome = q.get("nome") || "";
    const alvo = alertas.find((a) => a.nome === nome) ?? alertas[0];
    if (!alvo) return NextResponse.json({ ok: true, teste: true, aviso: "nenhum alerta configurado" });
    const saidas = await Promise.all(canaisDoAlerta(alvo).map((c) => consultar(alvo, c)));
    const destinos = alvo.destino ? [alvo.destino] : padrao;
    const texto = saidas
      .map((s) => textoAlerta(alvo, s.canal, s.total, s.conversas, agora, esperaLegivel))
      .join("\n\n");
    const enviados = destinos.length ? await enviarAlerta(`[teste] ${texto}`, destinos) : 0;
    return NextResponse.json({
      ok: true,
      teste: true,
      alerta: alvo.nome,
      destinos_total: destinos.length,
      destinos_ok: enviados,
      aviso: !destinos.length
        ? "alerta DESLIGADO: nenhum destino configurado nesta instalacao"
        : semToken && destinos.some((d) => d.tipo === "telegram")
          ? "destino Telegram sem TELEGRAM_BOT_TOKEN nesta instalacao"
          : undefined,
      resultados: saidas,
    });
  }

  if (!alertas.length) return NextResponse.json({ ok: true, disparados: 0, aviso: "nenhum alerta configurado" });

  const estado = await lerEstado();
  const devidos = alertasDevidos(alertas, horaLocal(agora, fuso), diaLocal(agora, fuso), estado);
  if (!devidos.length) {
    return NextResponse.json({ ok: true, disparados: 0, hora: horaLocal(agora, fuso), fuso });
  }

  const relato: any[] = [];
  let disparados = 0;
  for (const d of devidos) {
    const saidas = await Promise.all(canaisDoAlerta(d.alerta).map((c) => consultar(d.alerta, c)));
    const total = saidas.reduce((a, s) => a + s.total, 0);
    const destinos = d.alerta.destino ? [d.alerta.destino] : padrao;
    // canal que falhou responde total 0 — indistinguivel de "esta tudo em dia".
    // Marcar o dedupe aqui faria o alerta do dia SUMIR EM SILENCIO por causa de
    // um timeout: o gestor nao recebe nada e acha que nao havia nada a receber.
    const comErro = saidas.filter((s) => s.erro);

    if (comErro.length) {
      relato.push({
        alerta: d.alerta.nome,
        horario: d.horario,
        total,
        enviado: false,
        motivo: "consulta falhou em pelo menos um canal — estado NAO marcado, re-tenta na proxima batida",
        erros: comErro.map((s) => ({ canal: s.canal, erro: s.erro })),
      });
      continue; // sem marcar estado: a proxima batida dentro da janela tenta de novo
    }

    // nada a avisar: marca o horario como cumprido pra nao ficar re-tentando
    // dentro da janela de tolerancia, e nao acorda ninguem a toa
    if (!total) {
      estado[d.chave] = new Date().toISOString();
      relato.push({ alerta: d.alerta.nome, horario: d.horario, total: 0, enviado: false, motivo: "nada a avisar" });
      continue;
    }
    if (!destinos.length) {
      relato.push({
        alerta: d.alerta.nome,
        horario: d.horario,
        total,
        enviado: false,
        motivo: "alerta DESLIGADO: nenhum destino configurado nesta instalacao",
      });
      continue; // NAO marca o estado: quando configurarem o destino, sai
    }
    const texto = saidas
      .filter((s) => s.total > 0)
      .map((s) => textoAlerta(d.alerta, s.canal, s.total, s.conversas, agora, esperaLegivel))
      .join("\n\n");
    if (dry) {
      relato.push({ alerta: d.alerta.nome, horario: d.horario, total, enviado: false, motivo: "dry run", texto });
      continue;
    }
    const ok = (await enviarAlerta(texto, destinos)) > 0;
    if (ok) {
      estado[d.chave] = new Date().toISOString();
      disparados++;
    }
    relato.push({
      alerta: d.alerta.nome,
      horario: d.horario,
      total,
      enviado: ok,
      motivo: ok ? undefined : "nenhum destino aceitou (re-tenta na proxima batida da janela)",
    });
  }

  if (!dry) await gravarEstado(estado, fuso);

  return NextResponse.json({
    ok: true,
    hora: horaLocal(agora, fuso),
    fuso,
    dry,
    disparados,
    resultados: relato,
  });
}

// Pre-visualizacao: o que cada alerta configurado pega AGORA. Mesmo portao dos
// outros relatorios.
//
// SO CONTAGEM SAI DAQUI (corrigido 31/08/2026, achado da revisao cega da frente M).
// `consultar` devolve `conversas` — chat_id (que E o telefone do cliente) e nome
// de ate 200 conversas por alerta e por canal, montadas pelo `sla_conversas` SEM
// filtro de `conversaVisivel`. Isso e conteudo de conversa vazando pra QUALQUER
// portador da permissao `relatorios` (um Supervisor, por exemplo), por uma rota
// cuja unica finalidade na tela e mostrar "N conversas agora".
//
// A fronteira e por CONTRATO, nao por quem consome: o POST/tick continua com
// `conversas` porque ali a lista vai pro DESTINO que um admin configurou
// (Telegram/webhook do proprio alerta) — outro contrato, outra decisao humana.
// Aqui o payload vai pro NAVEGADOR de quem so tem permissao de leitura de
// relatorio, e relatorio e agregado.
//
// Nao confiar na tela pra isso: "a tela so usa total" e verdade hoje e mentira
// no proximo commit — e o dado ja estaria no devtools de quem abriu a aba.
export async function GET(req: NextRequest) {
  const acesso = await acessoRelatorios(req);
  if (!acesso.ok) return NextResponse.json({ error: acesso.erro }, { status: acesso.status });

  const cfg = await getConfig();
  // config VENCE a env (regra da frente F) — o mapa de troca no cabecalho de
  // lib/relatorios.ts mandava fazer exatamente isto, e `fusoInstalacao()` lia so
  // a env: instalacao que definiu o fuso PELA TELA tinha o horario do alerta
  // avaliado noutro fuso, e o alerta das 08:00 saia na hora errada.
  const fuso = fusoDaConfig(cfg);
  const agora = new Date();
  const padrao = destinosDaInstalacao(cfg);
  const alertas = cfg.alertas_sla ?? [];

  const previa = await Promise.all(
    alertas.map(async (a) => ({
      nome: a.nome,
      ativo: a.ativo,
      horarios: a.horarios,
      filtro: a.filtro,
      canal: a.canal,
      // destino nunca volta com chat_id/url: e credencial de canal, nao dado de tela
      destino: a.destino ? a.destino.tipo : padrao.length ? "padrao da instalacao" : null,
      resultados: (await Promise.all(canaisDoAlerta(a).map((c) => consultar(a, c)))).map(
        // sem `conversas`: so o numero e o motivo da falha
        ({ canal, total, erro }) => ({ canal, total, erro })
      ),
    }))
  );

  return NextResponse.json(
    {
      fuso,
      hora: horaLocal(agora, fuso),
      dia: diaLocal(agora, fuso),
      destino_padrao_configurado: padrao.length > 0,
      alertas: previa,
      aviso: !alertas.length ? "nenhum alerta configurado (mensageria.config, chave alertas_sla)" : undefined,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
