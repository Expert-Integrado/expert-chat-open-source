import { NextRequest, NextResponse } from "next/server";
import { canalPublico } from "@/lib/canais";
import { exigeConexaoLocal, portaDoCanal, portaDoCorpo, recusou } from "@/lib/canais-porta";
import {
  descreverEvento,
  formatarNumero,
  normalizarNumero,
  validarTroca,
  type TrocaPendente,
} from "@/lib/canal-conexao";
import { estadoDoCanal, gravarTroca, historicoDoCanal, registrarEvento } from "@/lib/canais-db";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// TROCAR O NUMERO DE UM CANAL PRESERVANDO O HISTORICO (card 86ak858nx)
//
//   GET    /api/canais/numero?canal=<id>  -> numero atual, troca pendente, historico
//   POST   /api/canais/numero             -> {canal, numero_novo, consentimento:true}
//   DELETE /api/canais/numero?canal=<id>  -> cancela a troca pendente
//
// O QUE FAZ O HISTORICO SOBREVIVER, e por que isto nao e uma frase de efeito:
// as conversas e as mensagens do canal moram em tabelas nomeadas pelo ID DO CANAL
// (`conversas_<id>` / `mensagens_<id>`, lib/canais.ts) e as tabelas compostas
// (conversa_responsaveis, notificacoes, conversa_visibilidade, conversa_funil) sao
// chaveadas por `(canal, chat_id)`. Esta rota NAO TOCA no id. Ela mexe no numero
// que o canal atende — e nada no historico depende desse numero. E por isso que a
// entidade canal foi separada do numero em 28/08 (secao "Canal e ENTIDADE" do
// CLAUDE.md): sem essa separacao, trocar de chip significaria canal novo, e canal
// novo significaria tabela nova, e tabela nova significaria historico perdido.
//
// A CONCLUSAO NAO ESTA AQUI. Quem conclui e `POST /api/canais/conexao`
// (`acao: "estado"`), quando ve o chip novo conectado — o card e explicito:
// "conectado o chip novo, a troca se conclui", sem clique de confirmacao. Esta
// rota ABRE e CANCELA; concluir e efeito de conectar.
//
// A CREDENCIAL NAO ENTRA NO CORPO, NUNCA. Trocar o chip do MESMO numero de
// provedor (o caso comum) nao muda credencial nenhuma: e reconectar a instancia
// por QR. Se a instalacao precisar apontar o canal pra outra INSTANCIA, isso e
// mudanca de env (`ZAPI_<CANAL>_INSTANCE_ID/_TOKEN`) — gesto humano no ambiente,
// pela regra da casa de segredo nunca virar literal em banco nem em corpo de
// requisicao. O painel DETECTA e REGISTRA essa troca de instancia (a marca em
// `canal_estado.instancia_marca`, comparada em /api/canais/conexao), mas nao a
// executa. Isso esta declarado no report da frente como pendencia de instalacao,
// nao como buraco escondido.

export async function GET(req: NextRequest) {
  // GET e nivel "ler" (`gerenciar_canais`): consultar o numero atual e o
  // historico do canal e diagnostico, e nao mexe em nada.
  const p = await portaDoCanal(req, req.nextUrl.searchParams.get("canal"), "ler");
  if (recusou(p)) return p.erro;
  const [estado, hist] = await Promise.all([
    estadoDoCanal(p.canal.id),
    historicoDoCanal(p.canal.id, 40),
  ]);
  return NextResponse.json(
    {
      canal: canalPublico(p.canal),
      // a identidade DECLARADA na configuracao (env) e o numero CONFERIDO no
      // provedor podem divergir — e essa divergencia e informacao, nao defeito:
      // e o que mostra que a instalacao trocou de chip e nao atualizou o rotulo.
      identidade_configurada: p.canal.identidade || "",
      numero: estado.numero,
      numero_em: estado.numero_em,
      numero_formatado: estado.numero ? formatarNumero(estado.numero) : null,
      troca_pendente: estado.troca,
      historico: hist.lista.map((ev) => ({
        ...ev,
        // a MESMA frase que a tela mostra, montada no servidor: frase copiada
        // entre tela e API diverge sozinha (licao que este repo pagou com a
        // assinatura de mensagem)
        texto: descreverEvento(ev),
      })),
      historico_disponivel: hist.disponivel,
      disponivel: estado.disponivel,
      aviso: estado.aviso,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(req: NextRequest) {
  // QUEM LE O CORPO E A PORTA (GRAVE D1): `req.json()` aqui consumia o corpo antes
  // de `getUser` poder cloná-lo, e o escopo de canal da chave de API ficava inerte.
  // ABRIR TROCA e nivel "operar" (`conectar_numero`): a troca para o canal ate
  // alguem aparecer com um aparelho na mao.
  const p = await portaDoCorpo(req, () => "operar");
  if (recusou(p)) return p.erro;
  const { canal, user, body } = p;

  // numero da API Oficial (e, hoje, Evolution) nao reconecta por aqui: abrir
  // troca pendente pra ele deixaria o canal com um aviso que nunca fecha.
  const local = exigeConexaoLocal(canal);
  if (local) return local;

  const estado = await estadoDoCanal(canal.id);
  if (!estado.disponivel) {
    // sem a 0023 (ou com o banco fora) NAO da pra guardar a pendencia. Aceitar o
    // pedido e nao guardar seria o pior dos mundos: o cliente reconecta o chip
    // achando que a troca esta registrada, e nada foi.
    return NextResponse.json({ error: estado.aviso, disponivel: false }, { status: 503 });
  }
  if (estado.troca) {
    return NextResponse.json(
      {
        error:
          `ja existe uma troca em andamento neste numero (para ${formatarNumero(estado.troca.numero_novo)}) — ` +
          "cancele ela antes de abrir outra",
        troca_pendente: estado.troca,
      },
      { status: 409 }
    );
  }

  // AS DUAS GUARDAS DO CARD, e nenhuma a mais (a regra e pura e provada):
  //  - numero novo tem que ser numero, e diferente do atual;
  //  - `consentimento` tem que vir true, EXPLICITO. Trocar chip nao e editar
  //    campo: o canal para de atender ate alguem ler um QR com o aparelho na mao,
  //    e o cliente precisa entender isso antes de comecar.
  const erros = validarTroca({
    numero_novo: body?.numero_novo,
    consentimento: body?.consentimento,
    numero_atual: estado.numero,
  });
  if (erros.length) {
    return NextResponse.json({ error: erros[0].texto, erros }, { status: 400 });
  }

  const troca: TrocaPendente = {
    numero_novo: normalizarNumero(body.numero_novo)!,
    numero_anterior: estado.numero ?? "",
    iniciada_em: new Date().toISOString(),
    iniciada_por: user.id,
    iniciada_por_nome: user.nome,
  };
  const g = await gravarTroca(canal.id, troca);
  if (!g.ok) return NextResponse.json({ error: g.aviso }, { status: 503 });

  await registrarEvento(canal.id, {
    tipo: "troca_iniciada",
    de: troca.numero_anterior || null,
    para: troca.numero_novo,
    autor_id: user.id,
    autor_nome: user.nome,
    detalhe: { consentimento: true },
  });

  return NextResponse.json({
    ok: true,
    troca_pendente: troca,
    // o proximo passo, escrito: sem isto a tela teria que adivinhar o que dizer, e
    // "troca aberta" sozinho nao ensina ninguem a terminar a troca
    proximo_passo:
      `agora conecte o chip ${formatarNumero(troca.numero_novo)}: leia o QR Code ` +
      "(ou use o codigo de 8 digitos) com o aparelho novo. A troca conclui sozinha quando ele conectar.",
  });
}

export async function DELETE(req: NextRequest) {
  // CANCELAR a troca tambem e "operar": ela muda o que vai acontecer com o chip.
  const p = await portaDoCanal(req, req.nextUrl.searchParams.get("canal"), "operar");
  if (recusou(p)) return p.erro;
  const { canal, user } = p;

  const estado = await estadoDoCanal(canal.id);
  if (!estado.disponivel) {
    return NextResponse.json({ error: estado.aviso, disponivel: false }, { status: 503 });
  }
  if (!estado.troca) {
    // 200 e nao 404: cancelar troca que nao existe e o estado que o usuario
    // queria. 404 aqui faria a tela mostrar erro depois de um clique que deu no
    // resultado certo (e duas abas abertas geram esse duplo cancelamento sozinhas).
    return NextResponse.json({ ok: true, cancelada: false, troca_pendente: null });
  }
  const g = await gravarTroca(canal.id, null);
  if (!g.ok) return NextResponse.json({ error: g.aviso }, { status: 503 });

  await registrarEvento(canal.id, {
    tipo: "troca_cancelada",
    de: estado.troca.numero_anterior || estado.numero,
    para: estado.troca.numero_novo,
    autor_id: user.id,
    autor_nome: user.nome,
  });
  return NextResponse.json({ ok: true, cancelada: true, troca_pendente: null });
}
