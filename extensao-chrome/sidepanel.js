// Painel lateral = uma moldura. O endereco do widget vem das Opcoes (chrome.storage.sync),
// nunca fica escrito aqui: a extensao e a mesma pra qualquer instalacao do painel.
const painel = document.getElementById("painel");
const vazio = document.getElementById("vazio");
document.getElementById("origem").textContent = `chrome-extension://${chrome.runtime.id}`;
document.getElementById("abrir-opcoes").addEventListener("click", () => chrome.runtime.openOptionsPage());

function aplicar(url) {
  if (!url) {
    painel.hidden = true;
    painel.removeAttribute("src");
    vazio.style.display = "block";
    return;
  }
  vazio.style.display = "none";
  painel.hidden = false;
  // NUNCA trocar o src a toa: recarregar o iframe derruba a sessao (login + 2FA de novo).
  if (painel.getAttribute("src") !== url) painel.setAttribute("src", url);
}

chrome.storage.sync.get("widgetUrl").then(({ widgetUrl }) => aplicar(widgetUrl || ""));
chrome.storage.onChanged.addListener((mudancas, area) => {
  if (area === "sync" && mudancas.widgetUrl) aplicar(mudancas.widgetUrl.newValue || "");
});
