// Opens the full-page UI in a new tab when the toolbar icon is clicked,
// passing the current tab's URL so the UI can auto-fill the Starting URL.
chrome.action.onClicked.addListener((tab) => {
  const src = tab && tab.url ? "?src=" + encodeURIComponent(tab.url) : "";
  chrome.tabs.create({ url: chrome.runtime.getURL("popup.html" + src) });
});
