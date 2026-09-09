// Lista de bloqueio (opt-out) — acesso ao banco.
//
// A parte pura (quais palavras significam "me tira daqui") mora em
// lib/disparo/optout.ts. Aqui e so leitura/escrita.
//
// FAIL-CLOSED, e este e o ponto: se a consulta a lista FALHAR, o destino conta
// como BLOQUEADO. Um erro de banco nao pode virar "manda pra todo mundo",
// inclusive pra quem pediu explicitamente pra sair — o custo dos dois erros e
// completamente diferente.
//
// A chave e a mesma `chaveDedupe` do publico (ultimos digitos): a pessoa aparece
// com e sem DDI, com e sem o nono digito. Bloquear pelo numero inteiro deixaria
// ela voltar a receber pela variante.

import { msgDb } from "@/lib/mensageria";
import { chaveDedupe, normalizarTelefone, type DestinoValido } from "@/lib/disparo/telefone";

export function chaveDeBloqueio(telefoneOuChatId: unknown): string | null {
  const d = normalizarTelefone(telefoneOuChatId);
  if (!d.ok) return null;
  return chaveDedupe(d as DestinoValido);
}

/** Um destino esta bloqueado? Erro de consulta = BLOQUEADO (fail-closed). */
export async function estaBloqueado(telefoneOuChatId: unknown): Promise<boolean> {
  const chave = chaveDeBloqueio(telefoneOuChatId);
  if (!chave) return false; // destino invalido nao chega a ser enviado mesmo
  try {
    const { data, error } = await msgDb()
      .from("campanha_bloqueios")
      .select("chave")
      .eq("chave", chave)
      .maybeSingle();
    if (error) {
      // tabela ausente (0012 nao aplicada) NAO pode travar o modulo inteiro:
      // nesse caso especifico a lista simplesmente nao existe ainda.
      if ((error as any).code === "42P01") return false;
      console.error("bloqueio: consulta falhou, tratando como bloqueado", { erro: error.message });
      return true;
    }
    return !!data;
  } catch (e: any) {
    console.error("bloqueio: excecao, tratando como bloqueado", { erro: e?.message });
    return true;
  }
}

/** Quais destes estao bloqueados (para filtrar o publico em lote). */
export async function bloqueadosEntre(telefones: unknown[]): Promise<Set<string>> {
  const chaves = Array.from(
    new Set(telefones.map(chaveDeBloqueio).filter((c): c is string => !!c))
  );
  const achados = new Set<string>();
  if (!chaves.length) return achados;
  const db = msgDb();
  for (let i = 0; i < chaves.length; i += 200) {
    const fatia = chaves.slice(i, i + 200);
    const { data, error } = await db.from("campanha_bloqueios").select("chave").in("chave", fatia);
    if (error) {
      if ((error as any).code === "42P01") return achados; // lista ainda nao existe
      // fail-closed: nao da pra afirmar que ninguem esta bloqueado
      for (const c of fatia) achados.add(c);
      continue;
    }
    for (const b of (data ?? []) as any[]) achados.add(b.chave);
  }
  return achados;
}

export async function bloquear(opcoes: {
  telefone: unknown;
  origem?: "manual" | "resposta";
  motivo?: string | null;
  usuario?: { id: string; nome: string } | null;
}): Promise<{ ok: boolean; chave?: string; erro?: string }> {
  const chave = chaveDeBloqueio(opcoes.telefone);
  if (!chave) return { ok: false, erro: "telefone invalido" };
  const d = normalizarTelefone(opcoes.telefone) as DestinoValido;
  const { error } = await msgDb()
    .from("campanha_bloqueios")
    .upsert(
      {
        chave,
        telefone: d.telefone || String(opcoes.telefone ?? ""),
        origem: opcoes.origem || "manual",
        motivo: opcoes.motivo ?? null,
        criado_por_id: opcoes.usuario?.id ?? null,
        criado_por_nome: opcoes.usuario?.nome ?? null,
      },
      { onConflict: "chave" }
    );
  if (error) return { ok: false, erro: error.message };
  return { ok: true, chave };
}

export async function desbloquear(telefone: unknown): Promise<{ ok: boolean; erro?: string }> {
  const chave = chaveDeBloqueio(telefone);
  if (!chave) return { ok: false, erro: "telefone invalido" };
  const { error } = await msgDb().from("campanha_bloqueios").delete().eq("chave", chave);
  return error ? { ok: false, erro: error.message } : { ok: true };
}
