// Как рисуются особые карты колоды.
//
// «❔» и «☕» — не оформление, а значения: они лежат в шкалах, в голосах и в базе,
// их знает телеграм-бот. Менять сами символы нельзя, иначе разъедутся уже
// сохранённые комнаты. Поэтому подменяется только отрисовка: значение остаётся
// прежним, а на экране — нарисованный значок.
//
// Значок рисуется линиями и берёт цвет из currentColor. У эмодзи цвет свой,
// встроенный в шрифт: CSS его не меняет, и в светлой теме «❔» выглядела бледной
// на светлом. Заодно значок одинаков во всех системах — эмодзи в каждой свой.

const POINT_ICONS = {
    // «Не знаю»: вопросительный знак линиями, а не глиф шрифта
    '❔': '<path d="M8.6 8.6a3.5 3.5 0 1 1 4.55 3.35c-.92.36-1.65 1.1-1.65 2.1v.55"/><path d="M11.5 18.3h.01"/>',
    // «Нужен перерыв»: чашка с ручкой и парой струек пара
    '☕': '<path d="M4 9.5h11.5V15a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M15.5 11h1.6a2.4 2.4 0 0 1 0 4.8h-1.6"/><path d="M7.5 3v2.6M12 3v2.6"/>',
};

// Экранирование без DOM: файл подключается и в браузере, и в тестах на node
function escapeText(text) {
    return String(text).replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

function hasIcon(point) {
    return Object.prototype.hasOwnProperty.call(POINT_ICONS, point);
}

// Готовая разметка значения карты: значок для особых, экранированный текст для
// остальных. Возвращает HTML, поэтому подставлять её можно только через innerHTML
// — и только эту строку, без склейки с чем-то непроверенным.
function pointMarkup(point) {
    if (!hasIcon(point)) return escapeText(point);
    const подпись = point === '☕' ? 'перерыв' : 'не знаю';
    return (
        `<svg class="point-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor"` +
        ` stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"` +
        ` role="img" aria-label="${подпись}">${POINT_ICONS[point]}</svg>`
    );
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { pointMarkup, hasIcon, escapeText, POINT_ICONS };
}
