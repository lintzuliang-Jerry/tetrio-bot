/**
 * Background Service Worker — relay messages between popup and content script.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message.type === 'BOT_START' ||
    message.type === 'BOT_STOP' ||
    message.type === 'SET_SPEED' ||
    message.type === 'SET_STRENGTH' ||
    message.type === 'GET_STATUS'
  ) {
    // Forward to active tetr.io tab's content script
    chrome.tabs.query({ url: 'https://tetr.io/*', active: true, currentWindow: true }, (tabs) => {
      if (tabs.length === 0) {
        // Try any tetr.io tab
        chrome.tabs.query({ url: 'https://tetr.io/*' }, (allTabs) => {
          if (allTabs.length === 0) {
            sendResponse({ error: 'No TETR.IO tab found' });
            return;
          }
          chrome.tabs.sendMessage(allTabs[0].id!, message, sendResponse);
        });
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id!, message, sendResponse);
    });
    return true; // async
  }
});
