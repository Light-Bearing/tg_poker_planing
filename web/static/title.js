// Заголовок вкладки браузера.
//
// Пока он был один на все комнаты, открытые параллельно вкладки выглядели
// одинаково: одна иконка, одна надпись, найти нужную — только перебором. И
// вернувшись к свёрнутой вкладке через час, по заголовку нельзя было вспомнить,
// что там обсуждалось.

const APP_TITLE = 'Planning Poker';

// В комнате показываем номер задачи Jira, а без него — номер комнаты.
// Чистая функция: покрыта тестами в tests/js/title.test.js.
function roomTitle(sessionId, jiraKey) {
    const метка = String(jiraKey || '').trim() || String(sessionId || '').trim();
    return метка ? `${APP_TITLE} - ${метка}` : APP_TITLE;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { roomTitle, APP_TITLE };
}
