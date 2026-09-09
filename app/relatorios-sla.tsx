"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, RefreshCw, Send, Trash2, X } from "lucide-react";
import type { CanalPublico } from "@/lib/canais";
import {
  IDADES_ALERTA,
  RASCUNHO_VAZIO,
  SEM_DONO_ALERTA,
  alertaParaRascunho,
  configMudouPorFora,
  garantirOpcao,
  nomesPerdidos,
  problemasDoRascunho,
  rascunhoParaAlerta,
  resumoDoFiltro,
  retratoDeAlertas,
  rotuloIdade,
  statusParaTela,
  type Opcao,
  type RascunhoAlerta,
} from "@/lib/relatorios-tela";

// GESTAO DOS ALERTAS DE SLA — card 86ak85bkh.
//
// O QUE E UM ALERTA: uma CONSULTA SALVA (o mesmo filtro da caixa de entrada) +
// horarios fixos + destino. Nao e relatorio que alguem abre; e o aviso que
// PROCURA a pessoa. A frente J entregou o motor (config `alertas_sla`,
// normalizarAlertas, tick em POST /api/relatorios/sla) sem tela — esta e a tela.
//
// ONDE GRAVA: `mensageria.config` chave `alertas_sla`, pela rota que ja existe
// (/api/admin/config, permissao `automacao`). Nao foi criada rota nova de
// proposito: a chave ja esta no CHAVES_CONFIG e ja passa por
// `validarConfig` -> `normalizarAlertas`. Rota nova seria um segundo caminho de
// escrita pro mesmo dado.
//
// A ARMADILHA QUE ESTA TELA TEM QUE EVITAR: `normalizarAlertas` e fail-closed e
// DESCARTA item torto EM SILENCIO (o que esta certo — alerta que dispara por
// config torta e pior que alerta nenhum). Sem cuidado, a tela mandaria um item
// invalido, receberia 200 e diria "salvei" pra um alerta que nao existe. Duas
// barreiras contra isso: `problemasDoRascunho` bloqueia o salvar ANTES de mandar,
// e `nomesPerdidos` compara o que foi enviado com o que voltou gravado.
//
// A TELA NAO EDITA O QUE NAO ENTENDE, MAS NAO DESTROI: destino webhook com
// `headers`/`body` configurado direto no banco tem esses campos PRESERVADOS
// (RascunhoAlerta.destinoExtra) — reenviar o alerta sem eles apagaria a
// autenticacao do destino de alguem em silencio.

type Previa = {
  fuso: string;
  hora: string;
  destino_padrao_configurado: boolean;
  alertas: {
    nome: string;
    ativo: boolean;
    resultados: { canal: string; total: number; erro?: string }[];
  }[];
  aviso?: string;
};

export default function RelatoriosSla({
  authedFetch,
  canais,
  departamentos,
  ehSuperAdmin,
}: {
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>;
  canais: CanalPublico[];
  departamentos: { id: string; nome: string }[];
  /** o tick e o teste da rota /api/relatorios/sla exigem super admin (padrao do vigia) */
  ehSuperAdmin: boolean;
}) {
  const [alertas, setAlertas] = useState<RascunhoAlerta[] | null>(null);
  // RETRATO da config de que esta tela partiu. `alertas_sla` e UMA chave com a
  // lista inteira: gravar sobrescreve tudo, entao sem isto o admin A que desliga
  // um alerta APAGA em silencio o alerta que o admin B criou no meio.
  const [retrato, setRetrato] = useState<string>(retratoDeAlertas([]));
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [editando, setEditando] = useState<{ indice: number | null; rascunho: RascunhoAlerta } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [testando, setTestando] = useState<string | null>(null);

  const nomeDep = useCallback(
    (id: string) => departamentos.find((d) => d.id === id)?.nome ?? null,
    [departamentos]
  );

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const [rCfg, rPrev] = await Promise.all([
        authedFetch("/api/admin/config"),
        authedFetch("/api/relatorios/sla"),
      ]);
      const jCfg = await rCfg.json().catch(() => ({}));
      if (!rCfg.ok) throw new Error(jCfg.error || "falha ao ler a configuracao");
      const brutos = Array.isArray(jCfg.alertas_sla) ? jCfg.alertas_sla : [];
      setRetrato(retratoDeAlertas(brutos));
      setAlertas(brutos.map(alertaParaRascunho));
      const jPrev = await rPrev.json().catch(() => ({}));
      if (rPrev.ok) setPrevia(jPrev);
    } catch (e: any) {
      setAlertas([]);
      setErro(e?.message || "falha ao carregar os alertas");
    }
  }, [authedFetch]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function gravar(lista: RascunhoAlerta[]) {
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      const valor = lista.map(rascunhoParaAlerta);

      // TRAVA DE ESCRITA CONCORRENTE: re-le a config e compara com o retrato de
      // que esta tela partiu. A rota nao tem versao/etag e a chave carrega a
      // lista inteira — sem esta conferencia a gravacao e um lost update sem
      // erro nenhum na tela. Divergiu = RECUSA, nunca sobrescreve: o trabalho do
      // outro admin vale tanto quanto o desta aba.
      const rAtual = await authedFetch("/api/admin/config");
      const jAtual = await rAtual.json().catch(() => ({}));
      if (!rAtual.ok) throw new Error(jAtual.error || "falha ao reler a configuracao antes de salvar");
      if (configMudouPorFora(retrato, jAtual.alertas_sla)) {
        setErro(
          "A configuracao dos alertas mudou em outro lugar (outra aba ou outro admin) depois que esta tela carregou. " +
            "Nada foi salvo pra nao apagar o trabalho do outro. Clique em atualizar e refaca a mudanca."
        );
        return;
      }

      const r = await authedFetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chave: "alertas_sla", valor }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "falha ao salvar");
      const gravados = Array.isArray(j.alertas_sla) ? j.alertas_sla : [];
      // a normalizacao do servidor descarta item torto em silencio: se algum
      // nome nao voltou, a tela DIZ — nunca "salvei" pra alerta que nao existe
      const perdidos = nomesPerdidos(valor, gravados);
      if (perdidos.length) {
        setAviso(
          `Estes alertas foram recusados pelo servidor e NAO existem: ${perdidos.join(", ")}. Revise nome, horario e destino.`
        );
      }
      setRetrato(retratoDeAlertas(gravados));
      setAlertas(gravados.map(alertaParaRascunho));
      setEditando(null);
      // a previa mostra quantas conversas cada filtro pega AGORA
      const rPrev = await authedFetch("/api/relatorios/sla");
      if (rPrev.ok) setPrevia(await rPrev.json().catch(() => null));
    } catch (e: any) {
      setErro(e?.message || "falha ao salvar");
    } finally {
      setSalvando(false);
    }
  }

  async function testar(nome: string) {
    setTestando(nome);
    setErro(null);
    setAviso(null);
    try {
      const r = await authedFetch(`/api/relatorios/sla?teste=1&nome=${encodeURIComponent(nome)}`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "falha no teste");
      setAviso(
        j.aviso
          ? `Teste de "${nome}": ${j.aviso}`
          : `Teste de "${nome}" enviado pra ${j.destinos_ok ?? 0} de ${j.destinos_total ?? 0} destino(s).`
      );
    } catch (e: any) {
      setErro(e?.message || "falha no teste");
    } finally {
      setTestando(null);
    }
  }

  const outrosNomes = (indice: number | null) =>
    (alertas ?? []).filter((_, i) => i !== indice).map((a) => a.nome);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="space-y-2 rounded-lg border bg-white p-3 text-[11px] text-muted-foreground">
        <p>
          Um alerta e uma <b>consulta salva</b> (o mesmo filtro da caixa de entrada) com horarios fixos. No horario, o
          painel conta as conversas que batem no filtro e manda o aviso pro destino.
        </p>
        <p>
          Horario no fuso da instalacao{previa?.fuso ? ` (${previa.fuso}, agora ${previa.hora})` : ""}. Alerta nasce{" "}
          <b>desligado</b> — so dispara depois de alguem ligar de proposito.
        </p>
        {previa && !previa.destino_padrao_configurado && (
          <p className="text-amber-800">
            Nenhum destino padrao configurado nesta instalacao (Configuracoes {"->"} Automacao {"->"} Vigia do canal).
            Alerta sem destino proprio fica DESLIGADO com aviso, em vez de disparar pra lugar nenhum.
          </p>
        )}
        <p className="text-amber-800">
          PENDENCIA DECLARADA: o disparo automatico depende de uma rotina do banco chamando{" "}
          <code>POST /api/relatorios/sla</code> de N em N minutos, como o vigia. Enquanto essa rotina nao existir nesta
          instalacao, o alerta so sai pelo botao de teste. Isto e escopo que falta, nao defeito da tela.
        </p>
      </div>

      {erro && <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-[11px] text-red-800">{erro}</div>}
      {aviso && (
        <div className="flex items-start justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-[11px] text-amber-800">
          <span>{aviso}</span>
          <button onClick={() => setAviso(null)} className="rounded p-0.5 hover:bg-amber-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase text-muted-foreground">
          Alertas configurados ({alertas?.length ?? 0})
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setEditando({ indice: null, rascunho: { ...RASCUNHO_VAZIO } })}
            className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium hover:bg-muted"
          >
            <Plus className="h-3.5 w-3.5" />
            Novo alerta
          </button>
          <button onClick={carregar} title="Atualizar" className="rounded p-1.5 text-muted-foreground hover:bg-muted">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {alertas === null ? (
        <p className="text-xs text-muted-foreground">Carregando...</p>
      ) : !alertas.length ? (
        <p className="rounded-lg border bg-white px-3 py-6 text-center text-[11px] text-muted-foreground">
          Nenhum alerta ainda. Um bom primeiro: conversas <b>aguardando</b> e <b>sem responsavel</b> paradas ha mais de
          1 dia, avisando as 08:00.
        </p>
      ) : (
        <div className="divide-y rounded-lg border bg-white">
          {alertas.map((a, i) => {
            const p = previa?.alertas.find((x) => x.nome === a.nome);
            const total = (p?.resultados ?? []).reduce((s, r) => s + (r.total || 0), 0);
            const comErro = (p?.resultados ?? []).filter((r) => r.erro);
            return (
              <div key={`${a.nome}-${i}`} className="space-y-1 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      a.ativo ? "bg-green-100 text-green-700" : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {a.ativo ? "ligado" : "desligado"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{a.nome}</span>
                  {p && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {total} conversa(s) agora
                    </span>
                  )}
                  <button
                    onClick={() => gravar(alertas.map((x, j) => (j === i ? { ...x, ativo: !x.ativo } : x)))}
                    disabled={salvando}
                    className="rounded-lg border px-2 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-50"
                  >
                    {a.ativo ? "Desligar" : "Ligar"}
                  </button>
                  {ehSuperAdmin && (
                    <button
                      onClick={() => testar(a.nome)}
                      disabled={!!testando}
                      title="Dispara este alerta agora, fora do horario, pra validar o destino"
                      className="flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-50"
                    >
                      <Send className="h-3 w-3" />
                      {testando === a.nome ? "enviando..." : "Testar"}
                    </button>
                  )}
                  <button
                    onClick={() => setEditando({ indice: i, rascunho: { ...a } })}
                    title="Editar"
                    className="rounded p-1 text-muted-foreground hover:bg-muted"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      if (!confirm(`Apagar o alerta "${a.nome}"?`)) return;
                      gravar(alertas.filter((_, j) => j !== i));
                    }}
                    title="Apagar"
                    className="rounded p-1 text-muted-foreground hover:bg-red-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {resumoDoFiltro(a, nomeDep)} · {a.horarios.join(", ")} ·{" "}
                  {a.canal ? `canal ${a.canal}` : "todos os canais"} ·{" "}
                  {a.destinoTipo ? `destino ${a.destinoTipo}` : "destino padrao da instalacao"}
                </p>
                {!!comErro.length && (
                  <p className="text-[11px] text-amber-800">
                    {comErro.map((r) => `${r.canal}: ${r.erro}`).join(" · ")}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {previa?.aviso && !alertas?.length && (
        <p className="text-[11px] text-muted-foreground">{previa.aviso}</p>
      )}

      {editando && (
        <Formulario
          rascunho={editando.rascunho}
          outrosNomes={outrosNomes(editando.indice)}
          canais={canais}
          departamentos={departamentos}
          salvando={salvando}
          aoCancelar={() => setEditando(null)}
          aoSalvar={(r) => {
            const lista = alertas ?? [];
            gravar(editando.indice === null ? [...lista, r] : lista.map((x, j) => (j === editando.indice ? r : x)));
          }}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
function Formulario({
  rascunho,
  outrosNomes,
  canais,
  departamentos,
  salvando,
  aoCancelar,
  aoSalvar,
}: {
  rascunho: RascunhoAlerta;
  outrosNomes: string[];
  canais: CanalPublico[];
  departamentos: { id: string; nome: string }[];
  salvando: boolean;
  aoCancelar: () => void;
  aoSalvar: (r: RascunhoAlerta) => void;
}) {
  const [r, setR] = useState<RascunhoAlerta>(rascunho);
  const problemas = problemasDoRascunho(r, outrosNomes);
  const mudar = (patch: Partial<RascunhoAlerta>) => setR((x) => ({ ...x, ...patch }));

  // VALOR GRAVADO FORA DAS OPCOES: `garantirOpcao` injeta a opcao sintetica.
  // Um <select> com value que nao casa com option nenhuma renderiza em branco E
  // o primeiro save "conserta" pro valor da primeira opcao, sem ninguem pedir.
  const opcoesDep: Opcao[] = garantirOpcao(
    [
      { valor: SEM_DONO_ALERTA, rotulo: "Sem responsavel (o caso que mais doi)" },
      ...departamentos.map((d) => ({ valor: d.id, rotulo: d.nome })),
    ],
    r.departamento
  );
  const opcoesIdade: Opcao[] = garantirOpcao(
    IDADES_ALERTA.map((i) => ({ valor: String(i.min), rotulo: i.rotulo })),
    r.idade_min > 0 ? String(r.idade_min) : "",
    (v) => rotuloIdade(Number(v))
  );
  const opcoesCanal: Opcao[] = garantirOpcao(
    canais.map((c) => ({ valor: c.id, rotulo: c.rotulo })),
    r.canal
  );

  const alternarStatus = (s: string) =>
    mudar({ status: r.status.includes(s) ? r.status.filter((x) => x !== s) : [...r.status, s] });

  return (
    <section className="space-y-3 rounded-lg border border-primary/40 bg-white p-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold">{rascunho.nome ? "Editar alerta" : "Novo alerta"}</h4>
        <button onClick={aoCancelar} className="rounded p-1 text-muted-foreground hover:bg-muted">
          <X className="h-4 w-4" />
        </button>
      </div>

      <label className="block space-y-1">
        <span className="text-[11px] text-muted-foreground">
          Nome (e a chave que evita repetir o mesmo aviso no dia)
        </span>
        <input
          value={r.nome}
          onChange={(e) => mudar({ nome: e.target.value })}
          placeholder="Ex: Implementacao sem contato por 3 dias"
          className="w-full rounded-lg border bg-white px-2 py-1.5 text-xs outline-none"
        />
      </label>

      <div className="space-y-1">
        <span className="text-[11px] text-muted-foreground">Status (vazio = qualquer status)</span>
        <div className="flex flex-wrap gap-2">
          {/* status gravado fora da lista canonica (pela API, ou de uma versao
              anterior do painel) ganha caixa PROPRIA: sem ela o valor ficava
              invisivel na tela e o primeiro save o apagava calado */}
          {statusParaTela(r.status).map((o) => (
            <label key={o.valor} className="flex cursor-pointer items-center gap-1 text-[11px]">
              <input type="checkbox" checked={r.status.includes(o.valor)} onChange={() => alternarStatus(o.valor)} />
              <span className={o.sintetica ? "text-amber-800" : ""}>{o.rotulo}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">Responsavel</span>
          <select
            value={r.departamento}
            onChange={(e) => mudar({ departamento: e.target.value })}
            className="w-full rounded-lg border bg-white px-2 py-1.5 text-xs outline-none"
          >
            <option value="">Qualquer responsavel</option>
            {/* departamento APAGADO continua gravado no alerta: a opcao sintetica
                mostra o id em vez de deixar o select em branco */}
            {opcoesDep.map((o) => (
              <option key={o.valor} value={o.valor}>
                {o.rotulo}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">Parada ha mais de</span>
          <select
            value={String(r.idade_min)}
            onChange={(e) => mudar({ idade_min: Number(e.target.value) })}
            className="w-full rounded-lg border bg-white px-2 py-1.5 text-xs outline-none"
          >
            <option value="0">qualquer tempo</option>
            {/* idade posta pela API (ex: 720 = 12h) nao esta nos presets: sem a
                opcao sintetica o select vinha vazio e o save trocava por 1 hora */}
            {opcoesIdade.map((o) => (
              <option key={o.valor} value={o.valor}>
                {o.rotulo}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">Canal</span>
          <select
            value={r.canal}
            onChange={(e) => mudar({ canal: e.target.value })}
            className="w-full rounded-lg border bg-white px-2 py-1.5 text-xs outline-none"
          >
            <option value="">Todos os canais ativos</option>
            {/* canal DESATIVADO sai de `canais` e continua gravado no alerta */}
            {opcoesCanal.map((o) => (
              <option key={o.valor} value={o.valor}>
                {o.rotulo}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] text-muted-foreground">Maximo de conversas no aviso</span>
          <input
            type="number"
            min={1}
            max={200}
            value={r.limite}
            onChange={(e) => mudar({ limite: Number(e.target.value) })}
            className="w-full rounded-lg border bg-white px-2 py-1.5 text-xs outline-none"
          />
        </label>
      </div>

      <Horarios horarios={r.horarios} aoMudar={(h) => mudar({ horarios: h })} />

      <div className="space-y-2 rounded-lg border p-2">
        <span className="text-[11px] text-muted-foreground">Destino</span>
        <select
          value={r.destinoTipo}
          onChange={(e) => mudar({ destinoTipo: e.target.value as RascunhoAlerta["destinoTipo"] })}
          className="w-full rounded-lg border bg-white px-2 py-1.5 text-xs outline-none"
        >
          <option value="">Destino padrao da instalacao</option>
          <option value="telegram">Telegram</option>
          <option value="webhook">Webhook (https)</option>
        </select>
        {r.destinoTipo === "telegram" && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              value={r.destinoChatId}
              onChange={(e) => mudar({ destinoChatId: e.target.value })}
              placeholder="chat_id (so numeros)"
              className="rounded-lg border bg-white px-2 py-1.5 text-xs outline-none"
            />
            <input
              value={r.destinoAssinatura}
              onChange={(e) => mudar({ destinoAssinatura: e.target.value })}
              placeholder="assinatura (opcional)"
              className="rounded-lg border bg-white px-2 py-1.5 text-xs outline-none"
            />
          </div>
        )}
        {r.destinoTipo === "webhook" && (
          <>
            <input
              value={r.destinoUrl}
              onChange={(e) => mudar({ destinoUrl: e.target.value })}
              placeholder="https://..."
              className="w-full rounded-lg border bg-white px-2 py-1.5 text-xs outline-none"
            />
            {!!Object.keys(r.destinoExtra).length && (
              <p className="text-[11px] text-muted-foreground">
                Este destino tem cabecalhos configurados fora do painel. Eles serao preservados como estao — esta tela
                nao os edita nem os apaga.
              </p>
            )}
          </>
        )}
      </div>

      <label className="flex cursor-pointer items-center gap-1.5 text-[11px]">
        <input type="checkbox" checked={r.ativo} onChange={(e) => mudar({ ativo: e.target.checked })} />
        Ligado (sem isto o alerta fica gravado e nao dispara)
      </label>

      {!!problemas.length && (
        <ul className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-800">
          {problemas.map((p) => (
            <li key={p}>· {p}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() => aoSalvar(r)}
          disabled={!!problemas.length || salvando}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {salvando ? "Salvando..." : "Salvar"}
        </button>
        <button onClick={aoCancelar} className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-muted">
          Cancelar
        </button>
      </div>
    </section>
  );
}

function Horarios({ horarios, aoMudar }: { horarios: string[]; aoMudar: (h: string[]) => void }) {
  const [novo, setNovo] = useState("");
  return (
    <div className="space-y-1">
      <span className="text-[11px] text-muted-foreground">
        Horarios (alerta sem horario nunca dispara; se o disparo atrasar, sai com ate 1h de tolerancia)
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {horarios.map((h) => (
          <span key={h} className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px]">
            {h}
            <button
              onClick={() => aoMudar(horarios.filter((x) => x !== h))}
              className="rounded-full p-0.5 hover:bg-accent"
              aria-label={`Remover ${h}`}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        <input
          type="time"
          value={novo}
          onChange={(e) => setNovo(e.target.value)}
          className="rounded-lg border bg-white px-1.5 py-1 text-[11px] outline-none"
        />
        <button
          onClick={() => {
            if (!novo || horarios.includes(novo)) return;
            aoMudar([...horarios, novo].sort());
            setNovo("");
          }}
          className="rounded-lg border px-2 py-1 text-[11px] font-medium hover:bg-muted"
        >
          Adicionar
        </button>
      </div>
    </div>
  );
}
