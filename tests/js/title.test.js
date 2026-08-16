// Заголовок вкладки: по нему находят нужную комнату среди открытых.

const { test } = require('node:test');
const assert = require('node:assert');

const { roomTitle } = require('../../web/static/title.js');

test('в комнате с задачей Jira показывается её номер', () => {
    assert.strictEqual(roomTitle('8bc1f414', 'PP-123'), 'Planning Poker - PP-123');
});

test('без задачи Jira показывается номер комнаты', () => {
    assert.strictEqual(roomTitle('8bc1f414', null), 'Planning Poker - 8bc1f414');
    assert.strictEqual(roomTitle('8bc1f414', ''), 'Planning Poker - 8bc1f414');
    assert.strictEqual(roomTitle('8bc1f414', '   '), 'Planning Poker - 8bc1f414');
});

test('вне комнаты остаётся одно название', () => {
    assert.strictEqual(roomTitle(null, null), 'Planning Poker');
    assert.strictEqual(roomTitle('', ''), 'Planning Poker');
    assert.strictEqual(roomTitle(undefined, undefined), 'Planning Poker');
});

test('лишние пробелы не превращаются в пустую метку', () => {
    assert.strictEqual(roomTitle('  ', 'PP-1'), 'Planning Poker - PP-1');
    assert.strictEqual(roomTitle('  ', '  '), 'Planning Poker');
});
