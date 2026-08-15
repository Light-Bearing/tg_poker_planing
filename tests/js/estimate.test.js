// Итоговая оценка: число в ИТОГЕ должно быть картой из колоды, а не результатом
// деления. И для шкал, где среднее не считается, итог всё равно обязан быть.

const { test } = require('node:test');
const assert = require('node:assert');

const { snapToScale, modePoint } = require('../../web/static/estimate.js');

const FIB = ['1', '2', '3', '5', '8', '13', '21', '❔', '☕'];
const POW2 = ['1', '2', '4', '8', '16', '32', '64', '❔', '☕'];
const TSHIRT = ['XS', 'S', 'M', 'L', 'XL', '❔', '☕'];

test('итог берётся из колоды, а не из среднего', () => {
    // Голоса 8/16/32 дают 18.666…, и в ИТОГ попадало 19 — такой карты нет
    assert.strictEqual(snapToScale(18.666, POW2), '16');
    assert.strictEqual(snapToScale(6.3, FIB), '5');
    assert.strictEqual(snapToScale(7.0, FIB), '8');
});

test('точное попадание остаётся собой', () => {
    assert.strictEqual(snapToScale(13, FIB), '13');
    assert.strictEqual(snapToScale(1, FIB), '1');
});

test('ровно посередине округляем вверх', () => {
    // 10.5 между 8 и 13 — ближе к 13; 4 между 3 и 5 равноудалено, берём 5
    assert.strictEqual(snapToScale(4, FIB), '5');
    assert.strictEqual(snapToScale(1.5, FIB), '2');
});

test('за краями колоды берётся крайняя карта', () => {
    assert.strictEqual(snapToScale(100, FIB), '21');
    assert.strictEqual(snapToScale(0.1, FIB), '1');
});

test('особые значения в итог не попадают', () => {
    assert.strictEqual(snapToScale(5, ['❔', '☕']), null);
});

test('шкала без чисел итога по среднему не даёт', () => {
    assert.strictEqual(snapToScale(3, TSHIRT), null);
    assert.strictEqual(snapToScale(3, []), null);
});

test('для нечисловой шкалы итог — самый частый голос', () => {
    assert.strictEqual(modePoint(['L', 'M', 'L'], TSHIRT), 'L');
    assert.strictEqual(modePoint(['S'], TSHIRT), 'S');
});

test('при ничьей берётся старшая карта колоды', () => {
    // M и L по одному голосу: L дороже, и недооценить хуже, чем переоценить
    assert.strictEqual(modePoint(['M', 'L'], TSHIRT), 'L');
    assert.strictEqual(modePoint(['XL', 'XS'], TSHIRT), 'XL');
});

test('«не знаю» и «перерыв» итогом не становятся', () => {
    assert.strictEqual(modePoint(['❔', '❔', 'M'], TSHIRT), 'M');
    assert.strictEqual(modePoint(['❔', '☕'], TSHIRT), null);
    assert.strictEqual(modePoint([], TSHIRT), null);
});
