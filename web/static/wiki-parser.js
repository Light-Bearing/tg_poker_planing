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

    // --- Блочный разбор ---------------------------------------------------
    // Строки идут по порядку с индексом i; каждое правило обязано продвинуть
    // i (или делегировать это collectBlockBody), иначе цикл зациклится.

    const CODE_OPEN_RE = /^\{code(?::([^}]*))?\}/;
    const NOFORMAT_OPEN = '{noformat}';
    const QUOTE_OPEN = '{quote}';
    const PANEL_OPEN_RE = /^\{panel(?::([^}]*))?\}/;
    const RULE_RE = /^-{4,}$/;
    const HEADING_RE = /^h([1-6])\.\s(.*)$/;
    const LIST_ITEM_RE = /^(\s*)([*\-#]+)\s+(.*)$/;

    // Собирает содержимое парной конструкции ({code}...{code}, {quote}...{quote}
    // и т.п.), открытой в lines[i] маркером длиной openLen, до строки с
    // closeMarker. Если открытие и закрытие оказались на одной строке
    // (`{code}x{code}`), это обрабатывается отдельно, как того требует бриф.
    // Хвост после закрывающего маркера на той же строке, где бы он ни
    // нашёлся, вставляется как отдельная "строка" сразу за текущей позицией —
    // так следующая итерация разберёт его по обычным правилам.
    // Если закрытия нет вообще, поглощается всё до конца ввода.
    function collectBlockBody(lines, i, openLen, closeMarker) {
        const firstRest = lines[i].slice(openLen);
        const sameLineClose = firstRest.indexOf(closeMarker);
        if (sameLineClose !== -1) {
            const text = firstRest.slice(0, sameLineClose);
            const leftover = firstRest.slice(sameLineClose + closeMarker.length);
            if (leftover !== '') lines.splice(i + 1, 0, leftover);
            return { lines: [text], nextIndex: i + 1 };
        }

        const contentLines = [];
        if (firstRest !== '') contentLines.push(firstRest);

        let j = i + 1;
        while (j < lines.length) {
            const closeIdx = lines[j].indexOf(closeMarker);
            if (closeIdx !== -1) {
                const before = lines[j].slice(0, closeIdx);
                if (before !== '') contentLines.push(before);
                const leftover = lines[j].slice(closeIdx + closeMarker.length);
                if (leftover !== '') lines.splice(j + 1, 0, leftover);
                return { lines: contentLines, nextIndex: j + 1 };
            }
            contentLines.push(lines[j]);
            j += 1;
        }
        // Закрытия не нашлось — поглощаем всё до конца ввода.
        return { lines: contentLines, nextIndex: j };
    }

    // Обрезает пустые строки по краям массива, не трогая содержимое внутри.
    function trimBlankEdges(lines) {
        const result = lines.slice();
        while (result.length && result[0].trim() === '') result.shift();
        while (result.length && result[result.length - 1].trim() === '') result.pop();
        return result;
    }

    // Разбирает одну строку таблицы. Если строка начинается с `||` — это
    // заголовочная строка, ячейки разделены `||`; иначе обычная строка,
    // ячейки разделены одиночным `|`. Обрамляющие разделители (по одному
    // с каждого края, если они есть) отбрасываются, каждая ячейка
    // обрезается по краям.
    function parseTableRow(line) {
        const header = line.startsWith('||');
        const sep = header ? '||' : '|';
        let content = line;
        if (content.startsWith(sep)) content = content.slice(sep.length);
        if (content.endsWith(sep)) content = content.slice(0, -sep.length);
        const cells = content.split(sep).map(function (cell) { return cell.trim(); });
        return { header: header, cells: cells };
    }

    // Строит одно поддерево списка из плоского массива пунктов, начиная с
    // pos.i. Глубина поддерева фиксируется первым пунктом на входе; все
    // однопригодные (равной глубины) пункты подряд становятся элементами
    // items, а любой более глубокий пункт сразу после — детьми последнего
    // добавленного пункта (рекурсивный вызов).
    //
    // Перепрыгивание уровней вниз (глубина внезапно меньше текущей, без
    // промежуточных значений) просто завершает текущее поддерево — цикл
    // buildAllLists подхватит оставшиеся пункты и начнёт для них новый
    // соседний список верхнего уровня. Перепрыгивание вверх (глубина сразу
    // на несколько больше единицы) трактуется как один уровень вложенности:
    // рекурсивный вызов берёт свою глубину из первого встреченного пункта,
    // поэтому промежуточные уровни просто не создаются. Ни один из этих
    // случаев не зацикливает разбор — pos.i продвигается на каждой итерации.
    function buildList(flatItems, pos) {
        const depth = flatItems[pos.i].depth;
        const ordered = flatItems[pos.i].ordered;
        const items = [];
        while (pos.i < flatItems.length && flatItems[pos.i].depth === depth) {
            const text = flatItems[pos.i].text;
            pos.i += 1;
            let children = null;
            if (pos.i < flatItems.length && flatItems[pos.i].depth > depth) {
                children = buildList(flatItems, pos);
            }
            items.push({ text: text, children: children });
        }
        return { type: 'list', ordered: ordered, items: items };
    }

    // Один прогон строк списка может содержать несколько соседних деревьев
    // (см. перепрыгивание вниз в buildList) — собираем их все.
    function buildAllLists(flatItems) {
        const result = [];
        const pos = { i: 0 };
        while (pos.i < flatItems.length) {
            result.push(buildList(flatItems, pos));
        }
        return result;
    }

    function parseBlocks(text) {
        const lines = text.split('\n');
        const blocks = [];
        let paragraphLines = [];

        function flushParagraph() {
            if (paragraphLines.length) {
                blocks.push({ type: 'paragraph', text: paragraphLines.join('\n') });
                paragraphLines = [];
            }
        }

        let i = 0;
        while (i < lines.length) {
            const line = lines[i];

            // 1. {code} / {code:язык} / {noformat}.
            const codeMatch = CODE_OPEN_RE.exec(line);
            const isNoformat = !codeMatch && line.startsWith(NOFORMAT_OPEN);
            if (codeMatch || isNoformat) {
                flushParagraph();
                const language = codeMatch ? (codeMatch[1] || null) : null;
                const openLen = codeMatch ? codeMatch[0].length : NOFORMAT_OPEN.length;
                const closeMarker = codeMatch ? '{code}' : NOFORMAT_OPEN;
                const body = collectBlockBody(lines, i, openLen, closeMarker);
                const contentLines = trimBlankEdges(body.lines);
                blocks.push({ type: 'code', text: contentLines.join('\n'), language: language });
                i = body.nextIndex;
                continue;
            }

            // 2. {quote}...{quote} и {panel[:title=...]}...{panel} — содержимое
            // разбирается рекурсивным вызовом parseBlocks.
            const panelMatch = PANEL_OPEN_RE.exec(line);
            const isQuote = !panelMatch && line.startsWith(QUOTE_OPEN);
            if (panelMatch || isQuote) {
                flushParagraph();
                let title = null;
                let openLen;
                let closeMarker;
                if (panelMatch) {
                    openLen = panelMatch[0].length;
                    closeMarker = '{panel}';
                    if (panelMatch[1]) {
                        const titleMatch = /title=([^}]*)/.exec(panelMatch[1]);
                        if (titleMatch) title = titleMatch[1];
                    }
                } else {
                    openLen = QUOTE_OPEN.length;
                    closeMarker = QUOTE_OPEN;
                }
                const body = collectBlockBody(lines, i, openLen, closeMarker);
                const innerBlocks = parseBlocks(body.lines.join('\n'));
                if (panelMatch) {
                    blocks.push({ type: 'panel', title: title, blocks: innerBlocks });
                } else {
                    blocks.push({ type: 'quote', blocks: innerBlocks });
                }
                i = body.nextIndex;
                continue;
            }

            // 3. ---- (строка целиком из четырёх и более дефисов).
            if (RULE_RE.test(line)) {
                flushParagraph();
                blocks.push({ type: 'rule' });
                i += 1;
                continue;
            }

            // 4. h1.–h6. плюс пробел.
            const headingMatch = HEADING_RE.exec(line);
            if (headingMatch) {
                flushParagraph();
                blocks.push({ type: 'heading', level: Number(headingMatch[1]), text: headingMatch[2] });
                i += 1;
                continue;
            }

            // 5. Таблица — подряд идущие строки, начинающиеся с |.
            if (line.startsWith('|')) {
                flushParagraph();
                const rows = [];
                while (i < lines.length && lines[i].startsWith('|')) {
                    rows.push(parseTableRow(lines[i]));
                    i += 1;
                }
                blocks.push({ type: 'table', rows: rows });
                continue;
            }

            // 6. Список — подряд идущие строки вида (пробелы)(*|-|#)+(пробел)(текст).
            if (LIST_ITEM_RE.test(line)) {
                flushParagraph();
                const flatItems = [];
                while (i < lines.length) {
                    const m = LIST_ITEM_RE.exec(lines[i]);
                    if (!m) break;
                    flatItems.push({ depth: m[2].length, ordered: m[2][0] === '#', text: m[3] });
                    i += 1;
                }
                blocks.push.apply(blocks, buildAllLists(flatItems));
                continue;
            }

            // 7. Пустая строка — завершает текущий абзац.
            if (line.trim() === '') {
                flushParagraph();
                i += 1;
                continue;
            }

            // 8. Прочее — накапливается в текущий абзац.
            paragraphLines.push(line);
            i += 1;
        }

        flushParagraph();
        return blocks;
    }

    // --- Сборка HTML --------------------------------------------------
    // HTML и экранирование появляются только здесь. Эта функция намеренно
    // дублирует одноимённую из adf-parser.js — оба файла обычные <script>
    // без сборщика, и вынос шести строк в третий файл добавил бы зависимость
    // по порядку загрузки ради их экономии.
    function escapeHtml(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderInline(nodes) {
        return nodes.map(renderInlineNode).join('');
    }

    function renderInlineNode(node) {
        switch (node.type) {
            case 'text':
                return escapeHtml(node.text);
            case 'strong':
                return '<strong>' + renderInline(node.children) + '</strong>';
            case 'em':
                return '<em>' + renderInline(node.children) + '</em>';
            case 'strike':
                return '<s>' + renderInline(node.children) + '</s>';
            case 'underline':
                return '<u>' + renderInline(node.children) + '</u>';
            case 'sup':
                return '<sup>' + renderInline(node.children) + '</sup>';
            case 'sub':
                return '<sub>' + renderInline(node.children) + '</sub>';
            case 'code':
                return '<code>' + escapeHtml(node.text) + '</code>';
            case 'link':
                return '<a href="' + escapeHtml(node.href) + '" target="_blank" class="jira-desc-link">' +
                    renderInline(node.children) + '</a>';
            case 'color':
                return '<span style="color:' + escapeHtml(node.color) + '">' + renderInline(node.children) + '</span>';
            case 'issue':
                return '<span class="jira-task-ref">' + escapeHtml(node.key) + '</span>';
            case 'break':
                return '<br>';
            default:
                return '';
        }
    }

    function renderList(block) {
        const tag = block.ordered ? 'ol' : 'ul';
        const itemsHtml = block.items.map(function (item) {
            const childrenHtml = item.children ? renderBlocks([item.children]) : '';
            return '<li>' + renderInline(parseInline(item.text)) + childrenHtml + '</li>';
        }).join('');
        return '<' + tag + '>' + itemsHtml + '</' + tag + '>';
    }

    function renderTable(block) {
        const rowsHtml = block.rows.map(function (row) {
            const cellTag = row.header ? 'th' : 'td';
            const cellsHtml = row.cells.map(function (cell) {
                return '<' + cellTag + '>' + renderInline(parseInline(cell)) + '</' + cellTag + '>';
            }).join('');
            return '<tr>' + cellsHtml + '</tr>';
        }).join('');
        return '<table class="jira-table"><tbody>' + rowsHtml + '</tbody></table>';
    }

    function renderBlocks(blocks) {
        return blocks.map(renderBlock).join('');
    }

    function renderBlock(block) {
        switch (block.type) {
            case 'paragraph':
                return '<p>' + renderInline(parseInline(block.text)) + '</p>';
            case 'heading':
                return '<h' + block.level + '>' + renderInline(parseInline(block.text)) + '</h' + block.level + '>';
            case 'code': {
                const lang = block.language ? ' data-language="' + escapeHtml(block.language) + '"' : '';
                return '<pre class="jira-code"><code' + lang + '>' + escapeHtml(block.text) + '</code></pre>';
            }
            case 'quote':
                return '<blockquote>' + renderBlocks(block.blocks) + '</blockquote>';
            case 'panel': {
                const titleHtml = block.title
                    ? '<div class="jira-panel-title">' + escapeHtml(block.title) + '</div>'
                    : '';
                return '<div class="jira-panel jira-panel-info">' + titleHtml +
                    '<div class="jira-panel-content">' + renderBlocks(block.blocks) + '</div></div>';
            }
            case 'rule':
                return '<hr>';
            case 'list':
                return renderList(block);
            case 'table':
                return renderTable(block);
            default:
                return '';
        }
    }

    function parseJiraWiki(text) {
        if (!text) return '';
        const blocks = parseBlocks(String(text));
        if (blocks.length === 0) return '';
        return '<div class="jira-doc">' + renderBlocks(blocks) + '</div>';
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { parseInline, parseBlocks, parseJiraWiki };
    }
    if (typeof window !== 'undefined') {
        window.parseJiraWiki = parseJiraWiki;
    }
})();
