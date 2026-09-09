"use client";

import { ArrowRightLeft, Download, FileText, History, Images, Star, Sticker } from "lucide-react";
import {
  ABAS_MIDIA,
  ROTULO_ABA_MIDIA,
  formatarDuracao,
  type AbaMidia,
  type LinhaStatus,
  type LinhaTransferencia,
  type ResumoStatus,
} from "@/lib/tela-conversa";

// Os quatro paineis de historico da tela de conversa — cards 86ak85nx0
// (status, avaliacoes/NPS, midia) e 86ak85nwu (transferencia).
//
// ARQUIVO PROPRIO, e nao mais 250 linhas dentro de app/home.tsx: o home.tsx ja
// passa de 5.000 linhas e e o arquivo mais disputado do repo. Mesma decisao de
// app/kanban-quadro.tsx e app/relatorios-*.tsx.
//
// ESTE COMPONENTE SO DESENHA. Nao busca, nao decide e nao formata regra: quem le
// as rotas e o home.tsx, e a regra (permanencia por status, verbo da
// transferencia, aba de cada anexo) mora em lib/tela-conversa.ts, provada sem
// navegador por scripts/prova-tela-conversa.ts.
//
// FRONTEIRA DE CONFIANCA: legenda de anexo, nome de arquivo e comentario de NPS
// sao CONTEUDO DE TERCEIRO. Tudo aqui sai como texto em nó JSX (o React escapa);
// nenhum `dangerouslySetInnerHTML`, e nenhuma URL de anexo vai pra `href` sem
// passar pelo filtro de esquema que o home.tsx aplica (`urlSegura`).

export type PainelHistoricoProps = {
  aba: "status" | "avaliacoes" | "midia" | "transferencias";
  status: {
    linhas: LinhaStatus[];
    resumo: ResumoStatus[];
    /** o resumo soma so a fatia lida — a tela rotula em vez de mentir com total */
    resumo_parcial?: boolean;
    truncado?: boolean;
    aviso?: string;
  } | null;
  transferencias: { linhas: LinhaTransferencia[]; truncado?: boolean; aviso?: string } | null;
  avaliacoes: {
    csat: { id: string; nota: number; atendente_nome: string | null; criada_em: string }[];
    nps: {
      id: string;
      nota: number | null;
      comentario: string | null;
      respondida_em: string | null;
      pesquisa_nome: string | null;
      origem: string;
    }[];
    avisos: string[];
  } | null;
  midia: {
    abas: Record<AbaMidia, { id: string; provider_msg_id: string | null; tipo: string; mime: string | null; url: string | null; legenda: string | null; criada_em: string; direcao: string }[]>;
    truncado: boolean;
    aviso?: string;
  } | null;
  abaMidia: AbaMidia;
  onAbaMidia: (a: AbaMidia) => void;
  /** rola a conversa ate a mensagem — "pular pra mensagem" do mapa */
  onPular: (idMensagem: string) => void;
  /** formatador de data/hora da INSTALACAO (o fuso mora no home.tsx) */
  fmtDataHora: (iso: string) => string;
  /** filtro de esquema de URL do home.tsx (bloqueia javascript:/data:) */
  urlSegura: (u: string | null | undefined) => string | null;
};

function Aviso({ texto }: { texto: string }) {
  // aviso e AMARELO, nao cinza: "a trilha nao existe nesta instalacao" nao pode
  // ter o mesmo peso visual de "esta conversa nunca mudou de status" — o
  // primeiro e uma pendencia de instalacao, o segundo e um fato.
  return (
    <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
      {texto}
    </p>
  );
}

function Vazio({ texto }: { texto: string }) {
  return <p className="text-xs text-muted-foreground">{texto}</p>;
}

function Carregando() {
  return <p className="text-xs text-muted-foreground">Carregando...</p>;
}

const ICONE_ABA: Record<AbaMidia, typeof Images> = {
  media: Images,
  document: FileText,
  sticker: Sticker,
};

export default function ConversaHistoricos(props: PainelHistoricoProps) {
  const { aba, fmtDataHora } = props;

  // ─────────────────────────────── STATUS ───────────────────────────────────
  if (aba === "status") {
    const d = props.status;
    if (!d) return <Carregando />;
    return (
      <div className="space-y-3">
        {d.aviso && <Aviso texto={d.aviso} />}
        {!!d.resumo.length && (
          <div className="rounded-lg border p-2">
            {/* O ROTULO MUDA QUANDO A LEITURA FOI CORTADA. O resumo soma o que
                veio; com mais trocas que o teto, "Tempo em cada status:
                atendimento 2h" seria falso (o real pode ser 40h). Nao somem com
                o resumo — a fatia recente ainda e util — mas nao o chame de
                total. */}
            <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
              <History className="h-3.5 w-3.5" />
              {d.resumo_parcial
                ? `Tempo em cada status — parcial (ultimas ${d.linhas.length} trocas)`
                : "Tempo em cada status"}
            </p>
            <dl className="space-y-1">
              {d.resumo.map((r) => (
                <div key={r.status} className="flex items-baseline justify-between gap-2">
                  <dt className="text-xs capitalize">{r.status}</dt>
                  <dd className="text-xs font-medium tabular-nums">{formatarDuracao(r.total_seg)}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              O tempo do status atual continua correndo — ele e calculado agora, nao guardado.
              {d.resumo_parcial && " Trocas mais antigas ficaram fora desta soma."}
            </p>
          </div>
        )}
        {!d.linhas.length && !d.aviso && (
          <Vazio texto="Nenhuma troca de status registrada nesta conversa." />
        )}
        {d.linhas.map((l) => (
          <div key={l.id} className="rounded-lg border p-2">
            <p className="flex items-center gap-1.5 text-xs">
              {l.status_anterior && (
                <>
                  <span className="capitalize text-muted-foreground">{l.status_anterior}</span>
                  <span className="text-muted-foreground">&rarr;</span>
                </>
              )}
              <span className="font-semibold capitalize">{l.status}</span>
              {l.atual && (
                <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                  atual
                </span>
              )}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {l.autor} — {fmtDataHora(l.criada_em)}
              {l.origem ? ` · ${l.origem}` : ""}
              {l.fluxo_nome ? ` · fluxo: ${l.fluxo_nome}` : ""}
            </p>
            {l.atual ? (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                neste status ha {formatarDuracao(l.em_curso_seg)}
              </p>
            ) : (
              l.status_anterior && (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  ficou {formatarDuracao(l.duracao_seg)} em {l.status_anterior}
                </p>
              )
            )}
          </div>
        ))}
      </div>
    );
  }

  // ───────────────────────────── TRANSFERENCIA ──────────────────────────────
  if (aba === "transferencias") {
    const d = props.transferencias;
    if (!d) return <Carregando />;
    return (
      <div className="space-y-3">
        {d.aviso && <Aviso texto={d.aviso} />}
        {d.truncado && (
          <p className="text-[11px] text-amber-700">
            Mostrando as passagens mais recentes — as mais antigas ficaram fora desta lista.
          </p>
        )}
        {!d.linhas.length && !d.aviso && (
          <>
            <Vazio texto="Nenhuma transferencia registrada nesta conversa." />
            {/* a trilha comeca a existir quando a migration roda: conversa
                antiga nao tem passado registrado, e dizer isso evita a leitura
                errada de "essa conversa nunca teve responsavel" */}
            <p className="mt-1 text-[11px] text-muted-foreground">
              A trilha registra as passagens a partir do momento em que ela foi criada — troca
              anterior a isso nao foi guardada por ninguem.
            </p>
          </>
        )}
        {d.linhas.map((l) => (
          <div key={l.id} className="rounded-lg border p-2">
            <p className="flex items-start gap-1.5 text-xs">
              <ArrowRightLeft
                className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${l.acao === "removido" ? "text-red-500" : "text-primary"}`}
              />
              <span className="break-words">{l.descricao}</span>
            </p>
            <p className="mt-0.5 pl-5 text-[11px] text-muted-foreground">
              {fmtDataHora(l.criada_em)}
              {l.origem ? ` · ${l.origem}` : ""}
              {l.fluxo_nome ? ` · fluxo: ${l.fluxo_nome}` : ""}
            </p>
          </div>
        ))}
      </div>
    );
  }

  // ────────────────────────── AVALIACOES E NPS ──────────────────────────────
  if (aba === "avaliacoes") {
    const d = props.avaliacoes;
    if (!d) return <Carregando />;
    const vazio = !d.csat.length && !d.nps.length;
    return (
      <div className="space-y-4">
        {d.avisos.map((a, i) => (
          <Aviso key={i} texto={a} />
        ))}
        {vazio && !d.avisos.length && <Vazio texto="Esse contato ainda nao respondeu nenhuma pesquisa." />}

        {!!d.csat.length && (
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
              <Star className="h-3.5 w-3.5" /> Pesquisa de satisfacao (1 a 5)
            </p>
            <div className="space-y-2">
              {d.csat.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-2 rounded-lg border p-2">
                  <div className="min-w-0">
                    <p className="text-[11px] text-muted-foreground">{fmtDataHora(a.criada_em)}</p>
                    {a.atendente_nome && (
                      <p className="truncate text-[11px] text-muted-foreground">
                        atendimento de {a.atendente_nome}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary tabular-nums">
                    {a.nota}/5
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {!!d.nps.length && (
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
              <Star className="h-3.5 w-3.5" /> NPS importado
            </p>
            <div className="space-y-2">
              {d.nps.map((n) => (
                <div key={n.id} className="rounded-lg border p-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium">{n.pesquisa_nome || "pesquisa sem nome"}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {n.respondida_em ? fmtDataHora(n.respondida_em) : "sem data de resposta"} · {n.origem}
                      </p>
                    </div>
                    {n.nota !== null && (
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold tabular-nums">
                        {n.nota}
                      </span>
                    )}
                  </div>
                  {n.comentario && (
                    <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                      {n.comentario}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {!!d.csat.length && !!d.nps.length && (
          // As duas escalas NAO se somam, e a tela diz isso. Media combinada de
          // "1 a 5 do painel" com "0 a 10 importado" produziria um numero que nao
          // significa nada — e alguem levaria pra reuniao.
          <p className="text-[11px] text-muted-foreground">
            As duas listas medem coisas diferentes (pesquisa do painel x pesquisa importada), em escalas
            diferentes — por isso aparecem separadas e sem media somada.
          </p>
        )}
      </div>
    );
  }

  // ────────────────────────────────── MIDIA ─────────────────────────────────
  const d = props.midia;
  if (!d) return <Carregando />;
  const itens = d.abas[props.abaMidia] ?? [];
  return (
    <div className="space-y-3">
      {d.aviso && <Aviso texto={d.aviso} />}
      <div className="flex gap-1 rounded-lg bg-muted p-1">
        {ABAS_MIDIA.map((a) => {
          const Icone = ICONE_ABA[a];
          const n = (d.abas[a] ?? []).length;
          return (
            <button
              key={a}
              onClick={() => props.onAbaMidia(a)}
              title={ROTULO_ABA_MIDIA[a]}
              className={`flex flex-1 items-center justify-center gap-1 rounded-md py-1 text-[11px] font-medium ${
                props.abaMidia === a ? "bg-white text-primary shadow-sm" : "text-muted-foreground hover:bg-white/60"
              }`}
            >
              <Icone className="h-3.5 w-3.5" /> {n}
            </button>
          );
        })}
      </div>
      {d.truncado && (
        <p className="text-[11px] text-amber-700">
          Mostrando os arquivos mais recentes desta conversa — os mais antigos ficaram fora.
        </p>
      )}
      {!itens.length ? (
        <Vazio texto={`Nenhum arquivo em "${ROTULO_ABA_MIDIA[props.abaMidia]}".`} />
      ) : props.abaMidia === "document" ? (
        <div className="space-y-2">
          {itens.map((m) => (
            <div key={m.id} className="rounded-lg border p-2">
              <p className="flex items-start gap-1.5 text-xs">
                <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="break-words">{m.legenda?.trim() || m.mime || "documento"}</span>
              </p>
              <p className="mt-0.5 pl-5 text-[11px] text-muted-foreground">
                {fmtDataHora(m.criada_em)} · {m.direcao === "out" ? "enviado" : "recebido"}
              </p>
              <div className="mt-1 flex gap-2 pl-5">
                {/* pular pra mensagem: requisito do mapa (modulo 10, 7.2). O
                    anexo isolado nao diz de que assunto era; a bolha diz. */}
                <button
                  onClick={() => props.onPular(m.id)}
                  className="text-[11px] font-medium text-primary hover:underline"
                >
                  ver na conversa
                </button>
                {props.urlSegura(m.url) && (
                  <a
                    href={props.urlSegura(m.url)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                  >
                    <Download className="h-3 w-3" /> abrir
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        // media e sticker: grade de miniatura. Audio e video nao tem miniatura,
        // entao ganham cartao com o tipo escrito — grade com quadrado preto
        // "quebrado" pareceria arquivo corrompido.
        <div className="grid grid-cols-3 gap-1.5">
          {itens.map((m) => {
            const url = props.urlSegura(m.url);
            const ehImagem = m.tipo === "image" || m.tipo === "sticker" || (m.mime || "").startsWith("image/");
            return (
              <button
                key={m.id}
                onClick={() => props.onPular(m.id)}
                title={`${m.legenda?.trim() || m.tipo} — ${fmtDataHora(m.criada_em)} (clique pra ver na conversa)`}
                className="relative aspect-square overflow-hidden rounded-lg border bg-muted hover:ring-2 hover:ring-primary"
              >
                {ehImagem && url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={url} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center px-1 text-center text-[11px] text-muted-foreground">
                    {m.tipo === "ptt" ? "audio gravado" : m.tipo}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
