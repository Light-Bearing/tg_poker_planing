// web/static/wiki-parser.js
// Разбор Jira wiki-разметки. Три шага: блоки -> инлайн -> HTML.
// HTML появляется только на последнем шаге, поэтому правила не могут
// испортить результат друг друга.

(function () {
    'use strict';

    // Символы, после которых маркер может ОТКРЫВАТЬСЯ, и перед которыми — ЗАКРЫВАТЬСЯ.
    // Так ведёт себя сама Jira: маркер вплотную к букве или цифре разметкой не считается.
    // Именно это правило не даёт превратить user_name_id в курсив, а C++ — в подчёркивание.
    const OPEN_BEFORE = /[\s(\[{«"'—–-]/;   // начало строки тоже годится
    const CLOSE_AFTER = /[\s)\]}»"'.,;:!?—–-]/; // конец строки тоже годится

    function canOpenAt(text, i) {
        return i === 0 || OPEN_BEFORE.test(text[i - 1]);
    }

    function canCloseAt(text, i) {
        return i === text.length - 1 || CLOSE_AFTER.test(text[i + 1]);
    }

    const MARKERS = {
        '*': 'strong',
        '_': 'em',
        '-': 'strike',
        '+': 'underline',
        '^': 'sup',
        '~': 'sub',
    };

    // Правило границ применяется НЕ ко всем маркерам. Верхний и нижний индекс в
    // Jira пишутся вплотную к основанию — x^2^, H~2~O, — поэтому требование
    // «перед маркером пробел» их бы просто сломало.
    const BOUNDARY_SENSITIVE = new Set(['*', '_', '-', '+']);

    const COLOR_RE = /^(inherit|initial|revert|unset|[a-z]+|#[\da-f]{3,8})$/i;

    // Символы, на которых обрывается голый URL (кроме пробельных).
    const BARE_URL_STOP = /[\s<>"’)\]]/;

    function normalizeHref(href) {
        if (/^(https?:\/\/|mailto:)/i.test(href)) return href;
        return 'https://' + href;
    }

    // Общий шаблон для правил 5 и 6: за открывающим `{...:` или `{` следует
    // заголовок до ближайшей `}`, а затем где-то дальше — парный закрывающий
    // тег. closeTagOf получает текст заголовка и решает, как выглядит парный
    // тег (для {color} он фиксирован, для произвольного {макрос} — зависит от
    // имени); вернув null, отказывается признавать конструкцию макросом.
    function findMacroSpan(text, headerStart, closeTagOf) {
        const headerEnd = text.indexOf('}', headerStart);
        if (headerEnd === -1) return null;
        const header = text.slice(headerStart, headerEnd);
        const closeTag = closeTagOf(header);
        if (closeTag === null) return null;
        const closeStart = text.indexOf(closeTag, headerEnd + 1);
        if (closeStart === -1) return null;
        return { headerEnd: headerEnd, closeStart: closeStart, header: header, closeTag: closeTag };
    }

    function parseInline(text) {
        const nodes = [];
        let buf = '';
        let i = 0;

        function flush() {
            if (buf) {
                nodes.push({ type: 'text', text: buf });
                buf = '';
            }
        }

        while (i < text.length) {
            const ch = text[i];

            // 1. {{code}} — моноширинный, внутрь не заходим.
            if (ch === '{' && text[i + 1] === '{') {
                const end = text.indexOf('}}', i + 2);
                if (end !== -1) {
                    flush();
                    nodes.push({ type: 'code', text: text.slice(i + 2, end) });
                    i = end + 2;
                    continue;
                }
            }

            // 2. \\ — перенос строки.
            if (ch === '\\' && text[i + 1] === '\\') {
                flush();
                nodes.push({ type: 'break' });
                i += 2;
                continue;
            }

            // 3. [ссылка] — закрывающая ] ищется только в пределах текущей
            // строки: незакрытая [ не должна поглощать текст за переводом строки.
            if (ch === '[') {
                const end = text.indexOf(']', i + 1);
                const lineBreak = text.indexOf('\n', i + 1);
                if (end !== -1 && (lineBreak === -1 || end < lineBreak)) {
                    const inner = text.slice(i + 1, end);
                    const barPos = inner.indexOf('|');
                    let children, href;
                    if (barPos === -1) {
                        // Подписи нет — она совпадает с адресом, а адрес не
                        // разбирается никогда, поэтому подпись тоже остаётся
                        // литеральным текстом (иначе голый URL внутри неё сам
                        // превратился бы во вложенную ссылку по правилу 4).
                        href = inner;
                        children = [{ type: 'text', text: inner }];
                    } else {
                        href = inner.slice(barPos + 1);
                        children = parseInline(inner.slice(0, barPos));
                    }
                    flush();
                    nodes.push({
                        type: 'link',
                        href: normalizeHref(href),
                        children: children,
                    });
                    i = end + 1;
                    continue;
                }
            }

            // 4. Голый URL — распознаётся раньше маркеров намеренно (см. бриф):
            // иначе ~ внутри адреса был бы съеден как нижний индекс.
            if (
                text.startsWith('http://', i) ||
                text.startsWith('https://', i)
            ) {
                let j = i;
                while (j < text.length && !BARE_URL_STOP.test(text[j])) {
                    j++;
                }
                const url = text.slice(i, j);
                flush();
                nodes.push({
                    type: 'link',
                    href: url,
                    children: [{ type: 'text', text: url }],
                });
                i = j;
                continue;
            }

            // 5. {color:...}...{color}
            if (text.startsWith('{color:', i)) {
                const span = findMacroSpan(text, i + 7, function () { return '{color}'; });
                if (span) {
                    let color = span.header;
                    if (!COLOR_RE.test(color)) color = 'inherit';
                    const inner = text.slice(span.headerEnd + 1, span.closeStart);
                    flush();
                    nodes.push({
                        type: 'color',
                        color: color,
                        children: parseInline(inner),
                    });
                    i = span.closeStart + span.closeTag.length;
                    continue;
                }
            }

            // 6. Прочий {макрос}...{макрос}
            if (ch === '{') {
                const span = findMacroSpan(text, i + 1, function (macro) {
                    // Имя макроса не должно содержать { — иначе это не макрос.
                    return (macro && macro.indexOf('{') === -1) ? ('{' + macro + '}') : null;
                });
                if (span) {
                    const inner = text.slice(span.headerEnd + 1, span.closeStart);
                    flush();
                    nodes.push.apply(nodes, parseInline(inner));
                    i = span.closeStart + span.closeTag.length;
                    continue;
                }
            }

            // 7. Парные маркеры *_-+^~
            if (Object.prototype.hasOwnProperty.call(MARKERS, ch)) {
                const boundarySensitive = BOUNDARY_SENSITIVE.has(ch);
                if (!boundarySensitive || canOpenAt(text, i)) {
                    // Ищем ближайший такой же символ правее с непустым содержимым между ними.
                    let j = i + 1;
                    let found = -1;
                    while (j < text.length) {
                        if (text[j] === ch && j > i + 1) {
                            if (!boundarySensitive || canCloseAt(text, j)) {
                                found = j;
                                break;
                            }
                        }
                        j++;
                    }
                    if (found !== -1) {
                        flush();
                        nodes.push({
                            type: MARKERS[ch],
                            children: parseInline(text.slice(i + 1, found)),
                        });
                        i = found + 1;
                        continue;
                    }
                }
            }

            // 8. Ключ задачи ABC-123
            // \b — ASCII-граница слова, кириллица в \w не входит, поэтому
            // "ABC-123текст" с ней считался бы границей и склеивался с ключом.
            // Отрицательный просмотр вперёд по Unicode-категориям буквы/цифры
            // работает корректно и для кириллицы, и для любых других алфавитов.
            if (canOpenAt(text, i)) {
                const rest = text.slice(i);
                const m = /^[A-Z]{2,6}-\d+(?![\p{L}\p{N}])/u.exec(rest);
                if (m) {
                    flush();
                    nodes.push({ type: 'issue', key: m[0] });
                    i += m[0].length;
                    continue;
                }
            }

            // 9. Обычный текст.
            buf += ch;
            i += 1;
        }

        flush();
        return nodes;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { parseInline };
    }
})();
