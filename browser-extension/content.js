// PP Jira Bridge — content script
// Работает в Chrome и Firefox
//
// Использует window.postMessage для связи со страницей (структурированное клонирование
// безопасно переносит данные между JavaScript-компартментами без Xray-проблем Firefox)

// Сообщаем странице, что расширение установлено
document.documentElement.dataset.ppJiraExt = '1.0';

// Сигналим странице через событие (на случай, если DOM уже готов)
document.dispatchEvent(new CustomEvent('pp-jira-ready'));

// Используем runtime API (работает в обоих браузерах)
const runtime = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;

// Слушаем сообщения от страницы через postMessage
window.addEventListener('message', async (event) => {
    // Фильтр: только наши сообщения по полю source
    // НЕ используем event.source — в Chrome content script и страница живут в разных
    // изолированных мирах, поэтому event.source !== window всегда true
    if (!event.data) return;
    if (event.data.source !== 'pp-jira-page') return;

    const { msg, msgId } = event.data;
    if (!msgId) return;

    try {
        const response = await new Promise(resolve => {
            runtime.sendMessage(msg, resolve);
        });
        // Отвечаем странице через postMessage
        window.postMessage({
            source: 'pp-jira-ext',
            msgId,
            response,
        }, '*');
    } catch (err) {
        window.postMessage({
            source: 'pp-jira-ext',
            msgId,
            response: { ok: false, error: String(err) },
        }, '*');
    }
});

console.log('PP Jira Bridge content script loaded');