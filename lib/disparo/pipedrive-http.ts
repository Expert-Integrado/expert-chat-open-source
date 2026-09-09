// A PORTA de rede do publico-por-Pipedrive: token, timeout e status HTTP.
//
// Separado de `lib/disparo/pipedrive.ts` (que decide e nao importa nada) pelo
// mesmo motivo de `fila.ts` x `fila-db.ts` e `funis.ts` x `funis-db.ts`: a
// decisao fica provavel em node solto, e a fiacao — a unica parte que precisa de
// credencial e de rede — fica isolada num arquivo curto.
//
// O TOKEN NUNCA SAI DAQUI. Ele entra na query string da chamada (e o que a API
// v1 aceita) e nao aparece em retorno, em mensagem de erro nem em log: mensagem
// de erro de rota vai pra tela do admin, e URL com `api_token=` na tela e
// segredo vazado. Por isso `mensagemDeFalha` monta o texto SEM a URL.
//
// SO GET. Montar publico e leitura; nao existe caminho de escrita no CRM neste
// repo, e a prova reprova se um verbo de escrita aparecer em qualquer um dos dois
// arquivos.
//
// ESPERA_NAO_AUTOMATICA (registrado na revisao cega de 31/08/2026): ao receber 429
// esta porta LE o cabecalho Retry-After e FALHA com o tempo na mensagem — ela nao
// dorme e nao retenta. Em coleta de ate 40 paginas dentro do request que CRIA a
// campanha, backoff automatico so troca um erro claro por um timeout de 300s, e
// deixaria a pessoa olhando a tela sem saber que o CRM esta limitando. O ramo e
// fail-closed (a campanha NAO nasce), entao falhar cedo e o lado seguro. Se um dia
// a coleta virar job de fundo, backoff passa a fazer sentido — e ai muda AQUI.

import {
  ErroPipedrive,
  esperaDoLimite,
  TIMEOUT_MS,
  basePipedrive,
  credencialPipedrive,
  type PortaPipedrive,
} from "@/lib/disparo/pipedrive";

/**
 * Porta de verdade. `null` quando a instalacao nao tem credencial — quem chama
 * trata isso como "a fonte nao existe aqui", nunca como falha.
 */
export function portaPipedrive(): PortaPipedrive | null {
  const token = credencialPipedrive();
  if (!token) return null;
  const base = basePipedrive();

  return async (caminho: string) => {
    const sep = caminho.includes("?") ? "&" : "?";
    const url = `${base}${caminho}${sep}api_token=${encodeURIComponent(token)}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let r: Response;
    try {
      r = await fetch(url, { signal: ctrl.signal, cache: "no-store", redirect: "manual" });
    } catch (e) {
      const abortou = (e as Error)?.name === "AbortError";
      throw new ErroPipedrive(
        abortou ? "o Pipedrive nao respondeu no tempo limite" : "falha de rede ao falar com o Pipedrive"
      );
    } finally {
      clearTimeout(timer);
    }

    if (!r.ok) {
      // `Retry-After` LIDO ANTES de drenar/descartar a resposta: e a unica pista de
      // QUANTO esperar, e sem ela a mensagem manda a pessoa adivinhar. Leitura de
      // cabecalho, nao retentativa: ver o comentario de ESPERA_NAO_AUTOMATICA.
      const retryApos = r.headers.get("retry-after");
      // corpo drenado mesmo no caminho de erro: corpo nao lido segura o socket
      // ate o GC no undici, e em serverless isso vira conexao vazando por
      // consulta (a licao que a frente F pagou nos webhooks de saida)
      await r.body?.cancel().catch(() => {});
      // 401/403 e credencial; o resto e do outro lado. Nunca ecoar a URL.
      if (r.status === 401 || r.status === 403) {
        throw new ErroPipedrive("o Pipedrive recusou a credencial desta instalacao");
      }
      if (r.status === 429) {
        throw new ErroPipedrive(esperaDoLimite(retryApos));
      }
      throw new ErroPipedrive(`o Pipedrive respondeu ${r.status}`);
    }

    const corpo = await r.json().catch(() => null);
    // `null` aqui nao e erro de rede: e resposta que nao e JSON. Quem decide
    // (respostaOk) trata como fail-closed.
    return corpo;
  };
}
