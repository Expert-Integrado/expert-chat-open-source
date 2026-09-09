# Rotas da API do painel (as que um integrador ou agente mais usa)

Autenticação: `Authorization: Bearer <token de sessão do Supabase Auth>` (o navegador) ou
`x-api-key: <chave>` gerada em Configurações → Acesso → Chaves de API (escopo por recurso e
por canal, `docs/permissoes.md`). Toda rota que fala de conversa aceita `canal` (id do canal em
`lib/canais.ts`; sem ele, `central`). Respostas de erro vêm como `{ "error": "..." }`.

| Rota | Método | Parâmetros | Devolve |
|---|---|---|---|
| `/api/chats` | GET | `canal`, `q` (nome ou dígitos), `antes` (ISO, paginação), `limite` (50–600) | `{ chats, canais, tem_mais, ... }` |
| `/api/messages` | GET | **`chat_id`** (não `chat`), `canal` | `{ messages, foto_url, janela }`, mais antiga primeiro |
| `/api/send` | POST | `chat_id`, `message`, `canal`; mídia: `tipo` (image, audio, ptt, video, document) + `media` (data URI base64) + `file_name`; `quoted_msg_id` | `{ ok, messageId }` |
| `/api/busca` | GET | `q` (3+ letras), `canal` | conversas com o trecho que bateu |
| `/api/conversa/busca` | GET | `chat_id`, `canal`, `q` | `{ achados, total }` dentro de uma conversa |
| `/api/conversa` | POST | `chat_id`, `canal`, e um ou mais de: `status`, `arquivada`, `auto_arquivar`, `marcar_lida`, `add_responsavel`, `remove_responsavel`, `bot_ativo` | `{ ok, responsaveis, visibilidade }` |
| `/api/conversa/iniciar` | POST | `canal`, `telefone`, `texto`, `nome`, `confirmado` | `{ ok, chat_id }` |
| `/api/ficha` | GET / PATCH | `chat_id`, `canal`; PATCH: `ficha` (objeto chave→valor; vazio remove) | a ficha com campos, etiquetas, notas |
| `/api/etiquetas` | GET / POST | POST: `chat_id`, `canal`, `etiquetas` (lista do catálogo) | `{ ok, etiquetas }` |
| `/api/nota` | POST | `chat_id`, `canal`, `texto` (com `@Nome` para marcar) | `{ ok, id, mencionados }` |
| `/api/mensagem/reacao` | POST | `id` (da mensagem), `emoji` (vazio remove), `canal` | `{ ok, reacao }` |
| `/api/users` | GET | — | pessoas e departamentos para atribuir |
| `/api/users/senha` | POST | `user_id` (só super admin, só sessão) | `{ ok, email, senha_temporaria }` |

Canal de fonte externa (`whatsapp-agent`): as mesmas rotas; `chat_id` é o telefone (ou o id do
grupo `…@g.us`), e o id de mensagem em `/api/mensagem/reacao` é o UUID do agent. Detalhes em
`docs/canal-whatsapp-agent.md`.
