// Определение браузера в popup.
//
// Прежняя проверка смотрела на глобальный browser и потому в Chrome тоже говорила
// «Firefox Detected»: этот самый browser создаёт browser-polyfill.min.js, подключённый
// к popup. Проверка опровергала сама себя.

const { test } = require('node:test');
const assert = require('node:assert');

const { browserTypeFromUrl } = require('../../browser-extension/popup.js');

test('схема moz-extension — Firefox', () => {
    assert.strictEqual(browserTypeFromUrl('moz-extension://11112222-3333/'), 'firefox');
});

test('схема chrome-extension — Chrome, даже когда polyfill создал browser', () => {
    assert.strictEqual(browserTypeFromUrl('chrome-extension://abcdefghijklmno/'), 'chrome');
});

test('пустой или неизвестный адрес не выдаётся за браузер', () => {
    for (const плохой of ['', null, undefined, 'https://example.com/', 'about:blank']) {
        assert.strictEqual(browserTypeFromUrl(плохой), 'unknown', String(плохой));
    }
});
