// Clicar no icone da extensao abre o painel lateral (em vez de um popup).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Primeira instalacao sem endereco configurado: abre as Opcoes pra pessoa colar a URL do painel.
chrome.runtime.onInstalled.addListener(async () => {
  const { widgetUrl } = await chrome.storage.sync.get("widgetUrl");
  if (!widgetUrl) chrome.runtime.openOptionsPage();
});
