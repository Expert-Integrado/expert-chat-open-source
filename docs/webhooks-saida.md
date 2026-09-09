# Webhook de saída por evento

O painel avisa um sistema seu toda vez que algo acontece numa conversa. Você
cadastra o destino **uma vez** e recebe sempre — não precisa desenhar fluxo
nenhum.

> Não confunda com a **ação `webhook` dentro de um fluxo** (motor de automação):
> lá você decide, passo a passo, quando chamar. Aqui é por evento, sem fluxo no
> meio.

Implementação: `lib/webhooks-saida.ts` (helper único). Prova sem rede e sem
banco: `node scripts/prova-webhooks-saida.ts`.

---

## Como cadastrar um destino

Pela tela: **Configurações → Automação → Webhooks de saída** (só super admin,
rota `/api/admin/webhooks-saida`).

O segredo **nunca volta** pra tela — o `GET` devolve só `segredo_definido: true`.
Por isso o campo de segredo aparece sempre em branco: digitar troca, deixar em
branco mantém o que está guardado, e apagar de verdade tem botão próprio.

Por configuração direta, quando a tela não for opção (instalação sem admin
logado, provisionamento automatizado): a lista mora em `mensageria.config`, na
chave `webhooks_saida`, como um array JSON.

```sql
insert into mensageria.config (chave, valor) values (
  'webhooks_saida',
  '[
    {
      "nome": "CRM",
      "url": "https://sistema-do-cliente.exemplo/hooks/expert-chat",
      "eventos": ["mensagem_recebida", "status_alterado", "conversa_concluida"],
      "segredo": "troque-por-um-segredo-longo",
      "ativo": true,
      "incluir_conteudo": false
    }
  ]'::jsonb
)
on conflict (chave) do update set valor = excluded.valor, updated_at = now();
```

| campo | obrigatório | o que faz |
|---|---|---|
| `url` | sim | destino do POST. **Só `https`**, sem usuário/senha embutidos na URL, e sem IP literal de rede interna (loopback, `10.x`, `192.168.x`, `169.254.x`, IPv6 literal). Cada URL só pode aparecer uma vez. |
| `eventos` | sim | lista dos eventos que este destino quer. Nome desconhecido é ignorado. |
| `nome` | não | rótulo só pra tela do admin. Nunca vai no payload. |
| `segredo` | não | liga a assinatura HMAC. Sem ele, a entrega vai sem assinar. |
| `ativo` | não | default `true`. Só `false` de verdade desliga. |
| `incluir_conteudo` | não | default `false`. Ver **Privacidade**. |

Regras de saneamento (as mesmas que a prova exercita): destino inválido é
**descartado em silêncio** — configuração torta nunca vira entrega pro lugar
errado nem derruba o painel. Teto de 20 destinos. A lista é relida a cada 30s.

---

## Eventos da v1

| evento | quando dispara | `dados` |
|---|---|---|
| `mensagem_recebida` | mensagem do cliente entra (webhook do provedor ou sync) | `tipo`, `de_grupo`, `tem_midia`, `provider_msg_id`, `tamanho` |
| `status_alterado` | status da conversa muda no painel | `de`, `para`, `por_id`, `por_nome` |
| `conversa_concluida` | conversa vai pra `concluido` | `por_id`, `por_nome`, `origem` (`painel` ou `automacao`) |
| `avaliacao_registrada` | cliente responde a pesquisa de satisfação | `nota` (1–5), `atendente_id`, `atendente_nome` |

`conversa_concluida` sai **junto** com `status_alterado` quando o novo status é
`concluido` — quem só quer o encerramento assina um; quem quer toda transição
assina o outro.

### Cobertura de `status_alterado` na v1 — leia antes de depender dela

Dispara em **duas** origens, e só nelas:

- `origem: "painel"` — alguém trocou o status na tela (ou pela API/MCP, que
  passam pela mesma rota `/api/conversa`), incluindo concluir e reabrir;
- `origem: "automacao"` — a pesquisa de satisfação concluiu a conversa sozinha
  ao receber a nota.

**Status reafirmado não é evento.** Gravar `concluido` numa conversa que já
estava concluída não dispara nada — o `de` e o `para` precisam ser diferentes.
É por isso que a resposta da pesquisa de satisfação normalmente **não** gera um
segundo `conversa_concluida`: a conversa já tinha sido encerrada quando a
pergunta saiu.

**Ainda não dispara** nas trocas de status que acontecem de raspão em outros
caminhos: a conversa que vai pra `atendimento` porque alguém respondeu
(`auto_atendimento_ao_responder`, no envio e no encaminhamento), a que reabre
como `aberto` porque o cliente escreveu (`auto_desarquivar_recebida`, na
ingestão) e a que o motor de automação move num fluxo. Nesses casos você recebe
`mensagem_recebida`, mas não o `status_alterado` correspondente.

Se o seu sistema precisa do estado exato da conversa, trate o evento como
**gatilho pra buscar**, não como fonte da verdade: ao receber qualquer evento,
leia a conversa pela API do painel.

---

## Formato do corpo

`POST`, `content-type: application/json`, JSON puro:

```json
{
  "versao": 1,
  "evento": "mensagem_recebida",
  "id": "8f14e45f-ceea-467a-9e1c-2b7f0e2a1234",
  "em": "2026-08-31T14:32:10.482Z",
  "canal": "central",
  "chat_id": "5500000000000",
  "dados": {
    "tipo": "text",
    "de_grupo": false,
    "tem_midia": false,
    "provider_msg_id": "3EB0ABC123",
    "tamanho": 42
  }
}
```

- `id` é o **id do disparo**, não o da mensagem. Use pra deduplicar a
  retentativa: o mesmo `id` chegando duas vezes é a mesma entrega.
- `em` é sempre **UTC** (`Z`). O fuso de exibição é assunto do seu sistema; o do
  painel está em `lib/fuso.ts`.
- `chat_id` + `canal` são a chave da conversa. No WhatsApp o `chat_id` é o
  telefone; no Instagram é o IGSID.
- O payload é propositalmente **pequeno**. Ele avisa que algo aconteceu; o
  detalhe você busca pela API do painel (ou pelo MCP) com a sua chave.

---

## Compatibilidade de formato: `expert`, `plano` e `mapa`

O corpo acima é o formato `expert`, e é o **default** — quem já tem destino
cadastrado não vê diferença nenhuma. Os outros dois existem por um motivo medido:
na migração de uma ferramenta antiga, os cenários que recebiam os webhooks
**continuam vivos**, mas quem passa a chamá-los é o Expert Chat. Se o corpo for
diferente do que aquele cenário lê, ele **para de funcionar em silêncio** — o
serviço responde 200 e simplesmente não acha os campos.

| modo | o que sai |
|---|---|
| `expert` | o JSON aninhado acima (default) |
| `plano` | as mesmas informações, sem aninhamento: `evento`, `chat_id`, `canal`, `tipo`, `conteudo`… tudo no primeiro nível |
| `mapa` | **você declara** o nome de cada campo do destino e de onde vem o valor |

`tipo_conteudo` escolhe `json` (default) ou `form`
(`application/x-www-form-urlencoded`) — cenário antigo montado pra formulário não
lê JSON.

No modo `mapa`, o valor de cada campo vem de um caminho de uma **lista fechada**:
`$evento`, `$chat_id`, `$canal`, `$id`, `$em`, `$dados.tipo`, `$dados.tem_midia`,
`$dados.provider_msg_id`, `$dados.tamanho`, `$conteudo` (apelido de
`$dados.conteudo`) — e texto literal, se você escrever algo que não começa com `$`.

Exemplo (o destino espera `phone`, `text` e `source`):

```json
{
  "modo": "mapa",
  "tipo_conteudo": "form",
  "mapa": { "phone": "$chat_id", "text": "$conteudo", "source": "expert-chat" }
}
```

Mapa **vazio** é recusado na gravação (HTTP 400) em vez de salvar rebaixado pro
modo `expert`: aceitar e mudar por trás é como um "salvei" que salva outra coisa.

### Não existe um modo "ferramenta antiga", e isso é deliberado

O corpo que a ferramenta anterior POSTA **não está documentado em lugar nenhum** —
nem nos backups, nem no mapeamento (varredura de 31/08/2026 em 6.527 diálogos de 29
contas). O backup guarda o formulário de **configuração** da ação, que é entrada pro
servidor deles, não o corpo de saída. Um modo com esse nome seria chute com carimbo
de compatibilidade, e chute que não casa falha do pior jeito possível: HTTP 200,
cenário silencioso, ninguém sabe por quanto tempo.

**Como descobrir o formato de verdade** (as duas únicas rotas, nesta ordem):

1. abrir um dos cenários no próprio serviço (Make, n8n, Zapier…) e ler a estrutura
   de dados do webhook, ou o corpo recebido numa execução passada — eles guardam;
2. apontar UMA das URLs pra um receptor temporário e disparar o diálogo uma vez.

Com o formato em mãos, o destino se configura no modo `mapa`. Uma vez por formato,
não uma vez por cenário.

### Três coisas medidas que mudam o tamanho do trabalho

1. **A exposição é maior do que a conta piloto sugeria**: 504 URLs configuradas em
   24 de 29 contas (de 2 a 91 por cliente). Hosts: Make/Integromat (239), sistemas
   próprios dos clientes (160), uChat (18), n8n próprio. Uma delas tem um placeholder
   literal no lugar do domínio — configuração quebrada já na origem.
2. **Não é um formato, são três**: o campo de vendor tem `POST PARA URL` (529),
   `RD_STATION` (4) e `ZAPIER` (2). Cada vendor tem corpo próprio — outra razão pra
   não existir um modo único.
3. **Parte do dado viaja na query string, não no corpo**: `service`, `status`,
   `agent_id`, `endpoint`, `token`, `queue`. Duas URLs carregam texto com
   `{PRIMEIRO_NOME_LEAD}` dentro da própria query, como se a origem interpolasse
   variável na URL. **Este painel não interpola**: a URL é enviada literal, com
   query e tudo. Se houver `{VAR}` lá dentro, ela chega assim no destino.

---

## Privacidade — o texto não sai por default

`incluir_conteudo` vem **desligado**. Sem ele, o corpo diz que chegou uma
mensagem de texto de 42 caracteres, e não o que ela diz.

Ligue só quando o destino realmente precisar do texto e você tiver decidido que
o conteúdo das conversas pode sair da instalação. Com a flag ligada, `dados`
ganha `conteudo` (cortado em 4096 caracteres).

A flag vale **igual nos três modos**. No `mapa`, `$conteudo` é apelido de
`$dados.conteudo`: ele lê do payload já filtrado, não recebe o texto por fora.
Portão de privacidade é um só — formato que reimplementa a regra é formato que
esquece a flag.

O `chat_id` (o telefone do cliente) vai em todo evento — é a chave que amarra a
conversa no seu sistema. Se isso já for demais pro seu caso, não cadastre o
destino.

---

## Assinatura HMAC

Com `segredo` preenchido, cada entrega leva:

```text
x-expert-chat-assinatura: sha256=<hex>
```

onde `<hex>` é `HMAC-SHA256(segredo, corpo_cru)`. Confira **sobre o corpo cru**
(os bytes que chegaram), antes de qualquer parse ou reserialização — reserializar
o JSON muda os bytes e a assinatura deixa de bater.

Os outros cabeçalhos:

| cabeçalho | valor |
|---|---|
| `x-expert-chat-evento` | nome do evento |
| `x-expert-chat-entrega` | o `id` do disparo |
| `user-agent` | `expert-chat-webhook/1` |

Todos são **constantes do código**. Nada em cabeçalho ou URL vem de conteúdo de
conversa — conteúdo hostil só existe dentro do corpo JSON, escapado.

Exemplo de verificação (Node):

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function confere(segredo, corpoCru, cabecalho) {
  const esperado = "sha256=" + createHmac("sha256", segredo).update(corpoCru, "utf8").digest("hex");
  const a = Buffer.from(esperado), b = Buffer.from(String(cabecalho ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Compare em tempo constante (`timingSafeEqual`), nunca com `===`. Confira também
o campo `em` pra recusar entrega velha demais pro seu gosto.

---

## Entrega: o que o painel garante (e o que não)

- Dispara **depois** do efeito principal. A mensagem já está gravada e a conversa
  já mudou de status quando o POST sai.
- **Timeout de 5s e uma única retentativa.** `5xx` e falha de rede repetem uma
  vez; `4xx` e `3xx` não repetem (é o destino dizendo que o problema é dele).
- **Não segue redirect.** Um `302` encerra a entrega — corpo assinado não viaja
  pra outro host.
- **Falha nunca quebra nem atrasa o atendimento.** Destino fora do ar não impede
  mensagem de entrar nem conversa de ser concluída.

O que **não** existe na v1, e você deve assumir:

- **Não é fila durável.** Sem as duas tentativas, a entrega se perde. Se o seu
  processo não pode perder evento, trate o webhook como aviso e reconcilie pela
  API (busque o que mudou desde a última sincronização).
- **Sem log de entregas na tela.** Diagnóstico é do lado do receptor.
- **Sem recuo exponencial e sem ordem garantida** entre eventos.

Responda **2xx rápido** (idealmente enfileirando do seu lado). Destino lento
consome o timeout e vira retentativa desnecessária.
