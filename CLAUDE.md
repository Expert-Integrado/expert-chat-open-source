# Expert Chat — CLAUDE.md

> Este repositório é a versão pública do painel de atendimento de WhatsApp da Expert Integrado
> (versão 1.0.0). O histórico interno de decisões não veio junto: o que vale está no código,
> nas migrations e em `docs/`.

## O que é

Painel de atendimento multiatendente (Next.js + Supabase): caixa de entrada compartilhada,
permissões por papel e escopo, ficha do contato, respostas rápidas, agendamento, relatórios,
automação (módulo desligado por padrão, versão instável) e disparo em massa (desligado por padrão).
**Uma instalação por empresa.** Não é multi-tenant.

## Comandos

```bash
npm install
npm run dev                          # http://localhost:3000
npx tsc --noEmit                     # tem que fechar em 0 erros antes de qualquer commit
node scripts/prova-permissoes.ts     # provas: Node >= 22.6, sem build, sem rede
node scripts/instalar/index.mjs      # conferidor da instalação (não altera nada)
```

## Regras que o código depende (não são estilo, são contrato)

- **Código NUNCA cria tabela nem coluna.** Schema só por `supabase/migrations/`, aplicadas na
  mão no SQL Editor, em ordem, sem pular. Rota que precisa de coluna nova degrada com aviso
  enquanto a migration não roda.
- **Nada da empresa no código.** Canal, remetente, domínio, destino de alerta: tudo por env ou
  pela tela de Configurações (`lib/canais.ts`, `lib/alertas.ts`, `lib/modulos.ts` explicam).
- **Segredo só via variável de ambiente.** Nunca literal em arquivo, nunca no navegador
  (`NEXT_PUBLIC_*` é público por definição).
- **Nunca `select *` nem `row_to_json` em `mensageria.config`**: a tabela guarda segredos por
  chave. Leia por `chave` (`where chave in (...)`).
- **Rota nova que resolve canal precisa de entrada EXATA em `CANAL_PADRAO_EM`**
  (`lib/escopo-chave.ts`), com os mesmos métodos do handler; `scripts/prova-seguranca-conta.ts`
  reprova nomeando a rota. Chave de API: mapear o recurso em `MAPA` no mesmo arquivo.
- **Permissão é fail-closed no servidor.** A tela só esconde; quem barra é a rota
  (`lib/permissoes.ts`, `docs/permissoes.md`).
- **Widget embutido (`/widget`)**: o iframe nunca é desmontado pelo hospedeiro (o login com 2FA
  vive dentro dele) e só emoldura origens listadas em `EMBED_FRAME_ANCESTORS`
  (`docs/embed-como-instalar.md`).

## Gotchas de ferramenta

- Arquivos com fim de linha misto (CRLF e LF). Patch por âncora de texto normaliza antes de casar.
- `scripts/` está fora do `tsconfig` de propósito: as provas rodam em Node puro
  (`--experimental-strip-types` em Node 22.6+). Não mova prova pra dentro do build.
- `app/home.tsx` é a tela inteira do painel (grande). Mudança pequena, provada por
  `scripts/prova-tela-conversa.ts` e afins; mudou rótulo/`title`, ajuste a prova junto.
- Deploy: qualquer host Node (Vercel ou VPS). Variável de ambiente só entra em build novo.

## Onde continua

`README.md` (instalação passo a passo), `docs/instalacao.md`, `docs/variaveis.md`,
`docs/permissoes.md`, `docs/disparo.md`, `docs/webhooks-saida.md`, `docs/exportacao.md`,
`docs/embed-como-instalar.md`, `extensao-chrome/README.md`.
