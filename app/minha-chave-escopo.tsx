"use client";

import { useState } from "react";
import type { CanalPublico } from "@/lib/canais";
import { alternar, avisoEscopoAberto, corpoDoEscopo, rotuloEscopo } from "@/lib/tela-acesso";
import { validarEscopoChave, type EscopoChave } from "@/lib/escopo-chave";

// RECORTE DA PROPRIA CHAVE — Frente Q (card 86ak85899), metade de autoatendimento.
//
// Vive num arquivo separado (e nao solto em app/home.tsx) por dois motivos: a
// aba "Minha conta" ja e o trecho mais denso do modal de Configuracoes, e o
// recorte precisa de estado proprio que ninguem mais no painel usa.
//
// TETO: aqui NAO existe `ignorar_janela`. E a unica dimensao do escopo que
// AFROUXA (a chave trabalhando fora da janela de acesso do dono) e por isso ela
// vive so no caminho de super admin (/api/admin/api-keys, tela
// app/admin-acesso.tsx). `corpoDoEscopo` nem monta o campo, e a rota
// `/api/minha-chave` o zera com `escopoSemPrivilegio` de todo jeito — dois
// cintos, porque marcar isso em si mesmo seria furar a propria janela com um
// passo a mais.
//
// FECHADO POR DEFAULT: chave sem recorte e o comportamento que sempre existiu
// (a chave vale o que o dono vale), e e o que a maioria quer. Quem precisa
// apertar abre o bloco.

export type RecursoCatalogo = { id: string; descricao: string };

export default function MinhaChaveEscopo({
  recursos,
  canais,
  escopo,
  prazo,
  aoMudarEscopo,
  aoMudarPrazo,
  desabilitado = false,
}: {
  recursos: RecursoCatalogo[];
  canais: CanalPublico[];
  escopo: EscopoChave;
  /** "YYYY-MM-DD" ou "" (sem prazo) */
  prazo: string;
  aoMudarEscopo: (e: EscopoChave) => void;
  aoMudarPrazo: (v: string) => void;
  /** a migration 0019 nao rodou: a rota recusa escopo, entao a tela nem oferece */
  desabilitado?: boolean;
}) {
  const [aberto, setAberto] = useState(false);
  const aviso = avisoEscopoAberto(escopo);

  if (desabilitado) return null;

  return (
    <div className="mt-2 rounded-lg border">
      <button
        type="button"
        onClick={() => setAberto(!aberto)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left">
        <span>
          <span className="text-[11px] font-medium">Limitar o que esta chave alcanca</span>
          <span className="block text-[11px] text-muted-foreground">{rotuloEscopo(escopo)}</span>
        </span>
        <span className="shrink-0 text-[11px] text-primary">{aberto ? "fechar" : "escolher"}</span>
      </button>

      {aberto && (
        <div className="space-y-3 border-t px-3 py-3">
          <label className="flex items-center gap-2 text-[11px]">
            <input
              type="checkbox"
              checked={escopo.somente_leitura}
              onChange={(e) => aoMudarEscopo({ ...escopo, somente_leitura: e.target.checked })}
            />
            Somente leitura — o agente le, mas nao envia mensagem nem muda nada
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">
                Recursos {escopo.recursos.length === 0 ? "(nada marcado = tudo que voce alcanca)" : ""}
              </p>
              <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
                {recursos.map((r) => (
                  <label key={r.id} className="flex items-start gap-2 text-[11px]" title={r.descricao}>
                    <input
                      type="checkbox"
                      checked={(escopo.recursos as string[]).includes(r.id)}
                      onChange={() =>
                        aoMudarEscopo(
                          validarEscopoChave({ ...escopo, recursos: alternar(escopo.recursos, r.id) })
                        )
                      }
                    />
                    <span>
                      {r.id}
                      <span className="block text-[11px] text-muted-foreground">{r.descricao}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">
                Numeros {escopo.canais.length === 0 ? "(nada marcado = todos)" : ""}
              </p>
              <div className="space-y-1">
                {canais.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-[11px]">
                    <input
                      type="checkbox"
                      checked={escopo.canais.includes(c.id)}
                      onChange={() => aoMudarEscopo({ ...escopo, canais: alternar(escopo.canais, c.id) })}
                    />
                    {c.rotulo}
                  </label>
                ))}
              </div>
              <p className="mt-2 text-[11px] font-semibold uppercase text-muted-foreground">Prazo</p>
              <input
                type="date"
                value={prazo}
                onChange={(e) => aoMudarPrazo(e.target.value)}
                className="mt-1 rounded border bg-white px-2 py-1 text-[11px] outline-none"
              />
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Vazio = sem prazo. Depois do prazo a chave para de funcionar sozinha.
              </p>
            </div>
          </div>

          {aviso && (
            <p className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900">{aviso}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** O corpo que a tela manda no POST — sem `ignorar_janela`, por definicao. */
export function corpoEscopoProprio(e: EscopoChave) {
  return corpoDoEscopo(e);
}
