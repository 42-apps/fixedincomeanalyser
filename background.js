// Fixed Income Analyser — service worker.
// Clicking the toolbar icon opens (or focuses) the full-page analyser tab.
const APP_URL = chrome.runtime.getURL("index.html");

chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: APP_URL });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId != null) {
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url: APP_URL });
  }
});
