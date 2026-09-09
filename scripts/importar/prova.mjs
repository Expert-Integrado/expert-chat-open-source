// Prova do importador — roda a CLI em --dry contra o backup SINTETICO de
// scripts/importar/fixture/ e confere o mapeamento linha a linha.
//
//   node scripts/importar/prova.mjs
//
// Nao toca em banco nenhum e nao usa dado de cliente: o fixture e inventado de
// proposito, com um caso de cada armadilha ja paga — grupo por kind e grupo so
// pelo sufixo @g.us, duplicata entre paginas, mesmo telefone em duas entradas do
// indice, mensagem sem identificador nenhum, mensagem sem data, apagada, tipo
// desconhecido, anotacao em HTML, envio de robo sem autor, responsavel em
// formato {$oid}, etiqueta fora do catalogo e conversa sem arquivo.
//
// Confere tambem as LINHAS (via --dump), nao so as contagens: e ali que se ve se
// o upsert esta mandando null onde deveria omitir a chave.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(AQUI, "fixture");
const TRABALHO = fs.mkdtempSync(path.join(os.tmpdir(), "prova-importar-"));

let falhas = 0;
const ok = (cond, oque, detalhe = "") => {
  console.log(`${cond ? "  ok  " : "FALHA "} ${oque}${detalhe ? ` — ${detalhe}` : ""}`);
  if (!cond) falhas++;
};
const igual = (obtido, esperado, oque) =>
  ok(JSON.stringify(obtido) === JSON.stringify(esperado), oque, `esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`);

console.log("PROVA DO IMPORTADOR (fixture sintetico, modo --dry)\n");

const DUMP = path.join(TRABALHO, "linhas.json");
execFileSync(
  process.execPath,
  [path.join(AQUI, "chatguru.mjs"), "--pasta", FIXTURE, "--dry", "--trabalho", TRABALHO, "--dump", DUMP],
  { stdio: "pipe" }
);
const linhas = JSON.parse(fs.readFileSync(DUMP, "utf8"));
const conversa = (chatId) => linhas.conversas.find((c) => c.chat_id === chatId);

const arq = fs.readdirSync(TRABALHO).find((f) => f.startsWith("relatorio-") && f.endsWith(".json"));
ok(!!arq, "gera o relatorio em json");
const e = JSON.parse(fs.readFileSync(path.join(TRABALHO, arq), "utf8"));

console.log("\n-- contagens");
igual(e.origem.conversas_no_indice, 8, "le as 8 conversas do indice");
igual(e.mapeado.conversas, 6, "mapeia 6: tira a sem arquivo de mensagens e a lista de transmissao");
igual(e.mapeado.mensagens_entrada, 16, "16 recebidas");
igual(e.mapeado.mensagens_saida, 10, "10 enviadas");
igual(e.mapeado.notas_internas, 4, "4 anotacoes (a de texto vazio e descartada)");

console.log("\n-- descartes");
igual(e.descartados.apagadas, 1, "descarta a mensagem apagada na origem");
igual(e.descartados.sem_data, 1, "descarta a mensagem sem data");
igual(e.descartados.sem_conteudo, 1, "descarta a anotacao sem texto");
igual(e.descartados.tipo_ignorado.call_log, 1, "descarta o registro de chamada");
igual(e.destino.por_tipo.unknown, 1, "tipo desconhecido entra como unknown, sem perder a mensagem");
igual(e.orfaos.tipos_sem_traducao.sticker_tipo_novo, 1, "e o relatorio diz QUAL tipo foi");

console.log("\n-- dedupe e datas");
igual(e.origem.itens_lidos_nesta_passada, 35, "conta os 35 itens lidos, sem esconder o que foi filtrado");
igual(e.descartados.duplicadas_no_backup, 1, "conta a repetida entre paginas como descarte declarado");
igual(e.mapeado.mensagens_total, 30, "a duplicata repetida entre paginas nao entra duas vezes");
ok(
  e.origem.itens_lidos_nesta_passada === e.mapeado.mensagens_total + 5,
  "leitura fecha: lidos = mapeados + descartados",
  `${e.origem.itens_lidos_nesta_passada} = ${e.mapeado.mensagens_total} + 5`
);
igual(e.datas.mensagem_mais_antiga, "2025-01-02T10:05:00.000Z", "acha a mensagem mais antiga");
igual(
  e.datas.mensagem_mais_recente,
  "2025-01-07T08:13:00.000Z",
  "a mais recente ignora a lista de transmissao (que e posterior e nao entra)"
);

console.log("\n-- autoria");
igual(e.origem.usuarios, 3, "le os 2 atendentes + 1 grupo do arquivo de usuarios");
igual(e.orfaos.envios_sem_autor_na_origem, 8, "separa os envios de robo (nunca tiveram autor)");
igual(e.orfaos.autores_desconhecidos, 0, "nenhum id de autor ficou sem nome");

console.log("\n-- etiquetas e funis");
igual(e.origem.etiquetas_no_catalogo, 2, "catalogo exportado tem 2 etiquetas");
igual(e.destino.etiquetas_catalogo, 3, "a etiqueta usada fora do catalogo tambem entra, pra nao perder a marcacao");
igual(e.orfaos.etiquetas_fora_do_catalogo, ["Etiqueta Solta"], "e e apontada no relatorio");
igual(e.origem.funis, 1, "le o funil");
igual(e.origem.etapas_de_funil, 2, "le as 2 etapas");
igual(e.orfaos.etapas_de_funil_desconhecidas, ["etapa-que-nao-existe"], "aponta a etapa referenciada que nao existe");

console.log("\n-- orfaos");
igual(e.orfaos.arquivos_sem_chat_no_indice, 1, "aponta o arquivo de mensagens sem conversa no indice");
igual(e.orfaos.chats_sem_arquivo_de_mensagens, 1, "aponta a conversa do indice sem arquivo de mensagens");

console.log("\n-- upsert nao destrutivo (nao pisa em dado vivo do painel)");
const semNome = conversa("5500900000005-1700000000-group");
ok(!!semNome, "a conversa de grupo por sufixo foi mapeada");
igual(semNome.is_group, true, "grupo reconhecido pelo sufixo @g.us mesmo com kind 'chat'");
ok(
  !Object.prototype.hasOwnProperty.call(conversa("5500900000002-1600000000-group"), "responsavel_nome"),
  "conversa sem responsavel OMITE a chave (mandar null apagaria o responsavel vivo)"
);
ok(
  !Object.prototype.hasOwnProperty.call(semNome, "foto_url"),
  "conversa sem foto OMITE a chave (mandar null apagaria a foto do painel)"
);
ok(
  !Object.prototype.hasOwnProperty.call(semNome, "etiquetas"),
  "conversa sem etiqueta OMITE a chave (lista vazia apagaria as etiquetas vivas)"
);
ok(
  conversa("5500900000001").canal === "chatguru-central",
  "rotulo de origem segue a convencao fonte-id, nao o id cru",
  conversa("5500900000001").canal
);

console.log("\n-- mesmo telefone em duas entradas do indice");
igual(e.descartados.conversas_colapsadas, 1, "colapsa as duas entradas do mesmo telefone numa conversa so");
igual(linhas.conversas.filter((c) => c.chat_id === "5500900000001").length, 1, "so uma linha vai pro upsert (senao e erro 21000)");
igual(conversa("5500900000001").responsavel_nome, "Bruno Atendente", "fica com a entrada mais recente e resolve o responsavel em formato {$oid}");
ok(
  linhas.mensagens.some((x) => x.provider_msg_id.endsWith("CCC1")) &&
    linhas.mensagens.some((x) => x.provider_msg_id.endsWith("AAA1")),
  "as mensagens das DUAS entradas entram na conversa colapsada"
);

console.log("\n-- mensagem sem identificador na origem");
const semId = linhas.mensagens.filter((x) => x.chat_id === "5500900000005-1700000000-group");
igual(semId.length, 2, "duas mensagens sem wa_message_id e sem _id continuam duas linhas");
igual(new Set(semId.map((x) => x.provider_msg_id)).size, 2, "e ganham identificadores distintos (id fixo colapsaria tudo em 1)");

console.log("\n-- vocabulario do painel");
igual(semId.find((x) => x.tipo === "image").conteudo, "[foto]", "midia sem texto usa o rotulo do painel");
igual(semId.find((x) => x.tipo === "audio").conteudo, "[audio]", "'ptt' vira '[audio]', nao '[ptt]'");

console.log("\n-- arquivado e encerrado, nao descarte");
igual(e.conversas_origem.arquivadas, 4, "conta as arquivadas da origem");
igual(
  linhas.conversas.filter((c) => c.arquivada).length,
  3,
  "e TODAS as arquivadas com arquivo de mensagens entram (nenhuma e jogada fora)"
);
igual(e.conversas_origem.status_nulo, 1, "conta a conversa com status nulo na origem");
igual(conversa("5500900000006").status, "aberto", "status nulo vira aberto");
igual(
  conversa("5500900000006").meta_chatguru.status_original,
  null,
  "e o original (null) fica registrado, pra decisao ser rastreavel"
);
ok(
  e.conversas_origem.arquivada_x_status["arquivada x (nulo)"] === 1,
  "o cruzamento arquivada x status publica a arquivada que nao esta encerrada"
);

console.log("\n-- lista de transmissao nao vira conversa");
igual(e.descartados.conversas_de_transmissao, 1, "a lista de transmissao nao e importada");
igual(e.descartados.itens_em_conversas_de_transmissao, 2, "e o relatorio diz quantos itens ficaram de fora");
ok(!conversa("1685887687"), "o timestamp da lista de transmissao NAO virou um contato no painel");
ok(
  e.pendencias.some((p) => p.tema === "conversas de transmissao"),
  "a ausencia e declarada em pendencia, nunca silenciosa"
);

console.log("\n-- o que a mensagem carrega alem do texto");
const comTudo = linhas.mensagens.find((x) => x.provider_msg_id === "true_5500900000006@c.us_F001");
igual(comTudo.quoted_msg_id, "false_5500900000006@c.us_F000", "preserva a citacao pelo id do WhatsApp");
igual(comTudo.reacao, "\u{1F64F}", "preserva a reacao, ficando com a MAIS RECENTE");
igual(comTudo.editada_em, "2025-01-07T08:05:00.000Z", "preserva a data da edicao");
igual(comTudo.encaminhada, true, "preserva a marca de encaminhada");
igual(comTudo.raw, { por_template: true, do_aparelho: true, processador: 7 }, "preserva os qualificadores reais");
igual(comTudo.status, "read", "estado de entrega sai do ack (3 = lido), nao do 'sent' generico");
igual(e.preservados.citacao, 5, "conta as citacoes no relatorio");
igual(e.preservados.reacao, 1, "conta a reacao");
igual(e.preservados.editada, 1, "conta a edicao");
igual(e.preservados.encaminhada, 1, "conta o encaminhamento");
const semQualificador = linhas.mensagens.find((x) => x.provider_msg_id.endsWith("AAA1"));
igual(semQualificador.raw, null, "mensagem sem nada a qualificar fica com raw null (nao vira jsonb morto)");

const comErro = linhas.mensagens.find((x) => x.provider_msg_id === "true_5500900000006@c.us_F004");
igual(comErro.status, "error", "erro vence o ack: mensagem que falhou nao 'foi lida'");
igual(comErro.raw.erro, "4005 - Message Sending failed", "o detalhe do erro da origem e preservado");

const processada = linhas.mensagens.find((x) => x.provider_msg_id === "true_5500900000006@c.us_F007");
igual(
  processada.status,
  "sent",
  "status da origem que NAO e estado de entrega (\"processed\" = o chatbot dela processou) cai pra sent"
);
igual(
  e.preservados.estado_de_entrega_sem_traducao,
  { processed: 1 },
  "e o valor original e declarado no relatorio, em vez de ir cru pra coluna"
);

console.log("\n-- apagada pra todos entra marcada, nao descartada");
const apagada = linhas.mensagens.find((x) => x.provider_msg_id === "false_5500900000006@c.us_F002");
ok(!!apagada, "a mensagem apagada na origem (revoked) ENTRA");
igual(apagada.is_deleted, true, "e entra marcada como apagada");
igual(apagada.conteudo, null, "sem conteudo inventado — o painel desenha a mascara");
igual(e.preservados.apagada_marcada, 1, "conta no relatorio");
ok(
  e.descartados.tipo_ignorado.revoked === undefined,
  "e nao aparece mais como tipo descartado"
);

console.log("\n-- tipo sem equivalente que TEM texto");
const interativa = linhas.mensagens.find((x) => x.provider_msg_id === "true_5500900000006@c.us_F003");
igual(interativa.tipo, "text", "mensagem de lista interativa entra como texto");
igual(interativa.conteudo, "Escolha uma opcao:", "com o texto que o cliente leu, nao com '[mensagem]'");
igual(e.preservados.tipos_degradados, { interactive_list: 1 }, "e a perda de estrutura e declarada por tipo");

console.log("\n-- midia: URL e inventario");
const doc = linhas.mensagens.find((x) => x.provider_msg_id === "false_5500900000006@c.us_F005");
igual(
  doc.media_url,
  "https://exemplo.invalido/absoluto/contrato.pdf",
  "arquivo sem path_relative usa o path_absolute quando ele ja e https"
);
igual(e.midia.arquivos, 2, "inventaria as mensagens com arquivo utilizavel");
igual(e.midia.bytes, 12345, "somando o tamanho declarado no backup");
igual(e.midia.por_mime["application/pdf"], 1, "com a distribuicao por mime, que e o insumo da re-hospedagem");
igual(e.descartados.midia_sem_url, 3, "e conta separado o arquivo sem URL nenhuma");

console.log("\n-- encoding: contar e declarar, nunca chutar conserto");
igual(e.avisos.textos_com_encoding_suspeito, 2, "acha os DOIS textos com charset trocado na origem (dialeto Latin-1 e dialeto CP1252)");
// FALSO POSITIVO que a re-revisao pegou: os altos do CP1252 estavam TAMBEM no
// ramo do `Ã`, e ali marcavam texto CERTO — `MACA` entre aspas curvas e
// `IRMÃ` seguido de travessao. A metrica existe pra dizer quanto do acervo
// chegou corrompido; inflar ela manda o operador procurar defeito que nao ha.
// As duas mensagens legitimas estao na fixture e o total tem que continuar 2.
ok(
  linhas.mensagens.some((x) => x.provider_msg_id === "3EB0LEGITIMO1") &&
    linhas.mensagens.some((x) => x.provider_msg_id === "3EB0LEGITIMO2"),
  "as duas mensagens de acentuacao LEGITIMA entraram na fixture"
);
igual(
  linhas.mensagens.find((x) => x.provider_msg_id === "false_5500900000006@c.us_F006").conteudo,
  "Obrigado pela atenÃ§Ã£o",
  "e NAO tenta consertar (chute de charset estraga o que estava certo)"
);

console.log("\n-- referencias: resolve, ou declara ressalva");
const ref = (t) => e.referencias.tabela.find((l) => l.tipo === t);
igual(ref("etiqueta").por_nome, 1, "etiqueta escrita em caixa baixa casa com a do catalogo por nome normalizado");
igual(conversa("5500900000006").etiquetas, ["Cliente"], "e a conversa fica com o nome do CATALOGO, nao com duas etiquetas");
igual(e.orfaos.etiquetas_normalizadas, 1, "a normalizacao e contada");
igual(ref("etiqueta").morto, 1, "etiqueta que nao existe no catalogo exportado vira ressalva");
igual(ref("autor_anotacao").por_nome, 2, "autor de anotacao casa por nome, mesmo com espaco sobrando e caixa trocada");
igual(
  ref("autor_anotacao").sem_alvo_na_origem,
  1,
  "anotacao assinada pelo ROBO nao e ressalva: nunca houve usuario pra casar (na conta da Expert sao 92% delas)"
);
igual(e.orfaos.anotacoes_assinadas_pelo_robo, 1, "e ela e contada separado, pra taxa falar das PESSOAS");
igual(
  linhas.mensagens.find((x) => x.provider_msg_id === "cgnota:n0000000000000000000103").sender_name,
  "Chatbot",
  "a assinatura do robo continua na anotacao (e quem escreveu)"
);
igual(ref("autor_anotacao").morto, 1, "autor que nao existe mais vira ressalva");
igual(
  linhas.mensagens.find((x) => x.provider_msg_id === "cgnota:n0000000000000000000102").sender_name,
  "Fulano Que Saiu",
  "e MESMO na ressalva o nome do autor nao se perde"
);
igual(
  linhas.mensagens.find((x) => x.provider_msg_id === "cgnota:n0000000000000000000101").sender_name,
  "Ana Atendente",
  "autor que casou passa a assinar com o nome do cadastro"
);
igual(ref("departamento_delegado").morto, 1, "departamento fantasma vira ressalva");
igual(ref("etapa_funil").morto, 1, "etapa inexistente vira ressalva");
ok(
  e.pendencias.some((p) => p.tema === "referencias"),
  "toda ressalva vira pendencia no relatorio"
);

console.log("\n-- delegacao e lista (e nao vira responsavel do painel)");
igual(e.conversas_origem.delegacao_multipla_usuarios, 1, "conta a conversa com mais de um usuario delegado");
igual(e.conversas_origem.delegacao_multipla_departamentos, 1, "conta a com mais de um departamento");
igual(
  conversa("5500900000006").meta_chatguru.responsaveis,
  ["Ana Atendente", "Bruno Atendente", "Suporte"],
  "a lista INTEIRA e preservada em meta_chatguru (nada e perdido)"
);
igual(conversa("5500900000006").responsavel_nome, "Ana Atendente", "e a coluna legada recebe o primeiro");
ok(
  e.pendencias.some((p) => p.tema === "responsaveis"),
  "e a pendencia explica por que conversa_responsaveis NAO e escrita"
);
igual(e.conversas_origem.em_mais_de_uma_etapa, 1, "conta a conversa em mais de uma etapa de funil");
igual(
  conversa("5500900000006").meta_chatguru.funil_etapas,
  ["Comercial / Novo lead", "Comercial / Proposta"],
  "e as duas etapas viajam pro segundo passo"
);

console.log("\n-- o DADO GRAVADO sai do mesmo resolvedor que MEDE");
// Reprovacao GRAVE da revisao cega: o placar resolvia por id -> nome -> posicao,
// mas a linha de conversa era montada por dois mapas que SO conhecem id
// (`AUTORES` e um `nomeEtapa`). Nos 33 backups os dois caminhos concordam, entao
// o defeito era invisivel — e continuaria invisivel ate o backup que traz ROTULO
// no lugar do id. A conversa a8 do fixture e exatamente esse backup.
const porRotulo = conversa("5500900000008");
ok(!!porRotulo, "a conversa cujo export traz ROTULO no lugar do id foi mapeada");
igual(
  porRotulo.meta_chatguru.responsaveis,
  ["Ana Atendente", "Suporte"],
  "delegado que vem como NOME resolve pelo indice e chega ao banco (pelo caminho antigo chegaria lista VAZIA)"
);
igual(
  porRotulo.responsavel_nome,
  "Ana Atendente",
  "e o espelho legado recebe o nome resolvido, nao um identificador cru"
);
igual(
  porRotulo.meta_chatguru.funil_etapas,
  ["Comercial / Proposta"],
  'etapa que vem como NOME sai no formato "Funil / Etapa" que o funis.mjs casa (pelo caminho antigo sairia so "Proposta", que nao casa com nada)'
);
igual(ref("usuario_delegado").por_nome, 1, "e o placar registra o casamento por nome — a MESMA passada que gravou");
igual(ref("departamento_delegado").por_nome, 1, "idem departamento");
igual(ref("etapa_funil").por_nome, 1, "idem etapa");

console.log("\n-- delegado que nao resolve: contado, declarado, e nunca no lugar do nome");
igual(e.orfaos.delegados_nao_resolvidos, 1, "o departamento fantasma e contado do lado do dado gravado");
igual(
  conversa("5500900000006").meta_chatguru.responsaveis_nao_resolvidos,
  ["g0000000000000000000fant"],
  "o identificador cru viaja em campo PROPRIO do meta, pra revisao"
);
ok(
  !conversa("5500900000006").meta_chatguru.responsaveis.includes("g0000000000000000000fant"),
  "e NAO entra na lista de responsaveis (um ObjectId em responsavel_nome viraria 'nome do atendente' na ficha)"
);
ok(
  e.pendencias.some((p) => p.tema === "responsaveis" && /NAO casaram/.test(p.detalhe)),
  "e a pendencia de responsaveis sai por causa dele — nao so quando ha delegacao multipla"
);
igual(e.orfaos.etapas_nao_resolvidas, 1, "etapa que nao casou tambem e contada");
ok(
  e.pendencias.some((p) => p.tema === "funis" && /IDENTIFICADOR CRU/.test(p.detalhe)),
  "com pendencia dizendo que ela viaja com o identificador cru (que o funis.mjs ainda tenta casar)"
);

console.log("\n-- citacao cujo alvo NAO entrou no import");
igual(
  e.preservados.citacao_com_alvo_fora_do_import,
  3,
  "conta as 3 citacoes que apontam pro vazio (alvo ausente no export, ou autorreferencia recusada)"
);
ok(
  linhas.mensagens.some((x) => x.provider_msg_id === "wamid.A8-CITA-VIVA" && x.quoted_msg_id === "wamid.A8-EXISTE"),
  "a citacao cujo alvo ENTROU nao e contada como orfa"
);
ok(
  linhas.mensagens.some((x) => x.provider_msg_id === "wamid.A8-CITA-ORFA"),
  "e a orfa entra normalmente (a mensagem existe; o que falta e o alvo)"
);

console.log("\n-- citacao no formato LONGO casa com o id NU da mensagem");
// Achado que a contagem de citacao orfa revelou (e o motivo de contar): na conta
// da Expert TODO `wa_message_id` e o hex nu, mas parte das citacoes vem no formato
// "false_<jid>_<hex>". Sem recasar, essas entravam apontando pra um identificador
// que nao existe no painel — a bolha "responder a" vazia de uma mensagem que esta
// importada ali do lado.
// Medido por ESTE codigo na conta INTEIRA (31/08), com as duas causas SEPARADAS:
// 133.682 citacoes · 18.015 RECUPERADAS aqui (13,5%) · 45.684 ORFAS DE ORIGEM
// (34,2%, a mensagem citada nao esta no backup — sem conserto) · 0 ambigua.
igual(
  linhas.mensagens.find((x) => x.provider_msg_id === "3EB0CITALONGA").quoted_msg_id,
  "3EB0FORMATOLONGO",
  "a citacao longa e reescrita pro identificador que a mensagem alvo REALMENTE carrega"
);
igual(e.preservados.citacao_recasada_por_formato, 1, "e o recasamento e contado no relatorio");
igual(e.preservados.citacao_com_hex_ambiguo, 0, "sem hex ambiguo nesta fixture (ambiguo ficaria como veio, sem palpite)");

// AUTORREFERENCIA: citacao longa apontando pro id da PROPRIA mensagem. Recasar
// faria a bolha responder a si mesma e contaria como recuperacao bem-sucedida.
const euMesmo = linhas.mensagens.find((x) => x.provider_msg_id === "3EB0EUMESMO");
igual(
  euMesmo.quoted_msg_id,
  "false_5500900000008@c.us_3EB0EUMESMO",
  "citacao que aponta pro proprio id NAO e recasada: fica como veio"
);
ok(
  e.preservados.citacao_recasada_por_formato === 1,
  "e nao entra na contagem de recasadas (recuperacao que nao recuperou nada seria numero falso)"
);

console.log("\n-- mojibake tem DOIS dialetos, e os dois sao detectados");
igual(
  linhas.mensagens.find((x) => x.provider_msg_id === "wamid.A8-CP1252").conteudo,
  `ele disse ${String.fromCharCode(0x00e2, 0x20ac, 0x0153)}bom dia${String.fromCharCode(0x00e2, 0x20ac, 0x0153)} e desligou`,
  "o texto no dialeto CP1252 entra INTACTO (contar e declarar, nunca chutar conserto)"
);
ok(
  e.pendencias.some((p) => /encoding/.test(p.tema) || /charset/.test(p.detalhe)),
  "e o encoding suspeito vira aviso declarado no relatorio"
);

console.log("\n-- lote de insercao: chaves iguais dentro de cada requisicao");
igual(
  new Set(linhas.mensagens.map((x) => Object.keys(x).sort().join("|"))).size,
  1,
  "anotacao e mensagem tem as MESMAS chaves (o PostgREST recusa lote misturado)"
);
ok(
  new Set(linhas.conversas.map((x) => Object.keys(x).sort().join("|"))).size > 1,
  "a linha de conversa tem chave variavel de proposito — e por isso que o flush agrupa por assinatura antes de gravar"
);

// ═══ RE-EXECUCAO CONTRA UM DESTINO QUE JA TEM VIDA ═══════════════════════════
// O `--dump` mostra a linha ANTES do ajuste ao destino; o que o upsert manda de
// verdade so aparece com um destino do outro lado. E ali que estava o defeito que
// a revisao cega pegou: `merge-duplicates` sobrescreve TODA chave presente, entao
// a segunda passada apagava etiqueta posta na ficha, nome corrigido e responsavel
// de verdade — o backup, que e mais VELHO, vencendo o painel, que e o presente.
// Servidor HTTP local em PROCESSO SEPARADO (`execFileSync` congela o event loop
// de quem chama, entao servidor no mesmo processo travaria a prova).
console.log("\n-- re-execucao: o backup nao apaga o que o painel ganhou depois");
const ARQ_PORTA = path.join(TRABALHO, "mock-porta.txt");
const ARQ_REQS = path.join(TRABALHO, "mock-requisicoes.ndjson");
const ARQ_ROTEIRO = path.join(TRABALHO, "mock-roteiro.json");
fs.writeFileSync(ARQ_REQS, "");
fs.writeFileSync(
  ARQ_ROTEIRO,
  JSON.stringify({
    conversas: [
      {
        chat_id: "5500900000006",
        // conversa VIVA: o painel ja andou mais que o backup
        last_message_at: "2099-01-01T00:00:00.000Z",
        nome: "Nome corrigido na ficha",
        foto_url: "https://painel.invalido/foto-atual.jpg",
        etiquetas: ["Etiqueta da equipe"],
        responsavel_id: "00000000-0000-4000-8000-000000000001",
        responsavel_nome: "Atendente com conta no painel",
      },
      {
        // conversa que existe mas esta CRUA (criada pela Z-API sem nome/foto):
        // aqui o backup TEM que preencher, senao a primeira carga nao serve
        chat_id: "5500900000008",
        last_message_at: null,
        nome: null,
        foto_url: null,
        etiquetas: null,
        responsavel_id: null,
        responsavel_nome: null,
      },
    ],
  })
);
const servidor = spawn(
  process.execPath,
  [path.join(AQUI, "prova-mock-destino.mjs"), ARQ_PORTA, ARQ_REQS, ARQ_ROTEIRO],
  { stdio: "ignore" }
);
let espera = 0;
while (!fs.existsSync(ARQ_PORTA) && espera < 100) {
  await new Promise((r) => setTimeout(r, 50));
  espera++;
}
// NAO deixar node orfao: se uma assercao adiante lancar, o processo da prova
// morre e o servidor de mentira ficaria vivo segurando uma porta.
// `process.on("exit")` cobre MAIS que try/finally aqui, e por isso foi o
// escolhido: esta prova termina com `process.exit(falhas ? 1 : 0)`, e finally NAO
// roda em process.exit.
const encerrarMock = () => {
  try {
    servidor.kill();
  } catch {
    // ja morreu
  }
};
process.on("exit", encerrarMock);
ok(fs.existsSync(ARQ_PORTA), "o destino de mentira subiu");
const BASE = `http://127.0.0.1:${fs.readFileSync(ARQ_PORTA, "utf8").trim()}`;

// Antes de gravar: o guarda do --dry deixa de ser afirmacao. Env ENVENENADA (url e
// key preenchidas, apontando pro servidor) e a cobranca e ZERO requisicao.
const TRABALHO_SECO = fs.mkdtempSync(path.join(os.tmpdir(), "prova-importar-seco-"));
execFileSync(
  process.execPath,
  [path.join(AQUI, "chatguru.mjs"), "--pasta", FIXTURE, "--dry", "--trabalho", TRABALHO_SECO],
  { stdio: "pipe", env: { ...process.env, MSG_SUPABASE_URL: BASE, MSG_SUPABASE_SERVICE_KEY: "chave-de-mentira" } }
);
const arqSeco = fs.readdirSync(TRABALHO_SECO).find((f) => f.startsWith("relatorio-") && f.endsWith(".json"));
const eSeco = JSON.parse(fs.readFileSync(path.join(TRABALHO_SECO, arqSeco), "utf8"));
igual(eSeco.erros, [], "com url e key no ambiente, o --dry nao registra erro nenhum");
igual(eSeco.destino.gravado, null, "e o relatorio de simulacao nao publica numero em \"gravado\"");
igual(
  fs.readFileSync(ARQ_REQS, "utf8").split("\n").filter((l) => l.trim()),
  [],
  "ZERO requisicao chegou ao servidor: o --dry do importador realmente nao abre conexao"
);
fs.rmSync(TRABALHO_SECO, { recursive: true, force: true });

const TRABALHO2 = fs.mkdtempSync(path.join(os.tmpdir(), "prova-importar-2-"));
execFileSync(
  process.execPath,
  [path.join(AQUI, "chatguru.mjs"), "--pasta", FIXTURE, "--trabalho", TRABALHO2, "--url", BASE, "--key", "chave-de-mentira"],
  { stdio: "pipe" }
);
encerrarMock();

const reqs = fs
  .readFileSync(ARQ_REQS, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
const postsConversas = reqs.filter((r) => r.metodo === "POST" && r.caminho.endsWith("/conversas"));
ok(postsConversas.length > 0, `o importador gravou conversas no destino (${postsConversas.length} requisicao(oes))`);
const enviadas = postsConversas.flatMap((r) => JSON.parse(r.corpo));
const enviada = (id) => enviadas.find((c) => c.chat_id === id);

const viva = enviada("5500900000006");
ok(!!viva, "a conversa que ja existia no destino foi enviada");
ok(!("nome" in viva), "NOME nao viaja: o painel tem um nome corrigido e o backup nao pisa nele");
ok(!("foto_url" in viva), "FOTO nao viaja pelo mesmo motivo");
ok(
  !("responsavel_nome" in viva),
  "RESPONSAVEL nao viaja: o destino tem responsavel com conta (responsavel_id), que vence o espelho historico"
);
igual(
  viva.etiquetas,
  ["Etiqueta da equipe", "Cliente"],
  "ETIQUETA e UNIAO, com o destino primeiro: a historica entra e a da equipe fica"
);
ok(!("status" in viva) && !("arquivada" in viva), "status e arquivo seguem sendo estado vivo (nao viajam)");
ok(
  !("last_message_at" in viva),
  "e o carimbo da ultima mensagem tambem nao, porque o destino esta mais novo que o backup"
);

const crua = enviada("5500900000008");
ok(!!crua, "a conversa que existe mas esta crua tambem foi enviada");
igual(crua.nome, "Conta com rotulo no lugar do id", "com destino VAZIO, o backup PREENCHE o nome (senao a 1a carga nao serviria)");
igual(crua.responsavel_nome, "Ana Atendente", "e preenche o responsavel historico");
igual(crua.etiquetas, ["Cliente"], "e a etiqueta entra (uniao com lista vazia e ela mesma)");

const arq2 = fs.readdirSync(TRABALHO2).find((f) => f.startsWith("relatorio-") && f.endsWith(".json"));
const e2 = JSON.parse(fs.readFileSync(path.join(TRABALHO2, arq2), "utf8"));
igual(
  e2.destino.preservado_do_painel,
  { nome: 1, foto_url: 1, responsavel_nome: 1, etiquetas_unidas: 1 },
  "e o relatorio CONTA o que foi preservado, em vez de deixar isso invisivel"
);
// ...E NO MARKDOWN, que e o que o operador le. Enterrado so no json, o numero que
// responde "reimportar apagou o que a equipe fez?" nao chega a quem pergunta.
const md2 = fs.readFileSync(path.join(TRABALHO2, arq2.replace(/\.json$/, ".md")), "utf8");
ok(md2.includes("O que o painel ja tinha e NAO foi sobrescrito"), "o markdown tem a secao do trabalho preservado");
ok(md2.includes("Etiquetas **unidas**"), "e diz que etiqueta e UNIAO, nao substituicao");
ok(!md2.includes("undefined"), "sem buraco no markdown da rodada com destino");

// EXIT CODE: a rodada com destino terminou pelo caminho de rede e o processo
// precisa sair 0. Com `process.exit()` e socket em keep-alive, o Node aborta no
// Windows com assertion de libuv (exit 3221226505) e o operador le "falhou" numa
// carga que deu certo. `execFileSync` acima ja teria lancado — aqui a checagem
// fica EXPLICITA, e no fonte tambem, pra ninguem reintroduzir o `process.exit`.

// AS PECAS COMPARTILHADAS DE RE-HOSPEDAGEM respondem pelo mesmo contrato: sem
// estas duas linhas, "usa o drenar de rehospedagem.mjs" (aceito logo abaixo) seria
// uma porta de saida — bastaria exportar uma funcao vazia com o nome certo.
{
  const compartilhado = fs.readFileSync(path.join(AQUI, "rehospedagem.mjs"), "utf8");
  ok(compartilhado.includes("r.body?.cancel()"), "rehospedagem.mjs (o drenar compartilhado) drena de verdade");
  ok(
    /export\s+async\s+function\s+subirParaStorage/.test(compartilhado) && /x-upsert/.test(compartilhado),
    "rehospedagem.mjs sobe com x-upsert (repetir a rodada sobrescreve o MESMO objeto)"
  );
}
// `anexos.mjs` (Frente W) entra na lista pelo mesmo motivo dos outros tres: ele fala
// com Storage e PostgREST em laco. Guarda que nasce cobrindo 3 de 4 arquivos vira
// guarda que nao cobre o proximo.
for (const arquivo of ["chatguru.mjs", "midia.mjs", "config-restante.mjs", "anexos.mjs"]) {
  const fonte = fs.readFileSync(path.join(AQUI, arquivo), "utf8");
  ok(
    !/\nprocess\.exit\((?!2\))/.test(fonte),
    `${arquivo} termina com process.exitCode, nunca process.exit (socket em keep-alive aborta o Node)`
  );
  // DRENAR o corpo: a guarda aceita as DUAS formas legitimas — drenar no proprio
  // arquivo, ou usar o `drenar` compartilhado de `rehospedagem.mjs` (onde ele mora
  // desde a Frente W, quando o passo de anexos passou a precisar das mesmas pecas).
  // A guarda antiga era grep de UMA frase e reprovou a extracao mesmo com o
  // comportamento intacto; a nova pergunta se o arquivo drena OU importa quem drena,
  // e continua fechada: tirar o `cancel()` do modulo compartilhado reprova os dois.
  const drenaAqui = fonte.includes("r.body?.cancel()");
  const usaCompartilhado =
    /import\s*\{[^}]*\bdrenar\b[^}]*\}\s*from\s*"\.\/rehospedagem\.mjs"/.test(fonte) &&
    /\bdrenar\s*\(/.test(fonte);
  ok(
    drenaAqui || usaCompartilhado,
    `${arquivo} drena o corpo da resposta (corpo nao lido segura o socket)`
  );
}
fs.rmSync(TRABALHO2, { recursive: true, force: true });

console.log("\n-- relatorio em markdown");
const md = fs.readFileSync(path.join(TRABALHO, arq.replace(/\.json$/, ".md")), "utf8");
ok(md.includes("# Relatorio de importacao"), "o markdown foi gerado");
ok(md.includes("SIMULACAO (--dry)"), "o markdown diz em alto e bom som que nada foi gravado");
ok(!md.includes("undefined"), "o markdown nao tem buraco (nenhum 'undefined')");

fs.rmSync(TRABALHO, { recursive: true, force: true });
console.log(`\n${falhas ? `${falhas} FALHA(S)` : "TUDO OK"}`);
process.exit(falhas ? 1 : 0);
