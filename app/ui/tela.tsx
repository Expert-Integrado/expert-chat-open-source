"use client";

import type { ReactNode } from "react";
import { ArrowLeft, type LucideIcon } from "lucide-react";

// PECAS UNICAS DE TELA PROPRIA (revisao de interface, tranche 2 — 03/09/2026,
// docs/revisao-interface-2026-09-02.md, achado 8).
//
// Antes, cada tela desenhava o proprio cabecalho e o proprio "voltar": "<- Conversas"
// com texto (quadro, relatorios), "<-" so icone em botao redondo (numeros, acesso),
// "<-" em botao com borda (campos, biblioteca), e /fluxos e /disparo sem voltar
// nenhum. Estado vazio idem: frase solta, cartao claro no tema escuro, icone + frase.
// Tres desenhos pra um gesto e o que faz o painel parecer "meio bagunçado".
//
// Regra: tela propria NASCE com <CabecalhoTela> (voltar + icone + titulo + 1 linha de
// descricao; o que a tela precisa a mais — abas, seletor, busca — entra como
// children, na mesma linha) e usa <EstadoVazio> pra "nao tem nada aqui ainda"
// (icone + frase + o que fazer). Tema: so classes que o globals.css ja traduz no
// escuro (bg-white, text-muted-foreground) — nada de cor fixa.

export function CabecalhoTela({
  titulo,
  descricao,
  icone: Icone,
  aoVoltar,
  voltarRotulo = "Conversas",
  children,
}: {
  titulo: string;
  descricao?: string;
  icone?: LucideIcon;
  /** ausente = tela sem "voltar" (ex.: embutida em outra tela) */
  aoVoltar?: () => void;
  /** pra onde o voltar leva; vira texto do botao (>= sm) e do title */
  voltarRotulo?: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-white px-3 py-2">
      {aoVoltar && (
        <button
          type="button"
          onClick={aoVoltar}
          title={`Voltar pra ${voltarRotulo}`}
          aria-label={`Voltar pra ${voltarRotulo}`}
          className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">{voltarRotulo}</span>
        </button>
      )}
      <div className="flex min-w-0 items-center gap-2">
        {Icone && <Icone className="h-4 w-4 shrink-0 text-primary" />}
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold leading-5">{titulo}</h1>
          {descricao && (
            <p className="hidden truncate text-[11px] leading-4 text-muted-foreground lg:block" title={descricao}>
              {descricao}
            </p>
          )}
        </div>
      </div>
      {/* Abaixo de `md` a faixa de ferramentas ocupa a linha de baixo INTEIRA (basis-full):
          medido em 420px (varredura de 03/09), abas e busca na mesma linha do titulo vazavam
          pela direita em /fluxos e /biblioteca. `grow` no lugar de `flex-1`: o atalho fixa
          flex-basis 0% e, na ordem do Tailwind, ganharia do basis-full. */}
      {children && <div className="flex min-w-0 grow basis-full flex-wrap items-center gap-2 md:basis-0">{children}</div>}
    </header>
  );
}

export function EstadoVazio({
  icone: Icone,
  titulo,
  texto,
  acao,
  compacto = false,
}: {
  icone?: LucideIcon;
  titulo: string;
  /** o que fazer a partir daqui — nunca so "nao tem nada" */
  texto?: string;
  acao?: ReactNode;
  /** dentro de coluna/lista estreita: menos respiro, icone menor */
  compacto?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 text-center ${compacto ? "px-3 py-6" : "px-6 py-12"}`}
      role="status"
    >
      {Icone && <Icone className={`${compacto ? "h-6 w-6" : "h-8 w-8"} text-muted-foreground/60`} aria-hidden />}
      <p className="text-sm font-medium">{titulo}</p>
      {texto && <p className="max-w-md text-xs leading-relaxed text-muted-foreground">{texto}</p>}
      {acao}
    </div>
  );
}
