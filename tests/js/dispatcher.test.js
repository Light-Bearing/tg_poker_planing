const { test } = require('node:test');
const assert = require('node:assert');

const { parseJiraDescription, escapeHtml } = require('../../web/static/adf-parser.js');

test('escapeHtml экранирует все пять опасных символов', () => {
    assert.strictEqual(
        escapeHtml(`<a href="x" class='y'>&</a>`),
        '&lt;a href=&quot;x&quot; class=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
    );
});

test('escapeHtml не требует браузера и переваривает не-строки', () => {
    assert.strictEqual(escapeHtml(42), '42');
    assert.strictEqual(escapeHtml(''), '');
});

test('диспетчер: пустое описание даёт пустую строку', () => {
    assert.strictEqual(parseJiraDescription(''), '');
    assert.strictEqual(parseJiraDescription(null), '');
    assert.strictEqual(parseJiraDescription(undefined), '');
});

test('диспетчер: объект ADF идёт в ADF-ветку', () => {
    const html = parseJiraDescription({
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'привет' }] }],
    });
    assert.match(html, /<div class="jira-doc">/);
    assert.match(html, /<p>привет<\/p>/);
});

test('ADF: ссылка и код сохраняют адрес и текст', () => {
    const html = parseJiraDescription({
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [
            { type: 'text', text: 'дока', marks: [{ type: 'link', attrs: { href: 'https://wiki.corp/api_v2_spec' } }] },
            { type: 'text', text: 'user_name_id', marks: [{ type: 'code' }] },
        ] }],
    });
    assert.match(html, /href="https:\/\/wiki\.corp\/api_v2_spec"/);
    assert.match(html, /<code>user_name_id<\/code>/);
});

const { parseJiraWiki } = require('../../web/static/wiki-parser.js');

test('диспетчер: строка идёт в wiki-ветку', () => {
    assert.strictEqual(parseJiraDescription('*жирный*'), parseJiraWiki('*жирный*'));
});

test('диспетчер: не строка и не ADF приводится к экранированной строке', () => {
    assert.strictEqual(parseJiraDescription(42), '42');
});

test('диспетчер: wiki-ветка больше не искажает адреса', () => {
    const html = parseJiraDescription('[Дока|https://wiki.corp/api_v2_spec]');
    assert.match(html, /href="https:\/\/wiki\.corp\/api_v2_spec"/);
});
