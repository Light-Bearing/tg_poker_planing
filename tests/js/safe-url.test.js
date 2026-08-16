// Схема адреса: `javascript:` в href — это код, который выполнится по клику.

const { test } = require('node:test');
const assert = require('node:assert');

const { safeUrl } = require('../../web/static/safe-url.js');

test('обычные ссылки проходят как есть', () => {
    assert.strictEqual(safeUrl('https://jira.example.com/browse/PP-1'), 'https://jira.example.com/browse/PP-1');
    assert.strictEqual(safeUrl('http://example.com'), 'http://example.com');
    assert.strictEqual(safeUrl('mailto:someone@example.com'), 'mailto:someone@example.com');
});

test('относительные адреса остаются на своём сайте и потому безопасны', () => {
    assert.strictEqual(safeUrl('/browse/PP-1'), '/browse/PP-1');
    assert.strictEqual(safeUrl('#anchor'), '#anchor');
    assert.strictEqual(safeUrl('//example.com/path'), '//example.com/path');
});

test('исполняемые схемы отбрасываются', () => {
    for (const опасный of [
        'javascript:alert(1)',
        'JaVaScRiPt:alert(1)',
        '  javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'vbscript:msgbox(1)',
        'file:///etc/passwd',
    ]) {
        assert.strictEqual(safeUrl(опасный), '#', опасный);
    }
});

test('пустое и мусор превращаются в заглушку', () => {
    assert.strictEqual(safeUrl(''), '#');
    assert.strictEqual(safeUrl(null), '#');
    assert.strictEqual(safeUrl(undefined), '#');
    assert.strictEqual(safeUrl('   '), '#');
});

test('схема с пробелами внутри — та же схема для браузера', () => {
    // «java\tscript:» браузер разбирает как javascript:, поэтому URL тоже
    assert.strictEqual(safeUrl('java\tscript:alert(1)'), '#');
    assert.strictEqual(safeUrl('java\nscript:alert(1)'), '#');
});
