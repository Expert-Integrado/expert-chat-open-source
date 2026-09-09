import { NextRequest, NextResponse } from "next/server";
import { canalPublico, type CanalDef } from "@/lib/canais";
import { credsZapi, zapiDevice, zapiDisconnect, zapiPhoneCode, zapiQrCode, zapiRestart, zapiStatus, type ZapiCreds } from "@/lib/zapi";
import { exigeConexaoLocal, portaDoCanal, portaDoCorpo, recusou } from "@/lib/canais-porta";
import {
  ACOES_CONEXAO,
  INTERVALO_ACAO,
  acaoMuda,
  ehAcaoConexao,
  estadoDesconhecido,
  estadoZapi,
  mascararInstancia,
  mesmoNumero,
  normalizarNumero,
  provedorRecusou,
  traduzirErroZapi,
  vereditoDaTroca,
  type AcaoConexao,
  type EstadoConexao,
} from "@/lib/canal-conexao";
import {
  concluirTroca,
  estadoDoCanal,
  gravarNumero,
  registrarEvento,
  registrarTransicao,
} from "@/lib/canais-db";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// CONECTAR NUMERO POR QR CODE E POR CODIGO DE 8 DIGITOS (card 86ak858mx)
// + a conclusao automatica da TROCA DE CHIP (card 86ak858nx).
//
//   GET  /api/canais/conexao?canal=<id>  -> estado do numero, SEM aplicar nada
//   POST /api/canais/conexao             -> {canal, acao, telefone?}
//        acao: estado | qr | codigo | desconectar | reiniciar
//
// A PORTA E COMPARTILHADA (`lib/canais-porta.ts`). Ela era copiada nas tres rotas
// de canal e as tres esqueceram a MESMA coisa — a restricao de canal do usuario
// (`usuario_restricoes`, Frente Q): quem tem a permissao mas esta recortado a um
// numero DESCONECTAVA o outro. Porta copiada e porta que divergiu.
//
// DUAS PERMISSOES, nao uma (revisao cega): `gerenciar_canais` VE o estado do
// numero (nivel "ler"); `conectar_numero` MEXE nele (nivel "operar"). Quem decide
// o nivel de cada POST e `acaoMuda(acao)` — a lista de acoes e fechada, entao nao
// existe caminho de escrita que escape do nivel.
//
// POR QUE O `canal` E OBRIGATORIO, e nao cai no default `central` como as rotas
// de conversa: aqui um default seria DESCONECTAR O NUMERO ERRADO. A guarda e a
// funcao PURA `canalObrigatorio` (400), chamada pela porta — nao um comentario.
// Rota que resolve canal com default entra em `CANAL_PADRAO_EM`
// (lib/escopo-chave.ts); esta NAO entra, de proposito, e isso tambem fecha o furo
// de uma chave restrita a um numero alcancar outro por OMISSAO do parametro.
//
// A CREDENCIAL NUNCA SAI DAQUI. O navegador pede "o QR do canal X"; quem sabe
// qual e a credencial do canal X e `credsZapi`, no servidor, depois de a porta
// conferir permissao e recorte. O que volta e imagem, estado e frase — nunca
// instancia inteira, nunca token. A unica coisa que atravessa e a MARCA da
// instancia (`mascararInstancia`), pra mostrar que a instalacao apontou o canal
// pra outra instancia.
//
// NUNCA TESTAR CONTRA NUMERO REAL: nada aqui roda em prova automatizada com
// provedor de verdade (as provas cobrem as REGRAS, sem rede — ver
// `scripts/prova-canais-conexao.ts`). A prova ponta a ponta com um chip de
// verdade e gesto humano, em card separado.

// Throttle por canal+acao, em memoria de instancia. Nao e cota nem seguranca — e
// um respiro pra duplo-clique e pra duas abas abertas. O caso caro e o `codigo`:
// cada pedido acende notificacao no celular do cliente E invalida o codigo
// anterior, entao repetir rapido garante que nenhum codigo funcione.
const ultimaAcao = new Map<string, number>();

function podeAgora(canal: string, acao: AcaoConexao): number {
  const espera = INTERVALO_ACAO[acao];
  if (!espera) return 0;
  const chave = `${canal}|${acao}`;
  const ultimo = ultimaAcao.get(chave) ?? 0;
  const falta = espera - (Date.now() - ultimo);
  if (falta > 0) return Math.ceil(falta / 1000);
  ultimaAcao.set(chave, Date.now());
  // teto simples: instalacao com muitos canais nao acumula chave pra sempre
  if (ultimaAcao.size > 500) {
    for (const k of ultimaAcao.keys()) {
      ultimaAcao.delete(k);
      if (ultimaAcao.size <= 400) break;
    }
  }
  return 0;
}

/** A credencial Z-API do canal, ou o 501 que diz o que falta na instalacao. */
function credencialOu501(canal: CanalDef): { creds: ZapiCreds } | { erro: NextResponse } {
  const creds = credsZapi(canal.id);
  if (creds) return { creds };
  // FAIL-CLOSED: canal sem credencial NAO cai na credencial de outro canal —
  // seria conectar/desconectar o numero errado. Mesma regra de `envioDisponivel`.
  return {
    erro: NextResponse.json(
      {
        error:
          "este numero nao tem credencial de provedor configurada nesta instalacao " +
          "(ZAPI_<CANAL>_INSTANCE_ID / _TOKEN / _CLIENT_TOKEN)",
      },
      { status: 501 }
    ),
  };
}

/** Estado do provedor: `/status` pro estado, `/device` pro NUMERO conectado. */
async function lerProvedor(creds: ZapiCreds): Promise<EstadoConexao> {
  try {
    const status = await zapiStatus(creds);
    // `/device` so tem numero quando ha chip conectado; instancia desconectada
    // responde vazio ou erro, e ai a falta de numero e a resposta certa.
    let device: any = null;
    if (status.corpo?.connected === true) {
      device = await zapiDevice(creds).then((r) => r.corpo).catch(() => null);
    }
    return estadoZapi(status.corpo, device);
  } catch (e: any) {
    // rede caiu: `desconhecido`, nunca "desconectado". Dizer "desconectado" faria
    // a tela pedir pro cliente ler um QR por causa de um soluco nosso.
    return estadoDesconhecido(`nao consegui falar com o provedor agora (${String(e?.message || e).slice(0, 80)})`);
  }
}

type Corpo = {
  estado: EstadoConexao;
  troca: ReturnType<typeof vereditoDaTroca> | null;
  banco: Awaited<ReturnType<typeof estadoDoCanal>>;
};

async function montar(canalId: string, creds: ZapiCreds): Promise<Corpo> {
  const [estado, banco] = await Promise.all([lerProvedor(creds), estadoDoCanal(canalId)]);
  const troca = banco.troca ? vereditoDaTroca(banco.troca, estado) : null;
  return { estado, troca, banco };
}

function resposta(canal: CanalDef, creds: ZapiCreds, c: Corpo, extra: Record<string, unknown> = {}) {
  return NextResponse.json(
    {
      canal: canalPublico(canal),
      // MARCA, nunca a instancia inteira — e nunca o token
      instancia: mascararInstancia(creds.instance),
      // a marca que o painel tinha gravado: diferente da atual = a instalacao
      // apontou o canal pra outra instancia (a trilha registra quando muda)
      instancia_anterior: c.banco.instancia_marca,
      estado: c.estado,
      numero_gravado: c.banco.numero,
      numero_gravado_em: c.banco.numero_em,
      troca_pendente: c.banco.troca,
      troca: c.troca,
      // migration 0023 pendente ou banco fora: conectar segue funcionando, a
      // troca e o catalogo ficam desligados COM AVISO (nunca em silencio)
      disponivel: c.banco.disponivel,
      aviso: c.banco.aviso,
      ...extra,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

/**
 * OBSERVAR sem aplicar. Nao grava numero, nao conclui troca, nao carimba trilha.
 *
 * Nivel "ler" (`gerenciar_canais`): acompanhar o estado de um numero e
 * diagnostico, e todo supervisor precisa. A separacao tambem existe pra que uma
 * chave `somente_leitura` consiga monitorar sem conseguir concluir a troca de
 * chip de ninguem — concluir e efeito, e efeito vive no POST.
 */
export async function GET(req: NextRequest) {
  const p = await portaDoCanal(req, req.nextUrl.searchParams.get("canal"), "ler");
  if (recusou(p)) return p.erro;
  const local = exigeConexaoLocal(p.canal);
  if (local) return local;
  const cred = credencialOu501(p.canal);
  if ("erro" in cred) return cred.erro;

  const c = await montar(p.canal.id, cred.creds);
  return resposta(p.canal, cred.creds, c, { aplicado: false });
}

export async function POST(req: NextRequest) {
  // QUEM LE O CORPO E A PORTA — nunca esta rota (`req.json()` aqui era o GRAVE D1:
  // deixava o escopo de canal da chave de API INERTE). O nivel sai da propria
  // acao, e por isso ele chega como funcao do corpo.
  const p = await portaDoCorpo(req, (body) => {
    if (!ehAcaoConexao(body?.acao)) {
      return NextResponse.json(
        { error: `acao invalida — use uma de: ${ACOES_CONEXAO.join(", ")}` },
        { status: 400 }
      );
    }
    // `estado` observa e carimba o painel (nivel "ler"); tudo que MEXE no provedor
    // exige `conectar_numero`. `acaoMuda` deixou de ser decorativa (era, e a
    // revisao pegou): ela e o interruptor.
    return acaoMuda(body.acao) ? "operar" : "ler";
  });
  if (recusou(p)) return p.erro;
  const { canal, user, body } = p;
  const acao = body.acao as AcaoConexao;
  const local = exigeConexaoLocal(canal);
  if (local) return local;
  const cred = credencialOu501(canal);
  if ("erro" in cred) return cred.erro;
  const creds = cred.creds;

  const espera = podeAgora(canal.id, acao);
  if (espera) {
    return NextResponse.json(
      { error: `espere ${espera}s antes de repetir esta acao neste numero`, retry_em: espera },
      { status: 429 }
    );
  }

  const autor = { autor_id: user.id, autor_nome: user.nome };

  // ——————————————————————————————————————————————————— acao: estado
  //
  // A acao que a tela chama em loop enquanto o modal esta aberto. Ela e a UNICA
  // que conclui troca de chip — de proposito: o card diz que "o usuario nao clica
  // em confirmar", entao concluir e efeito de CONECTAR, observado no polling.
  if (acao === "estado") {
    const c = await montar(canal.id, creds);
    const extra: Record<string, unknown> = { aplicado: true };

    if (c.troca?.acao === "concluir") {
      // GUARDA DE CONCORRENCIA no proprio UPDATE (`troca_pendente is not null`):
      // duas abas veem o chip novo no mesmo segundo, e sem ela as duas concluiam —
      // a segunda gravando uma linha de trilha que conta uma troca que nao houve
      // ("passou de X para X"). Quem chega primeiro conclui; a outra nao escreve.
      const g = await concluirTroca(canal.id, c.troca.numero, creds.instance);
      if (g.concluiu) {
        await registrarEvento(canal.id, {
          tipo: "troca_concluida",
          de: c.banco.troca?.numero_anterior || c.banco.numero,
          para: c.troca.numero,
          // autor NULO nos dois campos: quem concluiu foi o painel, ao ver o chip
          // novo conectado — a convencao de autor da 0006/0019. Quem ABRIU a troca
          // esta no evento `troca_iniciada`.
          detalhe: { aberta_por: c.banco.troca?.iniciada_por_nome || null },
        });
        extra.concluida = true;
        // relê pra a resposta ja sair sem a pendencia (a tela fecha o modal com
        // base nisso; devolver o estado velho faria o aviso de troca piscar)
        const depois = await estadoDoCanal(canal.id);
        c.banco = depois;
        c.troca = null;
      } else if (g.aviso) {
        // NAO deu pra gravar: a troca FICA pendente e o cliente e avisado. Dizer
        // "concluida" sem ter gravado deixaria o painel atendendo com um numero
        // que ninguem registrou.
        extra.aviso_troca = g.aviso;
      }
    } else if (c.troca?.acao === "divergente") {
      // SO NA TRANSICAO (achado de revisao, medido em ~1.028 linhas/h com o modal
      // aberto): divergencia e ESTADO, nao evento. A trilha e onde alguem procura
      // "de qual numero pra qual" — afogada em repeticao, ela deixa de servir.
      // `registrarTransicao` compara com o ultimo evento do canal e nao grava se
      // ja estiver nesse estado.
      await registrarTransicao(canal.id, {
        tipo: "troca_divergente",
        de: c.estado.numero,
        para: c.banco.troca?.numero_novo,
        ...autor,
      });
    } else if (
      !c.banco.troca &&
      c.estado.conectado &&
      c.estado.numero &&
      c.banco.disponivel &&
      // `mesmoNumero` (e nao `!==`) porque a comparacao de numero deste fluxo
      // tolera o nono digito num lugar so — regra em dois lugares diverge
      !(c.banco.numero && mesmoNumero(c.banco.numero, c.estado.numero))
    ) {
      // Duas situacoes diferentes, e a segunda NAO pode ser silenciosa:
      //
      //   PRIMEIRA conexao do canal (`numero_gravado` vazio): carimba e registra
      //   `conectado`. Rotina.
      //
      //   CHIP TROCADO FORA DO FLUXO (`numero_gravado` existe e e OUTRO): alguem
      //   leu o QR com um chip diferente sem abrir troca. A operacao passa a
      //   atender por outro numero, e ate a revisao isso reescrevia o campo EM
      //   SILENCIO — a unica pista era o numero mudando sozinho na tela. Agora e
      //   evento proprio, com DE e PARA, e a tela mostra em destaque.
      const trocaSelvagem = !!c.banco.numero;
      const g = await gravarNumero(canal.id, c.estado.numero, { instancia: creds.instance });
      if (g.ok) {
        await registrarEvento(canal.id, {
          tipo: trocaSelvagem ? "numero_trocado_sem_troca" : "conectado",
          de: c.banco.numero,
          para: c.estado.numero,
          detalhe: { instancia: mascararInstancia(creds.instance) },
        });
        if (trocaSelvagem) {
          extra.numero_trocado_sem_troca = { de: c.banco.numero, para: c.estado.numero };
        }
      } else if (g.aviso) {
        extra.aviso_numero = g.aviso;
      }
    }
    return resposta(canal, creds, c, extra);
  }

  // ————————————————————————————————————————————————————— acao: qr
  //
  // CADENCIA: quem decide quando pedir outro QR e a TELA, por `deveRenovarQr`
  // (lib/canal-conexao.ts) — pedir QR novo INVALIDA o anterior no provedor, entao
  // pedir a cada 4s faria o cliente escanear codigos que o nosso proprio polling
  // acabou de matar. Aqui e so o pedido.
  if (acao === "qr") {
    const r = await zapiQrCode(creds).catch((e: any) => ({ qr: null, erro: String(e?.message || e) }));
    const c = await montar(canal.id, creds);
    if (!r.qr) {
      // a Z-API responde erro tambem no caso BOM ("You are already connected"):
      // devolver 200 com o estado e a frase traduzida e melhor que 502, porque o
      // que o usuario precisa saber e que ja esta conectado.
      return resposta(canal, creds, c, {
        aplicado: false,
        qr: null,
        erro_qr: traduzirErroZapi(r.erro),
      });
    }
    return resposta(canal, creds, c, {
      aplicado: false,
      qr: r.qr,
      // o carimbo do QR e do SERVIDOR, e e ele que a tela usa pra dizer "gerado ha
      // Ns" (`rotuloIdadeQr`) e pra decidir a renovacao. Deixar a tela carimbar
      // seria confiar no relogio do navegador — e o relogio errado do cliente e
      // uma das causas do chamado "escaneei e nao funcionou".
      qr_em: new Date().toISOString(),
    });
  }

  // ———————————————————————————————————————————————————— acao: codigo
  if (acao === "codigo") {
    const telefone = normalizarNumero(body?.telefone);
    if (!telefone) {
      return NextResponse.json(
        { error: "informe o numero do aparelho com DDI e DDD, so digitos (ex.: 5511912345678)" },
        { status: 400 }
      );
    }
    const r = await zapiPhoneCode(creds, telefone).catch((e: any) => ({
      codigo: null,
      erro: String(e?.message || e),
    }));
    const c = await montar(canal.id, creds);
    if (!r.codigo) {
      return resposta(canal, creds, c, { aplicado: false, codigo: null, erro_codigo: traduzirErroZapi(r.erro) });
    }
    await registrarEvento(canal.id, { tipo: "codigo_pedido", para: telefone, ...autor });
    return resposta(canal, creds, c, { aplicado: false, codigo: r.codigo, codigo_em: new Date().toISOString() });
  }

  // —————————————————————————————— acao: desconectar / reiniciar
  //
  // TRILHA HONESTA (achado de revisao): antes, o evento entrava mesmo quando o
  // provedor RECUSAVA a acao — a trilha dizia "Ana desconectou o numero" e o
  // numero seguia conectado. Trilha que registra a INTENCAO como se fosse o FATO
  // e pior que trilha faltando: ela mente com autoridade. Agora o evento carrega
  // `recusado` e a frase muda; e a resposta leva o erro traduzido.
  const chamar = acao === "desconectar" ? zapiDisconnect : zapiRestart;
  const antes = await estadoDoCanal(canal.id);
  const r = await chamar(creds).catch((e: any) => ({ status: 0, corpo: { error: String(e?.message || e) } }));
  // A DECISAO E PURA (`provedorRecusou`): campo `error` no corpo OU status fora de
  // 2xx. Confiar so no campo deixava 502/504/429 sem esse campo virar SUCESSO na
  // trilha — "Ana desconectou o numero" com o numero seguindo conectado (D7).
  const { recusado: recusadoPeloProvedor, motivo: motivoRecusa } = provedorRecusou(r);

  await registrarEvento(canal.id, {
    tipo: acao === "desconectar" ? "desconectado" : "reiniciado",
    ...(acao === "desconectar" ? { de: antes.numero } : {}),
    ...autor,
    ...(recusadoPeloProvedor ? { detalhe: { recusado: true, motivo: motivoRecusa } } : {}),
  });

  const c = await montar(canal.id, creds);
  return resposta(canal, creds, c, {
    // `aplicado` passa a dizer a verdade: false quando o provedor recusou
    aplicado: !recusadoPeloProvedor,
    ...(recusadoPeloProvedor ? { erro_acao: motivoRecusa } : {}),
  });
}
