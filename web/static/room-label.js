// Как назвать комнату в списке последних.
//
// Задача из Jira хранится служебной строкой «__JIRA__{...}», и раньше этот JSON
// показывался человеку целиком — с кавычками, полями и ссылкой внутри.

function roomLabel(taskText) {
    const текст = (taskText || '').trim();
    if (!текст) return 'Без описания';
    if (!текст.startsWith('__JIRA__')) return текст;
    try {
        const задача = JSON.parse(текст.slice(8));
        return [задача.key, задача.summary].filter(Boolean).join(' · ') || 'Задача из Jira';
    } catch {
        return 'Задача из Jira';
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { roomLabel };
}
