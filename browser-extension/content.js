// PP Jira Bridge — content script
// Работает в Chrome и Firefox

// Сообщаем странице, что расширение установлено
document.documentElement.dataset.ppJiraExt = '1.0';

// Сигналим странице через событие (на случай, если DOM уже готов)
document.dispatchEvent(new CustomEvent('pp-jira-ready'));

// Используем runtime API (работает в обоих браузерах)
const runtime = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;

// Слушаем сообщения от страницы (через кастомное событие)
document.addEventListener('pp-jira-message', async (event) => {
    const { msg, msgId } = event.detail;
    if (!msg) return;

    try {
        // Promise-based sendMessage — одинаково работает в Chrome (MV3) и Firefox (MV2)
        const response = await new Promise(resolve => {
            runtime.sendMessage(msg, resolve);
        });
        document.dispatchEvent(new CustomEvent('pp-jira-response', {
            detail: { msgId, response }
        }));
    } catch (err) {
        document.dispatchEvent(new CustomEvent('pp-jira-response', {
            detail: { msgId, response: { ok: false, error: String(err) } }
        }));
    }
});

console.log('PP Jira Bridge content script loaded');