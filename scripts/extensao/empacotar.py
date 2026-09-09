# Empacota a extensao do Chrome (extensao-chrome/) pra Chrome Web Store e gera os materiais da
# ficha: icones (do app/icon.svg), zip SEM o campo `key` (a loja atribui o id dela) e as
# imagens da listagem (captura 1280x800 e tile 440x280), sem nenhum dado de cliente na tela —
# a captura mostra o painel lateral na tela de LOGIN do painel, nunca conversas.
#   python scripts/extensao/empacotar.py            (saida em ./saida-loja/)
#   PAINEL_URL obrigatoria: o endereco do SEU painel (ex: https://chat.suaempresa.com.br)
import base64, json, os, shutil, sys, tempfile, zipfile
from playwright.sync_api import sync_playwright

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
EXT = os.path.join(RAIZ, "extensao-chrome")
SVG = os.path.join(RAIZ, "app", "icon.svg")
SAIDA = sys.argv[1] if len(sys.argv) > 1 else "./saida-loja"
PAINEL_URL = os.environ.get("PAINEL_URL", "https://SEU-PAINEL").rstrip("/")
os.makedirs(SAIDA, exist_ok=True)
os.makedirs(os.path.join(EXT, "icones"), exist_ok=True)
svg = open(SVG, encoding="utf-8").read()
res = {}


def html_icone(px):
    return f"<html><body style='margin:0;background:transparent'><div style='width:{px}px;height:{px}px'>{svg.replace('<svg ', f'<svg width=\"{px}\" height=\"{px}\" ')}</div></body></html>"


def data_uri(caminho):
    return "data:image/png;base64," + base64.b64encode(open(caminho, "rb").read()).decode()


COMPOSICAO = """<html><head><meta charset='utf-8'><style>
  body{{margin:0;width:{w}px;height:{h}px;background:#0b141a;color:#e9edef;font-family:Segoe UI,Arial,sans-serif;overflow:hidden}}
  .wrap{{display:flex;height:100%;align-items:center;justify-content:space-between;padding:0 {pad}px;box-sizing:border-box;gap:{gap}px}}
  .txt{{max-width:{txtw}px}}
  .marca{{display:flex;align-items:center;gap:14px;margin-bottom:{mb}px}}
  .marca span{{font-size:{f1}px;font-weight:700;letter-spacing:-.5px}}
  h1{{font-size:{f2}px;line-height:1.15;margin:0 0 {mb}px;font-weight:600}}
  p{{font-size:{f3}px;line-height:1.5;color:#aebac1;margin:0 0 {mb2}px}}
  ul{{margin:0;padding-left:{f3}px;font-size:{f3}px;line-height:1.7;color:#d1d7db}}
  .shot{{border-radius:18px;padding:8px;background:#202c33;box-shadow:0 30px 60px rgba(0,0,0,.45)}}
  .shot img{{display:block;border-radius:12px;width:{imgw}px}}
</style></head><body><div class='wrap'>
  <div class='txt'>
    <div class='marca'>{svg}<span>Expert Chat</span></div>
    <h1>{titulo}</h1>
    <p>{sub}</p>
    {lista}
  </div>
  <div class='shot'><img src='{img}'></div>
</div></body></html>"""


with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    # 1) icones a partir do SVG do painel (fundo transparente)
    pg = b.new_page()
    for px in (16, 32, 48, 128):
        pg.set_viewport_size({"width": px, "height": px})
        pg.set_content(html_icone(px))
        pg.screenshot(path=os.path.join(EXT, "icones", f"{px}.png"), omit_background=True, clip={"x": 0, "y": 0, "width": px, "height": px})
    pg.close()
    res["icones"] = sorted(os.listdir(os.path.join(EXT, "icones")))

    # 2) manifesto do repo ganha os icones (a copia dev continua com a `key`)
    man_path = os.path.join(EXT, "manifest.json")
    man = json.load(open(man_path, encoding="utf-8"))
    icones = {str(px): f"icones/{px}.png" for px in (16, 32, 48, 128)}
    man["icons"] = icones
    man.setdefault("action", {})["default_icon"] = icones
    json.dump(man, open(man_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    open(man_path, "a", encoding="utf-8").write("\n")

    # 3) captura do painel lateral na tela de login (extensao carregada de verdade)
    perfil = tempfile.mkdtemp(prefix="ext-loja-")
    b.close()  # extensao so carrega em contexto persistente
    ctx = p.chromium.launch_persistent_context(
        perfil, channel="chromium", headless=True, viewport={"width": 400, "height": 760}, locale="pt-BR",
        args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
    ext_id = sw.url.split("/")[2]
    page = ctx.new_page()
    page.goto(f"chrome-extension://{ext_id}/options.html")
    page.fill("#url", PAINEL_URL); page.click("#salvar"); page.wait_for_timeout(400)
    page.screenshot(path=os.path.join(SAIDA, "sidepanel-opcoes.png"))
    page.goto(f"chrome-extension://{ext_id}/sidepanel.html"); page.wait_for_timeout(4000)
    quadro = next((f for f in page.frames if f.url.startswith(PAINEL_URL)), None)
    if quadro:
        quadro.wait_for_selector("input[type=email]", timeout=30000)
    page.wait_for_timeout(800)
    login_png = os.path.join(SAIDA, "sidepanel-login.png")
    page.screenshot(path=login_png)
    res["captura_login_ok"] = quadro is not None
    ctx.close()

    # 4) imagens da ficha da loja: 1280x800 (obrigatoria) e tile 440x280
    b = p.chromium.launch(headless=True)
    pg = b.new_page()
    lista = "<ul><li>Mesma tela, mesmo banco, mesma sessão do painel</li><li>Login com e-mail, senha e verificação em duas etapas</li><li>Funciona com qualquer instalação: aponte pro seu painel</li></ul>"
    pg.set_viewport_size({"width": 1280, "height": 800})
    pg.set_content(COMPOSICAO.format(w=1280, h=800, pad=96, gap=64, txtw=620, mb=28, mb2=24, f1=34, f2=44, f3=20, imgw=360,
                                     svg=svg.replace("<svg ", "<svg width='56' height='56' "), titulo="O atendimento no painel lateral do Chrome",
                                     sub="Responda os clientes sem trocar de aba: o painel de atendimento abre ao lado de qualquer site que você estiver usando.",
                                     lista=lista, img=data_uri(login_png)))
    pg.wait_for_timeout(300)
    pg.screenshot(path=os.path.join(SAIDA, "loja-captura-1280x800.png"))
    pg.set_viewport_size({"width": 1280, "height": 800})
    pg.set_content(COMPOSICAO.format(w=1280, h=800, pad=96, gap=64, txtw=620, mb=28, mb2=24, f1=34, f2=44, f3=20, imgw=360,
                                     svg=svg.replace("<svg ", "<svg width='56' height='56' "), titulo="Configure uma vez: cole o endereço do seu painel",
                                     sub="A extensão não guarda nenhum dado de conversa. Ela só lembra qual painel abrir, e cada pessoa entra com o próprio usuário.",
                                     lista="", img=data_uri(os.path.join(SAIDA, "sidepanel-opcoes.png"))))
    pg.wait_for_timeout(300)
    pg.screenshot(path=os.path.join(SAIDA, "loja-captura-2-1280x800.png"))
    pg.set_viewport_size({"width": 440, "height": 280})
    pg.set_content(COMPOSICAO.format(w=440, h=280, pad=28, gap=20, txtw=230, mb=10, mb2=8, f1=18, f2=20, f3=11, imgw=130,
                                     svg=svg.replace("<svg ", "<svg width='28' height='28' "), titulo="Atendimento no painel lateral",
                                     sub="Mesma tela, mesmo banco, mesma sessão.", lista="", img=data_uri(login_png)))
    pg.wait_for_timeout(300)
    pg.screenshot(path=os.path.join(SAIDA, "loja-tile-440x280.png"))
    b.close()

# 5) zip pra loja: tudo menos README e SEM `key`
zip_path = os.path.join(SAIDA, f"expert-chat-extensao-{man['version']}.zip")
man_loja = dict(man); man_loja.pop("key", None)
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("manifest.json", json.dumps(man_loja, ensure_ascii=False, indent=2) + "\n")
    for nome in ("background.js", "sidepanel.html", "sidepanel.js", "options.html", "options.js"):
        z.write(os.path.join(EXT, nome), nome)
    for px in (16, 32, 48, 128):
        z.write(os.path.join(EXT, "icones", f"{px}.png"), f"icones/{px}.png")
res["zip"] = zip_path
res["zip_bytes"] = os.path.getsize(zip_path)
res["zip_tem_key"] = "key" in json.loads(zipfile.ZipFile(zip_path).read("manifest.json"))
res["arquivos_saida"] = sorted(os.listdir(SAIDA))
print(json.dumps(res, ensure_ascii=False, indent=1))
