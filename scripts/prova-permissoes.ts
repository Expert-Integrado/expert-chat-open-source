// Prova das permissoes e da visibilidade — SEM banco e SEM navegador.
// Roda em Node >= 22.6 sem build: `node scripts/prova-permissoes.ts`
// (type stripping nativo; os `import type` sao apagados, nao precisa do alias @/).
//
// Cobre duas coisas que nao podem regredir:
//  A) NAO-REGRESSAO de conversaVisivel — a peca mais critica de seguranca do
//     painel. A matriz aqui e o contrato: super admin ve tudo; escopo proprias
//     so ve as suas; escopo departamento ve as do departamento; ACL fixa (F9)
//     restringe mesmo quem tem escopo "todas"; conversa de canal em fonte
//     externa (que chega sempre como status "aberto") segue a regra normal.
//  B) O modelo NOVO de papel nomeado, com a invariante que manda em tudo:
//     instalacao SEM papel nomeado se comporta EXATAMENTE como antes.

import assert from "node:assert/strict";

import {
  conversaVisivel,
  type ContextoVisao,
  type Responsavel,
  type VisibilidadeEntry,
  type PerfilVisao,
} from "../lib/visibilidade.ts";
import {
  PERMISSOES,
  PAPEIS_EMBUTIDOS,
  PAPEIS_SUGERIDOS,
  DESCRICAO_PERMISSAO,
  ehPermissao,
  bloqueiaApagarPapel,
  bloqueiaDelegacao,
  bloqueiaTrocaDePapelBase,
  editaPropriaAutorizacao,
  escopoComTeto,
  permissoesEfetivas,
  permissaoDoNivel,
  pode,
  PERM_POR_NIVEL_CANAL,
  validarPermissoes,
  validarExcecoes,
  validarEscopo,
  type Permissao,
} from "../lib/permissoes.ts";

// ————————————————————————————————— helpers
const EU = { id: "u-eu", email: "eu@x", nome: "Eu" };
const ctx = (meusDeps: string[] = [], colegas: string[] = []): ContextoVisao => ({
  meusDeps: new Set(meusDeps),
  colegas: new Set(colegas),
});
const perf = (
  escopo: PerfilVisao["escopo_visao"],
  papel: PerfilVisao["papel"] = "normal"
): PerfilVisao => ({ papel, escopo_visao: escopo });
const resp = (...rs: Array<[Responsavel["tipo"], string]>): Responsavel[] =>
  rs.map(([tipo, ref_id]) => ({ tipo, ref_id }));

let assercoes = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  assercoes++;
  assert.equal(a, b, msg);
};

// ============================================================ 1) SUPER ADMIN
// 1.1 super admin ve TUDO, em qualquer combinacao — inclusive contra ACL fixa
{
  const p = perf("proprias", "super_admin");
  eq(conversaVisivel([], EU, p, ctx()), true, "super admin ve conversa sem responsavel");
  eq(
    conversaVisivel(resp(["usuario", "outro"]), EU, p, ctx()),
    true,
    "super admin ve conversa de outro atendente"
  );
  eq(
    conversaVisivel(
      resp(["usuario", "outro"]),
      EU,
      p,
      ctx(),
      "aberto",
      [{ tipo: "usuario", ref_id: "terceiro" }] as VisibilidadeEntry[],
      []
    ),
    true,
    "super admin passa por cima da ACL fixa (F9)"
  );
}

// ============================================================ 2) ESCOPO "todas"
{
  const p = perf("todas");
  eq(conversaVisivel(resp(["usuario", "outro"]), EU, p, ctx()), true, "escopo todas ve a de outro");
  eq(conversaVisivel([], EU, p, ctx()), true, "escopo todas ve a sem responsavel");
}

// ============================================================ 3) ESCOPO "proprias"
{
  const p = perf("proprias");
  eq(
    conversaVisivel(resp(["usuario", EU.id]), EU, p, ctx()),
    true,
    "proprias: ve a que e dela"
  );
  eq(
    conversaVisivel(resp(["usuario", "outro"]), EU, p, ctx()),
    false,
    "proprias: NAO ve a de outro atendente"
  );
  eq(
    conversaVisivel(resp(["departamento", "d1"]), EU, p, ctx(["d1"])),
    false,
    "proprias: NAO ve a do proprio departamento (so as suas mesmo)"
  );
  eq(
    conversaVisivel(resp(["usuario", "outro"], ["usuario", EU.id]), EU, p, ctx()),
    true,
    "proprias: basta UM responsavel casar"
  );
  // pool: conversa sem dono e conversa encerrada sao de todo mundo (Eric, 16/08)
  eq(conversaVisivel([], EU, p, ctx()), true, "proprias: conversa SEM responsavel e pool");
  eq(
    conversaVisivel(resp(["usuario", "outro"]), EU, p, ctx(), "concluido"),
    true,
    "proprias: conversa CONCLUIDA e pool (quem responder assume)"
  );
}

// ============================================================ 4) ESCOPO "departamento"
{
  const p = perf("departamento");
  eq(
    conversaVisivel(resp(["departamento", "d1"]), EU, p, ctx(["d1"])),
    true,
    "departamento: ve a delegada ao meu departamento"
  );
  eq(
    conversaVisivel(resp(["departamento", "d9"]), EU, p, ctx(["d1"])),
    false,
    "departamento: NAO ve a de departamento que nao e meu"
  );
  eq(
    conversaVisivel(resp(["usuario", "colega"]), EU, p, ctx(["d1"], ["colega"])),
    true,
    "departamento: ve a de colega que divide departamento comigo"
  );
  eq(
    conversaVisivel(resp(["usuario", "estranho"]), EU, p, ctx(["d1"], ["colega"])),
    false,
    "departamento: NAO ve a de quem nao divide departamento"
  );
  eq(
    conversaVisivel(resp(["usuario", EU.id]), EU, p, ctx(["d1"])),
    true,
    "departamento: ve a que e dela mesma"
  );
  eq(
    conversaVisivel(resp(["departamento", "d2"]), EU, p, ctx(["d1", "d2"])),
    true,
    "departamento: pessoa em VARIOS deps casa por qualquer um"
  );
}

// ============================================================ 5) ACL FIXA (F9)
// Trava DURA do cadastro: vale ate contra escopo "todas".
{
  const todas = perf("todas");
  const acl = (...es: VisibilidadeEntry[]) => es;

  eq(
    conversaVisivel(resp(["usuario", "outro"]), EU, todas, ctx(), "aberto", acl({ tipo: "usuario", ref_id: "terceiro" }), []),
    false,
    "F9: ACL fixa restringe MESMO com escopo todas"
  );
  eq(
    conversaVisivel([], EU, todas, ctx(), "aberto", acl({ tipo: "usuario", ref_id: EU.id }), []),
    true,
    "F9: eu na lista, eu vejo"
  );
  eq(
    conversaVisivel([], EU, todas, ctx(["d1"]), "aberto", acl({ tipo: "departamento", ref_id: "d1" }), []),
    true,
    "F9: meu departamento na lista, eu vejo"
  );
  eq(
    conversaVisivel([], EU, todas, ctx(["d1"]), "aberto", acl({ tipo: "departamento", ref_id: "d9" }), []),
    false,
    "F9: departamento alheio na lista, eu nao vejo"
  );
  // o responsavel atual SEMPRE ve — senao a pessoa nao consegue atender o que e dela
  eq(
    conversaVisivel(resp(["usuario", EU.id]), EU, todas, ctx(), "aberto", acl({ tipo: "usuario", ref_id: "terceiro" }), []),
    true,
    "F9: responsavel atual ve mesmo fora da ACL"
  );
  // entrada de BU (contexto): vinculo null = usuario irrestrito, ve
  eq(
    conversaVisivel([], EU, todas, ctx(), "aberto", acl({ tipo: "contexto", ref_id: "bu-a" }), null),
    true,
    "F9: usuario SEM vinculo de BU e irrestrito e ve a entrada de contexto"
  );
  eq(
    conversaVisivel([], EU, todas, ctx(), "aberto", acl({ tipo: "contexto", ref_id: "bu-a" }), ["bu-a"]),
    true,
    "F9: usuario vinculado a BU da entrada ve"
  );
  eq(
    conversaVisivel([], EU, todas, ctx(), "aberto", acl({ tipo: "contexto", ref_id: "bu-a" }), ["bu-b"]),
    false,
    "F9: usuario vinculado a OUTRA BU nao ve"
  );
  // ACL vazia nao restringe nada (semantica: lista vazia = todo mundo)
  eq(
    conversaVisivel(resp(["usuario", "outro"]), EU, todas, ctx(), "aberto", [], []),
    true,
    "F9: ACL vazia nao restringe"
  );
  // e a ACL nao PROMOVE: passar pela ACL ainda exige passar pelo escopo
  eq(
    conversaVisivel(resp(["usuario", "outro"]), EU, perf("proprias"), ctx(), "aberto", acl({ tipo: "usuario", ref_id: EU.id }), []),
    false,
    "F9: estar na ACL nao da acesso que o escopo nega"
  );
}

// ============================================================ 6) CANAL EM FONTE EXTERNA
// Canal somente-leitura (instagram-agent) nao tem linha de conversa no painel:
// podeVerConversa injeta status "aberto" e o resto da regra vale igual. Aqui a
// prova de que "aberto" NAO ganha o passe livre que "concluido" tem.
{
  const p = perf("proprias");
  eq(
    conversaVisivel(resp(["usuario", "outro"]), EU, p, ctx(), "aberto"),
    false,
    "fonte externa: status aberto NAO vira pool — conversa de outro segue invisivel"
  );
  eq(
    conversaVisivel(resp(["usuario", EU.id]), EU, p, ctx(), "aberto"),
    true,
    "fonte externa: a minha conversa segue visivel"
  );
  eq(
    conversaVisivel([], EU, p, ctx(), "aberto"),
    true,
    "fonte externa: sem responsavel segue pool"
  );
  eq(
    conversaVisivel(resp(["usuario", "outro"]), EU, p, ctx(), null),
    false,
    "status null (canal sem linha) se comporta como aberto"
  );
}

// ============================================================ 7) LISTA CANONICA
{
  eq(new Set(PERMISSOES).size, PERMISSOES.length, "lista de permissoes sem repetida");
  for (const p of PERMISSOES) {
    assercoes++;
    assert.ok(DESCRICAO_PERMISSAO[p], `permissao "${p}" precisa de verbete em DESCRICAO_PERMISSAO`);
  }
  eq(
    Object.keys(DESCRICAO_PERMISSAO).length,
    PERMISSOES.length,
    "nao existe verbete de permissao que nao existe"
  );
  eq(PAPEIS_EMBUTIDOS.super_admin.length, PERMISSOES.length, "super admin embutido tem tudo");
  // papel sugerido nao pode citar permissao inventada
  for (const s of PAPEIS_SUGERIDOS) {
    eq(
      validarPermissoes(s.permissoes).length,
      s.permissoes.length,
      `papel sugerido "${s.nome}" so cita permissao canonica`
    );
  }
  eq(PAPEIS_SUGERIDOS.find((p) => p.nome === "Somente leitura")!.permissoes.length, 0,
    "Somente leitura nao age em nada");
}

// ============================================================ 8) SANEAMENTO
{
  eq(validarPermissoes(["enviar", "voar", "enviar"]).join(","), "enviar", "lista: ignora inventada e dedupe");
  eq(validarPermissoes({ enviar: true, concluir: false, voar: true }).join(","), "enviar",
    "mapa: so o que e true, e so o que existe");
  eq(validarPermissoes(null).length, 0, "null vira lista vazia");
  eq(validarPermissoes("enviar").length, 0, "string solta nao e lista de permissao");
  eq(validarPermissoes(["disparo", "enviar"]).join(","), "enviar,disparo",
    "saida sai na ordem canonica, nao na ordem digitada");

  eq(JSON.stringify(validarExcecoes({ relatorios: true, voar: true, enviar: "sim" })),
    '{"relatorios":true}', "excecao: so booleano de permissao canonica");
  eq(JSON.stringify(validarExcecoes({ enviar: false })), '{"enviar":false}', "excecao pode REVOGAR");
  eq(JSON.stringify(validarExcecoes(["enviar"])), "{}", "excecao nao aceita lista");

  eq(validarEscopo("departamento"), "departamento", "escopo valido passa");
  eq(validarEscopo("chefe"), "todas", "escopo invalido cai no default de sempre");
}

// ============================================================ 9) COMPATIBILIDADE
// A invariante que manda em tudo: SEM papel nomeado, nada muda.
{
  const semPapel = (escopo: "proprias" | "departamento" | "todas") =>
    permissoesEfetivas({ papel: "normal", escopo_visao: escopo });

  for (const escopo of ["proprias", "departamento", "todas"] as const) {
    const p = semPapel(escopo);
    eq(pode(p, "enviar"), true, `sem papel (${escopo}): atendente segue podendo enviar`);
    eq(pode(p, "concluir"), true, `sem papel (${escopo}): segue podendo concluir`);
    eq(pode(p, "disparo"), true, `sem papel (${escopo}): segue podendo agendar`);
    // tudo que era gateado por ehAdmin segue negado pro atendente — a tabela
    // abaixo e o contrato de "a troca nas rotas e no-op", permissao a permissao
    for (const soDeAdmin of [
      "relatorios",
      "gerenciar_usuarios",
      "gerenciar_etiquetas",
      "gerenciar_visibilidade",
      "gerenciar_canais",
      "automacao",
      "aprovar_automacao",
    ] as const) {
      eq(pode(p, soDeAdmin), false, `sem papel (${escopo}): "${soDeAdmin}" segue sendo so de admin`);
    }
    // e o escopo NAO e tocado por permissao nenhuma
    eq(escopoComTeto(escopo, p, false), escopo, `sem papel (${escopo}): escopo intacto`);
  }
  // ver_todas_conversas e DERIVADA do escopo no caminho legado — nunca o contrario
  eq(pode(semPapel("todas"), "ver_todas_conversas"), true, "sem papel + escopo todas => tem a mestra");
  eq(pode(semPapel("departamento"), "ver_todas_conversas"), false, "sem papel + escopo dep => nao tem a mestra");

  const admin = permissoesEfetivas({ papel: "super_admin", escopo_visao: "proprias" });
  eq(admin.size, PERMISSOES.length, "super admin tem todas as permissoes");
  eq(pode(admin, "gerenciar_usuarios"), true, "super admin administra usuario");
}

// ============================================================ 10) PAPEL NOMEADO
{
  const supervisor = PAPEIS_SUGERIDOS.find((p) => p.nome === "Supervisor")!.permissoes;
  const atendente = PAPEIS_SUGERIDOS.find((p) => p.nome === "Atendente")!.permissoes;

  const pSup = permissoesEfetivas({
    papel: "normal",
    escopo_visao: "todas",
    papelPermissoes: supervisor,
  });
  eq(pode(pSup, "relatorios"), true, "Supervisor le relatorio");
  eq(pode(pSup, "ver_todas_conversas"), true, "Supervisor enxerga a conta inteira");
  eq(pode(pSup, "gerenciar_usuarios"), false, "Supervisor NAO mexe no cadastro");
  eq(escopoComTeto("todas", pSup, true), "todas", "Supervisor mantem escopo todas");

  const pAt = permissoesEfetivas({
    papel: "normal",
    escopo_visao: "todas",
    papelPermissoes: atendente,
  });
  eq(pode(pAt, "enviar"), true, "Atendente envia");
  eq(pode(pAt, "relatorios"), false, "Atendente nao le relatorio");

  // `iniciar_conversa` (Frente O, 31/08/2026) — a permissao que separa RESPONDER
  // quem procurou a empresa de ABORDAR quem nao procurou. As duas convivem, e o
  // ponto todo dela e poder ter uma sem a outra.
  eq(pode(pAt, "iniciar_conversa"), true, "Atendente pode abordar numero novo");
  eq(pode(pSup, "iniciar_conversa"), true, "Supervisor tambem");
  {
    const soLeitura = PAPEIS_SUGERIDOS.find((p) => p.nome === "Somente leitura")!.permissoes;
    const pRo = permissoesEfetivas({
      papel: "normal",
      escopo_visao: "todas",
      papelPermissoes: soLeitura,
    });
    eq(pode(pRo, "iniciar_conversa"), false, "Somente leitura NAO abre conversa");
    eq(pode(pRo, "enviar"), false, "nem envia");
  }
  {
    // O CASO QUE JUSTIFICA A PERMISSAO EXISTIR: papel que responde mas nao
    // aborda. Se `iniciar_conversa` fosse derivada de `enviar`, isto seria
    // impossivel de configurar.
    const soResponde = permissoesEfetivas({
      papel: "normal",
      escopo_visao: "todas",
      papelPermissoes: ["enviar", "concluir"],
    });
    eq(pode(soResponde, "enviar"), true, "papel 'so responde' envia");
    eq(pode(soResponde, "iniciar_conversa"), false, "e NAO aborda numero frio");
  }
  {
    // COMPATIBILIDADE: quem NAO tem papel nomeado nao pode perder o botao no dia
    // do deploy — o fallback embutido tem a permissao, em paridade com `enviar`.
    const pSemPapel = permissoesEfetivas({ papel: "normal", escopo_visao: "todas" });
    eq(pode(pSemPapel, "iniciar_conversa"), true, "atendente SEM papel nomeado mantem o botao");
    eq(
      pode(permissoesEfetivas({ papel: "super_admin", escopo_visao: "todas" }), "iniciar_conversa"),
      true,
      "super admin tem"
    );
  }
  // TETO: papel sem a mestra REBAIXA escopo "todas" pra departamento
  eq(
    escopoComTeto("todas", pAt, true),
    "departamento",
    "papel sem ver_todas_conversas rebaixa escopo todas -> departamento"
  );
  eq(escopoComTeto("proprias", pAt, true), "proprias", "teto nunca AFROUXA escopo mais restrito");
  eq(escopoComTeto("departamento", pAt, true), "departamento", "teto e idempotente em departamento");

  // papel apagado/desativado = fail-closed (lista vazia, nao volta pro embutido)
  const pZero = permissoesEfetivas({ papel: "normal", escopo_visao: "todas", papelPermissoes: [] });
  eq(pZero.size, 0, "papel desativado deixa a pessoa sem permissao nenhuma (fail-closed)");
  eq(pode(pZero, "enviar"), false, "papel desativado nao envia");
  eq(escopoComTeto("todas", pZero, true), "departamento", "papel desativado tambem perde a visao total");

  // permissao desconhecida gravada no banco nao quebra nem vaza
  const pSujo = permissoesEfetivas({
    papel: "normal",
    escopo_visao: "todas",
    papelPermissoes: ["enviar", "virar_dono_da_empresa"],
  });
  eq(pSujo.size, 1, "permissao inventada no banco e ignorada");
  eq(pode(pSujo, "enviar"), true, "e a valida ao lado dela continua valendo");
}

// ================================= 10b) APROVAR AUTOMACAO (Frente P, 31/08/2026)
//
// Permissao PROPRIA, separada de `automacao` de proposito: quem ESCREVE o fluxo nao
// e necessariamente quem responde pelo que ele manda pro cliente. Ela governa so
// `aprovar`/`recusar` da fila (POST /api/fluxo-fila); enfileirar e cancelar pedem
// `enviar`, e a LISTAGEM da fila aceita qualquer uma das duas.
{
  const supervisor = PAPEIS_SUGERIDOS.find((p) => p.nome === "Supervisor")!.permissoes;
  const admin = PAPEIS_SUGERIDOS.find((p) => p.nome === "Administrador")!.permissoes;
  const atendente = PAPEIS_SUGERIDOS.find((p) => p.nome === "Atendente")!.permissoes;
  const efetivas = (lista: readonly string[]) =>
    permissoesEfetivas({ papel: "normal", escopo_visao: "todas", papelPermissoes: lista as any });

  eq(PERMISSOES.includes("aprovar_automacao" as any), true, "a permissao existe no catalogo");
  eq(
    typeof DESCRICAO_PERMISSAO["aprovar_automacao"],
    "string",
    "permissao sem verbete nao existe: a tabela de descricao E a documentacao"
  );

  eq(pode(efetivas(admin), "aprovar_automacao"), true, "Administrador aprova automacao");
  eq(pode(efetivas(supervisor), "aprovar_automacao"), true, "Supervisor aprova automacao (e quem confere o que sai)");
  eq(pode(efetivas(atendente), "aprovar_automacao"), false, "Atendente NAO aprova o que existe pra ser conferido");

  // as duas permissoes sao INDEPENDENTES nos dois sentidos — e e isso que permite
  // "supervisor aprova mas nao edita fluxo" e "quem configura nao libera envio"
  eq(
    pode(efetivas(["aprovar_automacao"]), "automacao"),
    false,
    "aprovar nao da o editor de fluxos de brinde"
  );
  eq(
    pode(efetivas(["automacao"]), "aprovar_automacao"),
    false,
    "configurar automacao nao da o direito de aprovar"
  );

  // super admin tem tudo (a contagem geral ja cobre, esta linha e o caso explicito)
  eq(
    pode(permissoesEfetivas({ papel: "super_admin", escopo_visao: "proprias" }), "aprovar_automacao"),
    true,
    "super admin aprova"
  );

  // PAPEL EMBUTIDO (sem papel nomeado) NAO ganha a permissao: instalacao antiga
  // nao passa a aprovar automacao sozinha por causa de um deploy
  eq(
    pode(permissoesEfetivas({ papel: "normal", escopo_visao: "todas" }), "aprovar_automacao"),
    false,
    "caminho legado sem papel nomeado nao ganha permissao nova de graca"
  );

  // excecao individual segue valendo pra ela (e o escape sem criar papel novo)
  eq(
    pode(
      permissoesEfetivas({
        papel: "normal",
        escopo_visao: "departamento",
        papelPermissoes: atendente,
        excecoes: { aprovar_automacao: true },
      }),
      "aprovar_automacao"
    ),
    true,
    "excecao individual pode conceder a aprovacao a um atendente especifico"
  );
}

// ============================================================ 11) EXCECAO INDIVIDUAL
{
  const atendente = PAPEIS_SUGERIDOS.find((p) => p.nome === "Atendente")!.permissoes;

  const concede = permissoesEfetivas({
    papel: "normal",
    escopo_visao: "departamento",
    papelPermissoes: atendente,
    excecoes: { relatorios: true },
  });
  eq(pode(concede, "relatorios"), true, "excecao CONCEDE permissao fora do papel");
  eq(pode(concede, "enviar"), true, "excecao nao mexe no resto do papel");

  const revoga = permissoesEfetivas({
    papel: "normal",
    escopo_visao: "departamento",
    papelPermissoes: atendente,
    excecoes: { enviar: false },
  });
  eq(pode(revoga, "enviar"), false, "excecao REVOGA permissao do papel");
  eq(pode(revoga, "concluir"), true, "revogar uma nao derruba as outras");

  // excecao tambem vale pra quem esta no fallback embutido
  const legado = permissoesEfetivas({
    papel: "normal",
    escopo_visao: "todas",
    excecoes: { relatorios: true },
  });
  eq(pode(legado, "relatorios"), true, "excecao funciona sem papel nomeado");

  // excecao concedendo a mestra levanta o teto
  const mestra = permissoesEfetivas({
    papel: "normal",
    escopo_visao: "todas",
    papelPermissoes: atendente,
    excecoes: { ver_todas_conversas: true },
  });
  eq(escopoComTeto("todas", mestra, true), "todas", "excecao da mestra devolve a visao total");

  // super admin nao e rebaixavel por excecao (senao da pra se trancar pra fora)
  const admin = permissoesEfetivas({
    papel: "super_admin",
    escopo_visao: "todas",
    excecoes: { gerenciar_usuarios: false },
  });
  eq(pode(admin, "gerenciar_usuarios"), true, "excecao NAO rebaixa super admin");

  // fail-closed geral: permissao que ninguem citou e negada
  const nada = permissoesEfetivas({ papel: "normal", escopo_visao: "proprias", papelPermissoes: [] });
  for (const p of PERMISSOES) {
    eq(pode(nada, p as Permissao), false, `fail-closed: "${p}" ausente = negado`);
  }
}

// ============================================================ 12) ESCALADA DE PRIVILEGIO
// Revisao cega de 31/08 REPROVOU a 1a versao por dois furos: `gerenciar_usuarios`
// cunhava super admin, e virava admin total por tres portas (editar qualquer
// papel, excecao sobre si mesmo, auto-atribuir Administrador). Cada furo vira
// assercao aqui. As funcoes exercitadas sao AS MESMAS que as rotas chamam.
{
  const admin = PAPEIS_SUGERIDOS.find((p) => p.nome === "Administrador")!.permissoes;
  const supervisor = PAPEIS_SUGERIDOS.find((p) => p.nome === "Supervisor")!.permissoes;

  // Ator: um "gerente de usuarios" — tem gerenciar_usuarios e mais nada de peso.
  const gerente = permissoesEfetivas({
    papel: "normal",
    escopo_visao: "departamento",
    papelPermissoes: ["enviar", "concluir", "gerenciar_usuarios"],
  });
  const superAdmin = permissoesEfetivas({ papel: "super_admin", escopo_visao: "todas" });

  // FURO 1 — cunhar super admin
  eq(
    bloqueiaTrocaDePapelBase(false, "super_admin"),
    true,
    "ESCALADA: gerenciar_usuarios NAO cunha super admin"
  );
  eq(
    bloqueiaTrocaDePapelBase(false, "normal"),
    true,
    "ESCALADA: nem rebaixa — papel base inteiro e privativo do super admin"
  );
  eq(bloqueiaTrocaDePapelBase(false, undefined), false, "quem nao mexe em papel base passa");
  eq(bloqueiaTrocaDePapelBase(true, "super_admin"), false, "super admin segue cunhando super admin");

  // FURO 2a — auto-atribuir um papel Administrador
  eq(
    bloqueiaDelegacao(false, gerente, admin).length > 0,
    true,
    "ESCALADA: gerente nao atribui papel Administrador (nem a si, nem a terceiro)"
  );
  eq(
    bloqueiaDelegacao(false, gerente, admin).includes("gerenciar_visibilidade"),
    true,
    "o veto nomeia a permissao que excede, pra mensagem de erro ser util"
  );
  // FURO 2b — excecao individual sobre si mesmo
  eq(
    editaPropriaAutorizacao({ atorEhAdmin: false, atorId: "a", alvoId: "a", mexeEmAutorizacao: true }),
    true,
    "ESCALADA: ninguem edita a propria autorizacao"
  );
  eq(
    editaPropriaAutorizacao({ atorEhAdmin: false, atorId: "a", alvoId: "b", mexeEmAutorizacao: true }),
    false,
    "editar a autorizacao de OUTRO segue permitido (com teto)"
  );
  eq(
    editaPropriaAutorizacao({ atorEhAdmin: false, atorId: "a", alvoId: "a", mexeEmAutorizacao: false }),
    false,
    "mexer no proprio nome/assinatura nao e mexer em autorizacao"
  );
  eq(
    editaPropriaAutorizacao({ atorEhAdmin: true, atorId: "a", alvoId: "a", mexeEmAutorizacao: true }),
    false,
    "super admin conserta a propria conta"
  );
  // FURO 2c — editar um papel mais poderoso que o proprio
  eq(
    bloqueiaDelegacao(false, gerente, supervisor).length > 0,
    true,
    "ESCALADA: gerente nao edita papel com ver_todas_conversas/relatorios"
  );

  // FURO 2d — apagar papel (3a revisao). Apagar NAO e revogar: o teto por
  // permissoes do papel nao torna isso seguro, entao apagar e so do super admin.
  eq(bloqueiaApagarPapel(false), true, "ESCALADA: gerente com gerenciar_usuarios NAO apaga papel");
  eq(
    bloqueiaApagarPapel(false),
    true,
    "ESCALADA: nem o papel VAZIO ('Somente leitura'), cujas permissoes cabem em qualquer teto"
  );
  eq(
    bloqueiaDelegacao(false, gerente, []).length,
    0,
    "prova de que o teto sozinho NAO barrava: papel vazio passa no teto — por isso o gate de apagar e separado"
  );
  eq(bloqueiaApagarPapel(true), false, "super admin apaga papel");

  // Reenviar o MESMO papel base nao e troca — trava nao pode virar paralisia
  eq(
    bloqueiaTrocaDePapelBase(false, "normal", "normal"),
    false,
    "reenvio do papel ja gravado passa (o formulario salva o registro inteiro)"
  );
  eq(
    bloqueiaTrocaDePapelBase(false, "super_admin", "normal"),
    true,
    "mas promover de verdade segue barrado"
  );
  eq(
    bloqueiaTrocaDePapelBase(false, "normal", "super_admin"),
    true,
    "e rebaixar de verdade tambem"
  );

  // O que CONTINUA funcionando — teto nao pode virar paralisia
  eq(
    bloqueiaDelegacao(false, gerente, ["enviar", "concluir"]).length,
    0,
    "gerente delega o que ele proprio tem"
  );
  eq(
    bloqueiaDelegacao(false, gerente, []).length,
    0,
    "papel vazio (Somente leitura) e delegavel por qualquer um"
  );
  eq(bloqueiaDelegacao(true, superAdmin, admin).length, 0, "super admin nao tem teto");
  eq(
    bloqueiaDelegacao(true, new Set<Permissao>(), PERMISSOES).length,
    0,
    "isencao do super admin nao depende do conjunto que ele carrega"
  );
  // revogar nunca e escalada: o teto so olha o que e CONCEDIDO
  eq(
    bloqueiaDelegacao(false, gerente, [] as Permissao[]).length,
    0,
    "revogacao pura nao passa pelo teto (nada e concedido)"
  );
}

// ============================================================ 13) FAIL-CLOSED DO CATALOGO
// Terceiro furo da revisao: papel_id SETADO com catalogo ilegivel caia no
// embutido `normal` e devolvia enviar/concluir/disparo a um "Somente leitura".
// Aqui a prova do formato: permissoes vazias E temPapelNomeado=true, que e como
// getPerfil passa a tratar o caso (o escopo vai pra "proprias" na rota).
{
  const degradado = permissoesEfetivas({
    papel: "normal",
    escopo_visao: "todas",
    papelPermissoes: [], // catalogo ilegivel -> fail-closed, NUNCA null
  });
  for (const p of PERMISSOES) {
    eq(pode(degradado, p as Permissao), false, `catalogo ilegivel: "${p}" negado`);
  }
  eq(
    escopoComTeto("todas", degradado, true),
    "departamento",
    "catalogo ilegivel nunca deixa o escopo em 'todas'"
  );
  // ALCANCE do fail-closed: zera o que vem do PAPEL. Excecao individual e
  // concessao explicita gravada na pessoa, nao depende do catalogo, e segue
  // valendo — comportamento deliberado, nao brecha.
  const degradadoComExcecao = permissoesEfetivas({
    papel: "normal",
    escopo_visao: "todas",
    papelPermissoes: [],
    excecoes: { relatorios: true },
  });
  eq(
    pode(degradadoComExcecao, "relatorios"),
    true,
    "catalogo ilegivel: excecao individual explicita sobrevive"
  );
  eq(
    pode(degradadoComExcecao, "enviar"),
    false,
    "...mas nada mais volta junto — o papel segue zerado"
  );
  // e o contraste que prova que o furo era real: se caisse no embutido...
  const seCaisseNoEmbutido = permissoesEfetivas({ papel: "normal", escopo_visao: "todas" });
  eq(
    pode(seCaisseNoEmbutido, "enviar"),
    true,
    "...o embutido daria 'enviar' — por isso catalogo ilegivel NAO pode cair nele"
  );
  eq(
    escopoComTeto("todas", seCaisseNoEmbutido, false),
    "todas",
    "...e devolveria a visao total; o fail-closed e o que impede isso"
  );
}


// ==================== 14) RESTRICAO POR FUNIL/CANAL — NAO-REGRESSAO (Frente Q)
// `conversaVisivel` ganhou um 8o parametro em 31/08 (restricao por funil e por
// canal, card 86ak85zm4). A regra da casa manda atualizar esta matriz junto —
// e o que ela cobra aqui e a UNICA coisa que esta prova precisa saber sobre a
// feature nova: **parametro ausente tem que se comportar exatamente como
// antes**. A matriz completa da restricao (fail-closed, funil, canal, ordem das
// camadas) vive em `scripts/prova-seguranca-conta.ts`.
{
  // os 3 casos-chave da matriz acima, agora tambem com o parametro EXPLICITO
  // como null/vazio: se algum dia o default virar "restringe", isto quebra.
  const combos: Array<[string, boolean, Parameters<typeof conversaVisivel>[7]]> = [
    ["ausente", true, undefined],
    ["null", true, null],
    ["par com restricao null", true, { restricao: null, alvo: null }],
    ["par com restricao vazia", true, { restricao: { canais: [], funis: [], sem_funil: false }, alvo: null }],
  ];
  for (const [nome, esperado, restr] of combos) {
    eq(
      conversaVisivel(resp(["usuario", EU.id]), EU, perf("proprias"), ctx(), "aberto", null, null, restr),
      esperado,
      `restricao ${nome}: escopo proprias segue vendo a propria conversa`
    );
    eq(
      conversaVisivel([], EU, perf("todas"), ctx(), "aberto", null, null, restr),
      esperado,
      `restricao ${nome}: escopo todas segue vendo conversa sem responsavel`
    );
  }
  // e a contraprova de que o parametro FUNCIONA quando vem preenchido de verdade
  eq(
    conversaVisivel([], EU, perf("todas"), ctx(), "aberto", null, null, {
      restricao: { canais: ["central"], funis: [], sem_funil: false },
      alvo: { canal: "apioficial", funilIds: [] },
    }),
    false,
    "restricao preenchida NEGA canal fora da lista, mesmo com escopo todas"
  );
}

// ═══════════ 15) `conectar_numero` — a metade que MEXE no numero (Frente U)
//
// A revisao cega apontou que `gerenciar_canais` sozinha era grossa demais: a mesma
// caixa que deixa um supervisor VER o estado do numero deixava ele DESCONECTAR o
// numero da empresa (derruba o atendimento inteiro na hora) e TROCAR o chip (para
// a operacao ate alguem aparecer com um aparelho na mao). A divisao e a mesma de
// `relatorios` x `relatorios_exportar`: ler e diagnostico, agir e consequencia.
{
  eq(ehPermissao("conectar_numero"), true, "a permissao existe no catalogo");
  eq(
    !!DESCRICAO_PERMISSAO.conectar_numero,
    true,
    "e tem verbete — permissao sem verbete nao existe (regra do proprio arquivo)"
  );
  assert.match(DESCRICAO_PERMISSAO.conectar_numero, /QR|desconectar|chip/i);
  assercoes++;
  // a frase que evita o chamado "marquei o papel e nao ganhei a permissao"
  assert.match(DESCRICAO_PERMISSAO.conectar_numero, /papel nomeado criado ANTES/i);
  assercoes++;
  // e o verbete de `gerenciar_canais` foi corrigido: ele PROMETIA operar
  assert.match(DESCRICAO_PERMISSAO.gerenciar_canais, /nao conecta|LEITURA/i);
  assercoes++;

  // ——— A MATRIZ: quem tem o que, nos papeis semeados e no fallback embutido.
  const doPapel = (nome: string) =>
    PAPEIS_SUGERIDOS.find((x) => x.nome === nome)!.permissoes as readonly string[];

  eq(doPapel("Administrador").includes("conectar_numero"), true, "Administrador mexe no numero");
  eq(doPapel("Supervisor").includes("conectar_numero"), false, "Supervisor NAO mexe no numero (decisao explicita)");
  eq(doPapel("Supervisor").includes("gerenciar_canais"), false, "e tambem nao administra canal, como sempre foi");
  eq(doPapel("Atendente").includes("conectar_numero"), false, "Atendente nao mexe no numero");
  eq(doPapel("Somente leitura").includes("conectar_numero"), false, "Somente leitura nao mexe em nada");
  eq(
    PAPEIS_SUGERIDOS.filter((x) => (x.permissoes as readonly string[]).includes("conectar_numero")).length,
    1,
    "dos papeis semeados, SO UM tem `conectar_numero` — e o Administrador"
  );

  // fallback embutido (instalacao sem papel nomeado: tem que se comportar como antes)
  eq(
    (PAPEIS_EMBUTIDOS.super_admin as readonly string[]).includes("conectar_numero"),
    true,
    "super admin tem, pelo fallback embutido (ele podia tudo antes desta feature)"
  );
  eq(
    (PAPEIS_EMBUTIDOS.normal as readonly string[]).includes("conectar_numero"),
    false,
    "e `normal` nao tem — atendimento nao mexia em canal antes, e nao passa a mexer agora"
  );
  eq(
    (PAPEIS_EMBUTIDOS.normal as readonly string[]).includes("gerenciar_canais"),
    false,
    "nem a metade de leitura"
  );

  // ——— as duas sao INDEPENDENTES: uma nao arrasta a outra
  const soLer = permissoesEfetivas({
    papel: "normal",
    escopo_visao: "todas",
    papelPermissoes: ["gerenciar_canais"],
    excecoes: {},
  });
  eq(soLer.has("gerenciar_canais"), true, "papel com so a leitura ve os numeros...");
  eq(soLer.has("conectar_numero"), false, "...e NAO mexe neles");

  const soOperar = permissoesEfetivas({
    papel: "normal",
    escopo_visao: "todas",
    papelPermissoes: ["conectar_numero"],
    excecoes: {},
  });
  eq(soOperar.has("conectar_numero"), true, "e o contrario tambem vale: quem opera nao precisa herdar a leitura");
  eq(
    soOperar.has("gerenciar_canais"),
    false,
    "porque permissao aqui nunca e implicada por outra (implicacao escondida e o que faz ninguem saber o que um papel pode)"
  );

  // ——— saneamento: instalacao velha nao ganha a permissao sozinha
  assert.deepEqual(
    validarPermissoes(["enviar", "gerenciar_canais"]),
    ["enviar", "gerenciar_canais"],
    "papel gravado ANTES desta feature nao ganha `conectar_numero` no saneamento"
  );
  assercoes++;

  // ———————————————————————————————————————————————————————————————————————
  // A POLITICA DA PORTA, medida como COMPORTAMENTO (achado D2 da 2a revisao).
  //
  // Ate aqui a divisao ler/operar estava provada so por grep de frase, e a revisao
  // mediu o preco: a mutacao que aponta `operar` de volta pra `gerenciar_canais` —
  // ou seja, que DESFAZ a correcao inteira em producao, devolvendo a quem so pode
  // VER o poder de DESCONECTAR o numero da empresa — passava a bateria verde.
  //
  // O mapa mora em lib/permissoes.ts, e nao em lib/canais-porta.ts, exatamente por
  // isso: nenhuma prova consegue carregar a porta (especificador `next/server` sem
  // extensao e alias `@/` — nao o modulo `next/server`, que carrega em node puro).
  eq(permissaoDoNivel("ler"), "gerenciar_canais", "nivel `ler` exige gerenciar_canais");
  eq(permissaoDoNivel("operar"), "conectar_numero", "nivel `operar` exige conectar_numero");
  eq(
    permissaoDoNivel("ler") !== permissaoDoNivel("operar"),
    true,
    "OS DOIS NIVEIS SAO PERMISSOES DIFERENTES — e este e o invariante: apontar os dois pra mesma caixa desfaz a correcao"
  );
  eq(ehPermissao(permissaoDoNivel("ler")), true, "e as duas existem no catalogo (nao e string solta)");
  eq(ehPermissao(permissaoDoNivel("operar")), true, "...as duas");
  assert.deepEqual(
    Object.keys(PERM_POR_NIVEL_CANAL).sort(),
    ["ler", "operar"],
    "os niveis sao exatamente dois: nao existe meio-termo silencioso"
  );
  assercoes++;

  // ——— e o efeito PRATICO, ponta a ponta, no papel que a divisao EXISTE pra
  // separar: quem tem a caixa de administrar canais e NADA mais. Antes da divisao,
  // esse papel desconectava o numero da empresa. E o mesmo caminho que a porta
  // percorre (`permissoesEfetivas` + `permissaoDoNivel`), entao mexer em qualquer
  // um dos dois lados morde aqui.
  //
  // (Os papeis SEMEADOS ja estao medidos acima: dos quatro, so o Administrador tem
  // `conectar_numero`, e o Supervisor nao tem nenhuma das duas.)
  const soAdministraCanal = permissoesEfetivas({
    papel: "normal",
    papelPermissoes: ["gerenciar_canais"],
  });
  eq(
    soAdministraCanal.has(permissaoDoNivel("ler")),
    true,
    "quem tem `gerenciar_canais` passa no nivel `ler` (ver estado do numero e diagnostico)"
  );
  eq(
    soAdministraCanal.has(permissaoDoNivel("operar")),
    false,
    "...e NAO passa no nivel `operar` — desconectar derruba o atendimento inteiro na hora"
  );

  const admin = permissoesEfetivas({
    papel: "normal",
    papelPermissoes: doPapel("Administrador"),
  });
  eq(admin.has(permissaoDoNivel("ler")), true, "Administrador passa nos dois niveis: le...");
  eq(admin.has(permissaoDoNivel("operar")), true, "...e opera");
}

// ═══════════ 16) `gerenciar_campos` — CONSTRUIR a ficha x PREENCHER a ficha
//
// Frente X (card 86ak85nxn). Antes desta frente, mexer nos campos da ficha morava
// dentro de `gerenciar_etiquetas`, e a caixa prometia duas coisas de tamanhos
// diferentes: por um lado, poer e tirar rotulo; por outro, MEXER NO CAMPO, que
// alcanca o valor gravado em todas as conversas da conta (arquivar tira o campo do
// formulario da instalacao inteira, renomear move o valor de milhares de fichas,
// remover apaga o cadastro). A divisao e a mesma de `relatorios` x
// `relatorios_exportar` e de `gerenciar_canais` x `conectar_numero`.
//
// A OUTRA metade da separacao — PREENCHER valor nao exige permissao nomeada, o
// gate e a CONVERSA — nao da pra medir aqui (as rotas importam `next/server` e
// nenhuma prova as carrega). Ela e medida por FORMA em `scripts/prova-campos.ts`,
// no bloco que compara o gate das duas rotas.
{
  eq(ehPermissao("gerenciar_campos"), true, "a permissao existe no catalogo");
  eq(
    !!DESCRICAO_PERMISSAO.gerenciar_campos,
    true,
    "e tem verbete — permissao sem verbete nao existe (regra do proprio arquivo)"
  );
  assert.match(DESCRICAO_PERMISSAO.gerenciar_campos, /tipar|obrigatorio|reordenar/i);
  assercoes++;
  // a frase que evita o chamado "marquei o papel e nao ganhei a permissao"
  assert.match(DESCRICAO_PERMISSAO.gerenciar_campos, /papel nomeado criado ANTES/i);
  assercoes++;
  // e o verbete tem que DIZER que preencher nao passa por aqui: sem essa linha, a
  // primeira instalacao que criar um papel de atendente vai deixar de fora uma
  // caixa que ela acha necessaria pra digitar o CNPJ do cliente
  assert.match(DESCRICAO_PERMISSAO.gerenciar_campos, /PREENCHER/);
  assercoes++;
  // o verbete de `gerenciar_etiquetas` foi corrigido: ele PROMETIA o construtor
  assert.match(DESCRICAO_PERMISSAO.gerenciar_etiquetas, /gerenciar_campos/);
  assercoes++;

  // ——— A MATRIZ dos papeis semeados
  const doPapel16 = (nome: string) =>
    PAPEIS_SUGERIDOS.find((x) => x.nome === nome)!.permissoes as readonly string[];

  eq(doPapel16("Administrador").includes("gerenciar_campos"), true, "Administrador constroi a ficha");
  eq(
    doPapel16("Supervisor").includes("gerenciar_campos"),
    false,
    "Supervisor NAO constroi a ficha (decisao explicita — e ele nao perde nada: preencher nao exige permissao)"
  );
  eq(doPapel16("Atendente").includes("gerenciar_campos"), false, "Atendente preenche, nao constroi");
  eq(doPapel16("Somente leitura").includes("gerenciar_campos"), false, "Somente leitura nao mexe em nada");
  eq(
    PAPEIS_SUGERIDOS.filter((x) => (x.permissoes as readonly string[]).includes("gerenciar_campos")).length,
    1,
    "dos papeis semeados, SO UM constroi a ficha — e o Administrador"
  );

  // ——— fallback embutido: instalacao SEM papel nomeado se comporta como antes
  eq(
    (PAPEIS_EMBUTIDOS.super_admin as readonly string[]).includes("gerenciar_campos"),
    true,
    "super admin tem, pelo fallback embutido (ehAdmin liberava /api/admin/ficha-config antes desta feature)"
  );
  eq(
    (PAPEIS_EMBUTIDOS.normal as readonly string[]).includes("gerenciar_campos"),
    false,
    "e `normal` NAO tem — atendimento nunca mexeu no cadastro da ficha, e nao passa a mexer agora"
  );

  // ——— A INVARIANTE DA SEPARACAO, e ela e o coracao deste bloco: quem tinha a
  // caixa antiga (`gerenciar_etiquetas`) NAO herda a nova. Se a permissao fosse
  // "arrastada" por conveniencia, todo papel de supervisor de etiqueta que existe
  // hoje em producao ganharia, no dia do deploy, o poder de arquivar campo da conta
  // inteira — exatamente a escalada silenciosa que a divisao existe pra impedir.
  const soEtiquetas = permissoesEfetivas({
    papel: "normal",
    escopo_visao: "todas",
    papelPermissoes: ["gerenciar_etiquetas"],
    excecoes: {},
  });
  eq(soEtiquetas.has("gerenciar_etiquetas"), true, "papel antigo continua administrando etiqueta...");
  eq(soEtiquetas.has("gerenciar_campos"), false, "...e NAO ganha o construtor da ficha de brinde");

  const soCampos = permissoesEfetivas({
    papel: "normal",
    escopo_visao: "todas",
    papelPermissoes: ["gerenciar_campos"],
    excecoes: {},
  });
  eq(soCampos.has("gerenciar_campos"), true, "e o contrario tambem vale: quem constroi a ficha...");
  eq(soCampos.has("gerenciar_etiquetas"), false, "...nao precisa herdar o catalogo de etiquetas");
  eq(soCampos.has("enviar"), false, "nem virar atendente por causa disso");

  // ——— e a permissao aparece UMA vez no catalogo (duplicata passaria batido em
  // `ehPermissao` e faria a tela de papeis desenhar a mesma caixa duas vezes)
  eq(
    PERMISSOES.filter((p) => p === "gerenciar_campos").length,
    1,
    "uma entrada so no catalogo"
  );
}

console.log(`prova-permissoes: 16 blocos, ${assercoes} assercoes OK`);
