"use client";

// Tela do modulo de DISPARO — pagina PROPRIA, de proposito.
//
// NAO toca `app/home.tsx`: aquele arquivo esta com outra frente no mesmo dia, e
// duas frentes no mesmo arquivo de 3.700 linhas e conflito garantido. A entrada
// pela navegacao do painel (um item no menu) fica de FORA desta entrega — quem
// usa chega por /disparo direto. Ligar no menu e um incremento de uma linha em
// home.tsx, pra fazer quando aquele arquivo tiver dono livre.
//
// AJUSTE VISUAL DO ERIC DE DIA. Esta tela e a minima consistente: mesma paleta
// e mesmos componentes visuais do painel (Tailwind, tema claro/escuro pela
// classe .dark), sem invencao de layout. O que importa aqui e o comportamento
// estar completo e honesto — o acabamento passa pelo olho dele.

import { useCallback, useEffect, useRef, useState } from "react";
import { Megaphone } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { CabecalhoTela, EstadoVazio } from "../ui/tela";

type Campanha = {
  id: string;
  nome: string;
  canal: string;
  canal_rotulo: string;
  estado: string;
  historico: boolean;
  pode_disparar: boolean;
  total: number;
  contagens: Record<string, number>;
  agendada_para: string | null;
  origem_ferramenta: string | null;
  origem_fluxo_nome: string | null;
  criado_por_nome: string | null;
  ativada_por_nome: string | null;
  progresso_origem: string | null;
  criada_em: string;
  erro: string | null;
};

type Detalhe = {
  campanha: Campanha & { mensagem: string; origem_fluxo_id: string | null; ativada_em: string | null };
  progresso: {
    total: number;
    enviados: number;
    respondidos: number;
    falhas: number;
    optout: number;
    pendentes: number;
    saindo_agora: number;
    percentual: string | null;
    canal_em_uso: string;
    estimativa_restante: string | null;
    impedimento: string | null;
  };
  destinos: { itens: any[]; pagina: number; por_pagina: number; total: number };
  respostas: { chat_id: string; nome: string | null; telefone: string | null; respondeu_em: string; link: string }[];
};

const CORES: Record<string, string> = {
  rascunho: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
  agendada: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  rodando: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
  pausada: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  concluida: "bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200",
  cancelada: "bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200",
};

export default function DisparoPage() {
  const [campanhas, setCampanhas] = useState<Campanha[]>([]);
  const [detalhe, setDetalhe] = useState<Detalhe | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  // GATE: a pagina e estatica e publica. Enquanto o primeiro fetch autorizado nao
  // volta, NADA e renderizado — nem titulo, nem descricao do modulo. Sem isso,
  // quem abre /disparo sem sessao (ou com o modulo desligado) via a casca da
  // tela contando que existe um modulo de disparo em massa nesta instalacao.
  const [liberado, setLiberado] = useState(false);
  const [aberta, setAberta] = useState<string | null>(null);
  const [novaAberta, setNovaAberta] = useState(false);
  const timer = useRef<any>(null);

  const auth = useCallback(async (): Promise<Record<string, string>> => {
    const { data } = await authClient.auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  const carregar = useCallback(async () => {
    try {
      const r = await fetch("/api/disparo", { headers: await auth(), cache: "no-store" });
      const j = await r.json();
      if (!r.ok) {
        // 401/403 nao ganham casca: a tela continua vazia, so com o motivo
        setErro(j?.error || "nao deu pra carregar as campanhas");
        setCampanhas([]);
        setLiberado(false);
        return;
      }
      setErro(null);
      setLiberado(true);
      setCampanhas(j.campanhas || []);
    } catch {
      setErro("nao deu pra falar com o servidor");
    } finally {
      setCarregando(false);
    }
  }, [auth]);

  const abrir = useCallback(
    async (id: string) => {
      setAberta(id);
      const r = await fetch(`/api/disparo/${id}`, { headers: await auth(), cache: "no-store" });
      const j = await r.json();
      if (r.ok) setDetalhe(j);
      else setErro(j?.error || "nao deu pra abrir a campanha");
    },
    [auth]
  );

  useEffect(() => {
    carregar();
  }, [carregar]);

  // enquanto uma campanha esta rodando, o acompanhamento e ao vivo
  useEffect(() => {
    clearInterval(timer.current);
    if (aberta && detalhe?.campanha?.estado === "rodando") {
      timer.current = setInterval(() => {
        abrir(aberta);
        carregar();
      }, 5000);
    }
    return () => clearInterval(timer.current);
  }, [aberta, detalhe?.campanha?.estado, abrir, carregar]);

  async function mudarEstado(id: string, estado: string) {
    setAviso(null);
    const r = await fetch(`/api/disparo/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await auth()) },
      body: JSON.stringify({ estado }),
    });
    const j = await r.json();
    if (!r.ok) {
      setAviso(j?.error || "nao deu pra mudar o estado");
      return;
    }
    await carregar();
    await abrir(id);
  }

  // ainda conferindo quem e: tela em branco de proposito
  if (carregando) {
    return (
      <main className="flex min-h-screen flex-col bg-background text-foreground">
        <p className="p-6 text-sm text-muted-foreground">carregando...</p>
      </main>
    );
  }

  // sem sessao, sem permissao ou modulo desligado: SO o motivo, sem contar o que
  // esta tela faria se estivesse ligada
  if (!liberado) {
    return (
      <main className="flex min-h-screen flex-col bg-background text-foreground">
        <CabecalhoTela titulo="Disparo em massa" icone={Megaphone} aoVoltar={() => { window.location.href = "/"; }} voltarRotulo="Painel" />
        <EstadoVazio
          icone={Megaphone}
          titulo={erro || "Tela indisponivel"}
          texto="Quem liga o modulo de disparo e quem cuida da instalacao (chave `modulos` na configuracao). Enquanto estiver desligado, nenhuma campanha sai daqui."
        />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <CabecalhoTela
        titulo="Disparo em massa"
        descricao="Toda campanha nasce como rascunho e so sai daqui quando alguem aprova."
        icone={Megaphone}
        aoVoltar={() => { window.location.href = "/"; }}
        voltarRotulo="Painel"
      >
        <button
          onClick={() => setNovaAberta((v) => !v)}
          className="ml-auto rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          Nova campanha
        </button>
      </CabecalhoTela>
      <div className="mx-auto w-full max-w-6xl p-6">

        {erro && (
          <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200">
            {erro}
          </div>
        )}
        {aviso && (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            {aviso}
          </div>
        )}

        {novaAberta && <NovaCampanha auth={auth} aoCriar={carregar} aoFechar={() => setNovaAberta(false)} />}

        <BloqueiosAutomaticos auth={auth} />

        {!campanhas.length ? (
          <EstadoVazio
            icone={Megaphone}
            titulo="Nenhuma campanha ainda"
            texto="Crie a primeira em Nova campanha: escolha o publico, escreva a mensagem e deixe como rascunho ate alguem aprovar."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-left text-xs uppercase text-slate-500 dark:bg-slate-700 dark:text-slate-300">
                <tr>
                  <th className="px-4 py-3">Campanha</th>
                  <th className="px-4 py-3">Canal</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3">Destinos</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {campanhas.map((c) => (
                  <tr key={c.id} className="border-t border-slate-100 dark:border-slate-700">
                    <td className="px-4 py-3">
                      <div className="font-medium">{c.nome}</div>
                      {c.historico && (
                        <div className="text-xs text-slate-500">
                          registro historico{c.origem_ferramenta ? ` (${c.origem_ferramenta})` : ""}
                          {c.origem_fluxo_nome ? ` · fluxo: ${c.origem_fluxo_nome}` : ""}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">{c.canal_rotulo}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded px-2 py-1 text-xs font-medium ${CORES[c.estado] || ""}`}>{c.estado}</span>
                    </td>
                    <td className="px-4 py-3">
                      {c.total}
                      {c.progresso_origem ? ` · ${c.progresso_origem}` : ""}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => abrir(c.id)} className="text-sm text-emerald-700 hover:underline dark:text-emerald-400">
                        acompanhar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {detalhe && aberta && (
          <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-800">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold">{detalhe.campanha.nome}</h2>
                <p className="text-xs text-slate-500">
                  {detalhe.progresso.canal_em_uso}
                  {detalhe.campanha.ativada_por_nome ? ` · aprovada por ${detalhe.campanha.ativada_por_nome}` : ""}
                </p>
              </div>
              <button onClick={() => { setAberta(null); setDetalhe(null); }} className="text-sm text-slate-500 hover:underline">
                fechar
              </button>
            </div>

            {detalhe.campanha.historico ? (
              <p className="mb-4 rounded-lg bg-slate-100 p-3 text-sm dark:bg-slate-700">
                Esta e uma campanha importada, guardada como registro historico. Ela nao dispara mensagem em nenhuma
                condicao.
              </p>
            ) : (
              <>
                {detalhe.progresso.impedimento && (
                  <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                    {detalhe.progresso.impedimento}
                  </p>
                )}
                <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-6">
                  {[
                    ["total", detalhe.progresso.total],
                    ["enviados", detalhe.progresso.enviados],
                    ["responderam", detalhe.progresso.respondidos],
                    ["falhas", detalhe.progresso.falhas],
                    ["faltam", detalhe.progresso.pendentes],
                    ...(detalhe.progresso.saindo_agora
                      ? ([["saindo agora", detalhe.progresso.saindo_agora]] as [string, number][])
                      : []),
                    ["progresso", detalhe.progresso.percentual ?? "-"],
                  ].map(([r, v]) => (
                    <div key={String(r)} className="rounded-lg bg-slate-100 p-3 dark:bg-slate-700">
                      <div className="text-xs uppercase text-slate-500 dark:text-slate-300">{r}</div>
                      <div className="text-xl font-semibold">{v as any}</div>
                    </div>
                  ))}
                </div>
                {detalhe.progresso.estimativa_restante && detalhe.progresso.pendentes > 0 && (
                  <p className="mb-4 text-sm text-slate-500">
                    estimativa pro que falta: {detalhe.progresso.estimativa_restante}
                  </p>
                )}

                <div className="mb-5 flex flex-wrap gap-2">
                  {detalhe.campanha.estado === "rascunho" && (
                    <button
                      onClick={() => mudarEstado(detalhe.campanha.id, "rodando")}
                      className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                    >
                      Aprovar e disparar
                    </button>
                  )}
                  {detalhe.campanha.estado === "rodando" && (
                    <button
                      onClick={() => mudarEstado(detalhe.campanha.id, "pausada")}
                      className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700"
                    >
                      Pausar
                    </button>
                  )}
                  {detalhe.campanha.estado === "pausada" && (
                    <button
                      onClick={() => mudarEstado(detalhe.campanha.id, "rodando")}
                      className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                    >
                      Retomar
                    </button>
                  )}
                  {["rascunho", "agendada", "rodando", "pausada"].includes(detalhe.campanha.estado) && (
                    <button
                      onClick={() => mudarEstado(detalhe.campanha.id, "cancelada")}
                      className="rounded-lg border border-rose-300 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-950"
                    >
                      Cancelar
                    </button>
                  )}
                </div>
              </>
            )}

            {!!detalhe.respostas.length && (
              <div className="mb-5">
                <h3 className="mb-2 text-sm font-semibold">Responderam ({detalhe.respostas.length})</h3>
                <ul className="space-y-1 text-sm">
                  {detalhe.respostas.map((r) => (
                    <li key={r.chat_id}>
                      <a href={r.link} className="text-emerald-700 hover:underline dark:text-emerald-400">
                        {r.nome || r.telefone || r.chat_id}
                      </a>
                      <span className="ml-2 text-xs text-slate-500">
                        {new Date(r.respondeu_em).toLocaleString("pt-BR")}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <h3 className="mb-2 text-sm font-semibold">Destinos ({detalhe.destinos.total})</h3>
            <div className="max-h-80 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
              <table className="w-full text-sm">
                <tbody>
                  {detalhe.destinos.itens.map((d) => (
                    <tr key={d.id} className="border-b border-slate-100 last:border-0 dark:border-slate-700">
                      <td className="px-3 py-2">{d.nome || d.telefone || d.chat_id}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">{d.estado}</td>
                      <td className="px-3 py-2 text-xs text-rose-600 dark:text-rose-400">{d.erro || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

// -------------------------------------------- bloqueios automaticos (revisao)
//
// O descadastro por resposta e AUTOMATICO e o efeito e forte: a pessoa para de
// receber disparo, para sempre, sem ninguem decidir. O reconhecimento e
// conservador (lib/disparo/optout.ts), mas conservador nao e infalivel — entao
// os bloqueios de origem `resposta` ficam VISIVEIS aqui, com a frase que os
// disparou, pra alguem conferir e desfazer se foi engano.
function BloqueiosAutomaticos({ auth }: { auth: () => Promise<Record<string, string>> }) {
  const [itens, setItens] = useState<any[]>([]);
  const [aberto, setAberto] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const r = await fetch("/api/disparo/bloqueios", { headers: await auth(), cache: "no-store" });
      const j = await r.json();
      if (!r.ok) {
        setErro(j?.error || null);
        return;
      }
      setErro(null);
      setItens((j.bloqueios || []).filter((b: any) => b.origem === "resposta"));
    } catch {
      /* a tela principal ja reporta indisponibilidade */
    }
  }, [auth]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function desbloquear(telefone: string) {
    await fetch(`/api/disparo/bloqueios?telefone=${encodeURIComponent(telefone)}`, {
      method: "DELETE",
      headers: await auth(),
    });
    carregar();
  }

  if (erro || !itens.length) return null;

  return (
    <section className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950">
      <button onClick={() => setAberto((v) => !v)} className="font-medium text-amber-900 dark:text-amber-200">
        {itens.length} contato(s) descadastrados automaticamente por resposta — conferir
        {aberto ? " ▲" : " ▼"}
      </button>
      {aberto && (
        <ul className="mt-3 space-y-2">
          {itens.map((b) => (
            <li key={b.chave} className="flex items-center justify-between gap-3">
              <span className="text-amber-900 dark:text-amber-200">
                {b.telefone || b.chave}
                <span className="ml-2 text-xs opacity-75">reconhecido por: {b.motivo || "?"}</span>
              </span>
              <button
                onClick={() => desbloquear(b.telefone || b.chave)}
                className="rounded border border-amber-400 px-2 py-1 text-xs text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900"
              >
                foi engano, desbloquear
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------ nova campanha
function NovaCampanha({
  auth,
  aoCriar,
  aoFechar,
}: {
  auth: () => Promise<Record<string, string>>;
  aoCriar: () => void;
  aoFechar: () => void;
}) {
  const [nome, setNome] = useState("");
  const [mensagem, setMensagem] = useState("");
  const [canal, setCanal] = useState("central");
  const [csv, setCsv] = useState("");
  const [previa, setPrevia] = useState<any>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  async function prever() {
    setErro(null);
    setOcupado(true);
    try {
      const r = await fetch("/api/disparo/publico", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await auth()) },
        body: JSON.stringify({ origem: "csv", csv, mensagem }),
      });
      const j = await r.json();
      if (!r.ok) setErro(j?.error || "nao deu pra validar o publico");
      else setPrevia(j);
    } finally {
      setOcupado(false);
    }
  }

  async function criar() {
    setErro(null);
    setOcupado(true);
    try {
      const r = await fetch("/api/disparo", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await auth()) },
        body: JSON.stringify({ nome, mensagem, canal, publico: { origem: "csv", csv } }),
      });
      const j = await r.json();
      if (!r.ok) {
        setErro(j?.error || "nao deu pra criar a campanha");
        return;
      }
      aoCriar();
      aoFechar();
    } finally {
      setOcupado(false);
    }
  }

  return (
    <section className="mb-6 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-800">
      <h2 className="mb-3 text-lg font-semibold">Nova campanha</h2>
      <p className="mb-4 text-xs text-slate-500">
        A campanha e criada como RASCUNHO. Nada e enviado ate voce aprovar na tela de acompanhamento.
      </p>
      <div className="grid gap-3">
        <input
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          placeholder="Nome da campanha"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900"
        />
        <input
          value={canal}
          onChange={(e) => setCanal(e.target.value)}
          placeholder="Canal (ex: central)"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900"
        />
        <textarea
          value={mensagem}
          onChange={(e) => setMensagem(e.target.value)}
          placeholder="Mensagem. Use {{nome}} pra personalizar."
          rows={4}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900"
        />
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={"telefone;nome\n5511999999999;Ana"}
          rows={5}
          className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs dark:border-slate-600 dark:bg-slate-900"
        />
        <input
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setCsv(await f.text());
          }}
          className="text-sm"
        />
      </div>

      {erro && <p className="mt-3 text-sm text-rose-600">{erro}</p>}

      {previa && (
        <div className="mt-4 rounded-lg bg-slate-100 p-3 text-sm dark:bg-slate-700">
          <p>
            <strong>{previa.total}</strong> destinos validos · {previa.invalidos_total} invalidos ·{" "}
            {previa.duplicados_total} duplicados · {previa.estimativa}
          </p>
          {!!previa.alertas?.length && (
            <ul className="mt-2 list-disc pl-5 text-amber-800 dark:text-amber-300">
              {previa.alertas.map((a: string) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
          {!!previa.invalidos?.length && (
            <ul className="mt-2 max-h-32 overflow-auto text-xs text-rose-700 dark:text-rose-300">
              {previa.invalidos.map((i: any) => (
                <li key={i.linha}>
                  linha {i.linha}: {i.valor || "(vazio)"} — {i.motivo}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <button
          onClick={prever}
          disabled={ocupado || !csv.trim()}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm disabled:opacity-50 dark:border-slate-600"
        >
          Conferir publico
        </button>
        <button
          onClick={criar}
          disabled={ocupado || !nome.trim() || !mensagem.trim() || !csv.trim()}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 hover:bg-emerald-700"
        >
          Criar rascunho
        </button>
        <button onClick={aoFechar} className="px-3 py-2 text-sm text-slate-500">
          cancelar
        </button>
      </div>
    </section>
  );
}
