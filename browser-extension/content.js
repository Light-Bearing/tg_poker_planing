// PP Jira Bridge — content script
// Работает в Chrome и Firefox
//
// Использует window.postMessage для связи со страницей (структурированное клонирование
// безопасно переносит данные между JavaScript-компартментами без Xray-проблем Firefox)

// Сообщаем странице, что расширение установлено
document.documentElement.dataset.ppJiraExt = '1.0';

// Сигналим странице через событие (на случай, если DOM уже готов)
document.dispatchEvent(new CustomEvent('pp-jira-ready'));

// Отправка сообщения в background в форме, корректной для обоих API:
// в Firefox browser.runtime.sendMessage возвращает промис и форма с колбэком
// там не гарантирована, в Chrome же промис-форма есть не везде.
// browser-polyfill.min.js в content script не подключён — поэтому разводим руками.
function sendToBackground(msg) {
    if (typeof browser !== 'undefined' && browser.runtime) {
        return browser.runtime.sendMessage(msg);
    }
    return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

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
        const response = await sendToBackground(msg);
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