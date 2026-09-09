import { NextRequest, NextResponse } from "next/server";
import { usuarioPorSessao } from "@/lib/auth-server";
import { acessoNaJanela, conferirDispositivo, janelaDoUsuario } from "@/lib/acesso";
import { getPerfil } from "@/lib/perfil";
import { fusoDaConfig, getConfig } from "@/lib/config";
import { resolverFuso } from "@/lib/fuso";
import { resumoJanela } from "@/lib/janela-acesso";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// POR QUE EU NAO CONSIGO ENTRAR? (Frente Q, cards 86ak858x0 / 86ak85917)
//
// Toda rota do painel atravessa `getUser`, e quando a politica de acesso barra
// alguem ela devolve `null` — a rota responde 401/403 e a pessoa nao carrega
// nada. Isso e o certo (fail-closed no servidor, nao no front), mas deixa a
// pessoa no escuro: "nao autorizado" nao diz se a senha esta errada, se o
// horario acabou ou se o dispositivo foi revogado.
//
// Esta e a UNICA rota que usa `usuarioPorSessao(req, { ignorarPolitica: true })`:
// ela nao le nem escreve NADA de conversa — so responde, pra quem provou ter
// sessao valida, qual e a situacao da propria conta. Sem isto, o unico jeito de
// descobrir seria olhar o log do servidor.
//
// COSTURA DE TELA (declarada, nao feita nesta leva): `app/home.tsx` esta fora
// do escopo desta frente. Pra a pessoa VER a frase, a tela precisa de duas
// linhas: quando `/api/chats` responder 403 com `sem_acesso: true`, mostrar o
// campo `error`; e, na tela de login, chamar esta rota depois de um login que
// entra no auth mas nao carrega o painel.
export async function GET(req: NextRequest) {
  const user = await usuarioPorSessao(req, { ignorarPolitica: true });
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const perfil = await getPerfil(user.id);
  const eh = () => perfil.papel === "super_admin";
  const [janela, dispositivo, janelaCfg, cfg] = await Promise.all([
    acessoNaJanela(user.id, eh),
    conferirDispositivo(user.id, eh, req),
    janelaDoUsuario(user.id),
    getConfig().catch(() => null),
  ]);

  const bloqueios: string[] = [];
  if (!janela.ok) bloqueios.push(janela.motivo);
  if (!dispositivo.ok) bloqueios.push(dispositivo.motivo);

  return NextResponse.json(
    {
      permitido: bloqueios.length === 0,
      bloqueios,
      // o que ESTA configurado pra esta pessoa — so a dela, nunca de terceiro
      janela: janelaCfg ? { ativo: janelaCfg.ativo, dias: janelaCfg.dias, resumo: resumoJanela(janelaCfg) } : null,
      // config ilegivel cai na MESMA cadeia do painel (config > env > fabrica),
      // nunca em "America/Sao_Paulo" chumbado nem em null
      fuso: cfg ? fusoDaConfig(cfg) : resolverFuso(undefined),
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
