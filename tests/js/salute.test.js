// Салют при единогласии.
//
// Главное здесь — когда он НЕ должен срабатывать: ложный праздник обесценивает
// настоящий, а бьющий очередями салют просто мешает работать.

const { test } = require('node:test');
const assert = require('node:assert');

const { isUnanimous, makeParticle, stepParticle, motionAllowed } = require('../../web/static/salute.js');

test('все сошлись на одном значении', () => {
    assert.strictEqual(isUnanimous(['5', '5', '5']), true);
    assert.strictEqual(isUnanimous(['13', '13']), true);
});

test('разброс — не повод для салюта', () => {
    assert.strictEqual(isUnanimous(['5', '8', '5']), false);
    assert.strictEqual(isUnanimous(['1', '2']), false);
});

test('один участник сам с собой не соглашается', () => {
    assert.strictEqual(isUnanimous(['5']), false);
    assert.strictEqual(isUnanimous([]), false);
    assert.strictEqual(isUnanimous(undefined), false);
});

test('дружное «не знаю» согласием не считается', () => {
    // «❔» — не оценка, а признание, что оценить нечем
    assert.strictEqual(isUnanimous(['❔', '❔', '❔']), false);
    assert.strictEqual(isUnanimous(['☕', '☕']), false);
});

test('непроголосовавшие не мешают и не создают согласия', () => {
    // Пустые значения приходят от тех, кто ещё не выбрал карту
    assert.strictEqual(isUnanimous(['5', '5', null, undefined, '']), true);
    assert.strictEqual(isUnanimous(['5', null]), false);
});

test('значения сравниваются как есть, без приведения типов', () => {
    // «5» и 5 из разных источников не должны схлопываться в согласие
    assert.strictEqual(isUnanimous(['5', 5]), false);
});

test('свой список особых значений уважается', () => {
    assert.strictEqual(isUnanimous(['XS', 'XS'], ['XS']), false);
    assert.strictEqual(isUnanimous(['XS', 'XS'], []), true);
});

test('частица летит из точки запуска и гаснет', () => {
    const p = makeParticle(100, 50, () => 0.5);
    assert.strictEqual(p.x, 100);
    assert.strictEqual(p.y, 50);
    assert.ok(p.жизнь > 0);

    for (let i = 0; i < 200; i++) stepParticle(p);
    assert.ok(p.жизнь <= 0, 'частица обязана погаснуть, иначе кадры считаются вечно');
});

test('частицу тянет вниз', () => {
    const p = makeParticle(0, 0, () => 0.5);
    const скоростьДо = p.vy;
    stepParticle(p);
    assert.ok(p.vy > скоростьДо, 'гравитация должна увеличивать вертикальную скорость');
});

test('при системной просьбе меньше движения салют не запускается', () => {
    const сОграничением = { matchMedia: () => ({ matches: true }) };
    const безОграничения = { matchMedia: () => ({ matches: false }) };
    assert.strictEqual(motionAllowed(сОграничением), false);
    assert.strictEqual(motionAllowed(безОграничения), true);
    // Браузер без matchMedia не повод отказывать
    assert.strictEqual(motionAllowed({}), true);
});
