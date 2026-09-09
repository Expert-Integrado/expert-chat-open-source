import { msgDb } from "./mensageria";
import { tabelas } from "./canal";
import { getConfig } from "./config";
import { notaDaMensagem, registrarAvaliacao } from "./csat";
import type { EstadoLinha } from "./estado-externo";
import type { FonteLigada, MensagemExterna } from "./fonte-externa";

// PESQUISA DE SATISFACAO NO CANAL DO AGENTE (09/09/2026).
//
// No canal principal o WEBHOOK reconhece a nota ("5") que o cliente responde.
// O agente nao manda webhook pro painel: a resposta entra no banco DELE, e o
// painel a ve na proxima leitura da conversa (/api/messages). Entao a nota e
// reconhecida AQUI, na leitura: se a linha de estado esta `aguardando_avaliacao`
// e a mensagem mais recente RECEBIDA depois da pergunta e um numero de 1 a 5,
// registra em `avaliacoes` (a mesma tabela do relatorio de satisfacao), fecha
// a conversa e agradece pela mcp-api. Idempotente: registrar zera a flag.
export async function reconhecerNotaExterna(
  canal: string,
  chatId: string,
  estado: EstadoLinha | undefined,
  mensagens: MensagemExterna[],
  ext: FonteLigada | null
): Promise<void> {
  if (!estado?.aguardando_avaliacao) return;
  // a lista vem em ordem decrescente: a primeira recebida e a mais recente
  const ultimaRecebida = mensagens.find((m) => m.direcao === "in");
  const nota = ultimaRecebida && ultimaRecebida.tipo === "text" ? notaDaMensagem(ultimaRecebida.conteudo) : null;
  if (nota === null) return;
  const cfg = await getConfig();
  await registrarAvaliacao(msgDb(), cfg, tabelas(canal), {
    canal,
    chatId,
    nota,
    conversa: { aguardando_avaliacao: true, responsavel_id: estado.responsavel_id, responsavel_nome: estado.responsavel_nome },
    agradecer: ext?.enviar ? (texto) => ext.enviar!(chatId, { texto, quoted: null }) : undefined,
  });
}
