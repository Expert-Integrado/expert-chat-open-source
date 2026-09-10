// Perfil proprio do usuario: preferencias de aviso e foto.
//
// Este arquivo NAO importa NADA de proposito (mesma convencao de lib/fluxo/schema.ts):
// roda dentro do Next e em `node` solto, e e por isso que da pra provar as regras
// sem navegador e sem banco (scripts/prova-perfil.ts).
//
// Regra da casa: nada da Expert aqui — preferencia e foto sao BASE, valem pra
// qualquer instalacao.

// ---------------------------------------------------------------- preferencias

// So existe preferencia pra aviso que o painel REALMENTE emite hoje:
//   som     = o bip do sininho (WebAudio, app/home.tsx `apitar`)
//   desktop = aviso do navegador (Notification API) enquanto a aba esta em segundo plano
// Nao existe e-mail nem push com a aba fechada (sem service worker / web-push):
// interruptor pra aviso que ninguem dispara e mentira na tela. Quando o envio por
// e-mail existir, a chave entra AQUI e o interruptor aparece junto.
// MODO SUPERVISOR (Frente N, 31/08/2026) tambem mora aqui, porque tambem e
// preferencia POR PESSOA gravada em `perfis.preferencias`:
//   supervisor                = abrir a conversa NAO marca como lida
//   supervisor_responder_zera = ... mas responder zera o contador
// Por que preferencia e nao papel: supervisionar e um jeito de USAR o painel, e
// duas pessoas com o mesmo papel podem querer jeitos diferentes. O admin
// tambem liga/desliga isso pela tela de usuarios (a chave e a mesma).
export type Preferencias = {
  som: boolean;
  desktop: boolean;
  supervisor: boolean;
  supervisor_responder_zera: boolean;
};

// Default = como o painel se comportava antes desta tela (bip ligado). O aviso de
// desktop nasce DESLIGADO porque depende de permissao do navegador: ligado por
// default so produziria pedido de permissao que ninguem pediu.
// `supervisor` nasce DESLIGADO (o painel se comporta como sempre se comportou) e
// `supervisor_responder_zera` nasce LIGADO — quem respondeu leu, e essa e a
// unica porta que zera o contador de quem esta em modo supervisor.
export const PREFERENCIAS_PADRAO: Preferencias = {
  som: true,
  desktop: false,
  supervisor: false,
  supervisor_responder_zera: true,
};

export const CHAVES_PREFERENCIA = Object.keys(PREFERENCIAS_PADRAO) as (keyof Preferencias)[];

// Le o que veio do banco/body e devolve SEMPRE um objeto completo e valido.
// Chave desconhecida e ignorada (instalacao velha nao quebra quando chave nova
// entra na lista) e valor que nao e booleano de verdade cai no default —
// mesma disciplina de lib/modulos.ts.
export function sanitizarPreferencias(bruto: unknown): Preferencias {
  const fonte = (bruto && typeof bruto === "object" && !Array.isArray(bruto) ? bruto : {}) as Record<string, unknown>;
  const saida = { ...PREFERENCIAS_PADRAO };
  for (const chave of CHAVES_PREFERENCIA) {
    if (typeof fonte[chave] === "boolean") saida[chave] = fonte[chave] as boolean;
  }
  return saida;
}

// Patch parcial: o que nao veio no patch MANTEM o valor atual.
export function mesclarPreferencias(atual: unknown, patch: unknown): Preferencias {
  const base = sanitizarPreferencias(atual);
  const p = (patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}) as Record<string, unknown>;
  for (const chave of CHAVES_PREFERENCIA) {
    if (typeof p[chave] === "boolean") base[chave] = p[chave] as boolean;
  }
  return base;
}

// ------------------------------------------------------------------- assinatura

export const LIMITE_ASSINATURA = 60;

// Nome que sai em negrito na frente da mensagem enviada. Vazio = usa o nome da
// conta (quem decide isso e quem envia, em /api/send).
export function sanitizarAssinaturaNome(bruto: unknown): string {
  return typeof bruto === "string" ? bruto.trim().slice(0, LIMITE_ASSINATURA) : "";
}

// ------------------------------------------------------------------------ senha

export const SENHA_MINIMA = 8;

// Mensagem de erro LEGIVEL, ou null quando esta tudo certo. Fail-closed: campo
// faltando e erro, nao "deixa passar".
// Senha TEMPORARIA gerada pelo super admin (rota /api/users/senha): 12 chars de
// um alfabeto sem ambiguidade (sem 0/O, 1/l/I) — ela vai ser DITADA ou colada
// por outro canal, e "O" contra "0" e o erro que faz a pessoa achar que a senha
// esta errada. Puro: recebe os bytes aleatorios, quem sorteia e a rota.
const ALFABETO_TEMPORARIA = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
export const SENHA_TEMPORARIA_TAMANHO = 12;

export function gerarSenhaTemporaria(bytes: ArrayLike<number>): string {
  let s = "";
  for (let i = 0; i < SENHA_TEMPORARIA_TAMANHO; i++) s += ALFABETO_TEMPORARIA[(bytes[i % bytes.length] ?? 0) % ALFABETO_TEMPORARIA.length];
  return s;
}

export function validarTrocaDeSenha(atual: unknown, nova: unknown): string | null {
  if (typeof atual !== "string" || !atual) return "Informe a senha atual.";
  if (typeof nova !== "string" || !nova) return "Informe a nova senha.";
  if (nova.length < SENHA_MINIMA) return `A nova senha precisa de pelo menos ${SENHA_MINIMA} caracteres.`;
  if (nova === atual) return "A nova senha precisa ser diferente da atual.";
  return null;
}

// --------------------------------------------------------------------- foto

export const LIMITE_FOTO_BYTES = 2 * 1024 * 1024; // 2 MB

// Teto do CORPO da requisicao (multipart), conferido pelo content-length ANTES
// de bufferizar o upload. A folga sobre LIMITE_FOTO_BYTES e o overhead do
// multipart — quem decide de verdade e o tamanho dos bytes da imagem.
export const LIMITE_MULTIPART_BYTES = 3 * 1024 * 1024;

// Recusa pelo cabecalho, antes de tocar no corpo. Content-length ausente ou
// ilegivel NAO e motivo de recusa (o teto real, nos bytes, vem logo depois);
// aqui so cortamos o upload que ja se declara grande demais.
export function corpoGrandeDemais(contentLength: unknown): boolean {
  const n = Number(contentLength ?? 0);
  return Number.isFinite(n) && n > LIMITE_MULTIPART_BYTES;
}

// --------------------------------------------------- gravacao do perfil

// Estado da leitura do perfil, do ponto de vista de QUEM VAI GRAVAR.
export type EstadoConta = { disponivel: boolean; erroLeitura: boolean };

// Mensagem de recusa, ou null quando pode gravar. Duas recusas diferentes de
// proposito — "falta migration" e problema de INSTALACAO, "nao consegui ler" e
// problema do MOMENTO, e o usuario precisa saber qual dos dois esta vendo.
// A segunda existe porque gravar preferencia mesclando sobre DEFAULT (que e o
// que sobra quando a leitura falha) religaria em silencio o que a pessoa tinha
// desligado.
export function motivoRecusaDeGravacao(conta: EstadoConta): string | null {
  if (conta.erroLeitura) {
    return "Nao consegui ler seu perfil agora, entao nao salvei nada. Tente de novo em alguns instantes.";
  }
  if (!conta.disponivel) {
    return "Preferencias de aviso indisponiveis: falta rodar a migration 0011 nesta instalacao.";
  }
  return null;
}

export type TipoImagem = { mime: string; ext: string };

// Sniff por MAGIC BYTES — o content-type do upload vem do cliente e nao vale nada.
// So passa jpeg, png e webp (o que todo navegador desenha em <img>); SVG fica de
// fora de proposito: SVG e documento com script, e o bucket e publico.
export function tipoImagem(bytes: Uint8Array | null | undefined): TipoImagem | null {
  if (!bytes || bytes.length < 12) return null;
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return { mime: "image/png", ext: "png" };
  }
  const ascii = (i: number, s: string) => s.split("").every((c, k) => b[i + k] === c.charCodeAt(0));
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return { mime: "image/webp", ext: "webp" };
  return null;
}

// Erro legivel do upload, ou null quando pode subir.
export function validarFoto(bytes: Uint8Array | null | undefined): string | null {
  if (!bytes || !bytes.length) return "Arquivo vazio.";
  if (bytes.length > LIMITE_FOTO_BYTES) return "A imagem precisa ter no maximo 2 MB.";
  if (!tipoImagem(bytes)) return "Formato nao aceito — envie JPG, PNG ou WEBP.";
  return null;
}

export const EXTENSOES_FOTO = ["jpg", "png", "webp"] as const;

// Mesmo bucket publico da foto de contato do WhatsApp (lib/foto-store.ts).
export const BUCKET_FOTOS = "fotos-perfil";

// Caminho no bucket. O bucket `fotos-perfil` ja existe (foto de CONTATO do
// WhatsApp mora em `central/<chat_id>.jpg`, lib/foto-store.ts) — a foto de
// ATENDENTE entra no prefixo `usuarios/`, sem bucket novo pra criar na mao em
// cada instalacao. Id de usuario e uuid do auth: qualquer coisa fora de
// [A-Za-z0-9-] e recusada (nunca montar caminho com entrada nao conferida).
export function caminhoFotoUsuario(userId: unknown, ext: string): string | null {
  if (typeof userId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(userId)) return null;
  if (!(EXTENSOES_FOTO as readonly string[]).includes(ext)) return null;
  return `usuarios/${userId}.${ext}`;
}

// URL publica do Storage do Supabase. O `?v=<hash>` so muda quando a IMAGEM muda
// — cache do navegador sobrevive a re-upload identico (mesma ideia da foto de
// contato). Sem base configurada, devolve null e quem chamou decide o que fazer.
export function urlPublicaFoto(base: string | undefined, bucket: string, path: string, versao: string): string | null {
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/storage/v1/object/public/${bucket}/${path}?v=${versao}`;
}
