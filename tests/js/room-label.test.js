// Название комнаты в списке последних.

const { test } = require('node:test');
const assert = require('node:assert');

// roomLabel живёт в script.js, который тянет за собой DOM, поэтому проверяем
// саму логику через её копию контракта: разбор служебной строки задачи Jira.
const { roomLabel } = require('../../web/static/room-label.js');

test('обычная задача остаётся собой', () => {
    assert.strictEqual(roomLabel('Починить вход'), 'Починить вход');
});

test('задача из Jira показывается ключом и названием', () => {
    const текст = '__JIRA__' + JSON.stringify({ key: 'PP-42', summary: 'Починить вход', url: 'https://j/browse/PP-42' });
    assert.strictEqual(roomLabel(текст), 'PP-42 · Починить вход');
});

test('битая служебная строка не показывается как есть', () => {
    assert.strictEqual(roomLabel('__JIRA__{сломано'), 'Задача из Jira');
});

test('пустое описание', () => {
    assert.strictEqual(roomLabel(''), 'Без описания');
    assert.strictEqual(roomLabel(null), 'Без описания');
    assert.strictEqual(roomLabel('   '), 'Без описания');
});
