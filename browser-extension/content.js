// PP Jira Bridge — content script
// Сообщает странице Planning Poker, что расширение установлено
// И проксирует запросы страницы в background.js (обходит CORS)

document.documentElement.dataset.ppJiraExt = '1.0';

// Дополнительно сигналим странице через событие (на случай, если DOM уже готов)
document.dispatchEvent(new CustomEvent('pp-jira-ready'));

// Слушаем сообщения от страницы (через кастомное событие)
document.addEventListener('pp-jira-message', (event) => {
  const { msg, msgId } = event.detail;
  if (!msg) return;

  chrome.runtime.sendMessage(msg, (response) => {
    // Возвращаем ответ странице через второй кастомный эвент
    document.dispatchEvent(new CustomEvent('pp-jira-response', {
      detail: { msgId, response }
    }));
  });
});
