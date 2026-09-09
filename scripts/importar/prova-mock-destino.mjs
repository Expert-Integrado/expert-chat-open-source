// Destino de MENTIRA para as provas do importador — servidor HTTP local.
//
//   node scripts/importar/prova-mock-destino.mjs <porta.txt> <requisicoes.ndjson> <roteiro.json>
//
// POR QUE ISTO E UM PROCESSO SEPARADO, e nao um `http.createServer` dentro da
// propria prova: as provas chamam a CLI com `execFileSync`, que BLOQUEIA o event
// loop do processo que chama. Um servidor no mesmo processo aceita a conexao no
// kernel e nunca responde — a CLI filha fica esperando pra sempre e a prova
// "trava" sem erro nenhum. Custou um travamento de verdade nesta sessao.
//
// O QUE ELE SERVE PRA PROVAR:
//   1. que `--dry` (e o default) NAO abre conexao — a env aponta pra ca e o
//      arquivo de requisicoes tem que terminar VAZIO;
//   2. que a pre-condicao da migration PARA de verdade — o roteiro faz o select
//      das colunas de origem responder 400 e a prova cobra que nenhum POST saia;
//   3. que atalho que JA existe no destino nao e sobrescrito — o roteiro devolve
//      a lista de atalhos globais e a prova cobra que o colidente fique fora do
//      corpo do POST;
//   4. que a biblioteca de anexos NAO reescreve o arquivo vivo — o roteiro diz
//      quem ja e dono de cada chave (`chaves`) e a prova cobra que nenhum POST de
//      Storage saia da chave ocupada por outro item.
//
// O roteiro e RELIDO a cada requisicao, entao a prova muda o cenario entre
// rodadas sem reiniciar o servidor.

import fs from "node:fs";
import http from "node:http";

const [ARQ_PORTA, ARQ_REQS, ARQ_ROTEIRO] = process.argv.slice(2);
if (!ARQ_PORTA || !ARQ_REQS || !ARQ_ROTEIRO) {
  console.error("uso: prova-mock-destino.mjs <porta.txt> <requisicoes.ndjson> <roteiro.json>");
  process.exit(2);
}

const roteiro = () => {
  try {
    return JSON.parse(fs.readFileSync(ARQ_ROTEIRO, "utf8"));
  } catch {
    return {};
  }
};

const anotar = (obj) => fs.appendFileSync(ARQ_REQS, JSON.stringify(obj) + String.fromCharCode(10));

const servidor = http.createServer((req, res) => {
  let corpo = "";
  req.on("data", (c) => {
    corpo += c;
  });
  req.on("end", () => {
    const r = roteiro();
    const [caminho, consulta = ""] = req.url.split("?");
    anotar({ metodo: req.method, caminho, consulta, corpo: corpo.slice(0, 20000) });

    const responder = (status, texto = "", extras = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...extras });
      res.end(texto);
    };

    // QUEM JA E DONO DE CADA CHAVE no painel de destino (importador de anexos,
    // `donosDasChaves`). E a leitura que decide se o objeto pode ser reescrito:
    // com ela respondendo, a prova monta o cenario do dano (chave ocupada por
    // OUTRO item) e cobra que nenhum POST de Storage saia daquela chave.
    if (req.method === "GET" && consulta.includes("select=chave,origem_ferramenta,origem_id")) {
      if (r.ler_chaves === false) return responder(500, JSON.stringify({ message: "boom" }));
      const chaves = r.chaves || [];
      // `Content-Range` e como o PostgREST declara QUANTAS linhas existem (com
      // `Prefer: count=exact`). `chaves_total` maior que a lista simula a resposta
      // CORTADA pelo db-max-rows do servidor — o 200 silencioso que fazia chave
      // ocupada ler como livre. `chaves_sem_faixa` tira o cabecalho: destino que
      // nao declara total nao prova leitura inteira.
      // e o TOTAL so aparece quando o cliente pediu a contagem, como no PostgREST
      // de verdade: sem `Prefer: count=exact` a faixa termina em `/*`.
      const pediuContagem = String(req.headers.prefer || "").includes("count=exact");
      const total = typeof r.chaves_total === "number" ? r.chaves_total : chaves.length;
      const faixa = `${chaves.length ? `0-${chaves.length - 1}` : "*"}/${pediuContagem ? total : "*"}`;
      return responder(200, JSON.stringify(chaves), r.chaves_sem_faixa ? {} : { "Content-Range": faixa });
    }
    if (req.method === "GET" && consulta.includes("select=origem_ferramenta")) {
      // pre-condicao da migration 0020
      return r.colunas_de_origem === false
        ? responder(400, JSON.stringify({ code: "42703", message: 'column "origem_ferramenta" does not exist' }))
        : responder(200, "[]");
    }
    if (req.method === "GET" && consulta.includes("select=atalho")) {
      if (r.ler_atalhos === false) return responder(500, JSON.stringify({ message: "boom" }));
      return responder(200, JSON.stringify(r.atalhos || []));
    }
    // estado ATUAL das conversas no destino (o que o importador nao pode pisar)
    if (req.method === "GET" && consulta.includes("chat_id=in.")) {
      return responder(200, JSON.stringify(r.conversas || []));
    }
    // `post_corpo` existe pro caso em que o importador decide pelo CONTEUDO do
    // erro, nao so pelo status: 23505 (nome repetido) precisa cair no reenvio
    // linha-por-linha, e qualquer outro erro precisa parar. Sem corpo nao da pra
    // distinguir os dois. Default segue vazio: nenhuma prova antiga muda.
    if (req.method === "POST") return responder(r.post_status || 201, r.post_corpo || "");
    if (req.method === "PATCH") return responder(r.patch_status || 204, "");
    return responder(200, "[]");
  });
});

servidor.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(ARQ_PORTA, String(servidor.address().port));
});
