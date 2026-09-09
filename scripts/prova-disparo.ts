// Prova do modulo de DISPARO — ritmo, ciclo de vida da campanha, telefone e CSV.
// Roda em Node >= 22.6 sem build: `node scripts/prova-disparo.ts`
// (type stripping nativo; `scripts/` esta fora do tsconfig por isso).
//
// REGRA DA CASA NESTA FRENTE: nenhum disparo real. Nada aqui abre rede, nada
// aqui toca banco. A decisao de "quem sai agora" e funcao pura (lib/disparo/
// ritmo.ts) exatamente pra poder ser provada assim — a rota de tick nao decide
// nada por conta propria, so executa o que esta funcao mandar.
import assert from "node:assert/strict";
import {
  decidirEnvios, estimarDuracao, inicioDoDia, normalizarRitmo, segundosAteVirarODia,
  type ConfigRitmo,
} from "../lib/disparo/ritmo.ts";
import { aceitaTick, ESTADOS, estadoValido, horaDeComecar, podeTransicionar } from "../lib/disparo/estado.ts";
import { chaveDedupe, normalizarTelefone, type DestinoValido } from "../lib/disparo/telefone.ts";
import {
  aplicarVariaveis, detectarSeparador, lerPublicoCsv, parseCsv, TETO_MENSAGEM, variaveisSemValor,
} from "../lib/disparo/csv.ts";
import { MODULOS, MODULOS_PADRAO, validarMapaModulos } from "../lib/modulos.ts";
import {
  decidirFalha, deveInterromper, executarLote, lockDisponivel, reservaExpirada,
  type DestinoLote, type PortaLote, type ResultadoEnvioLote,
} from "../lib/disparo/lote.ts";
import { pedidoDeDescadastro } from "../lib/disparo/optout.ts";
import { isoDeLocal } from "../lib/disparo/fuso.ts";

let checagens = 0;
const teste = (oque: string, fn: () => void) => {
  fn();
  checagens++;
  console.log(`  ok  ${oque}`);
};

const RITMO: ConfigRitmo = { lote: 40, intervalo_s: 5, teto_por_numero_dia: 300 };
const AGORA = new Date("2026-08-31T15:00:00.000Z"); // 12:00 BRT

// ==================================================== 1) RITMO (o coracao)
console.log("\n1) RITMO — quem sai agora, e por que nao sai o resto");

teste("fila vazia manda ENCERRAR a campanha, nao esperar pra sempre", () => {
  const d = decidirEnvios(RITMO, { pendentes: 0, enviados_hoje_no_canal: 0, ultimo_envio_em: null }, AGORA);
  assert.equal(d.encerrar, true);
  assert.equal(d.enviar, 0);
  assert.equal(d.causa, "fila_vazia");
});

teste("primeira rodada envia o lote inteiro e avisa quanto sobrou", () => {
  const d = decidirEnvios(RITMO, { pendentes: 100, enviados_hoje_no_canal: 0, ultimo_envio_em: null }, AGORA);
  assert.equal(d.enviar, 40);
  assert.equal(d.causa, "lote");
  assert.match(d.motivo!, /restam 60/);
});

teste("publico menor que o lote sai inteiro, sem motivo pendente", () => {
  const d = decidirEnvios(RITMO, { pendentes: 7, enviados_hoje_no_canal: 0, ultimo_envio_em: null }, AGORA);
  assert.equal(d.enviar, 7);
  assert.equal(d.causa, "ok");
  assert.equal(d.motivo, null);
});

teste("INTERVALO segura o envio e diz quantos segundos faltam", () => {
  const d = decidirEnvios(
    RITMO,
    { pendentes: 100, enviados_hoje_no_canal: 0, ultimo_envio_em: new Date(AGORA.getTime() - 2000) },
    AGORA
  );
  assert.equal(d.enviar, 0);
  assert.equal(d.causa, "intervalo");
  assert.equal(d.esperar_s, 3);
});

teste("intervalo ja cumprido nao segura nada", () => {
  const d = decidirEnvios(
    RITMO,
    { pendentes: 100, enviados_hoje_no_canal: 0, ultimo_envio_em: new Date(AGORA.getTime() - 9000) },
    AGORA
  );
  assert.equal(d.enviar, 40);
});

teste("TETO DIARIO do canal zera a rodada e manda esperar o dia virar", () => {
  const d = decidirEnvios(RITMO, { pendentes: 100, enviados_hoje_no_canal: 300, ultimo_envio_em: null }, AGORA);
  assert.equal(d.enviar, 0);
  assert.equal(d.causa, "teto_diario");
  assert.match(d.motivo!, /teto diario do canal atingido \(300\/300\)/);
  // 12:00 BRT -> faltam 12h pro dia virar
  assert.equal(d.esperar_s, 12 * 3600);
});

teste("teto e checado ANTES do intervalo (as duas esperas sao respostas diferentes)", () => {
  const d = decidirEnvios(
    RITMO,
    { pendentes: 100, enviados_hoje_no_canal: 300, ultimo_envio_em: new Date(AGORA.getTime() - 1000) },
    AGORA
  );
  assert.equal(d.causa, "teto_diario", "com o chip estourado, dizer 'espera 4s' seria mentira");
});

teste("folga parcial no teto corta o lote e explica que o limite e do canal", () => {
  const d = decidirEnvios(RITMO, { pendentes: 100, enviados_hoje_no_canal: 290, ultimo_envio_em: null }, AGORA);
  assert.equal(d.enviar, 10, "so cabem 10 hoje, mesmo com lote 40 e 100 na fila");
  assert.equal(d.causa, "teto_diario");
  assert.match(d.motivo!, /folga pra 10 hoje/);
});

teste("teto conta TODAS as campanhas do canal, nao so a atual", () => {
  // 250 ja sairam hoje por outras campanhas do mesmo numero
  const d = decidirEnvios(RITMO, { pendentes: 500, enviados_hoje_no_canal: 250, ultimo_envio_em: null }, AGORA);
  assert.equal(d.enviar, 40, "lote ainda cabe na folga de 50");
  const d2 = decidirEnvios(RITMO, { pendentes: 500, enviados_hoje_no_canal: 275, ultimo_envio_em: null }, AGORA);
  assert.equal(d2.enviar, 25, "folga de 25 vence o lote de 40");
});

teste("config torta do banco e normalizada pros limites da migration 0012", () => {
  assert.deepEqual(normalizarRitmo({ lote: 9999, intervalo_s: -5, teto_por_numero_dia: 0 }), {
    lote: 200,
    intervalo_s: 0,
    teto_por_numero_dia: 1,
  });
  assert.deepEqual(normalizarRitmo(null), { lote: 40, intervalo_s: 5, teto_por_numero_dia: 300 });
  assert.deepEqual(normalizarRitmo({ lote: NaN } as any).lote, 40, "NaN cai no padrao, nunca em 0 ou Infinity");
});

teste("ultimo_envio_em invalido nao trava a campanha pra sempre", () => {
  const d = decidirEnvios(RITMO, { pendentes: 10, enviados_hoje_no_canal: 0, ultimo_envio_em: "data-torta" }, AGORA);
  assert.equal(d.enviar, 10);
});

teste("janela do teto diario e o dia da INSTALACAO, nao UTC", () => {
  // 02:00 BRT do dia 31 = 05:00 UTC; o dia BRT comecou 03:00 UTC
  const madrugada = new Date("2026-08-31T05:00:00.000Z");
  assert.equal(inicioDoDia(madrugada), "2026-08-31T03:00:00.000Z");
  // 23:00 BRT do dia 31 = 02:00 UTC do dia 1o; o dia BRT ainda e 31
  const noite = new Date("2026-09-01T02:00:00.000Z");
  assert.equal(inicioDoDia(noite), "2026-08-31T03:00:00.000Z");
  assert.equal(segundosAteVirarODia(noite), 3600);
});

// ------------------------------------------------ estimativa antes de disparar
console.log("\n1b) ESTIMATIVA — o que quem aprova ve antes de autorizar");

teste("publico que cabe no dia estima pelo intervalo", () => {
  const e = estimarDuracao(61, RITMO);
  assert.equal(e.dias, 0);
  assert.equal(e.segundos, 300);
  assert.match(e.texto, /5 minuto/);
});

teste("publico grande mostra os DIAS impostos pelo teto do chip", () => {
  const e = estimarDuracao(5000, RITMO);
  assert.equal(e.dias, Math.ceil(4700 / 300));
  assert.match(e.texto, /dia\(s\), limitado pelo teto de 300\/dia/);
});

teste("folga ja gasta hoje empurra a estimativa pra mais um dia", () => {
  const cheio = estimarDuracao(100, RITMO, 0);
  assert.ok(cheio.dias >= 1, "sem folga hoje, nada sai hoje");
});

// ============================================ 2) CICLO DE VIDA DA CAMPANHA
console.log("\n2) ESTADO — disparo em massa nao comeca sozinho");

teste("os 6 estados do card estao modelados", () => {
  assert.deepEqual([...ESTADOS], ["rascunho", "agendada", "rodando", "pausada", "concluida", "cancelada"]);
  assert.equal(estadoValido("rodando"), true);
  assert.equal(estadoValido("enviando"), false);
});

teste("GUARDRAIL: o motor NUNCA tira a campanha do rascunho", () => {
  const r = podeTransicionar("rascunho", "rodando", { autor: "motor" });
  assert.equal(r.ok, false);
  assert.match((r as any).motivo, /so uma pessoa com permissao de disparo/);
});

teste("uma pessoa com permissao tira do rascunho — e so ela", () => {
  assert.equal(podeTransicionar("rascunho", "rodando", { autor: "humano" }).ok, true);
  assert.equal(podeTransicionar("rascunho", "agendada", { autor: "humano" }).ok, true);
});

teste("o relogio so cumpre o que ja foi aprovado (agendada -> rodando)", () => {
  assert.equal(podeTransicionar("agendada", "rodando", { autor: "motor" }).ok, true);
  assert.equal(horaDeComecar("2026-08-31T14:00:00.000Z", AGORA), true);
  assert.equal(horaDeComecar("2026-08-31T16:00:00.000Z", AGORA), false);
  assert.equal(horaDeComecar(null, AGORA), false, "sem hora marcada, nunca comeca sozinha");
  assert.equal(horaDeComecar("data-torta", AGORA), false);
});

teste("pausar e retomar sao gesto humano; concluir e do motor", () => {
  assert.equal(podeTransicionar("rodando", "pausada", { autor: "humano" }).ok, true);
  assert.equal(podeTransicionar("rodando", "pausada", { autor: "motor" }).ok, false);
  assert.equal(podeTransicionar("pausada", "rodando", { autor: "humano" }).ok, true);
  assert.equal(podeTransicionar("rodando", "concluida", { autor: "motor" }).ok, true);
});

teste("cancelar vale de qualquer estado vivo; estado terminal nao volta", () => {
  for (const de of ["rascunho", "agendada", "rodando", "pausada"]) {
    assert.equal(podeTransicionar(de, "cancelada", { autor: "humano" }).ok, true, de);
  }
  assert.equal(podeTransicionar("concluida", "rodando", { autor: "humano" }).ok, false);
  assert.equal(podeTransicionar("cancelada", "rodando", { autor: "humano" }).ok, false);
});

teste("campanha PAUSADA nao volta a enviar sozinha", () => {
  assert.equal(podeTransicionar("pausada", "rodando", { autor: "motor" }).ok, false);
  assert.equal(aceitaTick("pausada"), false);
  assert.equal(aceitaTick("rodando"), true);
  assert.equal(aceitaTick("agendada"), true);
});

teste("GUARDRAIL: campanha HISTORICA importada nao dispara em nenhuma condicao", () => {
  for (const alvo of ["rodando", "agendada", "pausada"]) {
    const r = podeTransicionar("concluida", alvo, { autor: "humano", historico: true });
    assert.equal(r.ok, false, alvo);
    assert.match((r as any).motivo, /registro importado/);
  }
  // nem partindo de um estado vivo (que a migration nem deixa existir)
  assert.equal(podeTransicionar("rascunho", "rodando", { autor: "humano", historico: true }).ok, false);
});

teste("estado desconhecido e recusado com nome, nao ignorado", () => {
  const r = podeTransicionar("enviando", "rodando", { autor: "humano" });
  assert.equal(r.ok, false);
  assert.match((r as any).motivo, /desconhecido/);
});

// ==================================================== 3) TELEFONE E DEDUPE
console.log("\n3) TELEFONE — validacao dura antes de a campanha sair do rascunho");

teste("telefone com mascara vira chat_id so-digitos", () => {
  const d = normalizarTelefone("+55 (11) 91234-5678");
  assert.equal(d.ok, true);
  assert.equal((d as DestinoValido).chat_id, "5511912345678");
});

teste("recusa curto, longo, vazio e texto — cada um com motivo proprio", () => {
  assert.equal(normalizarTelefone("119123").ok, false);
  assert.match((normalizarTelefone("119123") as any).motivo, /curto/);
  assert.match((normalizarTelefone("5511912345678901234") as any).motivo, /longo/);
  assert.match((normalizarTelefone("") as any).motivo, /vazio/);
  assert.match((normalizarTelefone("sem telefone") as any).motivo, /letras/);
  assert.equal(normalizarTelefone(null).ok, false);
});

teste("grupo entra nos dois formatos e vira a chave do painel", () => {
  const a = normalizarTelefone("120363000000000000-group");
  const b = normalizarTelefone("120363000000000000@g.us");
  assert.equal((a as DestinoValido).chat_id, "120363000000000000-group");
  assert.equal((b as DestinoValido).chat_id, "120363000000000000-group");
  assert.equal((b as DestinoValido).grupo, true);
});

teste("dedupe pelos ultimos digitos une as variantes da MESMA pessoa", () => {
  const comDdi = normalizarTelefone("5511912345678") as DestinoValido;
  const semDdi = normalizarTelefone("11912345678") as DestinoValido;
  assert.equal(chaveDedupe(comDdi), chaveDedupe(semDdi), "com e sem DDI e a mesma pessoa");
  const outra = normalizarTelefone("5511999998888") as DestinoValido;
  assert.notEqual(chaveDedupe(comDdi), chaveDedupe(outra));
});

// ============================================================= 4) CSV
console.log("\n4) CSV — a planilha que a pessoa anexa");

teste("separador do Excel BR (;) e detectado sem a pessoa configurar nada", () => {
  assert.equal(detectarSeparador("telefone;nome"), ";");
  assert.equal(detectarSeparador("telefone,nome"), ",");
});

teste("aspas com separador dentro nao quebram a linha", () => {
  const l = parseCsv('telefone;nome\n5511912345678;"Silva, Joao"');
  assert.deepEqual(l[1], ["5511912345678", "Silva, Joao"]);
});

teste("BOM do Excel nao vira lixo no primeiro cabecalho", () => {
  const p = lerPublicoCsv("﻿telefone;nome\n5511912345678;Ana");
  assert.equal(p.coluna_telefone, "telefone");
  assert.equal(p.itens.length, 1);
});

teste("cabecalho e reconhecido em varios nomes e com acento", () => {
  for (const cab of ["telefone;nome", "celular;nome", "WhatsApp;Nome", "Número;Contato"]) {
    const p = lerPublicoCsv(`${cab}\n5511912345678;Ana`);
    assert.equal(p.itens.length, 1, cab);
    assert.equal(p.itens[0].nome, "Ana", cab);
  }
});

teste("sem cabecalho reconhecivel, a 1a linha ja e dado (nao some)", () => {
  const p = lerPublicoCsv("5511912345678;Ana\n5511999998888;Bruno");
  assert.equal(p.itens.length, 2);
  assert.equal(p.itens[0].nome, "Ana");
});

teste("telefone invalido NAO derruba o arquivo: vira linha rejeitada com numero", () => {
  const p = lerPublicoCsv("telefone;nome\n5511912345678;Ana\n123;Bruno\n;Carla");
  assert.equal(p.itens.length, 1);
  assert.equal(p.invalidos.length, 2);
  assert.equal(p.invalidos[0].linha, 3, "aponta a LINHA da planilha, pra pessoa achar e corrigir");
  assert.match(p.invalidos[0].motivo, /curto/);
});

teste("duplicata e contada em separado do invalido", () => {
  const p = lerPublicoCsv("telefone;nome\n5511912345678;Ana\n11912345678;Ana de novo");
  assert.equal(p.itens.length, 1, "a mesma pessoa com e sem DDI entra uma vez so");
  assert.equal(p.duplicados.length, 1);
  assert.equal(p.invalidos.length, 0, "duplicata nao e erro de formato");
});

teste("colunas extras viram variaveis da mensagem", () => {
  const p = lerPublicoCsv("telefone;nome;empresa\n5511912345678;Ana;Acme");
  assert.deepEqual(p.itens[0].variaveis, { empresa: "Acme" });
});

teste("{{variavel}} e substituida, com ou sem acento e espaco", () => {
  const item = { chat_id: "5511912345678", telefone: "5511912345678", nome: "Ana", variaveis: { empresa: "Acme" } };
  assert.equal(aplicarVariaveis("Oi {{nome}}, tudo bem?", item), "Oi Ana, tudo bem?");
  assert.equal(aplicarVariaveis("Oi {{ Nome }} da {{empresa}}", item), "Oi Ana da Acme");
});

teste("variavel sem valor vira vazio — {{nome}} cru NUNCA sai pro cliente", () => {
  const item = { chat_id: "5511912345678", telefone: "5511912345678", nome: "" };
  const saida = aplicarVariaveis("Oi {{nome}}, aqui e a equipe", item);
  assert.ok(!saida.includes("{{"), `saiu com placeholder cru: ${saida}`);
});

teste("variavel gigante da planilha e cortada (celula com texto colado inteiro)", () => {
  const item = {
    chat_id: "5511912345678",
    telefone: "5511912345678",
    nome: "Ana",
    variaveis: { obs: "x".repeat(5000) },
  };
  const saida = aplicarVariaveis("Obs: {{obs}}", item);
  assert.ok(saida.length <= TETO_MENSAGEM, `texto final passou do teto: ${saida.length}`);
  assert.ok(saida.length < 1000, "a variavel isolada tambem tem teto proprio");
});

teste("texto FINAL respeita o limite mesmo com mensagem curta e variaveis longas", () => {
  const item = {
    chat_id: "5511912345678",
    telefone: "5511912345678",
    nome: "Ana",
    variaveis: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`v${i}`, "y".repeat(500)])),
  };
  const modelo = Array.from({ length: 20 }, (_, i) => `{{v${i}}}`).join(" ");
  const saida = aplicarVariaveis(modelo, item);
  assert.ok(saida.length <= TETO_MENSAGEM, `texto final passou do teto: ${saida.length}`);
});

teste("a tela consegue AVISAR de variavel que ninguem preenche, antes de disparar", () => {
  const p = lerPublicoCsv("telefone;nome\n5511912345678;Ana");
  assert.deepEqual(variaveisSemValor("Oi {{nome}}, seu plano {{plano}} vence", p.itens), ["plano"]);
  assert.deepEqual(variaveisSemValor("Oi {{nome}}", p.itens), []);
});

// ================================================ 5) MODULO (fail-closed)
console.log("\n5) MODULO — a instalacao nasce sem disparo");

teste("`disparo` esta no registro de modulos", () => {
  assert.ok((MODULOS as readonly string[]).includes("disparo"));
});

teste("e nasce DESLIGADO na instalacao", () => {
  assert.equal(MODULOS_PADRAO.disparo, false);
});

teste("so booleano de verdade liga o modulo (string 'true' nao liga)", () => {
  assert.deepEqual(validarMapaModulos({ disparo: "true" }), {});
  assert.deepEqual(validarMapaModulos({ disparo: 1 }), {});
  assert.deepEqual(validarMapaModulos({ disparo: true }), { disparo: true });
});

// ============================== 6) O LACO DO LOTE — a corrida entre dois ticks
//
// Esta e a secao que faltava e que reprovou a entrega anterior. A "porta" abaixo
// e um banco EM MEMORIA que honra o mesmo contrato do Postgres: `reservar` faz
// check-and-set sem await no meio, exatamente como um
// `update ... where id=? and estado='pendente'` — quem chegar depois nao pega
// nada. Os dois ticks rodam concorrentes de verdade (Promise.all) e se
// intercalam nos await de envio.
//
// O que isto prova: o PROTOCOLO. O que isto NAO prova: que o Postgres honra o
// update condicional — isso e garantia do banco, nao do nosso codigo.
console.log("\n6) LOTE — reserva, corrida entre ticks, interrupcao e retry");

type LinhaFake = {
  id: string;
  chat_id: string;
  telefone: string;
  estado: string;
  tentativas: number;
  reservado_em: string | null;
};

function criarBanco(n: number) {
  const destinos: LinhaFake[] = [];
  for (let i = 1; i <= n; i++) {
    destinos.push({
      id: `d${i}`,
      chat_id: `55119000000${String(i).padStart(2, "0")}`,
      telefone: `55119000000${String(i).padStart(2, "0")}`,
      estado: "pendente",
      tentativas: 0,
      reservado_em: null,
    });
  }
  return {
    destinos,
    campanha: { estado: "rodando" },
    // quantas vezes CADA destino foi efetivamente entregue ao provedor
    envios: new Map<string, number>(),
    bloqueados: new Set<string>(),
  };
}
type BancoFake = ReturnType<typeof criarBanco>;

function criarPorta(
  banco: BancoFake,
  extra: {
    aoEnviar?: (d: DestinoLote) => ResultadoEnvioLote;
    duranteEnvio?: () => void;
  } = {}
): PortaLote {
  return {
    async estadoDaCampanha() {
      return banco.campanha.estado;
    },
    async candidatos(q) {
      return banco.destinos
        .filter((d) => d.estado === "pendente")
        .slice(0, Math.min(200, q * 2))
        .map((d) => ({ ...d })) as DestinoLote[];
    },
    async reservar(d) {
      // CHECK-AND-SET sem await no meio = o mesmo contrato do update condicional
      const linha = banco.destinos.find((x) => x.id === d.id);
      if (!linha || linha.estado !== "pendente") return null;
      linha.estado = "enviando";
      linha.reservado_em = new Date().toISOString();
      return { ...linha } as DestinoLote;
    },
    async bloqueado(d) {
      return banco.bloqueados.has(d.telefone || d.chat_id);
    },
    async marcarOptout(d) {
      const l = banco.destinos.find((x) => x.id === d.id)!;
      l.estado = "optout";
    },
    async enviar(d) {
      // ponto de intercalacao real entre os dois ticks
      await new Promise((r) => setTimeout(r, 1));
      extra.duranteEnvio?.();
      banco.envios.set(d.id, (banco.envios.get(d.id) || 0) + 1);
      return extra.aoEnviar ? extra.aoEnviar(d) : { ok: true, provider_msg_id: `p-${d.id}` };
    },
    async registrarEnvio(d) {
      const l = banco.destinos.find((x) => x.id === d.id)!;
      if (l.estado !== "enviando") return;
      l.estado = "enviado";
      l.reservado_em = null;
    },
    async registrarFalha(d, desfecho) {
      const l = banco.destinos.find((x) => x.id === d.id)!;
      if (l.estado !== "enviando") return;
      l.estado = desfecho.estado;
      l.tentativas = desfecho.tentativas;
      l.reservado_em = null;
    },
    async devolverReserva(d) {
      const l = banco.destinos.find((x) => x.id === d.id)!;
      if (l.estado !== "enviando") return;
      l.estado = "pendente";
      l.reservado_em = null;
    },
    agora: () => Date.now(),
    esperar: async (ms) => {
      await new Promise((r) => setTimeout(r, Math.min(ms, 2)));
    },
  };
}

const LOTE_PADRAO = { intervaloS: 0, orcamentoMs: 30_000 };

await (async () => {
  // ---------------------------------------------- a corrida propriamente dita
  {
    const banco = criarBanco(10);
    const [a, b] = await Promise.all([
      executarLote(criarPorta(banco), { quantidade: 10, ...LOTE_PADRAO }),
      executarLote(criarPorta(banco), { quantidade: 10, ...LOTE_PADRAO }),
    ]);

    teste("CORRIDA: dois ticks simultaneos nao enviam a mesma mensagem duas vezes", () => {
      const duplicados = [...banco.envios.entries()].filter(([, n]) => n > 1);
      assert.deepEqual(duplicados, [], `destinos entregues mais de uma vez: ${JSON.stringify(duplicados)}`);
    });

    teste("CORRIDA: cada destino sai exatamente uma vez, somando os dois ticks", () => {
      assert.equal(a.enviados + b.enviados, 10);
      assert.equal(banco.destinos.filter((d) => d.estado === "enviado").length, 10);
    });

    teste("CORRIDA: o tick que perdeu a reserva contabiliza a perda, nao envia", () => {
      assert.ok(a.perdidos + b.perdidos > 0, "com 2 ticks na mesma fila alguem tem que perder reserva");
    });

    teste("CORRIDA: nenhum destino fica preso em 'enviando'", () => {
      assert.equal(banco.destinos.filter((d) => d.estado === "enviando").length, 0);
    });
  }

  // ----------------------------------------------------- lote e teto do laco
  {
    const banco = criarBanco(10);
    const r = await executarLote(criarPorta(banco), { quantidade: 4, ...LOTE_PADRAO });
    teste("o laco respeita a quantidade decidida pelo ritmo (nao varre a fila toda)", () => {
      assert.equal(r.enviados, 4);
      assert.equal(banco.destinos.filter((d) => d.estado === "pendente").length, 6);
    });
  }

  // --------------------------------------------------------- INTERRUPCAO
  {
    const banco = criarBanco(10);
    let enviados = 0;
    const porta = criarPorta(banco, {
      duranteEnvio: () => {
        enviados++;
        if (enviados === 3) banco.campanha.estado = "pausada"; // alguem pausou na tela
      },
    });
    const r = await executarLote(porta, { quantidade: 10, ...LOTE_PADRAO });

    teste("PAUSAR interrompe o lote em curso (nao segue ate o fim)", () => {
      assert.equal(r.interrompido, true);
      assert.match(r.motivo!, /pausada/);
      assert.ok(r.enviados < 10, `enviou ${r.enviados} de 10 mesmo depois de pausada`);
    });
    teste("o que nao saiu continua PENDENTE (nada se perde na interrupcao)", () => {
      assert.equal(banco.destinos.filter((d) => d.estado === "enviando").length, 0);
      assert.ok(banco.destinos.filter((d) => d.estado === "pendente").length > 0);
    });
  }

  {
    const banco = criarBanco(10);
    let n = 0;
    const porta = criarPorta(banco, {
      duranteEnvio: () => {
        if (++n === 2) banco.campanha.estado = "cancelada";
      },
    });
    const r = await executarLote(porta, { quantidade: 10, ...LOTE_PADRAO });
    teste("CANCELAR tambem interrompe, com o motivo certo", () => {
      assert.equal(r.interrompido, true);
      assert.match(r.motivo!, /cancelada/);
    });
  }

  // ---------------------------------------------------------------- RETRY
  {
    const banco = criarBanco(1);
    const porta = criarPorta(banco, { aoEnviar: () => ({ ok: false, erro: "timeout na rede" }) });
    const r1 = await executarLote(porta, { quantidade: 1, ...LOTE_PADRAO, maxTentativas: 2 });

    teste("falha transitoria VOLTA pra fila (timeout nao custa o destino pra sempre)", () => {
      assert.equal(banco.destinos[0].estado, "pendente");
      assert.equal(banco.destinos[0].tentativas, 1);
      assert.equal(r1.falhas, 0, "ainda nao e falha definitiva");
    });

    const r2 = await executarLote(porta, { quantidade: 1, ...LOTE_PADRAO, maxTentativas: 2 });
    teste("na ultima tentativa vira falha DEFINITIVA, com o motivo", () => {
      assert.equal(banco.destinos[0].estado, "falhou");
      assert.equal(banco.destinos[0].tentativas, 2);
      assert.equal(r2.falhas, 1);
    });
  }

  {
    const banco = criarBanco(1);
    const porta = criarPorta(banco, {
      aoEnviar: () => ({ ok: false, erro: "credenciais ausentes", configuracao: true }),
    });
    const r = await executarLote(porta, { quantidade: 1, ...LOTE_PADRAO, maxTentativas: 2 });
    teste("falha de CONFIGURACAO nao fica repetindo: definitiva na primeira", () => {
      assert.equal(banco.destinos[0].estado, "falhou");
      assert.equal(banco.destinos[0].tentativas, 1);
      assert.equal(r.falhas, 1);
    });
  }

  // -------------------------------------------------------------- OPT-OUT
  {
    const banco = criarBanco(3);
    banco.bloqueados.add(banco.destinos[1].telefone);
    const r = await executarLote(criarPorta(banco), { quantidade: 3, ...LOTE_PADRAO });
    teste("quem esta na lista de bloqueio NAO recebe, mesmo ja estando no publico", () => {
      assert.equal(r.bloqueados, 1);
      assert.equal(r.enviados, 2);
      assert.equal(banco.destinos[1].estado, "optout");
      assert.equal(banco.envios.has(banco.destinos[1].id), false, "nem chegou a chamar o envio");
    });
  }

  // ------------------------------------------------------------ ORCAMENTO
  {
    const banco = criarBanco(10);
    const r = await executarLote(criarPorta(banco), { quantidade: 10, intervaloS: 0, orcamentoMs: -1 });
    teste("orcamento estourado para a rodada e deixa o resto pendente", () => {
      assert.equal(r.enviados, 0);
      assert.match(r.motivo!, /orcamento/);
      assert.equal(banco.destinos.every((d) => d.estado === "pendente"), true);
    });
  }
})();

// ---------------------------------------------------- puros do lote
teste("reserva sem carimbo ou vencida volta pra fila; reserva fresca nao", () => {
  const agora = Date.now();
  assert.equal(reservaExpirada(null, agora), true, "reserva sem carimbo e reserva podre");
  assert.equal(reservaExpirada(new Date(agora - 6 * 60 * 1000), agora), true);
  assert.equal(reservaExpirada(new Date(agora - 10 * 1000), agora), false);
  assert.equal(reservaExpirada("data-torta", agora), true);
});

teste("lock do tick expira sozinho (tick morto nao trava a campanha pra sempre)", () => {
  const agora = Date.now();
  assert.equal(lockDisponivel(null, agora), true);
  assert.equal(lockDisponivel(new Date(agora - 5 * 1000), agora), false, "lock fresco de outro tick segura");
  assert.equal(lockDisponivel(new Date(agora - 5 * 60 * 1000), agora), true, "lock velho e tomado");
});

teste("decidirFalha: conta tentativa e so desiste no teto", () => {
  assert.deepEqual(decidirFalha(0, "erro", { max: 3 }), {
    estado: "pendente",
    tentativas: 1,
    erro: "erro",
    definitivo: false,
  });
  const fim = decidirFalha(2, "erro", { max: 3 });
  assert.equal(fim.estado, "falhou");
  assert.equal(fim.definitivo, true);
  assert.match(fim.erro, /desistiu apos 3/);
});

teste("deveInterromper reconhece cada saida de 'rodando'", () => {
  assert.equal(deveInterromper("rodando").parar, false);
  for (const e of ["pausada", "cancelada", "concluida", "rascunho"]) {
    assert.equal(deveInterromper(e).parar, true, e);
  }
});

// ========================================== 7) DESCADASTRO (parte pura)
console.log("\n7) OPT-OUT — reconhecer quem pediu pra sair, sem descadastrar por engano");

// TABELA DO REVISOR (achado ALTO, 31/08/2026). Um falso positivo aqui bloqueia a
// pessoa global, permanente e silenciosamente — por isso cada frase e um caso.
teste("gatilho de uma palavra descadastra (igualdade exata, com ou sem pontuacao)", () => {
  for (const p of ["PARE", "sair", "Stop", "cancelar", "descadastrar", "  PARE!  ", "unsubscribe"]) {
    assert.ok(pedidoDeDescadastro(p), `deveria reconhecer "${p}"`);
  }
});

teste("NAO bloqueia resposta comercial comum — as 6 que a versao anterior bloqueava", () => {
  const comerciais = [
    "cancela minha consulta de sexta",
    "pare de brincadeira, adorei!",
    "sair as 18h ta bom?",
    "remover o item do pedido, por favor",
    "parar tudo e me liga",
    "cancelar a reuniao de amanha",
  ];
  for (const f of comerciais) {
    assert.equal(pedidoDeDescadastro(f), null, `bloqueou errado: "${f}"`);
  }
});

teste("DESCADASTRO REAL bloqueia — inclusive a frase mais comum, que antes escapava", () => {
  const reais = [
    "nao quero mais receber essas mensagens",
    "nao quero receber mais nada de voces",
    "pare de mandar mensagem",
    "pare de me enviar mensagens",
    "sair da lista",
    "me tira da lista por favor",
    "cancelar inscricao",
    "nao envie mais",
    "sem interesse",
    "me descadastra",
  ];
  for (const f of reais) {
    assert.ok(pedidoDeDescadastro(f), `deixou passar descadastro real: "${f}"`);
  }
});

teste("verbo SOZINHO nunca basta: precisa do objeto de canal", () => {
  // o mesmo verbo, com e sem objeto de canal — e o que separa os dois grupos
  assert.equal(pedidoDeDescadastro("pare de brincadeira"), null);
  assert.ok(pedidoDeDescadastro("pare de mandar mensagem"));
  assert.equal(pedidoDeDescadastro("cancela o almoco"), null);
  assert.ok(pedidoDeDescadastro("cancela a inscricao"));
});

teste("NEGACAO nao descadastra — o caso que um includes cru erraria", () => {
  assert.equal(pedidoDeDescadastro("nao pare de me mandar novidades"), null);
  assert.equal(pedidoDeDescadastro("nunca cancele meu plano"), null);
  assert.equal(pedidoDeDescadastro("nao pare de mandar mensagem"), null, "verbo+objeto nao vence a negacao");
});

teste("frase longa que so menciona a palavra nao descadastra ninguem", () => {
  assert.equal(
    pedidoDeDescadastro("oi, gostaria de saber se posso cancelar a consulta de quinta e remarcar"),
    null
  );
  assert.equal(
    pedidoDeDescadastro("bom dia, o pedido chegou certo mas quero remover um item e trocar por outro maior"),
    null
  );
});

teste("mensagem comum nao descadastra", () => {
  for (const p of ["oi", "quero saber o preco", "obrigado!", ""]) {
    assert.equal(pedidoDeDescadastro(p), null, p);
  }
  assert.equal(pedidoDeDescadastro(null), null);
});

// ============================================ 8) AGENDAMENTO E FUSO
console.log("\n8) AGENDAMENTO — sem fuso cravado, e recusando data invalida");

teste("texto COM offset e respeitado como veio", () => {
  assert.equal(isoDeLocal("2026-09-01T12:00:00Z"), "2026-09-01T12:00:00.000Z");
  assert.equal(isoDeLocal("2026-09-01T09:00:00-03:00"), "2026-09-01T12:00:00.000Z");
});

teste("texto SEM offset e lido no fuso da instalacao (nao em UTC nem em BRT cravado)", () => {
  assert.equal(isoDeLocal("2026-09-01T09:00", "America/Sao_Paulo"), "2026-09-01T12:00:00.000Z");
  assert.equal(isoDeLocal("2026-09-01T09:00", "UTC"), "2026-09-01T09:00:00.000Z");
  assert.equal(isoDeLocal("2026-09-01T09:00", "Europe/Lisbon"), "2026-09-01T08:00:00.000Z");
});

teste("data invalida devolve null (a rota vira 400 com mensagem, nao 1970)", () => {
  for (const t of ["", "amanha", "01/09/2026", "2026-13-01T10:00", "2026-02-31T10:00", "2026-09-01T99:00"]) {
    assert.equal(isoDeLocal(t), null, t);
  }
  assert.equal(isoDeLocal(null), null);
});

teste("o dia da instalacao e o dia DELA (a janela do teto acompanha o fuso)", () => {
  // 02:00 em Sao Paulo = 05:00Z; o dia local comecou as 03:00Z
  assert.equal(inicioDoDia(new Date("2026-08-31T05:00:00Z"), "America/Sao_Paulo"), "2026-08-31T03:00:00.000Z");
  // o mesmo instante em UTC ja e outro dia
  assert.equal(inicioDoDia(new Date("2026-08-31T05:00:00Z"), "UTC"), "2026-08-31T00:00:00.000Z");
});

console.log(`\nTUDO OK — ${checagens} checagens, nenhum envio real (nenhuma rede tocada).`);
