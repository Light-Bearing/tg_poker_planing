// Копирование в буфер обмена.
//
// navigator.clipboard существует только в защищённом контексте: HTTPS или localhost.
// Стенд открыт по http на голом IP, поэтому там объекта нет вовсе, и обращение
// к navigator.clipboard.writeText бросало TypeError синхронно — не отвергнутый промис.
// Из-за этого не срабатывал даже .catch(), и кнопка молчала: ни текста в буфере,
// ни сообщения об ошибке.
//
// Запасной путь — execCommand('copy') через временное поле. Он объявлен устаревшим,
// но работает без защищённого контекста и поддержан всеми браузерами, которые нас
// интересуют. Вынесено отдельным файлом, чтобы покрыть тестами.

/**
 * Кладёт текст в буфер обмена.
 * @returns {Promise<boolean>} удалось ли скопировать
 */
async function copyText(text, env = {}) {
    const nav = env.navigator || (typeof navigator !== 'undefined' ? navigator : null);
    const doc = env.document || (typeof document !== 'undefined' ? document : null);
    const value = String(text == null ? '' : text);

    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        try {
            await nav.clipboard.writeText(value);
            return true;
        } catch (_) {
            // Отказ в доступе или незащищённый контекст — пробуем запасной путь
        }
    }

    return copyTextFallback(value, doc);
}

/** Запасной путь: скрытое поле и execCommand. Работает по http. */
function copyTextFallback(value, doc) {
    if (!doc || !doc.body || typeof doc.execCommand !== 'function') return false;

    const area = doc.createElement('textarea');
    area.value = value;
    // Поле должно быть в документе и доступно выделению, но незаметно:
    // display:none и visibility:hidden ломают execCommand
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    doc.body.appendChild(area);

    try {
        area.select();
        if (area.setSelectionRange) area.setSelectionRange(0, value.length);
        return Boolean(doc.execCommand('copy'));
    } catch (_) {
        return false;
    } finally {
        doc.body.removeChild(area);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { copyText, copyTextFallback };
}
