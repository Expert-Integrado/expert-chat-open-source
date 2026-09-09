"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Save, X } from "lucide-react";
import { DESCRICAO_TIPO, type CampoFicha, type LeituraValor, type TipoCampo } from "@/lib/campos";

// A FICHA DO CONTATO, TIPADA — componente REUSAVEL (Frente X, card 86ak85nxn).
//
// POR QUE COMPONENTE, E NAO UM PEDACO DE `app/home.tsx`: a tela de conversa
// pertence a outra frente nesta onda, e o criterio do card ("valor por campo por
// contato, consultavel e editavel") tinha que ser entregue por ROTA +
// COMPONENTE, com a costura DECLARADA em vez de feita a marteladas num arquivo
// de 6.800 linhas com dono. A costura esta escrita na secao desta frente no
// CLAUDE.md; o contrato e:
//
//     <FichaCampos authedFetch={authedFetch} canal={canal} chatId={active.chat_id} />
//
// Ele nao depende de nada do painel alem do `authedFetch` — nem de estado, nem de
// contexto, nem do modal. Enquanto a costura nao acontece, a ficha de hoje segue
// funcionando exatamente como funcionava: `/api/ficha` continua devolvendo
// `campos_padrao` e `ficha`, e agora tambem `campos` (tipado), `pendencias` e
// `orfaos` — tudo ADITIVO, nada trocado.
//
// A REGRA NAO MORA AQUI. Tipo, canonicalizacao de valor, pendencia de campo
// obrigatorio e "valor sem campo" sao decididos em `lib/campos.ts` (puro, provado
// por `node scripts/prova-campos.ts`) e aplicados pela rota. Este arquivo desenha
// o que o servidor mandou e manda de volta o que a pessoa digitou — inclusive o
// erro: quando a rota recusa (422), o texto DIGITADO fica na tela junto do motivo,
// porque limpar o formulario no erro faz a pessoa perder o que escreveu por causa
// de uma virgula no lugar errado.
//
// A TELA NAO PASSOU POR AJUSTE VISUAL DO ERIC — so componentes e classes que o
// painel ja usa.

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

type CampoComValor = CampoFicha & { valor: LeituraValor | null };

type Resposta = {
  campos?: CampoComValor[];
  pendencias?: string[];
  orfaos?: { chave: string; valor: string }[];
  somente_leitura?: boolean;
  tipos_disponiveis?: boolean;
  aviso?: string;
  error?: string;
};

export default function FichaCampos({
  authedFetch,
  canal,
  chatId,
  aoSalvar,
}: {
  authedFetch: Fetch;
  canal: string;
  chatId: string;
  /** avisa quem embute que a ficha mudou (a tela de conversa recarrega o resto) */
  aoSalvar?: () => void;
}) {
  const [dados, setDados] = useState<Resposta | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [rascunho, setRascunho] = useState<Record<string, string> | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await authedFetch(
        `/api/campos/valores?chat_id=${encodeURIComponent(chatId)}&canal=${encodeURIComponent(canal)}`
      );
      const j: Resposta = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErro(j.error || "nao deu pra carregar os campos da ficha");
        setDados(null);
      } else {
        setDados(j);
      }
    } catch {
      setErro("nao deu pra carregar os campos da ficha");
    } finally {
      setCarregando(false);
    }
  }, [authedFetch, canal, chatId]);

  useEffect(() => {
    // conversa trocou: o rascunho da ANTERIOR nao pode viajar (seria escrever o
    // valor de um contato na ficha de outro)
    setRascunho(null);
    setErro(null);
    void carregar();
  }, [carregar]);

  const campos = dados?.campos ?? [];
  const pendencias = new Set(dados?.pendencias ?? []);
  const orfaos = dados?.orfaos ?? [];
  const somenteLeitura = !!dados?.somente_leitura;

  const abrirEdicao = () => {
    const base: Record<string, string> = {};
    for (const c of campos) base[c.nome] = c.valor?.texto ?? "";
    setRascunho(base);
    setErro(null);
  };

  const salvar = async () => {
    if (!rascunho) return;
    setSalvando(true);
    setErro(null);
    try {
      const r = await authedFetch("/api/campos/valores", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, canal, valores: rascunho }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // 422 = a rota recusou por FORMATO e nao gravou nada (tudo ou nada). O
        // rascunho FICA na tela: limpar faria a pessoa redigitar a ficha inteira
        // por causa de um campo.
        setErro(j.error || "a ficha nao foi salva");
        return;
      }
      setRascunho(null);
      await carregar();
      aoSalvar?.();
    } catch {
      setErro("a ficha nao foi salva (falha de rede)");
    } finally {
      setSalvando(false);
    }
  };

  if (carregando && !dados) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> carregando os campos...
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {dados?.aviso && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
          {dados.aviso}
        </p>
      )}
      {erro && (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-[11px] leading-snug text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{erro}</span>
        </p>
      )}

      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Campos da ficha</p>
        {!somenteLeitura && rascunho === null && campos.length > 0 && (
          <button onClick={abrirEdicao} className="text-[11px] font-medium text-primary hover:underline">
            editar
          </button>
        )}
      </div>

      {!campos.length ? (
        <p className="text-xs text-muted-foreground">
          Nenhum campo cadastrado. Quem monta a ficha desta instalacao e a tela de campos da ficha (permissao
          <span className="font-mono"> gerenciar_campos</span>).
        </p>
      ) : rascunho === null ? (
        <dl className="space-y-2">
          {campos.map((c) => (
            <div key={c.id} className="text-xs">
              <dt className="flex items-center gap-1 text-muted-foreground">
                <span>{c.nome}</span>
                {c.obrigatorio && (
                  <span
                    title="campo obrigatorio: nao pode ser esvaziado depois de preenchido"
                    className={pendencias.has(c.nome) ? "text-destructive" : "text-muted-foreground"}
                  >
                    *
                  </span>
                )}
                <span className="rounded bg-muted px-1 text-[11px]" title={DESCRICAO_TIPO[c.tipo as TipoCampo]}>
                  {c.tipo}
                </span>
              </dt>
              <dd className="break-words">
                {c.valor ? (
                  <span className={c.valor.fora_do_formato ? "text-amber-700 dark:text-amber-400" : ""}>
                    {c.valor.texto}
                    {/* VALOR FORA DO FORMATO E MOSTRADO, NUNCA CONSERTADO NEM
                        ESCONDIDO: o acervo de valores e anterior aos tipos (o sync
                        do ChatGuru grava texto livre desde sempre). Reescrever
                        inventaria um dado; esconder faria alguem achar que a ficha
                        esta vazia. */}
                    {c.valor.fora_do_formato && (
                      <span className="ml-1 text-[11px]" title={c.valor.motivo}>
                        (fora do formato {c.tipo})
                      </span>
                    )}
                  </span>
                ) : (
                  <span className={pendencias.has(c.nome) ? "text-destructive" : "text-muted-foreground"}>
                    {pendencias.has(c.nome) ? "— falta preencher" : "—"}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="space-y-2">
          {campos.map((c) => (
            <label key={c.id} className="block text-xs">
              <span className="text-muted-foreground">
                {c.nome}
                {c.obrigatorio && <span title="campo obrigatorio"> *</span>}
              </span>
              <EntradaCampo
                campo={c}
                valor={rascunho[c.nome] ?? ""}
                aoMudar={(v) => setRascunho((r) => ({ ...(r || {}), [c.nome]: v }))}
              />
              {c.descricao && <span className="text-[11px] text-muted-foreground">{c.descricao}</span>}
            </label>
          ))}
          <div className="flex gap-2 pt-1">
            <button
              onClick={salvar}
              disabled={salvando}
              className="flex items-center gap-1 rounded-lg bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-60"
            >
              {salvando ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} salvar
            </button>
            <button
              onClick={() => {
                setRascunho(null);
                setErro(null);
              }}
              className="flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] hover:bg-muted"
            >
              <X className="h-3 w-3" /> cancelar
            </button>
          </div>
        </div>
      )}

      {/* VALORES SEM CAMPO — o defeito que esta frente fecha.
          A ficha e desenhada iterando o CATALOGO ATIVO, entao o valor de um campo
          arquivado (ou renomeado pela rota antiga, ou trazido pelo sync sem
          cadastro) ficava no banco e desaparecia da tela: ninguem apagou nada, e
          ninguem conseguia mais ver. Aqui ele aparece, com a chave, em vez de
          sumir. So leitura de proposito — a escrita passa pelo catalogo. */}
      {orfaos.length > 0 && (
        <div className="rounded-lg border border-dashed p-2">
          <p className="text-[11px] font-semibold text-muted-foreground">
            Valores sem campo ({orfaos.length})
          </p>
          <p className="text-[11px] leading-snug text-muted-foreground">
            Gravados nesta conversa por um campo que saiu da ficha (arquivado, renomeado ou nunca cadastrado). Ficam
            aqui em vez de desaparecer; pra voltarem a ser editaveis, recrie o campo com este nome.
          </p>
          <dl className="mt-1 space-y-1">
            {orfaos.map((o) => (
              <div key={o.chave} className="text-[11px]">
                <dt className="text-muted-foreground">{o.chave}</dt>
                <dd className="break-words">{o.valor}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

/**
 * A entrada por TIPO.
 *
 * `lista` e `sim_nao` viram `<select>`, e isso e mais que conforto: o valor
 * gravado passa a ser o texto EXATO da opcao do catalogo, entao "a vista"
 * digitado por um atendente e "A Vista" por outro deixam de virar duas linhas
 * diferentes no relatorio.
 *
 * VALOR GRAVADO FORA DAS OPCOES GANHA OPCAO SINTETICA. Sem isso o `<select>`
 * renderiza em BRANCO e o primeiro salvar "conserta" pro primeiro item da lista,
 * sem ninguem pedir — a mesma armadilha que a Frente M documentou (`garantirOpcao`
 * nas telas de relatorio). Aqui o dano seria maior: o valor perdido e do cliente.
 */
function EntradaCampo({
  campo,
  valor,
  aoMudar,
}: {
  campo: CampoComValor;
  valor: string;
  aoMudar: (v: string) => void;
}) {
  const classe =
    "mt-0.5 w-full rounded-lg border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary";

  if (campo.tipo === "lista" || campo.tipo === "sim_nao") {
    const opcoes = campo.tipo === "sim_nao" ? ["sim", "nao"] : campo.opcoes;
    const foraDaLista = valor.trim() !== "" && !opcoes.some((o) => o === valor);
    return (
      <select className={classe} value={valor} onChange={(e) => aoMudar(e.target.value)}>
        <option value="">— sem valor —</option>
        {opcoes.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        {foraDaLista && <option value={valor}>{valor} (gravado fora das opcoes)</option>}
      </select>
    );
  }

  // `numero` e `data` seguem como TEXTO no <input>, de proposito: `type="date"` e
  // `type="number"` do navegador impoem o dialeto do LOCALE dele e, pior, apagam
  // em silencio o valor que nao casa — e valor importado fora do formato existe
  // (por isso `lerValor` o marca em vez de descartar). Quem valida e a rota, que
  // devolve a frase dizendo o que escrever.
  return (
    <input
      className={classe}
      value={valor}
      onChange={(e) => aoMudar(e.target.value)}
      placeholder={
        campo.tipo === "numero" ? "ex: 1234,56" : campo.tipo === "data" ? "dd/mm/aaaa" : ""
      }
    />
  );
}
