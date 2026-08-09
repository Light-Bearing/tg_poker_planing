const { test } = require('node:test');
const assert = require('node:assert');

const { parseInline, parseBlocks, parseJiraWiki } = require('../../web/static/wiki-parser.js');

// Хелпер: собирает из узлов плоскую строку вида "text|strong(text)" для читаемых сравнений
function shape(nodes) {
    return nodes.map(function walk(n) {
        if (n.type === 'text') return n.text;
        if (n.type === 'code') return 'code(' + n.text + ')';
        if (n.type === 'issue') return 'issue(' + n.key + ')';
        if (n.type === 'break') return 'break';
        if (n.type === 'link') return 'link[' + n.href + '](' + n.children.map(walk).join('') + ')';
        if (n.type === 'color') return 'color:' + n.color + '(' + n.children.map(walk).join('') + ')';
        return n.type + '(' + n.children.map(walk).join('') + ')';
    }).join('');
}

test('простой текст остаётся текстом', () => {
    assert.strictEqual(shape(parseInline('просто текст')), 'просто текст');
});

test('жирный, курсив, зачёркнутый, подчёркнутый', () => {
    assert.strictEqual(shape(parseInline('это *жирный* текст')), 'это strong(жирный) текст');
    assert.strictEqual(shape(parseInline('это _курсив_ текст')), 'это em(курсив) текст');
    assert.strictEqual(shape(parseInline('это -зачёркнутый- текст')), 'это strike(зачёркнутый) текст');
    assert.strictEqual(shape(parseInline('это +подчёркнутый+ текст')), 'это underline(подчёркнутый) текст');
});

test('верхний и нижний индекс пишутся вплотную к основанию', () => {
    assert.strictEqual(shape(parseInline('x^2^ и H~2~O')), 'xsup(2) и Hsub(2)O');
});

test('моноширинный не разбирается внутри', () => {
    assert.strictEqual(shape(parseInline('{{a_b_c}}')), 'code(a_b_c)');
    assert.strictEqual(shape(parseInline('{{*не жирный*}}')), 'code(*не жирный*)');
});

// --- правило границ: то, ради чего всё затевалось ---

test('подчёркивания внутри идентификатора не создают курсив', () => {
    assert.strictEqual(shape(parseInline('Поле user_name_id пустое')), 'Поле user_name_id пустое');
});

test('плюсы в C++ и Java+Kotlin не создают подчёркивание', () => {
    assert.strictEqual(shape(parseInline('Нужно C++ и Java+Kotlin')), 'Нужно C++ и Java+Kotlin');
});

test('дефис в числовом диапазоне не создаёт зачёркивание', () => {
    assert.strictEqual(shape(parseInline('Срок 5-10 дней')), 'Срок 5-10 дней');
});

// Jira требует, чтобы выделяемая фраза не начиналась и не заканчивалась
// пробелом: маркер с пробелом внутри — обычный текст, а не разметка.

test('тире между словами не создаёт зачёркивание', () => {
    assert.strictEqual(
        shape(parseInline('Иванов - разработка, Петров - тестирование')),
        'Иванов - разработка, Петров - тестирование'
    );
});

test('тире в перечислении «ключ - значение» не создаёт зачёркивание', () => {
    assert.strictEqual(
        shape(parseInline('Формат: ключ - значение, тип - строка')),
        'Формат: ключ - значение, тип - строка'
    );
});

test('плюс в арифметике не создаёт подчёркивание', () => {
    assert.strictEqual(shape(parseInline('Итого 2 + 2 + 2 = 6')), 'Итого 2 + 2 + 2 = 6');
});

test('звёздочка с пробелами не создаёт жирный', () => {
    assert.strictEqual(shape(parseInline('Оценка * 5 * баллов')), 'Оценка * 5 * баллов');
});

test('подчёркивание с пробелами не создаёт курсив', () => {
    assert.strictEqual(shape(parseInline('Формула a _ b _ c')), 'Формула a _ b _ c');
});

test('маркер после открывающей скобки работает', () => {
    assert.strictEqual(shape(parseInline('(*жирный*)')), '(strong(жирный))');
});

test('незакрытый маркер остаётся текстом', () => {
    assert.strictEqual(shape(parseInline('это *не закрыт')), 'это *не закрыт');
});

// --- ссылки: адрес непрозрачен ---

test('ссылка с текстом сохраняет адрес дословно', () => {
    const nodes = parseInline('[Дока|https://wiki.corp/api_v2_spec]');
    assert.strictEqual(nodes.length, 1);
    assert.strictEqual(nodes[0].type, 'link');
    assert.strictEqual(nodes[0].href, 'https://wiki.corp/api_v2_spec');
    assert.strictEqual(shape(nodes[0].children), 'Дока');
});

test('ссылка без текста использует адрес как подпись', () => {
    const nodes = parseInline('[https://example.com/a_b]');
    assert.strictEqual(nodes[0].type, 'link');
    assert.strictEqual(nodes[0].href, 'https://example.com/a_b');
    assert.strictEqual(shape(nodes[0].children), 'https://example.com/a_b');
});

test('адрес без схемы получает https://', () => {
    assert.strictEqual(parseInline('[текст|wiki.corp/x]')[0].href, 'https://wiki.corp/x');
});

test('голый URL с подчёркиваниями становится ссылкой целиком', () => {
    const nodes = parseInline('см. https://wiki.corp/api_v2_spec тут');
    const link = nodes.find(n => n.type === 'link');
    assert.strictEqual(link.href, 'https://wiki.corp/api_v2_spec');
});

test('голый URL не глотает точку в конце предложения', () => {
    const nodes = parseInline('см. https://wiki.corp/page.');
    const link = nodes.find(n => n.type === 'link');
    assert.strictEqual(link.href, 'https://wiki.corp/page');
    assert.strictEqual(shape(nodes), 'см. link[https://wiki.corp/page](https://wiki.corp/page).');

    const html = parseJiraWiki('см. https://wiki.corp/page.');
    assert.match(html, /href="https:\/\/wiki\.corp\/page"/);
    assert.match(html, /<\/a>\.<\/p>/, 'точка должна остаться за пределами ссылки');
});

test('голый URL в скобках и с подчёркиваниями цел', () => {
    const nodes = parseInline('(см. https://example.com/a_b)');
    const link = nodes.find(n => n.type === 'link');
    assert.strictEqual(link.href, 'https://example.com/a_b');
    assert.strictEqual(shape(nodes), '(см. link[https://example.com/a_b](https://example.com/a_b))');
});

test('тильда внутри голого URL не превращается в нижний индекс', () => {
    const nodes = parseInline('см. https://example.com/~user/a~b тут');
    const link = nodes.find(n => n.type === 'link');
    assert.strictEqual(link.href, 'https://example.com/~user/a~b');
    assert.ok(!nodes.some(n => n.type === 'sub'), 'внутри адреса не должно быть разметки');
});

test('незакрытая скобка ссылки не пересекает границу строки', () => {
    const input = '[oops this is unclosed and runs on\nfor a while until it finds a ] somewhere later';
    const nodes = parseInline(input);
    assert.ok(!nodes.some(n => n.type === 'link'), 'ссылка не должна собираться из текста за пределами первой строки');
    assert.strictEqual(shape(nodes), input);
});

// --- прочее ---

test('ключ задачи распознаётся', () => {
    assert.strictEqual(shape(parseInline('см. ABC-123 подробнее')), 'см. issue(ABC-123) подробнее');
});

test('ключ задачи, слитый с кириллическим словом, ключом не считается', () => {
    assert.strictEqual(shape(parseInline('см. ABC-123текст без пробела')), 'см. ABC-123текст без пробела');
});

test('ключ задачи в квадратных скобках остаётся ссылкой на задачу, а не мёртвым href', () => {
    assert.strictEqual(shape(parseInline('[ABC-123]')), 'issue(ABC-123)');

    const html = parseJiraWiki('[ABC-123]');
    assert.match(html, /<span class="jira-task-ref">ABC-123<\/span>/);
    assert.ok(!/<a /.test(html), 'ключ задачи не должен превращаться в ссылку на https://ABC-123');
});

test('ключ задачи с подписью остаётся обычной ссылкой', () => {
    const nodes = parseInline('[ABC-123|https://jira.corp/browse/ABC-123]');
    assert.strictEqual(nodes[0].type, 'link');
    assert.strictEqual(nodes[0].href, 'https://jira.corp/browse/ABC-123');
});

test('ключ задачи в конце предложения перед точкой распознаётся', () => {
    assert.strictEqual(shape(parseInline('Готово: ABC-123.')), 'Готово: issue(ABC-123).');
});

test('цвет разбирается и содержит вложенную разметку', () => {
    assert.strictEqual(shape(parseInline('{color:red}это *важно*{color}')), 'color:red(это strong(важно))');
});

test('перенос строки', () => {
    assert.strictEqual(shape(parseInline('раз\\\\два')), 'разbreakдва');
});

test('неизвестный макрос отдаёт внутренний текст', () => {
    assert.strictEqual(shape(parseInline('{unknown}текст{unknown}')), 'текст');
});

test('абзацы разделяются пустой строкой', () => {
    const blocks = parseBlocks('первый\n\nвторой');
    assert.deepStrictEqual(blocks.map(b => b.type), ['paragraph', 'paragraph']);
    assert.strictEqual(blocks[0].text, 'первый');
    assert.strictEqual(blocks[1].text, 'второй');
});

test('соседние строки склеиваются в один абзац', () => {
    const blocks = parseBlocks('первая\nвторая');
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].text, 'первая\nвторая');
});

test('заголовки h1..h6', () => {
    const blocks = parseBlocks('h2. Заголовок');
    assert.deepStrictEqual(blocks, [{ type: 'heading', level: 2, text: 'Заголовок' }]);
});

test('блок кода сохраняет содержимое дословно', () => {
    const blocks = parseBlocks('{code}\nif (a*b) { return x_y_z; }\nhttps://example.com\n{code}');
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].type, 'code');
    assert.strictEqual(blocks[0].text, 'if (a*b) { return x_y_z; }\nhttps://example.com');
});

test('блок кода с языком', () => {
    const blocks = parseBlocks('{code:java}int x = 1;{code}');
    assert.strictEqual(blocks[0].language, 'java');
    assert.strictEqual(blocks[0].text, 'int x = 1;');
});

test('noformat даёт такой же блок кода', () => {
    const blocks = parseBlocks('{noformat}a*b{noformat}');
    assert.strictEqual(blocks[0].type, 'code');
    assert.strictEqual(blocks[0].text, 'a*b');
});

test('незакрытый блок кода поглощает текст до конца', () => {
    const blocks = parseBlocks('{code}\nхвост без закрытия');
    assert.strictEqual(blocks[0].type, 'code');
    assert.strictEqual(blocks[0].text, 'хвост без закрытия');
});

test('цитата содержит вложенные блоки', () => {
    const blocks = parseBlocks('{quote}текст цитаты{quote}');
    assert.strictEqual(blocks[0].type, 'quote');
    assert.strictEqual(blocks[0].blocks[0].type, 'paragraph');
    assert.strictEqual(blocks[0].blocks[0].text, 'текст цитаты');
});

test('панель с заголовком и без', () => {
    const withTitle = parseBlocks('{panel:title=Важно}Текст{panel}')[0];
    assert.strictEqual(withTitle.type, 'panel');
    assert.strictEqual(withTitle.title, 'Важно');
    assert.strictEqual(withTitle.blocks[0].text, 'Текст');

    const noTitle = parseBlocks('{panel}Текст{panel}')[0];
    assert.strictEqual(noTitle.title, null);
});

test('горизонтальная линия', () => {
    assert.deepStrictEqual(parseBlocks('----'), [{ type: 'rule' }]);
});

test('пустой ввод даёт пустой список блоков', () => {
    assert.deepStrictEqual(parseBlocks(''), []);
    assert.deepStrictEqual(parseBlocks('   \n  \n'), []);
});

// --- списки ---

test('маркированный список без br между пунктами', () => {
    const html = parseJiraWiki('* первый\n* второй');
    assert.match(html, /<ul><li>первый<\/li><li>второй<\/li><\/ul>/);
    assert.ok(!/<ul>[\s\S]*<br>[\s\S]*<\/ul>/.test(html), 'внутри списка не должно быть <br>');
});

test('нумерованный список даёт корректно вложенные теги', () => {
    const html = parseJiraWiki('# раз\n# два');
    assert.match(html, /<ol><li>раз<\/li><li>два<\/li><\/ol>/);
});

test('вложенный список', () => {
    const html = parseJiraWiki('* внешний\n** внутренний');
    assert.match(html, /<ul><li>внешний<ul><li>внутренний<\/li><\/ul><\/li><\/ul>/);
});

test('дефис тоже маркер списка', () => {
    assert.match(parseJiraWiki('- пункт'), /<ul><li>пункт<\/li><\/ul>/);
});

// --- таблицы ---

test('таблица: заголовок в th, строки данных отрисованы', () => {
    const html = parseJiraWiki('||Имя||Тип||\n|user_id|int|\n|name|string|');
    assert.match(html, /<th>Имя<\/th><th>Тип<\/th>/);
    assert.match(html, /<td>user_id<\/td><td>int<\/td>/);
    assert.match(html, /<td>name<\/td><td>string<\/td>/);
    assert.ok(!/<tbody>[\s\S]*<br>[\s\S]*<\/tbody>/.test(html), 'внутри таблицы не должно быть <br>');
});

test('таблица без заголовочной строки', () => {
    const html = parseJiraWiki('|a|b|');
    assert.match(html, /<td>a<\/td><td>b<\/td>/);
    assert.ok(!/<th>/.test(html));
});

test('ссылка внутри ячейки данных остаётся одной ячейкой', () => {
    const rows = parseBlocks('||Что||Где||\n|Спека|[Дока|https://wiki.corp/api_v2_spec]|')[0].rows;
    assert.deepStrictEqual(rows[1].cells, ['Спека', '[Дока|https://wiki.corp/api_v2_spec]']);

    const html = parseJiraWiki('||Что||Где||\n|Спека|[Дока|https://wiki.corp/api_v2_spec]|');
    assert.match(html, /<td>Спека<\/td><td><a href="https:\/\/wiki\.corp\/api_v2_spec"[^>]*>Дока<\/a><\/td>/);
});

test('ссылка внутри заголовочной ячейки остаётся одной ячейкой', () => {
    const rows = parseBlocks('||Что||[Дока|https://wiki.corp/api_v2_spec]||')[0].rows;
    assert.deepStrictEqual(rows[0].cells, ['Что', '[Дока|https://wiki.corp/api_v2_spec]']);

    const html = parseJiraWiki('||Что||[Дока|https://wiki.corp/api_v2_spec]||');
    assert.match(html, /<th>Что<\/th><th><a href="https:\/\/wiki\.corp\/api_v2_spec"[^>]*>Дока<\/a><\/th>/);
});

test('моноширинный с вертикальной чертой внутри ячейки не разрезается', () => {
    const rows = parseBlocks('|{{a|b}}|второй|')[0].rows;
    assert.deepStrictEqual(rows[0].cells, ['{{a|b}}', 'второй']);
    assert.match(parseJiraWiki('|{{a|b}}|второй|'), /<td><code>a\|b<\/code><\/td><td>второй<\/td>/);
});

// --- регрессии на найденные поломки ---

test('регрессия: идентификатор с подчёркиваниями цел', () => {
    const html = parseJiraWiki('Поле user_name_id пустое');
    assert.match(html, /user_name_id/);
    assert.ok(!/<em>/.test(html));
});

test('регрессия: адрес ссылки не искажается', () => {
    const html = parseJiraWiki('[Дока|https://wiki.corp/api_v2_spec]');
    assert.match(html, /href="https:\/\/wiki\.corp\/api_v2_spec"/);
    assert.ok(!/&lt;em&gt;/.test(html));
});

test('регрессия: C++ и Java+Kotlin целы', () => {
    const html = parseJiraWiki('Нужно C++ и Java+Kotlin');
    assert.match(html, /C\+\+/);
    assert.ok(!/<u>/.test(html));
});

test('регрессия: классы панели не повреждены', () => {
    const html = parseJiraWiki('{panel:title=Важно}Текст панели{panel}');
    assert.match(html, /class="jira-panel jira-panel-info"/);
    assert.match(html, /class="jira-panel-title"/);
    assert.ok(!/<s>/.test(html), 'дефисы в именах классов не должны стать зачёркиванием');
});

test('регрессия: содержимое блока кода дословно', () => {
    const html = parseJiraWiki('{code}\nif (a*b) { return x_y_z; }\nhttps://example.com\n{code}');
    assert.match(html, /<pre class="jira-code"><code>/);
    assert.ok(!/<a /.test(html), 'URL внутри кода не должен стать ссылкой');
    assert.ok(!/<br>/.test(html), 'переводы строк внутри кода не должны стать <br>');
    assert.match(html, /x_y_z/);
});

test('регрессия: одиночный перенос строки внутри абзаца становится <br>', () => {
    const html = parseJiraWiki('Нужно починить отчёт.\nСрок — пятница.\nОтветственный — Иванов.');
    const brCount = (html.match(/<br>/g) || []).length;
    assert.strictEqual(brCount, 2, 'между тремя строками абзаца должно быть ровно два <br>');
    assert.match(html, /Нужно починить отчёт\.<br>Срок — пятница\.<br>Ответственный — Иванов\./);
});

test('регрессия: <br> внутри абзаца не портит списки, таблицы и код рядом', () => {
    const listHtml = parseJiraWiki('* первый\n* второй');
    assert.ok(!/<ul>[\s\S]*<br>[\s\S]*<\/ul>/.test(listHtml), 'внутри списка по-прежнему нет <br>');

    const tableHtml = parseJiraWiki('|a|b|');
    assert.ok(!/<tbody>[\s\S]*<br>[\s\S]*<\/tbody>/.test(tableHtml), 'внутри таблицы по-прежнему нет <br>');

    const codeHtml = parseJiraWiki('{code}\nстрока1\nстрока2\n{code}');
    assert.ok(!/<br>/.test(codeHtml), 'внутри кода по-прежнему нет <br>');
});

test('регрессия: тип вложенного уровня списка определяется последним символом серии', () => {
    const olWithUl = parseJiraWiki('# шаг\n#* деталь\n#* деталь\n# шаг два');
    assert.match(olWithUl, /<ol><li>шаг<ul><li>деталь<\/li><li>деталь<\/li><\/ul><\/li><li>шаг два<\/li><\/ol>/);

    const ulWithOl = parseJiraWiki('* пункт\n*# нумерованный');
    assert.match(ulWithOl, /<ul><li>пункт<ol><li>нумерованный<\/li><\/ol><\/li><\/ul>/);
});

test('регрессия: смена типа на одной глубине даёт два отдельных списка', () => {
    const html = parseJiraWiki('* a\n# b');
    assert.match(html, /<ul><li>a<\/li><\/ul><ol><li>b<\/li><\/ol>/);
});

// --- вывод и экранирование ---

test('вывод обёрнут в jira-doc', () => {
    assert.match(parseJiraWiki('текст'), /^<div class="jira-doc">/);
});

test('опасные символы экранируются', () => {
    const html = parseJiraWiki('<script>alert(1)</script> & "кавычки"');
    assert.ok(!/<script>/.test(html));
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&amp;/);
    assert.match(html, /&quot;кавычки&quot;/);
});

test('блок кода с языком отрисовывает data-language', () => {
    const html = parseJiraWiki('{code:java}int x = 1;{code}');
    assert.match(html, /<pre class="jira-code"><code data-language="java">int x = 1;<\/code><\/pre>/);
});

test('цитата отрисовывается как blockquote', () => {
    const html = parseJiraWiki('{quote}текст цитаты{quote}');
    assert.match(html, /<blockquote><p>текст цитаты<\/p><\/blockquote>/);
});

test('горизонтальная линия отрисовывается как hr', () => {
    assert.strictEqual(parseJiraWiki('----'), '<div class="jira-doc"><hr></div>');
});

test('пустой ввод даёт пустую строку', () => {
    assert.strictEqual(parseJiraWiki(''), '');
});

// --- то, что работало раньше, продолжает работать (из tests/e2e/fixtures/wiki-samples.ts) ---

test('образцы из wiki-samples по-прежнему разбираются', () => {
    assert.match(parseJiraWiki('This is *bold* text'), /<strong>bold<\/strong>/);
    assert.match(parseJiraWiki('This is _italic_ text'), /<em>italic<\/em>/);
    assert.match(parseJiraWiki('Use {{var}} here'), /<code>var<\/code>/);
    assert.match(parseJiraWiki('-deleted- text'), /<s>deleted<\/s>/);
    const h = parseJiraWiki('h2. Title');
    assert.match(h, /<h2>/); assert.match(h, /Title/); assert.match(h, /<\/h2>/);
    const cb = parseJiraWiki('{code}print("hi"){code}');
    assert.match(cb, /<pre class="jira-code">/); assert.match(cb, /<code>/); assert.match(cb, /print/);
    const link = parseJiraWiki('[text|https://example.com]');
    assert.match(link, /<a href="https:\/\/example\.com"/); assert.match(link, /text/);
});
