"""Estado da extensão Expert Chat na Chrome Web Store, sem navegador e sem login.

Uso:  python scripts/extensao/status-loja.py            # imprime JSON e sai 0 (publicada) ou 1 (ainda não)
      python scripts/extensao/status-loja.py --id <id>  # outro item (ex.: controle publicado)

Duas provas independentes, medidas em 03/09/2026 contra itens publicados de controle:
1. Página da loja: item NÃO publicado redireciona pra `/detail/empty-title/<id>` e o og:title é só
   "Chrome Web Store"; item publicado redireciona pro slug real (ex.: `/detail/google-translate/<id>`)
   e o og:title vira "<Nome> - Chrome Web Store".
2. Endpoint de atualização do Chrome (clients2.google.com/service/update2/crx): item publicado devolve
   o pacote .crx (HTTP 200, bytes > 0, medido 9,6 MB no controle uBlock Origin Lite); item não
   publicado devolve HTTP 404.
Publicada = as duas provas positivas. Uma só positiva = estado intermediário, reportado como tal.
"""
import argparse
import json
import re
import sys
import urllib.error
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128"
ID_OFICIAL = "fnidebgjjamnnppdlcckodkiehlhagkp"


def _get(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.geturl(), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.geturl(), b""


def status(ext_id: str) -> dict:
    url_loja = f"https://chromewebstore.google.com/detail/{ext_id}"
    code, final, html = _get(url_loja)
    slug = final.split("/detail/")[1].split("/")[0] if "/detail/" in final else ""
    m = re.search(r'<meta property="og:title" content="([^"]*)"', html.decode("utf-8", "replace"))
    og = m.group(1) if m else ""
    pagina_ok = code == 200 and slug not in ("", "empty-title") and og.strip() not in ("", "Chrome Web Store")

    url_crx = (
        "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=128.0.0.0"
        f"&acceptformat=crx2,crx3&x=id%3D{ext_id}%26installsource%3Dondemand%26uc"
    )
    crx_code, _, crx = _get(url_crx)
    crx_ok = crx_code == 200 and len(crx) > 0

    return {
        "id": ext_id,
        "publicada": pagina_ok and crx_ok,
        "pagina": {"http": code, "slug": slug, "og_title": og, "ok": pagina_ok, "url": url_loja},
        "crx": {"http": crx_code, "bytes": len(crx), "ok": crx_ok},
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", default=ID_OFICIAL)
    args = ap.parse_args()
    r = status(args.id)
    print(json.dumps(r, ensure_ascii=False, indent=2))
    sys.exit(0 if r["publicada"] else 1)
