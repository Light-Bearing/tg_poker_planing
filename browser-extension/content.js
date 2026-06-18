// PP Jira Bridge — content script
// Работает в Chrome и Firefox благодаря polyfill

// Сообщаем странице, что расширение установлено
document.documentElement.dataset.ppJiraExt = '1.0';

// Сигналим странице через событие (на случай, если DOM уже готов)
document.dispatchEvent(new CustomEvent('pp-jira-ready'));

// Используем runtime API (работает в обоих браузерах с polyfill)
const runtime = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;

// Слушаем сообщения от страницы (через кастомное событие)
document.addEventListener('pp-jira-message', (event) => {
  const { msg, msgId } = event.detail;
  if (!msg) return;

  runtime.sendMessage(msg, (response) => {
    // Возвращаем ответ странице через второй кастомный эвент
    document.dispatchEvent(new CustomEvent('pp-jira-response', {
      detail: { msgId, response }
    }));
  });
});

console.log('PP Jira Bridge content script loaded');
