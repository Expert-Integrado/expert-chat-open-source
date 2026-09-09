const campo = document.getElementById("url");
const msg = document.getElementById("msg");
document.getElementById("origem").textContent = `chrome-extension://${chrome.runtime.id}`;

// aceita "https://painel", "https://painel/", "https://painel/widget" e "https://painel/widget?ctx=..."
function normalizar(entrada) {
  let u;
  try {
    u = new URL(entrada.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && u.hostname === "localhost")) return null;
  if (!u.pathname.startsWith("/widget")) u.pathname = "/widget";
  return u.toString();
}

chrome.storage.sync.get("widgetUrl").then(({ widgetUrl }) => {
  if (widgetUrl) campo.value = widgetUrl;
});

document.getElementById("salvar").addEventListener("click", async () => {
  const url = normalizar(campo.value);
  if (!url) {
    msg.textContent = "Endereco invalido: use https:// e o dominio do painel.";
    msg.className = "erro";
    return;
  }
  await chrome.storage.sync.set({ widgetUrl: url });
  campo.value = url;
  msg.textContent = "Salvo. Abra o painel lateral pelo icone da extensao.";
  msg.className = "ok";
});
