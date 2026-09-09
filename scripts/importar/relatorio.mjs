// Relatorio de validacao da importacao: compara ORIGEM (o backup) com DESTINO
// (o que foi gravado, ou — em --dry — o que SERIA gravado) e lista o que sobrou
// de fora. Saida em Markdown, pra colar num chamado, anexar a um e-mail ou
// converter em PDF.
//
// Usado automaticamente por chatguru.mjs. Da pra rodar de novo em cima dos dados
// de uma execucao passada (o .json que fica ao lado do .md):
//
//   node scripts/importar/relatorio.mjs --dados <relatorio-....json> [--saida <arquivo.md>]

import fs from "node:fs";

const n = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("pt-BR"));
const data = (v) => {
  if (!v) return "—";
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
};

// diferenca origem x destino: o que a linha explica (0 = tudo casou)
function linha(rotulo, origem, destino, obs = "") {
  const dif = typeof origem === "number" && typeof destino === "number" ? destino - origem : null;
  const marca = dif === null ? "" : dif === 0 ? "OK" : dif > 0 ? `+${n(dif)}` : n(dif);
  return `| ${rotulo} | ${n(origem)} | ${n(destino)} | ${marca} | ${obs} |`;
}

export function renderRelatorio(e) {
  const o = e.origem || {};
  const d = e.destino || {};
  const desc = e.descartados || {};
  const orf = e.orfaos || {};
  const dry = String(e.modo || "").startsWith("dry");
  const m = e.mapeado || {};
  // "mapeado" e o que a leitura do backup produziu. Chamar isso de "gravado"
  // seria mentira quando um lote falha: a prova da gravacao e a secao 1.1
  // (contagem real da tabela antes e depois).
  const colunaDestino = dry ? "seria gravado" : "mapeado";

  const ignorados = Object.entries(desc.tipo_ignorado || {});
  const totalIgnorado = ignorados.reduce((a, [, v]) => a + v, 0);
  const descartadoTotal =
    (desc.sem_data || 0) +
    (desc.apagadas || 0) +
    (desc.sem_conteudo || 0) +
    (desc.duplicadas_no_backup || 0) +
    totalIgnorado;

  const L = [];
  L.push(`# Relatorio de importacao — ChatGuru para Expert Chat`);
  L.push("");
  L.push(`- **Gerado em:** ${data(e.gerado_em)}`);
  L.push(`- **Modo:** ${dry ? "SIMULACAO (--dry) — nenhuma conexao foi aberta e nada foi gravado" : e.modo}`);
  L.push(`- **Origem (backup):** \`${e.pasta}\``);
  L.push(`- **Destino:** ${e.destino_host ? `\`${e.destino_host}\` · schema \`${e.schema}\` · canal \`${e.canal}\`` : `schema \`${e.schema}\` · canal \`${e.canal}\` (sem destino: simulacao)`}`);
  L.push(`- **Tabelas:** \`${e.tabelas?.conversas}\` / \`${e.tabelas?.mensagens}\``);
  L.push("");

  L.push(`## 1. Contagem por entidade`);
  L.push("");
  L.push(`| Entidade | lidos nesta passada | ${colunaDestino} | diferenca | observacao |`);
  L.push(`| --- | ---: | ---: | ---: | --- |`);
  L.push(linha("Conversas (indice)", o.conversas_no_indice, m.conversas, o.conversas_processadas !== o.conversas_no_indice ? `processadas: ${n(o.conversas_processadas)} (--limite)` : ""));
  L.push(linha("Mensagens recebidas", null, m.mensagens_entrada, "direcao `in`"));
  L.push(linha("Mensagens enviadas", null, m.mensagens_saida, "direcao `out`"));
  L.push(linha("Anotacoes internas", null, m.notas_internas, "direcao `interna`, tipo `nota`"));
  L.push(linha("Itens de conversa (total)", o.itens_lidos_nesta_passada, m.mensagens_total, descartadoTotal ? `${n(descartadoTotal)} descartados (secao 3)` : ""));
  L.push(
    linha(
      "Etiquetas (catalogo)",
      o.etiquetas_no_catalogo,
      d.etiquetas_catalogo,
      d.etiquetas_catalogo === null ? "**GRAVACAO FALHOU** — ver secao de erros" : `usadas em conversas: ${n(o.etiquetas_usadas_em_conversas)}`
    )
  );
  L.push(
    linha(
      "Atendentes (autoria)",
      o.usuarios,
      dry ? o.usuarios : d.autores,
      d.autores === null && !dry ? "**GRAVACAO FALHOU** — ver secao de erros" : "so o NOME e preservado; nenhuma conta de login e criada"
    )
  );
  L.push(linha("Funis", o.funis, 0, "sem tabela no painel — ver pendencias"));
  L.push(linha("Etapas de funil", o.etapas_de_funil, 0, "sem tabela no painel — ver pendencias"));
  L.push("");
  if (o.passada_completa === false)
    L.push(
      `> Esta foi uma passada PARCIAL: ${n(d.conversas_puladas_pelo_checkpoint)} conversa(s) ja constavam no checkpoint e nem foram relidas. Por isso a coluna diz "lidos nesta passada" — pra ver o acervo inteiro, compare com a secao 1.1 ou rode com \`--recomecar\`.`
    );
  if (!dry) {
    L.push(
      `> Gravado de fato (lotes que o banco aceitou): ${n(d.gravado?.conversas)} conversa(s) e ${n(d.gravado?.mensagens)} mensagem(ns).`
    );
    if (d.perdidos_em_lote_falhado)
      L.push(
        `> **${n(d.perdidos_em_lote_falhado)} mensagem(ns) ficaram num lote que falhou** e nao entraram no checkpoint — rodar de novo tenta outra vez.`
      );
    // TRABALHO HUMANO PRESERVADO — no MARKDOWN, nao so no json. Quem le o
    // relatorio e o operador, e este e o numero que responde a duvida dele
    // ("reimportar apagou o que a equipe fez?"). Enterrado no json, ninguem ve.
    const pp = d.preservado_do_painel;
    const totalPreservado = pp
      ? (pp.nome || 0) + (pp.foto_url || 0) + (pp.responsavel_nome || 0) + (pp.etiquetas_unidas || 0)
      : 0;
    if (totalPreservado) {
      L.push("");
      L.push(`### O que o painel ja tinha e NAO foi sobrescrito`);
      L.push("");
      L.push(
        `O upsert e \`merge-duplicates\`: toda chave enviada sobrescreve o destino. Nas conversas que JA existiam, ` +
          `o importador **omitiu** o que o painel ganhou depois da primeira carga — o backup e mais VELHO que o painel.`
      );
      L.push("");
      L.push(`| Dado vivo do painel | Conversas em que foi preservado |`);
      L.push(`| --- | ---: |`);
      L.push(`| Nome corrigido na ficha | ${n(pp.nome)} |`);
      L.push(`| Foto do contato | ${n(pp.foto_url)} |`);
      L.push(`| Responsavel (quem tem conta vence o espelho historico) | ${n(pp.responsavel_nome)} |`);
      L.push(`| Etiquetas **unidas** (a da equipe fica, a historica entra) | ${n(pp.etiquetas_unidas)} |`);
      L.push("");
    }
  }
  if (m.com_midia !== undefined) L.push(`> Mensagens com midia apontando pra URL utilizavel: ${n(m.com_midia)}.`);
  if (e.avisos?.textos_truncados) L.push(`> ${n(e.avisos.textos_truncados)} mensagem(ns) tiveram o texto truncado no teto do importador.`);
  L.push("");

  if (d.antes || d.depois) {
    L.push(`## 1.1 Conferencia no banco de destino`);
    L.push("");
    L.push(`Contagem real das tabelas antes e depois da execucao — e a prova de que o que saiu daqui chegou la.`);
    L.push("");
    L.push(`| Tabela | antes | depois | entraram |`);
    L.push(`| --- | ---: | ---: | ---: |`);
    L.push(`| \`${e.tabelas?.conversas}\` | ${n(d.antes?.conversas)} | ${n(d.depois?.conversas)} | ${n(d.entraram?.conversas)} |`);
    L.push(`| \`${e.tabelas?.mensagens}\` | ${n(d.antes?.mensagens)} | ${n(d.depois?.mensagens)} | ${n(d.entraram?.mensagens)} |`);
    L.push("");
    L.push(`> Esta secao — e nao a coluna "mapeado" — e a prova da gravacao. "Entraram" menor que "mapeado" e o esperado numa reexecucao: o banco recusa a duplicata pelo \`provider_msg_id\`.`);
    L.push("");
  }

  L.push(`## 2. Datas-limite`);
  L.push("");
  L.push(`| Marco | Quando |`);
  L.push(`| --- | --- |`);
  L.push(`| Mensagem mais antiga | ${data(e.datas?.mensagem_mais_antiga)} |`);
  L.push(`| Mensagem mais recente | ${data(e.datas?.mensagem_mais_recente)} |`);
  L.push("");
  L.push(`> Confira a mensagem mais recente contra o dia em que o backup foi tirado: se estiver muito atras, o backup esta velho e vale reexportar antes de cortar o sistema antigo.`);
  L.push("");

  L.push(`## 3. O que NAO entrou (e por que)`);
  L.push("");
  L.push(`| Motivo | Itens |`);
  L.push(`| --- | ---: |`);
  L.push(`| Sem data utilizavel (nao da pra posicionar na conversa) | ${n(desc.sem_data)} |`);
  L.push(`| Apagadas/ocultas na origem | ${n(desc.apagadas)} |`);
  L.push(`| Anotacao sem texto | ${n(desc.sem_conteudo)} |`);
  L.push(`| Repetidas dentro do proprio backup (a exportacao repete entre paginas) | ${n(desc.duplicadas_no_backup)} |`);
  for (const [tipo, qtd] of ignorados) L.push(`| Tipo sem equivalente no painel: \`${tipo}\` | ${n(qtd)} |`);
  L.push(`| **Total descartado** | **${n(descartadoTotal)}** |`);
  L.push("");
  L.push(
    `Conferencia: **${n(o.itens_lidos_nesta_passada)} lidos = ${n(m.mensagens_total)} mapeados + ${n(descartadoTotal)} descartados**.`
  );
  L.push("");
  if (desc.conversas_colapsadas)
    L.push(
      `> ${n(desc.conversas_colapsadas)} conversa(s) do indice foram colapsadas: o mesmo telefone aparecia em mais de uma entrada (tipicamente uma ativa e uma arquivada) e vira UMA conversa no painel, ficando com a mais recente. As mensagens das duas entram — a contagem acima nao muda.`
    );
  if (desc.conversas_colapsadas) L.push("");
  if (d.por_tipo && Object.keys(d.por_tipo).length) {
    L.push(`Distribuicao das mensagens importadas por tipo:`);
    L.push("");
    L.push(`| Tipo | Qtd |`);
    L.push(`| --- | ---: |`);
    for (const [t, q] of Object.entries(d.por_tipo).sort((a, b) => b[1] - a[1])) L.push(`| \`${t}\` | ${n(q)} |`);
    L.push("");
  }

  L.push(`## 4. Orfaos e o que nao casou`);
  L.push("");
  L.push(`| Achado | Qtd |`);
  L.push(`| --- | ---: |`);
  L.push(`| Arquivos de mensagem sem conversa correspondente no indice | ${n(orf.arquivos_sem_chat_no_indice)} |`);
  L.push(`| Conversas do indice sem arquivo de mensagens no backup | ${n(orf.chats_sem_arquivo_de_mensagens)} |`);
  L.push(`| Autoria com id que nao esta na lista de usuarios exportada | ${n(orf.autores_desconhecidos)} |`);
  L.push(`| Envios que nunca tiveram autor na origem (robo/campanha) | ${n(orf.envios_sem_autor_na_origem)} |`);
  L.push(`| Etiquetas usadas em conversa mas fora do catalogo exportado | ${n((orf.etiquetas_fora_do_catalogo || []).length)} |`);
  L.push(`| Etiquetas que casaram por nome e adotaram o nome do catalogo | ${n(orf.etiquetas_normalizadas)} |`);
  L.push(`| Anotacoes assinadas pelo robo (nao ha usuario pra casar) | ${n(orf.anotacoes_assinadas_pelo_robo)} |`);
  L.push(`| Etapas de funil referenciadas e desconhecidas | ${n((orf.etapas_de_funil_desconhecidas || []).length)} |`);
  L.push("");
  const semTraducao = Object.entries(orf.tipos_sem_traducao || {});
  if (semTraducao.length) {
    L.push(`Tipos de mensagem que a origem tem e o painel nao conhece — entraram como \`unknown\`, com o texto preservado:`);
    L.push("");
    for (const [t, q] of semTraducao.sort((a, b) => b[1] - a[1])) L.push(`- \`${t}\`: ${n(q)}`);
    L.push("");
  }
  if ((orf.etiquetas_fora_do_catalogo || []).length) {
    L.push(`Etiquetas fora do catalogo (entraram assim mesmo, pra nao perder a marcacao — revisar nas Configuracoes):`);
    L.push("");
    for (const t of orf.etiquetas_fora_do_catalogo.slice(0, 50)) L.push(`- ${t}`);
    if (orf.etiquetas_fora_do_catalogo.length > 50) L.push(`- ...e mais ${n(orf.etiquetas_fora_do_catalogo.length - 50)}`);
    L.push("");
  }

  // ─── 4.1 retrato da origem ─────────────────────────────────────────────────
  const co = e.conversas_origem;
  if (co && Object.keys(co.por_status || {}).length) {
    L.push(`## 4.1 Retrato da origem: status, arquivo e delegacao`);
    L.push("");
    L.push(`| Status na origem | Conversas |`);
    L.push(`| --- | ---: |`);
    for (const [s, q] of Object.entries(co.por_status).sort((a, b) => b[1] - a[1])) L.push(`| ${s} | ${n(q)} |`);
    L.push("");
    L.push(
      `**Arquivado na origem significa ENCERRADO, nao descarte** — e a tabela abaixo e o que sustenta essa ` +
        `leitura. ${n(co.arquivadas)} conversa(s) chegaram arquivadas, e TODAS entram.`
    );
    L.push("");
    L.push(`| Arquivo x status | Conversas |`);
    L.push(`| --- | ---: |`);
    for (const [k, q] of Object.entries(co.arquivada_x_status || {}).sort((a, b) => b[1] - a[1]))
      L.push(`| ${k} | ${n(q)} |`);
    L.push("");
    const kinds = Object.entries(co.por_kind || {});
    if (kinds.length) L.push(`Tipos de conversa na origem: ${kinds.map(([k, q]) => `${k} (${n(q)})`).join(" · ")}.`);
    L.push("");
    L.push(`| Achado | Conversas |`);
    L.push(`| --- | ---: |`);
    L.push(`| Com mais de um usuario delegado | ${n(co.delegacao_multipla_usuarios)} |`);
    L.push(`| Com mais de um departamento delegado | ${n(co.delegacao_multipla_departamentos)} |`);
    L.push(`| Em mais de uma etapa de funil ao mesmo tempo | ${n(co.em_mais_de_uma_etapa)} |`);
    L.push(`| Com status nulo na origem (entram como "aberto") | ${n(co.status_nulo)} |`);
    L.push("");
  }

  // ─── 4.2 o que foi preservado ──────────────────────────────────────────────
  const pr = e.preservados;
  if (pr) {
    L.push(`## 4.2 O que a mensagem carrega alem do texto`);
    L.push("");
    L.push(`| Atributo | Mensagens |`);
    L.push(`| --- | ---: |`);
    L.push(`| Citacao / resposta a outra mensagem | ${n(pr.citacao)} |`);
    L.push(
      `| &nbsp;&nbsp;recasadas: vinham no formato longo, o alvo usa o id nu | ${n(pr.citacao_recasada_por_formato)} |`
    );
    L.push(
      `| &nbsp;&nbsp;com o alvo FORA do import (aponta pro vazio) | ${n(pr.citacao_com_alvo_fora_do_import)} |`
    );
    if (pr.citacao_com_hex_ambiguo)
      L.push(`| &nbsp;&nbsp;com identificador ambiguo (ficaram como vieram) | ${n(pr.citacao_com_hex_ambiguo)} |`);
    L.push(`| Reacao | ${n(pr.reacao)} |`);
    L.push(`| Editada na origem | ${n(pr.editada)} |`);
    L.push(`| Encaminhada | ${n(pr.encaminhada)} |`);
    L.push(`| Apagada pra todos (entra marcada, nao descartada) | ${n(pr.apagada_marcada)} |`);
    L.push(`| Enviada por template | ${n(pr.por_template)} |`);
    L.push(`| Enviada pelo aparelho (fora do painel de origem) | ${n(pr.do_aparelho)} |`);
    L.push(`| Envio que a origem marcou como falho | ${n(pr.com_erro_de_envio)} |`);
    L.push("");
    const entrega = Object.entries(pr.estado_de_entrega || {});
    if (entrega.length) {
      L.push(`Estado de entrega (vem do \`ack\` do WhatsApp, nao de um "sent" generico):`);
      L.push("");
      for (const [s, q] of entrega.sort((a, b) => b[1] - a[1])) L.push(`- \`${s}\`: ${n(q)}`);
      L.push("");
    }
    const degr = Object.entries(pr.tipos_degradados || {});
    if (degr.length) {
      L.push(`Tipos sem equivalente no painel que entraram como TEXTO (o texto sobrevive, a estrutura nao):`);
      L.push("");
      for (const [t, q] of degr.sort((a, b) => b[1] - a[1])) L.push(`- \`${t}\`: ${n(q)}`);
      L.push("");
    }
  }

  // ─── 4.3 midia ─────────────────────────────────────────────────────────────
  const mid = e.midia;
  if (mid && (mid.arquivos || mid.sem_url)) {
    L.push(`## 4.3 Midia — inventario pra re-hospedagem`);
    L.push("");
    L.push(
      `As URLs de midia apontam pro armazenamento do fornecedor antigo e **morrem com a conta**. Este ` +
        `inventario e o insumo do passo separado \`scripts/importar/midia.mjs\`, que baixa, sobe pro storage ` +
        `da instalacao e reescreve o endereco nas mensagens ja importadas. Atencao ao denominador: aqui a ` +
        `contagem e POR MENSAGEM (o mesmo arquivo citado em varias conta varias vezes); o numero deduplicado ` +
        `por arquivo, que e o que define custo de armazenamento, sai no relatorio daquele passo.`
    );
    L.push("");
    L.push(`| Item | Valor |`);
    L.push(`| --- | ---: |`);
    L.push(`| Mensagens com arquivo utilizavel | ${n(mid.arquivos)} |`);
    // UNIDADE DECLARADA: GB decimal (10^9 bytes), a mesma conta usada no card e no
    // relatorio do passo de midia. Sem o rotulo, o mesmo acervo aparece com dois
    // numeros diferentes (GB x GiB dao ~7% de diferenca) e a conferencia trava.
    L.push(
      `| Tamanho declarado, somado por mensagem | ${(Number(mid.bytes || 0) / 1e9).toFixed(2)} GB (10^9 bytes) |`
    );
    L.push(`| Mensagens com arquivo sem URL utilizavel | ${n(mid.sem_url)} |`);
    L.push("");
    const porTipoMidia = Object.entries(mid.por_tipo || {});
    if (porTipoMidia.length)
      L.push(`Por tipo: ${porTipoMidia.sort((a, b) => b[1] - a[1]).map(([t, q]) => `${t} (${n(q)})`).join(" · ")}.`);
    const mimes = Object.entries(mid.por_mime || {}).sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (mimes.length) L.push(`Principais mime types: ${mimes.map(([t, q]) => `\`${t}\` (${n(q)})`).join(" · ")}.`);
    L.push("");
  }

  // ─── 4.4 referencias ───────────────────────────────────────────────────────
  const tabRef = e.referencias?.tabela || [];
  if (tabRef.length) {
    L.push(`## 4.4 Referencias: resolvidas, ambiguas ou mortas`);
    L.push("");
    L.push(
      `Tudo que aponta pra outra entidade passa por um resolvedor unico. A regra e a mesma pra todo tipo: ` +
        `um alvo unico resolve; nome **ambiguo** ou alvo **morto** vira RESSALVA declarada, nunca chute — ` +
        `apontar pro alvo errado e pior que nao ter a referencia. "Sem alvo" e placeholder da origem, ` +
        `nao perda (nunca houve alvo), e por isso fica fora do denominador da taxa.`
    );
    L.push("");
    L.push(`| Referencia | Total | Sem alvo | Com alvo | Por id | Por nome | Por posicao | Ambiguo | Morto | Resolvido |`);
    L.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
    for (const l of tabRef) {
      const pct = l.taxa_resolvido === null ? "—" : `${String(l.taxa_resolvido).replace(".", ",")}%`;
      L.push(
        `| ${l.tipo} | ${n(l.total)} | ${n(l.sem_alvo_na_origem)} | ${n(l.com_alvo)} | ${n(l.por_id)} | ` +
          `${n(l.por_nome)} | ${n(l.por_posicao)} | ${n(l.ambiguo)} | ${n(l.morto)} | ${pct} |`
      );
    }
    L.push("");
    const totalRessalvas = tabRef.reduce((a, l) => a + (l.ressalvas || 0), 0);
    L.push(
      totalRessalvas
        ? `> ${n(totalRessalvas)} referencia(s) ficaram de ressalva. Os valores que nao casaram estao no json deste relatorio, em \`referencias.ressalvas\` (amostra por tipo).`
        : `> Nenhuma ressalva: toda referencia com alvo resolveu pra um alvo unico.`
    );
    L.push("");
  }

  L.push(`## 5. Pendencias pra revisao humana`);
  L.push("");
  if (!(e.pendencias || []).length) {
    L.push(`Nenhuma.`);
  } else {
    for (const p of e.pendencias) L.push(`- **${p.tema}:** ${p.detalhe}`);
  }
  L.push("");

  if ((e.erros || []).length) {
    L.push(`## 6. Erros na execucao`);
    L.push("");
    for (const x of e.erros.slice(0, 30)) L.push(`- ${x}`);
    if (e.erros.length > 30) L.push(`- ...e mais ${n(e.erros.length - 30)}`);
    L.push("");
  }

  L.push(`---`);
  L.push("");
  L.push(
    dry
      ? `Simulacao: rode de novo sem \`--dry\` (com \`--url\` e \`--key\`) pra importar de verdade. A importacao e idempotente — repetir nunca duplica.`
      : `A importacao e idempotente: rodar de novo completa o que faltou e nunca duplica.`
  );
  return L.join("\n") + "\n";
}

// execucao direta: re-renderiza o markdown a partir do json de uma rodada
const executadoDireto = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/importar/relatorio.mjs");
if (executadoDireto) {
  const arg = (nome) => {
    const i = process.argv.indexOf(`--${nome}`);
    return i > -1 ? process.argv[i + 1] : undefined;
  };
  const dados = arg("dados");
  if (!dados) {
    console.log("uso: node scripts/importar/relatorio.mjs --dados <relatorio-....json> [--saida <arquivo.md>]");
    process.exit(2);
  }
  const md = renderRelatorio(JSON.parse(fs.readFileSync(dados, "utf8")));
  const saida = arg("saida");
  if (saida) {
    fs.writeFileSync(saida, md);
    console.log(saida);
  } else {
    process.stdout.write(md);
  }
}
