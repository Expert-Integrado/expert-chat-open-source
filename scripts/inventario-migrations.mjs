// Inventario: quais migrations de supabase/migrations estao APLICADAS na instancia?
//
//   SUPABASE_PAT="$(op read 'op://Agentes Eric/SUPABASE_PAT_EXPERT/credential')" \
//     node scripts/inventario-migrations.mjs [--projeto <ref>]
//
// POR QUE EXISTE (02/09/2026): migration aqui e gesto humano, e ninguem anota
// qual rodou onde. Em producao a 0006 (autoria da troca de status) nunca tinha
// rodado — o POST /api/conversa devolvia 500 em TODA troca de status e a tela
// otimista escondia. Descoberto por teste funcional, nao por reclamacao.
// Este script checa UM objeto-assinatura por migration (tabela, coluna ou
// funcao que so ela cria) e sai com codigo 1 se faltar alguma. Rodar antes de
// declarar um deploy "pronto" e depois de qualquer DDL manual.
//
// Nao entra na bateria `prova-*.ts` de proposito: precisa de rede e credencial.
// Fora de rede (sem PAT) so imprime a lista de assinaturas.
const PAT = process.env.SUPABASE_PAT;
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PROJ = arg("projeto", "SEU-PROJECT-REF"); // --projeto <ref do seu Supabase>

const col = (t, c) => `exists(select 1 from information_schema.columns where table_schema='mensageria' and table_name='${t}' and column_name='${c}')`;
const tab = (t) => `to_regclass('mensageria.${t}') is not null`;
const fn = (f) => `exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='mensageria' and p.proname='${f}')`;

// UM objeto por migration — o que SO ela cria. Migration nova = linha nova aqui.
export const ASSINATURAS = {
  "0001_schema_completo": tab("config"),
  "0002_embed": tab("embed_contextos"),
  "0003_perfil_contextos": tab("perfil_contextos"),
  "0004_visibilidade_auto_arquivar": tab("conversa_visibilidade"),
  "0005_api_keys": tab("api_keys"),
  "0006_status_autor": col("conversas", "status_alterado_em"),
  "0007_canal_whatsapp_extra": fn("criar_canal_whatsapp"),
  "0008_fluxos": tab("fluxos"),
  "0009_funis": tab("funis"),
  "0010_papeis": tab("papeis"),
  "0011_perfil_preferencias": col("perfis", "preferencias"),
  "0012_disparo": tab("campanhas"),
  "0013_relatorios": fn("relatorio_operacional"),
  "0014_relatorio_fuso": fn("relatorio_atendimento"),
  "0015_fluxo_pastas": col("fluxos", "pasta"),
  "0016_conversa_contexto": tab("conversa_contexto"),
  "0017_tela_conversa": col("conversas", "inicio_estado"),
  "0018_fluxo_fila": tab("fluxo_fila"),
  "0019_seguranca_conta": tab("acesso_janelas"),
  "0020_respostas_rapidas_origem": col("respostas_rapidas", "origem_ferramenta"),
  "0021_fila_atendimento": tab("atendente_fila"),
  "0022_intencoes": tab("intencoes"),
  "0023_canais_conexao_templates": tab("canal_estado"),
  "0024_anexos_biblioteca": tab("anexos"),
  "0025_campos_ficha": col("campos_personalizados", "tipo"),
};

if (!PAT) {
  console.log("sem SUPABASE_PAT: so listando as assinaturas");
  for (const k of Object.keys(ASSINATURAS)) console.log(" ", k);
  process.exit(0);
}

const query = "select json_build_object(" +
  Object.entries(ASSINATURAS).map(([k, v]) => `'${k}', ${v}`).join(", ") + ") inv";
const r = await fetch(`https://api.supabase.com/v1/projects/${PROJ}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query }),
});
const txt = await r.text();
if (!r.ok) { console.error(`HTTP ${r.status}: ${txt.slice(0, 400)}`); process.exit(2); }
const inv = JSON.parse(txt)[0].inv;
const faltam = Object.entries(inv).filter(([, ok]) => !ok).map(([k]) => k);
for (const [k, ok] of Object.entries(inv)) console.log(`${ok ? "ok    " : "FALTA "} ${k}`);
console.log(faltam.length ? `\n${faltam.length} migration(s) NAO aplicada(s): ${faltam.join(", ")}` : `\nTODAS as ${Object.keys(inv).length} migrations aplicadas em ${PROJ}`);
// exitCode em vez de process.exit(): sair no meio do fechamento do fetch dispara
// um assert do libuv no Windows (UV_HANDLE_CLOSING) — ruido, nao erro
process.exitCode = faltam.length ? 1 : 0;
