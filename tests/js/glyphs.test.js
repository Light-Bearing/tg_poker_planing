// Отрисовка особых карт.
//
// Главное здесь — что подмена касается только вида. Значение карты остаётся тем
// же символом: под ним лежат голоса в базе и его знает телеграм-бот.

const { test } = require('node:test');
const assert = require('node:assert');

const { pointMarkup, hasIcon, escapeText } = require('../../web/static/glyphs.js');

test('особые карты рисуются значком', () => {
    assert.match(pointMarkup('❔'), /class="point-glyph point-glyph-unknown"/);
    assert.match(pointMarkup('☕'), /class="point-glyph point-glyph-coffee"/);
    for (const point of ['❔', '☕']) {
        assert.ok(!pointMarkup(point).includes(point), 'сам эмодзи в разметку не попадает');
    }
});

test('у значка есть подпись для тех, кто не видит картинку', () => {
    assert.match(pointMarkup('❔'), /aria-label="не знаю"/);
    assert.match(pointMarkup('☕'), /aria-label="перерыв"/);
});

test('обычные значения остаются текстом', () => {
    assert.strictEqual(pointMarkup('8'), '8');
    assert.strictEqual(pointMarkup('XL'), 'XL');
    assert.strictEqual(pointMarkup('½'), '½');
});

test('текст значения экранируется', () => {
    // Значения приходят из своей шкалы, а её пишет человек
    assert.strictEqual(pointMarkup('<b>'), '&lt;b&gt;');
    assert.strictEqual(escapeText('a"b\'c&d'), 'a&quot;b&#39;c&amp;d');
});

test('значок положен только двум картам', () => {
    assert.strictEqual(hasIcon('❔'), true);
    assert.strictEqual(hasIcon('☕'), true);
    assert.strictEqual(hasIcon('8'), false);
    assert.strictEqual(hasIcon('constructor'), false, 'наследованные свойства объекта — не карты');
    assert.strictEqual(hasIcon(''), false);
});
