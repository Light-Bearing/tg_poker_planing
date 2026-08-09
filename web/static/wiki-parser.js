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

            // 3. [ссылка]
            if (ch === '[') {
                const end = text.indexOf(']', i + 1);
                if (end !== -1) {
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
                const headerEnd = text.indexOf('}', i + 7);
                if (headerEnd !== -1) {
                    let color = text.slice(i + 7, headerEnd);
                    if (!COLOR_RE.test(color)) color = 'inherit';
                    const closeStart = text.indexOf('{color}', headerEnd + 1);
                    if (closeStart !== -1) {
                        const inner = text.slice(headerEnd + 1, closeStart);
                        flush();
                        nodes.push({
                            type: 'color',
                            color: color,
                            children: parseInline(inner),
                        });
                        i = closeStart + 7;
                        continue;
                    }
                }
            }

            // 6. Прочий {макрос}...{макрос}
            if (ch === '{') {
                const headerEnd = text.indexOf('}', i + 1);
                if (headerEnd !== -1) {
                    const macro = text.slice(i + 1, headerEnd);
                    // Имя макроса не должно содержать { или } — иначе это не макрос.
                    if (macro && macro.indexOf('{') === -1) {
                        const closeTag = '{' + macro + '}';
                        const closeStart = text.indexOf(closeTag, headerEnd + 1);
                        if (closeStart !== -1) {
                            const inner = text.slice(headerEnd + 1, closeStart);
                            flush();
                            nodes.push.apply(nodes, parseInline(inner));
                            i = closeStart + closeTag.length;
                            continue;
                        }
                    }
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
            if (canOpenAt(text, i)) {
                const rest = text.slice(i);
                const m = /^[A-Z]{2,6}-\d+\b/.exec(rest);
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
