// Prova do webhook de SAIDA por evento (lib/webhooks-saida.ts).
// Roda em Node >= 22.6 sem build: `node scripts/prova-webhooks-saida.ts`
// (type stripping nativo; `scripts/` esta fora do tsconfig por isso).
//
// SEM REDE E SEM BANCO: a mecanica de entrega e exercitada com um `fetch` de
// mentira, entao "nao segue redirect", "nao repete 4xx" e "cabecalho nao vem da
// conversa" viram teste, e nao comentario. Nenhum dado real de cliente aqui.
import assert from "node:assert/strict";
import {
  CAB_ASSINATURA,
  CAB_ENTREGA,
  CAB_EVENTO,
  EVENTOS,
  TENTATIVAS,
  VERSAO_PAYLOAD,
  assinar,
  assinaturaConfere,
  cabecalhos,
  destinosDoEvento,
  entregar,
  eventoConhecido,
  eventosDeStatus,
  ipReservado,
  montarPayload,
  statusMudou,
  urlAceita,
  validarAssinantes,
  type Assinante,
  type Payload,
} from "../lib/webhooks-saida.ts";

const META = { id: "11111111-2222-3333-4444-555555555555", em: "2026-08-31T12:00:00.000Z" };

const destino = (over: Partial<Assinante> = {}): Assinante => ({
  nome: "CRM do cliente",
  url: "https://exemplo.invalido/hook",
  eventos: ["mensagem_recebida"],
  segredo: "",
  ativo: true,
  incluir_conteudo: false,
  ...over,
});

// ============================================================ 1) URL DE DESTINO
{
  assert.equal(urlAceita("https://exemplo.invalido/hook"), true);
  assert.equal(urlAceita("https://exemplo.invalido/hook?x=1"), true);
  assert.equal(urlAceita("http://exemplo.invalido/hook"), false, "http puro nao passa: isto e saida de dados");
  assert.equal(urlAceita("ftp://exemplo.invalido/hook"), false);
  assert.equal(urlAceita("file:///etc/passwd"), false);
  assert.equal(urlAceita("javascript:alert(1)"), false);
  assert.equal(urlAceita("https://usuario:senha@exemplo.invalido/h"), false, "credencial na URL vaza em log de proxy");
  assert.equal(urlAceita("https://localhost/hook"), false, "host sem ponto nao e destino de verdade");
  assert.equal(urlAceita("nao sou url"), false);
  assert.equal(urlAceita(""), false);
  assert.equal(urlAceita(null), false);
  assert.equal(urlAceita("https://exemplo.invalido/" + "a".repeat(2100)), false, "URL absurda nao passa");

  // IP literal de rede interna: o painel nao vira ferramenta de varredura da
  // rede de quem o hospeda, nem porta pros metadados da nuvem
  assert.equal(urlAceita("https://127.0.0.1/hook"), false, "loopback");
  assert.equal(urlAceita("https://127.1.2.3:8443/hook"), false, "loopback nao e so o .0.0.1");
  assert.equal(urlAceita("https://10.0.0.5/hook"), false, "privada 10/8");
  assert.equal(urlAceita("https://192.168.1.10/hook"), false, "privada 192.168/16");
  assert.equal(urlAceita("https://172.16.0.1/hook"), false, "privada 172.16/12");
  assert.equal(urlAceita("https://172.31.255.254/hook"), false, "fim da faixa 172.16/12");
  assert.equal(urlAceita("https://169.254.169.254/latest/meta-data"), false, "metadados da nuvem");
  assert.equal(urlAceita("https://0.0.0.0/hook"), false);
  assert.equal(urlAceita("https://100.64.0.1/hook"), false, "CGNAT");
  assert.equal(urlAceita("https://255.255.255.255/hook"), false, "broadcast");
  assert.equal(urlAceita("https://[::1]/hook"), false, "IPv6 literal recusado inteiro");
  assert.equal(urlAceita("https://[::ffff:127.0.0.1]/hook"), false, "IPv4 mapeado em IPv6 nao escapa");
  // ...e IP publico de verdade segue valendo (o admin pode ter destino sem DNS)
  assert.equal(urlAceita("https://172.32.0.1/hook"), true, "172.32 ja esta FORA da faixa privada");
  assert.equal(urlAceita("https://8.8.8.8/hook"), true, "IP publico continua aceito");
  assert.equal(urlAceita("https://192.169.0.1/hook"), true, "192.169 nao e 192.168");

  assert.equal(ipReservado("10.0.0.1"), true);
  assert.equal(ipReservado("11.0.0.1"), false);
  assert.equal(ipReservado("999.1.1.1"), true, "octeto invalido nao vira destino");
  assert.equal(ipReservado("exemplo.invalido"), false, "nome nao e IP: quem decide e o DNS");
}

// ================================================ 2) NORMALIZACAO DA CONFIG
{
  assert.deepEqual(validarAssinantes(null), [], "config ausente = ninguem recebe");
  assert.deepEqual(validarAssinantes({}), [], "objeto nao e lista");
  assert.deepEqual(validarAssinantes("[]"), [], "string nao e lista");
  assert.deepEqual(validarAssinantes([null, 1, "x", []]), [], "lixo na lista some");
  assert.deepEqual(validarAssinantes([{ url: "http://inseguro.invalido/h", eventos: ["mensagem_recebida"] }]), [],
    "destino http e DESCARTADO, nao convertido");

  const l = validarAssinantes([
    {
      nome: "x".repeat(200),
      url: " https://exemplo.invalido/hook ",
      eventos: ["mensagem_recebida", "danca_do_creu", "mensagem_recebida", "avaliacao_registrada"],
      segredo: "s3gr3d0",
    },
  ]);
  assert.equal(l.length, 1);
  assert.equal(l[0].url, "https://exemplo.invalido/hook", "url e trimada");
  assert.equal(l[0].nome.length, 80, "nome tem teto");
  assert.deepEqual(l[0].eventos, ["mensagem_recebida", "avaliacao_registrada"], "evento desconhecido some e repetido deduplica");
  assert.equal(l[0].ativo, true, "ativo default = true (quem cadastrou quer receber)");
  assert.equal(l[0].incluir_conteudo, false, "PRIVACIDADE: conteudo default = false");

  // so booleano de verdade mexe nas duas flags (mesma regra de lib/modulos.ts)
  const flags = validarAssinantes([
    { url: "https://a.invalido/h", eventos: [], ativo: "false", incluir_conteudo: "true" },
    { url: "https://b.invalido/h", eventos: [], ativo: false, incluir_conteudo: true },
    { url: "https://c.invalido/h", eventos: [], incluir_conteudo: 1 },
  ]);
  assert.equal(flags[0].ativo, true, '"false" texto NAO desliga');
  assert.equal(flags[0].incluir_conteudo, false, '"true" texto NAO liga conteudo');
  assert.equal(flags[1].ativo, false);
  assert.equal(flags[1].incluir_conteudo, true);
  assert.equal(flags[2].incluir_conteudo, false, "1 nao liga conteudo");

  // teto de destinos: config gigante nao vira tempestade de requests
  const muitos = validarAssinantes(
    Array.from({ length: 50 }, (_, i) => ({ url: `https://d${i}.invalido/h`, eventos: ["mensagem_recebida"] }))
  );
  assert.equal(muitos.length, 20, "teto de 20 destinos");
}

// ==================================================== 3) QUEM RECEBE O QUE
{
  const lista = [
    destino({ nome: "A", eventos: ["mensagem_recebida", "status_alterado"] }),
    destino({ nome: "B", eventos: ["status_alterado"] }),
    destino({ nome: "C", eventos: ["status_alterado"], ativo: false }),
  ];
  assert.deepEqual(destinosDoEvento(lista, "mensagem_recebida").map((d) => d.nome), ["A"]);
  assert.deepEqual(destinosDoEvento(lista, "status_alterado").map((d) => d.nome), ["A", "B"], "destino inativo nao recebe");
  assert.deepEqual(destinosDoEvento(lista, "conversa_concluida"), [], "ninguem inscrito = ninguem chamado");

  assert.equal(eventoConhecido("mensagem_recebida"), true);
  assert.equal(eventoConhecido("mensagem_enviada"), false, "evento fora do v1 nao existe");
  assert.equal(EVENTOS.length, 4, "v1 tem 4 eventos");

  // concluir dispara DOIS eventos; qualquer outra transicao dispara um
  assert.deepEqual(eventosDeStatus("concluido"), ["status_alterado", "conversa_concluida"]);
  assert.deepEqual(eventosDeStatus("aberto"), ["status_alterado"]);
  assert.deepEqual(eventosDeStatus("atendimento"), ["status_alterado"]);
  assert.deepEqual(eventosDeStatus("aguardando"), ["status_alterado"]);

  // STATUS REAFIRMADO NAO E TRANSICAO. O caso real: a resposta da pesquisa de
  // satisfacao re-grava "concluido" numa conversa que JA estava concluida (a
  // pergunta so sai ao concluir). Sem esta guarda saia um status_alterado
  // de:null->concluido que nao houve, MAIS um segundo conversa_concluida — e o
  // CRM do cliente contava o encerramento duas vezes.
  assert.equal(statusMudou("concluido", "concluido"), false, "re-gravar o mesmo status nao e evento");
  assert.equal(statusMudou("aberto", "concluido"), true);
  assert.equal(statusMudou(null, "concluido"), true, "conversa que nao existia -> concluida e transicao");
  assert.equal(statusMudou(undefined, "aberto"), true, "sem linha no banco conta como null");
  assert.equal(statusMudou(null, "aberto"), true);
  assert.equal(statusMudou("aberto", "aberto"), false);
}

// ===================================== 4) PAYLOAD — pequeno, e sem conteudo
{
  const ev = {
    evento: "mensagem_recebida" as const,
    canal: "central",
    chat_id: "5500000000000",
    dados: { tipo: "text", de_grupo: false, tem_midia: false, provider_msg_id: "ABC123" },
    conteudo: "texto privado do cliente",
  };

  const sem = montarPayload(ev, false, META);
  assert.deepEqual(sem, {
    versao: VERSAO_PAYLOAD,
    evento: "mensagem_recebida",
    id: META.id,
    em: META.em,
    canal: "central",
    chat_id: "5500000000000",
    dados: { tipo: "text", de_grupo: false, tem_midia: false, provider_msg_id: "ABC123" },
  });
  assert.equal("conteudo" in sem.dados, false, "PRIVACIDADE: sem a flag, o texto NAO sai da instalacao");

  const com = montarPayload(ev, true, META);
  assert.equal(com.dados.conteudo, "texto privado do cliente", "com a flag, o texto sai");

  // o campo `conteudo` e a UNICA porta: enfiar texto dentro de `dados` nao burla a flag
  const contrabando = montarPayload(
    { ...ev, dados: { ...ev.dados, conteudo: "escondido em dados" } },
    false,
    META
  );
  assert.equal("conteudo" in contrabando.dados, false, "conteudo dentro de dados e removido");
  const contrabandoCom = montarPayload(
    { ...ev, dados: { ...ev.dados, conteudo: "escondido em dados" } },
    true,
    META
  );
  assert.equal(contrabandoCom.dados.conteudo, "texto privado do cliente", "vale o campo dedicado, nao o de dados");

  // texto gigante nao vira payload gigante
  const grande = montarPayload({ ...ev, conteudo: "x".repeat(9999) }, true, META);
  assert.equal(String(grande.dados.conteudo).length, 4096);

  // evento sem conteudo nenhum
  const avaliacao = montarPayload(
    { evento: "avaliacao_registrada", canal: "central", chat_id: "5500000000000", dados: { nota: 5 } },
    true,
    META
  );
  assert.deepEqual(avaliacao.dados, { nota: 5 }, "sem campo conteudo, nada e inventado");

  // o payload e serializavel e pequeno
  assert.ok(JSON.stringify(sem).length < 400, "payload v1 e pequeno");
}

// ======================================================== 5) ASSINATURA HMAC
{
  const corpo = JSON.stringify(montarPayload(
    { evento: "status_alterado", canal: "central", chat_id: "5500000000000", dados: { de: "aberto", para: "concluido" } },
    false,
    META
  ));
  const segredo = "s3gr3d0-do-destino";
  const hex = assinar(segredo, corpo);
  assert.match(hex, /^[0-9a-f]{64}$/, "sha256 em hex");
  // vetor FIXO: a formula documentada e hmac-sha256(segredo, corpo) em hex, e o
  // destino do cliente valida com ela. Mudar isso em silencio quebra integracao
  // de terceiro — por isso o valor esta cravado aqui.
  assert.equal(
    assinar("chave", "corpo"),
    "e421208dc07b8cb6a6628be93d2f12333f228020a94be20a65c42687908c8f57",
    "hmac-sha256('chave','corpo') — o mesmo que `openssl dgst -sha256 -hmac chave`"
  );
  assert.notEqual(assinar("chave", "corpo"), assinar("chave", "corpo2"), "corpo diferente, assinatura diferente");
  assert.notEqual(assinar("chave", "corpo"), assinar("chave2", "corpo"), "segredo diferente, assinatura diferente");

  assert.equal(assinaturaConfere(segredo, corpo, `sha256=${hex}`), true);
  assert.equal(assinaturaConfere(segredo, corpo, hex), false, "sem o prefixo sha256= nao confere");
  assert.equal(assinaturaConfere(segredo, corpo + " ", `sha256=${hex}`), false, "corpo alterado nao confere");
  assert.equal(assinaturaConfere("outro", corpo, `sha256=${hex}`), false);
  assert.equal(assinaturaConfere(segredo, corpo, ""), false);
  assert.equal(assinaturaConfere(segredo, corpo, "sha256=" + "0".repeat(64)), false);
}

// ============================================ 6) CABECALHOS — nada da conversa
{
  const payload = montarPayload(
    {
      evento: "mensagem_recebida",
      canal: "central",
      // valores hostis de proposito: se algo disto vazasse pra um cabecalho, seria
      // header injection a partir de conteudo de conversa
      chat_id: "5500000000000\r\nx-injetado: 1",
      dados: { tipo: "text" },
      conteudo: "\r\nx-injetado: 1",
    },
    true,
    META
  );
  const corpo = JSON.stringify(payload);

  const semSegredo = cabecalhos(destino(), payload, corpo);
  assert.deepEqual(Object.keys(semSegredo).sort(), ["content-type", CAB_ENTREGA, CAB_EVENTO, "user-agent"].sort());
  assert.equal(semSegredo[CAB_ASSINATURA], undefined, "sem segredo, sem cabecalho de assinatura");
  assert.equal(semSegredo[CAB_EVENTO], "mensagem_recebida");
  assert.equal(semSegredo[CAB_ENTREGA], META.id);

  const comSegredo = cabecalhos(destino({ segredo: "s3" }), payload, corpo);
  assert.equal(comSegredo[CAB_ASSINATURA], `sha256=${assinar("s3", corpo)}`);

  // NENHUM cabecalho carrega texto de conversa nem quebra de linha
  for (const [k, v] of Object.entries(comSegredo)) {
    assert.ok(!/[\r\n]/.test(v), `cabecalho ${k} sem quebra de linha`);
    assert.ok(!v.includes("x-injetado"), `cabecalho ${k} nao carrega conteudo de conversa`);
  }
  // o valor hostil segue existindo no CORPO (JSON escapa) — o destino que trate
  assert.ok(corpo.includes("x-injetado"), "o dado nao foi perdido: so nao virou cabecalho");
}

// ================================== 7) ENTREGA: timeout, retentativa, redirect
{
  const fetchReal = globalThis.fetch;
  type Chamada = { url: string; init: any };
  const espionar = (responder: (n: number) => Promise<Response> | Response) => {
    const chamadas: Chamada[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      chamadas.push({ url: String(url), init });
      return responder(chamadas.length);
    }) as any;
    return chamadas;
  };
  const resp = (status: number) => new Response(null, { status });
  const payload: Payload = montarPayload(
    { evento: "conversa_concluida", canal: "central", chat_id: "5500000000000", dados: { por_nome: "Fulano" } },
    false,
    META
  );

  // 7.1 sucesso: uma chamada so, POST, sem redirect, com assinatura
  {
    const c = espionar(() => resp(200));
    await entregar(destino({ segredo: "s3" }), payload);
    assert.equal(c.length, 1, "200 nao repete");
    assert.equal(c[0].url, "https://exemplo.invalido/hook");
    assert.equal(c[0].init.method, "POST");
    assert.equal(c[0].init.redirect, "manual", "NUNCA seguir redirect com corpo assinado");
    assert.equal(c[0].init.cache, "no-store");
    assert.equal(c[0].init.headers["content-type"], "application/json");
    assert.equal(c[0].init.headers[CAB_ASSINATURA], `sha256=${assinar("s3", c[0].init.body)}`,
      "a assinatura e do CORPO CRU que foi enviado");
    assert.deepEqual(JSON.parse(c[0].init.body), payload, "corpo e o JSON puro do payload");
    assert.ok(c[0].init.signal, "tem AbortSignal (timeout)");
  }

  // 7.1b O CONTENT-TYPE DA REQUISICAO REAL bate com o corpo que foi enviado.
  //
  // Esta assercao existe porque uma MUTACAO sobreviveu (verificacao de 31/08/2026):
  // apagar o 4o argumento de `cabecalhos(a, payload, corpo, contentType)` passava
  // verde nas 23 provas. O efeito no cliente seria o silencio que o card de
  // compatibilidade existe pra evitar: destino `form` recebendo o corpo urlencoded
  // rotulado `application/json` — servidor responde 200 e nao acha campo nenhum.
  // Conferir o cabecalho no RETORNO de `cabecalhos()` nao pegava isso; so a
  // requisicao capturada pega, porque e ela que vai na rede.
  {
    const c = espionar(() => resp(200));
    await entregar(
      destino({ segredo: "s4", formato: { modo: "plano", tipo_conteudo: "form", mapa: {} } }),
      payload
    );
    assert.equal(c.length, 1);
    assert.equal(
      c[0].init.headers["content-type"],
      "application/x-www-form-urlencoded;charset=UTF-8",
      "destino `form` NAO pode receber o corpo rotulado como json"
    );
    assert.equal(c[0].init.body.includes("evento=conversa_concluida"), true, "e o corpo e mesmo urlencoded");
    assert.equal(c[0].init.body.trimStart().startsWith("{"), false, "nao e JSON");
    assert.equal(
      c[0].init.headers[CAB_ASSINATURA],
      `sha256=${assinar("s4", c[0].init.body)}`,
      "a assinatura acompanha o corpo urlencoded, nao um JSON que nao foi enviado"
    );
  }

  // 7.2 redirect nao e seguido: 302 conta como resposta do destino, nao repete
  {
    const c = espionar(() => resp(302));
    await entregar(destino(), payload);
    assert.equal(c.length, 1, "3xx nao vira nova chamada nem retentativa");
  }

  // 7.3 4xx = problema do destino: nao adianta repetir
  {
    const c = espionar(() => resp(404));
    await entregar(destino(), payload);
    assert.equal(c.length, 1, "404 nao repete");
  }

  // 7.4 5xx = transitorio: exatamente 1 retentativa
  {
    const c = espionar(() => resp(500));
    await entregar(destino(), payload);
    assert.equal(c.length, TENTATIVAS, "5xx repete uma unica vez");
    assert.equal(TENTATIVAS, 2);
  }

  // 7.5 erro de rede na 1a, sucesso na 2a
  {
    const c = espionar((n) => (n === 1 ? Promise.reject(new Error("ECONNRESET")) : resp(200)));
    await entregar(destino(), payload);
    assert.equal(c.length, 2, "falha de rede cai na retentativa e para quando da certo");
  }

  // 7.6 destino que so quebra NUNCA lanca pra fora nem trava a rota
  {
    const c = espionar(() => Promise.reject(new Error("DNS")));
    await entregar(destino(), payload); // se lancasse, a prova morria aqui
    assert.equal(c.length, TENTATIVAS);
  }

  // 7.7 o CORPO da resposta e sempre descartado. A resposta do destino nao
  // interessa (isto e aviso, nao consulta), mas corpo nao lido deixa o socket
  // preso ate o GC no undici — em serverless isso vira conexao vazando a cada
  // mensagem recebida.
  {
    const vistas: Response[] = [];
    espionar(() => {
      const r = new Response("ok", { status: 200 });
      vistas.push(r);
      return r;
    });
    await entregar(destino(), payload);
    assert.equal(vistas.length, 1);
    assert.equal(vistas[0].bodyUsed, true, "corpo drenado no caminho de sucesso");
  }
  {
    const vistas: Response[] = [];
    espionar(() => {
      const r = new Response("erro do destino", { status: 503 });
      vistas.push(r);
      return r;
    });
    await entregar(destino(), payload);
    assert.equal(vistas.length, TENTATIVAS);
    assert.ok(vistas.every((r) => r.bodyUsed), "drenado tambem ANTES da retentativa, nao so no fim");
  }

  globalThis.fetch = fetchReal;
}

console.log(
  "prova-webhooks-saida: OK — so https e sem IP de rede interna, config saneada, conteudo so com opt-in, " +
    "STATUS REAFIRMADO nao vira evento, HMAC sha256 do corpo cru, cabecalho constante, e entrega com " +
    "timeout/1 retentativa/sem redirect/corpo sempre drenado"
);
