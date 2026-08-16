// Отрисовка особых карт.
//
// Главное здесь — что подмена касается только вида. Значение карты остаётся тем
// же символом: под ним лежат голоса в базе и его знает телеграм-бот.

const { test } = require('node:test');
const assert = require('node:assert');

const { pointMarkup, hasIcon, escapeText } = require('../../web/static/glyphs.js');

test('особые карты рисуются значком', () => {
    for (const point of ['❔', '☕']) {
        const html = pointMarkup(point);
        assert.ok(html.startsWith('<svg'), `${point} должна рисоваться значком`);
        assert.ok(html.includes('currentColor'), 'цвет обязан наследоваться от темы');
        assert.ok(!html.includes(point), 'сам эмодзи в разметку не попадает');
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
