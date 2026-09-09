import { NextRequest, NextResponse } from "next/server";
import { getUser, usuarioPorSessao } from "@/lib/auth-server";
import { getPerfil, permitido, ehAdmin } from "@/lib/perfil";
import { getConfig } from "@/lib/config";
import {
  chaveDeAnexo,
  chaveJaValida,
  decidirExclusao,
  decidirPatch,
  descricaoDeAnexo,
  etiquetasDeAnexo,
  etiquetasEmUso,
  filtrarAnexos,
  LIMITE_BYTES,
  nomeDeAnexo,
  porPaginaValido,
  POR_PAGINA_MAX,
  POR_PAGINA_MIN,
  resumoDoImpacto,
  tipoDeEnvio,
  validarArquivo,
} from "@/lib/anexos";
import {
  anexoPorChave,
  anexoPorId,
  apagarAnexo,
  atualizarAnexo,
  criarAnexo,
  listarAnexos,
  registrarEventoAnexo,
  subirAnexo,
  trilhaDoAnexo,
  usoDeAnexosPorFluxo,
  varrerFluxos,
  type Autor,
  type LinhaAnexo,
} from "@/lib/anexos-db";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
// upload atravessa esta rota (o corpo e bufferizado antes de subir pro Storage),
// como na foto de perfil — 25 MB num link ruim nao cabe no default
export const maxDuration = 60;

// BIBLIOTECA DE ANEXOS REUTILIZAVEIS (Frente W, card 86ak85bmw)
//
//   GET     lista + busca + filtro por etiqueta (paginado, tamanho configuravel)
//           ?id=<uuid>        um item
//           ?trilha=<uuid>    a trilha daquele item (quem subiu/descreveu/apagou)
//   POST    sobe arquivo novo   (multipart)      -> permissao `anexos_enviar`
//   PATCH   descreve / etiqueta (json)           -> `anexos_descrever` / `anexos_etiquetar`
//   DELETE  apaga                                -> `anexos_apagar` + confirmacao
//
// AS QUATRO PERMISSOES SAO SEPARADAS porque a origem tem quatro caixas dedicadas
// — sinal de que este acervo e gerido por MAIS DE UMA PESSOA, nao pasta pessoal.
// Quem faz a separacao valer e `decidirPatch` (lib/anexos.ts, PURA): um pedido
// `{descricao, etiquetas}` de quem so pode etiquetar e RECUSADO INTEIRO, nunca
// gravado pela metade.
//
// LER A BIBLIOTECA NAO EXIGE PERMISSAO NOVA, e isso e decisao: quem atende usa o
// acervo (e o catalogo de etiquetas e as respostas rapidas seguem a mesma regra
// neste painel). O que as quatro permissoes governam e ADMINISTRAR o acervo.
// ANEXAR numa conversa exige `enviar` + o gate da conversa, e mora na sub-rota
// `/api/anexos/conversa`.
//
// ESTA ROTA NAO ENVIA NADA. O anexo chega ao cliente por `/api/send`, que tem a
// permissao, o gate de conversa, a janela de 24h, a trava anti-disparo-frio e a
// trilha. Rota de biblioteca que envia vira segunda porta de envio sem as travas
// da primeira — o mesmo motivo pelo qual o editor de fluxos nao executa fluxo.
//
// ELA TAMBEM NAO FALA DE CANAL: a biblioteca e da INSTALACAO, nao de um numero.
// Por isso ela NAO entra em `CANAL_PADRAO_EM` (lib/escopo-chave.ts) — declarar
// canal padrao pra rota que nao le canal do pedido criaria negacao falsa pra uma
// chave de API restrita a um numero, defeito ja medido duas vezes neste repo.

const semCache = { "Cache-Control": "no-store, max-age=0" } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function autorDe(user: { id: string; nome: string }): Autor {
  return { id: user.id, nome: user.nome };
}

/** Recorte publico de uma linha. `origem` viaja porque item importado nao se reimporta de graca. */
function paraTela(linha: LinhaAnexo, usos?: Record<string, number> | null) {
  return {
    id: linha.id,
    chave: linha.chave,
    nome: linha.nome,
    descricao: linha.descricao ?? "",
    etiquetas: linha.etiquetas ?? [],
    arquivo_nome: linha.arquivo_nome,
    mime: linha.mime,
    bytes: linha.bytes ?? null,
    url: linha.url,
    tipo_envio: tipoDeEnvio(linha.mime),
    ultimo_uso_em: linha.ultimo_uso_em ?? null,
    // POR QUE ESTES DOIS NOMES SAEM SEM GATE, e a trilha nao.
    //
    // Sao coisas diferentes, e a diferenca e declarada de proposito: aqui e o
    // AUTOR ATUAL do item ("quem subiu isso", "quem mexeu por ultimo") — dado
    // operacional que qualquer atendente precisa pra saber com quem falar sobre o
    // material. A trilha (`?trilha=`) e o HISTORICO de acoes por pessoa, que e
    // material de auditoria; por isso ela exige `anexos_apagar` (quem pode apagar
    // e quem responde pelo acervo). Alargar o gate desta listagem esconderia o
    // autor sem proteger nada — a trilha continuaria sendo a superficie sensivel.
    criado_por: linha.criado_por_nome ?? null,
    criada_em: linha.criada_em,
    atualizada_em: linha.atualizada_em,
    atualizado_por: linha.atualizado_por_nome ?? null,
    origem: linha.origem_ferramenta
      ? { ferramenta: linha.origem_ferramenta, id_original: linha.origem_id ?? null }
      : null,
    // "usado em N fluxos" — undefined quando a varredura nao pode ser feita
    // (modulo de automacao nunca ligado, 0008 pendente). undefined e "nao sei",
    // e 0 e "nenhum": a tela nao pode transformar um no outro.
    usado_em_fluxos: usos ? usos[linha.chave] ?? 0 : undefined,
  };
}

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const q = req.nextUrl.searchParams;
  const perfil = await getPerfil(user.id);
  const permissoes = {
    enviar: permitido(perfil, "anexos_enviar"),
    apagar: permitido(perfil, "anexos_apagar"),
    descrever: permitido(perfil, "anexos_descrever"),
    etiquetar: permitido(perfil, "anexos_etiquetar"),
  };

  // TRILHA de um item (quem subiu, descreveu, etiquetou, apagou). Fica atras de
  // `anexos_apagar` OU super admin: e a leitura que responde "quem apagou a
  // tabela de precos", e ela nomeia pessoas.
  const trilhaDe = q.get("trilha");
  if (trilhaDe) {
    if (!UUID_RE.test(trilhaDe)) return NextResponse.json({ error: "id invalido" }, { status: 400 });
    if (!permissoes.apagar && !ehAdmin(perfil)) {
      return NextResponse.json({ error: "sem permissao pra ver a trilha da biblioteca" }, { status: 403 });
    }
    const t = await trilhaDoAnexo(trilhaDe);
    if (!t.ok) return NextResponse.json({ eventos: [], aviso: t.aviso }, { headers: semCache });
    return NextResponse.json({ eventos: t.eventos }, { headers: semCache });
  }

  const cfg = await getConfig();
  // A CONFIG E O DEFAULT; a query da tela pode pedir outro tamanho, e as duas
  // passam pelo MESMO clamp (4..300, os limites do card). Valor torto nao derruba
  // a listagem e nao vira pagina de 10 mil itens.
  const porPagina = porPaginaValido(q.get("por_pagina") ?? undefined, porPaginaValido(cfg.anexos_por_pagina));
  const pagina = Math.max(1, Math.round(Number(q.get("pagina") ?? 1)) || 1);

  const leitura = await listarAnexos();
  if (!leitura.ok) {
    // MIGRATION PENDENTE NAO E "BIBLIOTECA VAZIA": as duas frases sao diferentes
    // e so uma e verdade. A tela mostra o aviso em vez de afirmar que ninguem
    // subiu nada (mesmo criterio dos historicos da Frente O).
    return NextResponse.json(
      {
        anexos: [],
        total: 0,
        pagina: 1,
        por_pagina: porPagina,
        etiquetas: [],
        permissoes,
        aviso: leitura.aviso,
        disponivel: false,
      },
      { headers: semCache }
    );
  }

  const um = q.get("id");
  if (um) {
    if (!UUID_RE.test(um)) return NextResponse.json({ error: "id invalido" }, { status: 400 });
    const achado = leitura.linhas.find((l) => l.id === um);
    if (!achado) return NextResponse.json({ error: "arquivo nao encontrado" }, { status: 404 });
    const usos = await usoDeAnexosPorFluxo();
    return NextResponse.json({ anexo: paraTela(achado, usos), permissoes, disponivel: true }, { headers: semCache });
  }

  const filtrados = filtrarAnexos(leitura.linhas, { termo: q.get("busca"), etiqueta: q.get("etiqueta") });
  const inicio = (pagina - 1) * porPagina;
  const fatia = filtrados.slice(inicio, inicio + porPagina);
  // a coluna "usado em N fluxos" custa UMA leitura da tabela de fluxos; ela e
  // pedida so quando a tela quer (`?com_uso=1`), porque a listagem e o que abre
  // toda vez que alguem procura um arquivo
  const usos = q.get("com_uso") === "1" ? await usoDeAnexosPorFluxo() : null;

  return NextResponse.json(
    {
      anexos: fatia.map((l) => paraTela(l, usos)),
      total: filtrados.length,
      total_no_acervo: leitura.linhas.length,
      pagina,
      por_pagina: porPagina,
      por_pagina_limites: { minimo: POR_PAGINA_MIN, maximo: POR_PAGINA_MAX },
      etiquetas: etiquetasEmUso(leitura.linhas),
      permissoes,
      disponivel: true,
      // teto do acervo batido: a tela avisa em vez de parecer completa
      ...(leitura.truncado ? { truncado: true } : {}),
    },
    { headers: semCache }
  );
}

/**
 * SUBIR arquivo novo (multipart).
 *
 * IDENTIDADE SO POR SESSAO (`usuarioPorSessao`, que devolve null pra
 * `x-api-key`), a mesma regra da foto de perfil: upload multipart e gesto de
 * gente na tela. E ha um motivo mecanico junto — a porta que resolve o canal do
 * pedido pra escopo de chave LE o corpo de metodo que muda estado, e corpo
 * multipart nao e JSON: manter esta rota fora do caminho de chave fecha essa
 * conversa antes de ela comecar.
 */
export async function POST(req: NextRequest) {
  const user = await usuarioPorSessao(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  // GATE ANTES DE QUALQUER EFEITO (licao da Frente O: gate depois do efeito e
  // efeito parcial com resposta de recusa)
  if (!permitido(perfil, "anexos_enviar")) {
    return NextResponse.json({ error: "voce nao tem a permissao de SUBIR arquivo pra biblioteca" }, { status: 403 });
  }

  // teto ANTES de tocar no corpo: `req.formData()` ja bufferiza o upload inteiro
  const declarado = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declarado) && declarado > LIMITE_BYTES + 512 * 1024) {
    return NextResponse.json(
      { error: `o arquivo passa de ${Math.round(LIMITE_BYTES / (1024 * 1024))} MB` },
      { status: 413 }
    );
  }

  let bytes: Uint8Array;
  let nomeArquivoCliente = "";
  // o content-type que o NAVEGADOR declarou. Ele NAO decide o tipo (quem decide
  // sao os magic bytes): ele so desempata familia — docx, xlsx e pptx sao todos
  // `PK\x03\x04` e nao ha como distinguir por bytes sem abrir o pacote.
  let mimeDeclarado = "";
  let campos: Record<string, string> = {};
  try {
    const form = await req.formData();
    const arquivo = form.get("arquivo");
    if (!(arquivo instanceof Blob)) {
      return NextResponse.json({ error: "envie o arquivo no campo 'arquivo'" }, { status: 400 });
    }
    if (arquivo.size > LIMITE_BYTES) {
      return NextResponse.json(
        { error: `o arquivo passa de ${Math.round(LIMITE_BYTES / (1024 * 1024))} MB` },
        { status: 400 }
      );
    }
    nomeArquivoCliente = (arquivo as File).name ?? "";
    mimeDeclarado = arquivo.type || "";
    bytes = new Uint8Array(await arquivo.arrayBuffer());
    for (const campo of ["nome", "chave", "descricao", "etiquetas"]) {
      const v = form.get(campo);
      if (typeof v === "string") campos[campo] = v;
    }
  } catch {
    return NextResponse.json({ error: "nao consegui ler o arquivo enviado" }, { status: 400 });
  }

  // O TIPO SAI DOS BYTES. Ver o cabecalho de lib/anexos.ts: o bucket e publico,
  // entao svg e pagina web sao recusados de proposito.
  const arq = validarArquivo({ bytes, nome: nomeArquivoCliente, mime: mimeDeclarado });
  if (!arq.ok) return NextResponse.json({ error: arq.erro }, { status: 400 });

  const nome = nomeDeAnexo(campos.nome || nomeArquivoCliente);
  if (!nome) return NextResponse.json({ error: "de um nome ao arquivo" }, { status: 400 });
  // chave: a que a pessoa digitou (se ja e valida) ou derivada do nome
  const chave = chaveJaValida(campos.chave) ? String(campos.chave) : chaveDeAnexo(campos.chave || nome);
  if (!chave) {
    return NextResponse.json(
      { error: "nao consegui montar uma chave pra este arquivo — escreva uma (letras minusculas, numeros, - e _)" },
      { status: 400 }
    );
  }
  const desc = descricaoDeAnexo(campos.descricao ?? "");
  if (!desc.ok) return NextResponse.json({ error: desc.erro }, { status: 400 });
  let etiquetas: string[] = [];
  if (campos.etiquetas) {
    let bruto: unknown = campos.etiquetas;
    try {
      bruto = JSON.parse(campos.etiquetas);
    } catch {
      bruto = String(campos.etiquetas)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const e = etiquetasDeAnexo(bruto);
    if (!e.ok) return NextResponse.json({ error: e.erro }, { status: 400 });
    etiquetas = e.etiquetas;
  }

  // A CHAVE E CONFERIDA ANTES DE ENCOSTAR NO STORAGE — e este e o ponto, nao um
  // detalhe de ordem. O caminho do objeto e DETERMINISTICO (`biblioteca/<chave>.<ext>`)
  // e a subida e `upsert`, entao subir com uma chave que ja existe reescreve o
  // arquivo VIVO que N passos de fluxo mandam pro cliente. Antes desta guarda, o
  // 23505 de `criarAnexo` chegava tarde: a tela dizia "ja existe um arquivo com a
  // chave..." e seguia mostrando nome, bytes e `?v=<hash antigo>` — enquanto o
  // bucket publico ja servia o arquivo NOVO, sem uma linha na trilha. Trocar o
  // material de N fluxos em silencio e a mesma familia do apagar em silencio que
  // esta rota existe pra impedir.
  //
  // FAIL-CLOSED: leitura que FALHOU nao e "a chave esta livre". Sem conseguir
  // olhar, a rota recusa (503) em vez de sobrescrever no escuro.
  const jaExiste = await anexoPorChave(chave);
  if (!jaExiste.ok) return NextResponse.json({ error: jaExiste.aviso }, { status: 503 });
  if (jaExiste.linha) {
    return NextResponse.json(
      {
        error: `ja existe um arquivo com a chave "${chave}" — escolha outra chave. Trocar o arquivo de um item ja usado por fluxos nao se faz por aqui.`,
      },
      { status: 409 }
    );
  }

  // SOBE O ARQUIVO ANTES DE GRAVAR A LINHA: linha apontando pra objeto que nao
  // existe faria o fluxo mandar link morto pro cliente. Se a linha falhar depois
  // (a corrida em que duas pessoas sobem a MESMA chave no mesmo instante, que a
  // unique do banco ainda pega), sobra um objeto orfao no bucket sob uma chave
  // que nao tem linha — e ele so e alcancado por um upload futuro daquela mesma
  // chave, que agora passa por esta guarda.
  const subida = await subirAnexo(bytes, { chave, ext: arq.ext, mime: arq.mime });
  if (!subida.ok) return NextResponse.json({ error: subida.erro }, { status: 500 });

  const criado = await criarAnexo({
    chave,
    nome,
    descricao: desc.valor,
    etiquetas,
    arquivo_nome: arq.arquivo_nome,
    mime: arq.mime,
    bytes: arq.bytes,
    url: subida.url,
    autor: autorDe(user),
  });
  if (!criado.ok) return NextResponse.json({ error: criado.erro }, { status: criado.status });

  await registrarEventoAnexo({
    anexo_id: criado.linha.id,
    chave: criado.linha.chave,
    nome: criado.linha.nome,
    tipo: "criado",
    autor: autorDe(user),
    detalhe: { mime: arq.mime, bytes: arq.bytes, arquivo: arq.arquivo_nome },
  });

  return NextResponse.json({ ok: true, anexo: paraTela(criado.linha) }, { headers: semCache });
}

/** DESCREVER e ETIQUETAR — permissoes SEPARADAS, decididas por `decidirPatch` (pura). */
export async function PATCH(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);

  const body = await req.json().catch(() => ({}) as any);
  const id = typeof body?.id === "string" ? body.id : "";
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "id invalido" }, { status: 400 });

  const decisao = decidirPatch(
    { descricao: body?.descricao, etiquetas: body?.etiquetas },
    {
      descrever: permitido(perfil, "anexos_descrever"),
      etiquetar: permitido(perfil, "anexos_etiquetar"),
    }
  );
  if (!decisao.ok) return NextResponse.json({ error: decisao.erro }, { status: decisao.status });

  const atual = await anexoPorId(id);
  if (!atual.ok) return NextResponse.json({ error: atual.aviso }, { status: 503 });
  if (!atual.linha) return NextResponse.json({ error: "arquivo nao encontrado" }, { status: 404 });

  const gravado = await atualizarAnexo(id, decisao.campos, autorDe(user));
  if (!gravado.ok) return NextResponse.json({ error: gravado.erro }, { status: gravado.status });

  // um evento por CAMPO mexido: a trilha responde "quem mudou a descricao" e
  // "quem trocou as etiquetas" separadamente, que e a razao de as permissoes
  // serem separadas
  if (decisao.campos.descricao !== undefined) {
    await registrarEventoAnexo({
      anexo_id: id,
      chave: gravado.linha.chave,
      nome: gravado.linha.nome,
      tipo: "descrito",
      autor: autorDe(user),
      detalhe: { de: atual.linha.descricao ?? "", para: decisao.campos.descricao },
    });
  }
  if (decisao.campos.etiquetas !== undefined) {
    await registrarEventoAnexo({
      anexo_id: id,
      chave: gravado.linha.chave,
      nome: gravado.linha.nome,
      tipo: "etiquetado",
      autor: autorDe(user),
      detalhe: { de: atual.linha.etiquetas ?? [], para: decisao.campos.etiquetas },
    });
  }

  return NextResponse.json({ ok: true, anexo: paraTela(gravado.linha) }, { headers: semCache });
}

/**
 * APAGAR — e o criterio de aceite mais duro do card: "apagar arquivo referenciado
 * por fluxo MOSTRA quais fluxos serao afetados antes de confirmar; nunca apaga em
 * silencio".
 *
 * Duas confirmacoes diferentes, que nao se substituem (`confirmar=1` e
 * `ciente_fluxos=1`), e a decisao mora em `decidirExclusao` (lib/anexos.ts, pura)
 * — inclusive o fail-closed: varredura que NAO deu pra fazer RECUSA o apagar.
 * Modelo declarado: o DELETE de `/api/fluxos`, que ja para em 409 com a lista de
 * quem chama o fluxo.
 */
export async function DELETE(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  if (!permitido(perfil, "anexos_apagar")) {
    return NextResponse.json({ error: "voce nao tem a permissao de APAGAR arquivo da biblioteca" }, { status: 403 });
  }

  const q = req.nextUrl.searchParams;
  const id = q.get("id") ?? "";
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "id invalido" }, { status: 400 });

  const atual = await anexoPorId(id);
  if (!atual.ok) return NextResponse.json({ error: atual.aviso }, { status: 503 });
  if (!atual.linha) return NextResponse.json({ error: "arquivo nao encontrado" }, { status: 404 });

  const varredura = await varrerFluxos(atual.linha.chave);
  const decisao = decidirExclusao({
    confirmar: q.get("confirmar") === "1",
    ciente_fluxos: q.get("ciente_fluxos") === "1",
    varredura,
  });
  if (!decisao.ok) {
    return NextResponse.json(
      {
        error: decisao.erro,
        ...(decisao.detalhe ? { detalhe: decisao.detalhe } : {}),
        // A LISTA VAI NA RESPOSTA, sempre que existir: o criterio e MOSTRAR quais
        // fluxos serao afetados, e uma frase com o numero nao mostra quais.
        ...(varredura.ok && varredura.afetados.length ? { usado_por: varredura.afetados.slice(0, 50) } : {}),
      },
      { status: decisao.status }
    );
  }

  const afetados = varredura.ok ? varredura.afetados : [];
  const apagado = await apagarAnexo(atual.linha);
  if (!apagado.ok) return NextResponse.json({ error: apagado.erro }, { status: apagado.status });

  await registrarEventoAnexo({
    anexo_id: atual.linha.id,
    chave: atual.linha.chave,
    nome: atual.linha.nome,
    tipo: "apagado",
    autor: autorDe(user),
    // A LISTA DE FLUXOS AFETADOS VAI PRA TRILHA. Depois do apagar, ela e a unica
    // coisa que responde "quais fluxos ficaram sem arquivo" — e essa e a pergunta
    // que aparece quando o cliente reclama que nao recebeu o material.
    detalhe: {
      arquivo_removido: apagado.arquivo_removido,
      fluxos_afetados: afetados.map((f) => ({ slug: f.slug, passos: f.passos.length, ativo: f.ativo })),
      resumo: resumoDoImpacto(afetados),
    },
  });

  return NextResponse.json(
    {
      ok: true,
      chave: atual.linha.chave,
      arquivo_removido: apagado.arquivo_removido,
      ...(apagado.arquivo_removido
        ? {}
        : {
            aviso:
              "a linha saiu da biblioteca, mas nao consegui remover o arquivo do armazenamento — quem tiver o link antigo ainda alcanca. Confira o bucket.",
          }),
      ...(afetados.length ? { fluxos_afetados: afetados.map((f) => f.slug) } : {}),
    },
    { headers: semCache }
  );
}
