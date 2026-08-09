const { test } = require('node:test');
const assert = require('node:assert');

const { describeJiraError } = require('../../browser-extension/background.js');

test('JSON с errorMessages: код ответа впереди, сообщения через точку с запятой', () => {
    const body = JSON.stringify({ errorMessages: ['Issue does not exist', 'Try again'], errors: {} });
    assert.strictEqual(
        describeJiraError(404, body),
        'HTTP 404: Issue does not exist; Try again'
    );
});

test('JSON с errors: значения полей через точку с запятой', () => {
    const body = JSON.stringify({
        errorMessages: [],
        errors: {
            customfield_10016: 'Field cannot be set. It is not on the appropriate screen, or unknown.',
        },
    });
    assert.strictEqual(
        describeJiraError(400, body),
        'HTTP 400: Field cannot be set. It is not on the appropriate screen, or unknown.'
    );
});

test('errorMessages имеет приоритет над errors', () => {
    const body = JSON.stringify({ errorMessages: ['главное'], errors: { f: 'второстепенное' } });
    assert.strictEqual(describeJiraError(400, body), 'HTTP 400: главное');
});

test('JSON с message (типовой ответ прокси или Jira Cloud)', () => {
    assert.strictEqual(
        describeJiraError(401, JSON.stringify({ message: 'Unauthorized' })),
        'HTTP 401: Unauthorized'
    );
});

test('HTML-страница nginx: перевод строки схлопывается, код ответа виден', () => {
    const html = '<html>\r\n<head><title>403 Forbidden</title></head>\n<body>\n<center><h1>403 Forbidden</h1></center>\n<hr><center>nginx/1.18.0</center>\n</body>\n</html>\n';
    const result = describeJiraError(403, html);
    assert.ok(result.startsWith('HTTP 403: '), `ожидался префикс с кодом, получено: ${result}`);
    assert.ok(!/[\r\n]/.test(result), 'переводы строк должны быть схлопнуты');
    assert.ok(result.includes('403 Forbidden'), 'текст страницы должен быть виден');
    assert.ok(result.includes('nginx/1.18.0'), 'сервер из страницы должен быть виден');
});

test('пустое тело: только код ответа, без двоеточия', () => {
    assert.strictEqual(describeJiraError(502, ''), 'HTTP 502');
    assert.strictEqual(describeJiraError(502, '   \n\t '), 'HTTP 502');
    assert.strictEqual(describeJiraError(502, null), 'HTTP 502');
    assert.strictEqual(describeJiraError(502, undefined), 'HTTP 502');
});

test('очень длинное тело обрезается до 300 символов', () => {
    const long = 'x'.repeat(5000);
    const result = describeJiraError(500, long);
    assert.strictEqual(result, `HTTP 500: ${'x'.repeat(300)}`);
    assert.strictEqual(result.length, 'HTTP 500: '.length + 300);
});

test('длинное тело с пробелами: сначала схлопывание, потом обрезка', () => {
    const long = ('слово   \n'.repeat(200));
    const result = describeJiraError(500, long);
    assert.ok(result.startsWith('HTTP 500: слово слово слово'));
    assert.strictEqual(result.length, 'HTTP 500: '.length + 300);
});

test('JSON без знакомых полей: показываем сам текст, а не голый код', () => {
    assert.strictEqual(describeJiraError(400, '{"foo":1}'), 'HTTP 400: {"foo":1}');
});

test('не-JSON текстовое тело показывается как есть', () => {
    assert.strictEqual(describeJiraError(413, 'Request Entity Too Large'), 'HTTP 413: Request Entity Too Large');
});

test('r.json() на ошибочном ответе не вызывается — в коде остались только r.text()', () => {
    // Регресс-охрана: именно вызов r.json() на ошибке прятал код ответа за SyntaxError
    const fs = require('node:fs');
    const src = fs.readFileSync(require.resolve('../../browser-extension/background.js'), 'utf8');
    const code = src.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    const jsonCalls = code.match(/r\.json\(\)/g) || [];
    // Допустимы только успешные ветки: testConnection, getFields, searchIssues
    assert.strictEqual(jsonCalls.length, 3, `неожиданное число вызовов r.json(): ${jsonCalls.length}`);
});
