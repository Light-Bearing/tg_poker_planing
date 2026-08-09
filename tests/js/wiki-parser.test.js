const { test } = require('node:test');
const assert = require('node:assert');

const { parseInline } = require('../../web/static/wiki-parser.js');

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
