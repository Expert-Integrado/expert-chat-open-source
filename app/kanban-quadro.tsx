"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Columns3, Loader2, MoveRight, RefreshCw, Search, X } from "lucide-react";
import { CabecalhoTela, EstadoVazio } from "./ui/tela";
import type { CanalPublico } from "@/lib/canais";
import {
  aplicarMovimento, desfazerMovimento, funilSelecionado, montarQuadro,
  movimentoValido, opcoesDoFunil, rotuloResponsavel,
  type CardConversa, type ForaDoQuadro, type FunilQuadro, type Movimento, type VinculoQuadro,
} from "@/lib/kanban";

// QUADRO (kanban) de conversas por funil — card 86ak86k7g.
//
// A REGRA nao mora aqui: montar coluna, filtrar, cortar a fatia da rolagem e o
// par aplicar/desfazer do arrasto sao funcoes puras em lib/kanban.ts, provadas
// sem navegador por `node scripts/prova-kanban.ts`. Este arquivo e so a tela.
//
// ONDE ELE VIVE: e uma VISAO do painel (app/home.tsx), nao uma pagina propria —
// a decisao esta no CLAUDE.md. O motivo pratico e o criterio "clicar no cartao
// abre a conversa": pagina separada precisaria refazer sessao, MFA, canais e o
// `authedFetch` que o painel ja tem, e a volta pra conversa seria uma navegacao
// em vez de um clique.
//
// ARRASTAR E OTIMISTA: o cartao muda de coluna na hora de soltar e o POST vai
// atras. Falhou, volta pro lugar com o motivo na tela — nunca fica no lugar
// novo mentindo que gravou.

type Dados = {
  funis: FunilQuadro[];
  conversas: VinculoQuadro[];
  cards: CardConversa[];
  fora_do_quadro: ForaDoQuadro[];
  truncado: boolean;
  aviso?: string;
};

const VAZIO: Dados = { funis: [], conversas: [], cards: [], fora_do_quadro: [], truncado: false };
const PAGINA = 30;

// Status da conversa com as mesmas cores da lista (o par escuro dessas classes
// ja existe em globals.css — cor nova aqui exigiria linha nova la).
const PILL_STATUS: Record<string, string> = {
  aberto: "bg-red-100 text-red-700",
  atendimento: "bg-sky-100 text-sky-700",
  concluido: "bg-green-100 text-green-700",
  aguardando: "bg-amber-100 text-amber-700",
};

function iniciais(nome: string) {
  return nome.split(" ").filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
}

function httpsOuNada(u: string | null | undefined) {
  if (!u) return null;
  try {
    return new URL(u).protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

export default function KanbanQuadro({
  authedFetch, canais, usuarioNome, aoAbrirConversa, aoSair,
}: {
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>;
  canais: CanalPublico[];
  /** nome de quem esta logado: o cartao carimba o autor do movimento na hora,
   *  sem esperar a resposta do servidor (que grava o mesmo) */
  usuarioNome: string;
  /** clicar no cartao devolve o controle pro painel, que abre a conversa */
  aoAbrirConversa: (canal: string, chatId: string) => void;
  aoSair: () => void;
}) {
  const [dados, setDados] = useState<Dados>(VAZIO);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [funilId, setFunilId] = useState<string | null>(null);
  const [busca, setBusca] = useState("");
  const [responsavel, setResponsavel] = useState("");
  const [etiqueta, setEtiqueta] = useState("");
  const [canal, setCanal] = useState("");
  const [visiveis, setVisiveis] = useState<Record<string, number>>({});
  const [arrastando, setArrastando] = useState<string | null>(null);
  const [alvo, setAlvo] = useState<string | null>(null);
  const [movendo, setMovendo] = useState<string | null>(null);
  const [menuMover, setMenuMover] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await authedFetch("/api/funis?com_conversas=1");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "falha ao carregar o quadro");
      setDados({
        funis: Array.isArray(j.funis) ? j.funis : [],
        conversas: Array.isArray(j.conversas) ? j.conversas : [],
        cards: Array.isArray(j.cards) ? j.cards : [],
        fora_do_quadro: Array.isArray(j.fora_do_quadro) ? j.fora_do_quadro : [],
        truncado: !!j.truncado,
        aviso: j.aviso,
      });
    } catch (e: any) {
      setErro(e?.message || "falha ao carregar o quadro");
    } finally {
      setCarregando(false);
    }
  }, [authedFetch]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const funil = useMemo(() => funilSelecionado(dados.funis, funilId), [dados.funis, funilId]);

  const filtro = useMemo(
    () => ({ busca, responsavel: responsavel || null, etiqueta: etiqueta || null, canal: canal || null }),
    [busca, responsavel, etiqueta, canal]
  );

  const colunas = useMemo(
    () => montarQuadro({
      funil, vinculos: dados.conversas, cards: dados.cards, fora: dados.fora_do_quadro,
      filtro, visiveisPorColuna: visiveis, paginaInicial: PAGINA,
    }),
    [funil, dados, filtro, visiveis]
  );

  // opcoes de filtro: lidas dos cards direto (uma varredura), nunca de um
  // segundo quadro montado e ordenado so pra colher etiqueta e responsavel
  const opcoes = useMemo(
    () => opcoesDoFunil({ funil, vinculos: dados.conversas, cards: dados.cards }),
    [funil, dados.conversas, dados.cards]
  );

  // ------------------------------------------------------------- movimento
  const mover = useCallback(
    async (m: Movimento) => {
      if (!movimentoValido(m)) return;
      // 1) a tela muda AGORA (o atendente soltou o cartao; esperar a rede seria
      //    o cartao "voltar" e ele arrastar de novo)
      setDados((d) => ({ ...d, conversas: aplicarMovimento(d.conversas, m) }));
      setMovendo(m.uid);
      // NAO limpar o erro aqui: se o movimento anterior falhou, o atendente
      // ainda nao leu o aviso — arrastar outro cartao apagaria a unica pista de
      // que a conversa passada nao gravou. O erro sai quando ESTE movimento der
      // certo, ou quando ele fechar o aviso no X.
      try {
        const r = await authedFetch("/api/conversa/funil", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: m.chat_id, canal: m.canal, funil_id: m.funil_id, etapa_id: m.para }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "falha ao mover a conversa");
        setErro(null); // gravou: o aviso que estava na tela ja nao vale
      } catch (e: any) {
        // 2) falhou: ROLLBACK. Age sobre o estado ATUAL e so no vinculo desta
        //    conversa neste funil — e nao mexe em nada se a conversa ja saiu de
        //    `m.para` (o atendente arrastou de novo e AQUELE movimento gravou):
        //    desfazer ali jogaria a tela pra um lugar que o servidor nao tem
        //    mais. Movimento mais novo vence.
        setDados((d) => ({ ...d, conversas: desfazerMovimento(d.conversas, m) }));
        setErro(e?.message || "falha ao mover a conversa");
      } finally {
        setMovendo(null);
      }
    },
    [authedFetch]
  );

  const soltarEm = useCallback(
    (etapaDestino: string) => {
      setAlvo(null);
      const uid = arrastando;
      setArrastando(null);
      if (!uid || !funil) return;
      const cartao = colunas.flatMap((c) => c.cartoes).find((c) => c.uid === uid);
      if (!cartao) return;
      mover({
        uid, canal: cartao.canal, chat_id: cartao.chat_id, funil_id: funil.id,
        de: cartao.etapa_id, para: etapaDestino,
        // metadado atual do vinculo: e o que o rollback devolve, pra um
        // movimento que nao gravou nao deixar rastro de que gravou
        deAtualizadoEm: cartao.atualizado_em,
        deDefinidoPorNome: cartao.definido_por_nome,
        porNome: usuarioNome,
      });
    },
    [arrastando, colunas, funil, mover]
  );

  // ------------------------------------------------------------------ tela
  const semFunil = !carregando && !dados.funis.length;

  return (
    <div className="flex h-screen flex-col bg-background">
      {/* cabecalho unico de tela propria (app/ui/tela.tsx); funil, busca e filtros na mesma linha */}
      <CabecalhoTela titulo="Quadro de funil" icone={Columns3} aoVoltar={aoSair}>
        <select
          value={funil?.id || ""}
          onChange={(e) => {
            setFunilId(e.target.value);
            setVisiveis({});
          }}
          className="min-w-0 max-w-[240px] truncate rounded-lg border bg-white px-2 py-1.5 text-xs font-medium outline-none"
        >
          {dados.funis.map((f) => (
            <option key={f.id} value={f.id}>
              {f.nome}
            </option>
          ))}
          {!dados.funis.length && <option value="">Nenhum funil</option>}
        </select>

        <div className="flex min-w-[160px] flex-1 items-center gap-2 rounded-lg bg-muted px-3 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por nome ou numero"
            className="w-full bg-transparent text-xs outline-none"
          />
          {busca && (
            <button onClick={() => setBusca("")} className="rounded text-muted-foreground hover:bg-accent">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <select
          value={responsavel}
          onChange={(e) => setResponsavel(e.target.value)}
          className={`min-w-0 max-w-[170px] truncate rounded-lg border bg-white px-2 py-1.5 text-[11px] outline-none ${responsavel ? "border-primary text-primary" : ""}`}
        >
          <option value="">Todos os responsaveis</option>
          {opcoes.responsaveis.map((r) => (
            <option key={r.id} value={r.id}>
              {r.nome}
            </option>
          ))}
        </select>

        <select
          value={etiqueta}
          onChange={(e) => setEtiqueta(e.target.value)}
          className={`min-w-0 max-w-[150px] truncate rounded-lg border bg-white px-2 py-1.5 text-[11px] outline-none ${etiqueta ? "border-primary text-primary" : ""}`}
        >
          <option value="">Todas as etiquetas</option>
          {opcoes.etiquetas.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>

        {canais.length > 1 && (
          <select
            value={canal}
            onChange={(e) => setCanal(e.target.value)}
            className={`min-w-0 max-w-[150px] truncate rounded-lg border bg-white px-2 py-1.5 text-[11px] outline-none ${canal ? "border-primary text-primary" : ""}`}
          >
            <option value="">Todos os canais</option>
            {canais.map((c) => (
              <option key={c.id} value={c.id}>
                {c.rotulo}
              </option>
            ))}
          </select>
        )}

        <button
          onClick={carregar}
          title="Atualizar o quadro"
          className="rounded p-1.5 text-muted-foreground hover:bg-muted"
        >
          {carregando ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </button>
      </CabecalhoTela>

      {/* avisos: migration ausente, corte por teto e falha de movimento */}
      {dados.aviso && (
        <div className="shrink-0 border-b bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
          {dados.aviso}
        </div>
      )}
      {dados.truncado && (
        <div className="shrink-0 border-b bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
          O quadro mostra as conversas movidas mais recentemente — a lista bateu no teto do servidor e foi
          cortada. Use a busca e os filtros pra achar uma conversa que nao aparece aqui.
        </div>
      )}
      {erro && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
          <span>{erro}</span>
          <button onClick={() => setErro(null)} className="rounded p-0.5 hover:bg-amber-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* estados vazios */}
      {carregando && !dados.funis.length && (
        <p className="p-6 text-center text-sm text-muted-foreground">Carregando o quadro...</p>
      )}
      {semFunil && (
        <div className="flex flex-1 items-center justify-center">
          <EstadoVazio
            icone={Columns3}
            titulo="Nenhum funil cadastrado ainda"
            texto="Funil e etapa sao criados pelo super admin, em Configuracoes. Depois de criar, cada conversa pode entrar numa etapa e o quadro aparece aqui."
          />
        </div>
      )}

      {/* o quadro: colunas rolam na horizontal, cada coluna rola na vertical */}
      {!!funil && (
        <div className="flex flex-1 gap-3 overflow-x-auto overflow-y-hidden p-3">
          {colunas.map((col) => {
            const podeSoltar = !col.sintetica && !!arrastando;
            return (
              <section
                key={col.etapa_id}
                onDragOver={(e) => {
                  if (!podeSoltar) return;
                  e.preventDefault();
                  setAlvo(col.etapa_id);
                }}
                onDragLeave={() => setAlvo((a) => (a === col.etapa_id ? null : a))}
                onDrop={(e) => {
                  if (!podeSoltar) return;
                  e.preventDefault();
                  soltarEm(col.etapa_id);
                }}
                className={`flex w-[280px] shrink-0 flex-col overflow-hidden rounded-lg border bg-muted/40 ${
                  alvo === col.etapa_id ? "border-primary ring-1 ring-primary" : ""
                }`}
              >
                <header className="flex shrink-0 items-center gap-2 border-b bg-white px-3 py-2">
                  {/* a cor da etapa vem do banco (hex): risquinho, nunca fundo —
                      cor arbitraria de fundo quebraria a leitura no tema escuro */}
                  <span
                    className="h-3.5 w-1 shrink-0 rounded-full bg-primary"
                    style={col.cor ? { backgroundColor: col.cor } : undefined}
                  />
                  <h2 className="min-w-0 flex-1 truncate text-xs font-semibold">{col.nome}</h2>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-bold text-muted-foreground">
                    {col.total}
                  </span>
                </header>

                {col.sintetica ? (
                  // DIVIDA DECLARADA (CLAUDE.md): conversa presa em etapa/funil
                  // arquivado. A rota manda so a contagem — sem chat_id, pra nao
                  // vazar conversa por uma porta lateral. Mostrar o numero e o
                  // que impede o trabalho de sumir em silencio.
                  <div className="flex-1 overflow-y-auto p-3 text-[11px] text-muted-foreground">
                    <p className="mb-2">
                      Conversas que ficaram apontando pra uma etapa ou funil que foi arquivado. Elas continuam
                      no lugar — so nao ha coluna pra desenhar. Reative a etapa em Configuracoes, ou abra cada
                      conversa e mova pela ficha.
                    </p>
                    <ul className="space-y-1">
                      {dados.fora_do_quadro.map((f, i) => (
                        <li key={i} className="rounded border bg-white px-2 py-1.5">
                          <span className="font-medium">{f.conversas}</span>{" "}
                          {f.conversas === 1 ? "conversa" : "conversas"} em{" "}
                          <span className="font-medium">{f.funil ?? "funil apagado"}</span>
                          {f.etapa ? ` / ${f.etapa}` : ""} — {f.motivo}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div
                    onScroll={(e) => {
                      // rolagem infinita por coluna: uma etapa com milhares de
                      // conversas nao pode desenhar tudo de uma vez
                      const el = e.currentTarget;
                      if (el.scrollHeight - el.scrollTop - el.clientHeight > 200) return;
                      setVisiveis((v) => {
                        const atual = v[col.etapa_id] ?? PAGINA;
                        if (atual >= col.total) return v;
                        return { ...v, [col.etapa_id]: atual + PAGINA };
                      });
                    }}
                    className="flex-1 space-y-2 overflow-y-auto p-2"
                  >
                    {col.cartoes.map((c) => {
                      const foto = httpsOuNada(c.foto);
                      const dono = rotuloResponsavel(c);
                      return (
                        <article
                          key={c.uid}
                          draggable
                          onDragStart={(e) => {
                            setArrastando(c.uid);
                            e.dataTransfer.effectAllowed = "move";
                            // alguns navegadores so iniciam o arrasto com payload
                            e.dataTransfer.setData("text/plain", c.uid);
                          }}
                          onDragEnd={() => {
                            setArrastando(null);
                            setAlvo(null);
                          }}
                          className={`group rounded-lg border bg-white p-2.5 text-left shadow-sm ${
                            arrastando === c.uid ? "opacity-40" : ""
                          } ${movendo === c.uid ? "animate-pulse" : ""}`}
                        >
                          <button
                            onClick={() => aoAbrirConversa(c.canal, c.chat_id)}
                            className="flex w-full items-start gap-2 text-left"
                          >
                            {foto ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={foto} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
                            ) : (
                              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
                                {iniciais(c.nome || "?")}
                              </span>
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="min-w-0 flex-1 truncate text-xs font-semibold">{c.nome}</span>
                                {c.status && (
                                  <span
                                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                                      PILL_STATUS[c.status] || "bg-muted text-muted-foreground"
                                    }`}
                                  >
                                    {c.status}
                                  </span>
                                )}
                              </span>
                              {c.preview && (
                                <span className="mt-0.5 line-clamp-2 block text-[11px] text-muted-foreground">
                                  {c.preview}
                                </span>
                              )}
                            </span>
                          </button>

                          {(c.etiquetas.length > 0 || dono) && (
                            <div className="mt-2 flex flex-wrap items-center gap-1">
                              {c.etiquetas.slice(0, 3).map((e) => (
                                <span key={e} className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-800">
                                  {e}
                                </span>
                              ))}
                              {c.etiquetas.length > 3 && (
                                <span className="text-[10px] text-muted-foreground">+{c.etiquetas.length - 3}</span>
                              )}
                              {dono && (
                                <span className="ml-auto max-w-[120px] truncate rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                  {dono}
                                </span>
                              )}
                            </div>
                          )}

                          {/* CELULAR: arrastar nao existe no toque. O mesmo
                              movimento sai por menu — as duas portas chamam a
                              MESMA funcao, entao nao ha caminho que grave
                              diferente. */}
                          <div className="relative mt-1.5">
                            <button
                              onClick={() => setMenuMover((m) => (m === c.uid ? null : c.uid))}
                              className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                            >
                              <MoveRight className="h-3 w-3" />
                              Mover para
                            </button>
                            {menuMover === c.uid && (
                              <div className="absolute bottom-6 left-0 z-40 w-52 overflow-hidden rounded-lg border bg-white text-xs shadow-lg">
                                {funil.etapas
                                  .filter((e) => e.id !== c.etapa_id)
                                  .map((e) => (
                                    <button
                                      key={e.id}
                                      onClick={() => {
                                        setMenuMover(null);
                                        mover({
                                          uid: c.uid, canal: c.canal, chat_id: c.chat_id,
                                          funil_id: funil.id, de: c.etapa_id, para: e.id,
                                          deAtualizadoEm: c.atualizado_em,
                                          deDefinidoPorNome: c.definido_por_nome,
                                          porNome: usuarioNome,
                                        });
                                      }}
                                      className="block w-full truncate px-3 py-2 text-left hover:bg-muted"
                                    >
                                      {e.nome}
                                    </button>
                                  ))}
                              </div>
                            )}
                          </div>
                        </article>
                      );
                    })}

                    {col.total === 0 && (
                      <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">
                        {arrastando ? "Solte aqui" : "Nenhuma conversa"}
                      </p>
                    )}
                    {col.cartoes.length < col.total && (
                      <p className="py-2 text-center text-[11px] text-muted-foreground">
                        {col.cartoes.length} de {col.total} — role pra carregar mais
                      </p>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
