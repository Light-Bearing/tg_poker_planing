// Поиск по загруженным задачам в окне «Выбор задачи из Jira»

const { test } = require('node:test');
const assert = require('node:assert');

const { filterJiraIssues } = require('../../web/static/jira-search.js');

const EPIC_FIELD = 'customfield_10014';
const EPICS = { 'PAY-1': 'Платежи', 'AUTH-9': 'Авторизация' };

const issue = (key, summary, epic) => ({
    key,
    fields: { summary, [EPIC_FIELD]: epic || null },
});

const ISSUES = [
    issue('PAY-14', 'Оплата картой', 'PAY-1'),
    issue('PAY-15', 'Возврат средств', 'PAY-1'),
    issue('AUTH-22', 'Вход по SMS', 'AUTH-9'),
    issue('MISC-3', 'Починить отчёт'),
];

const keys = (list) => list.map((i) => i.key);

test('пустой запрос возвращает все задачи', () => {
    assert.deepStrictEqual(keys(filterJiraIssues(ISSUES, '', EPICS, EPIC_FIELD)), keys(ISSUES));
    assert.deepStrictEqual(keys(filterJiraIssues(ISSUES, '   ', EPICS, EPIC_FIELD)), keys(ISSUES));
    assert.deepStrictEqual(keys(filterJiraIssues(ISSUES, undefined, EPICS, EPIC_FIELD)), keys(ISSUES));
});

test('находит по ключу задачи, в том числе по части', () => {
    assert.deepStrictEqual(keys(filterJiraIssues(ISSUES, 'AUTH-22', EPICS, EPIC_FIELD)), ['AUTH-22']);
    assert.deepStrictEqual(keys(filterJiraIssues(ISSUES, 'pay-1', EPICS, EPIC_FIELD)), ['PAY-14', 'PAY-15']);
});

test('регистр не имеет значения', () => {
    assert.deepStrictEqual(keys(filterJiraIssues(ISSUES, 'ОПЛАТА', EPICS, EPIC_FIELD)), ['PAY-14']);
    assert.deepStrictEqual(keys(filterJiraIssues(ISSUES, 'оплата', EPICS, EPIC_FIELD)), ['PAY-14']);
});

test('находит по заголовку', () => {
    assert.deepStrictEqual(keys(filterJiraIssues(ISSUES, 'возврат', EPICS, EPIC_FIELD)), ['PAY-15']);
});

test('находит по названию эпика — задачи эпика целиком', () => {
    assert.deepStrictEqual(keys(filterJiraIssues(ISSUES, 'платежи', EPICS, EPIC_FIELD)), ['PAY-14', 'PAY-15']);
});

test('слова ищутся в любом порядке и по частям', () => {
    // Ровно ради этого запрос делится на слова: набирать точную фразу неудобно
    assert.deepStrictEqual(keys(filterJiraIssues(ISSUES, 'карт оплат', EPICS, EPIC_FIELD)), ['PAY-14']);
});

test('подходят только задачи со всеми словами сразу', () => {
    assert.deepStrictEqual(keys(filterJiraIssues(ISSUES, 'оплата sms', EPICS, EPIC_FIELD)), []);
});

test('ничего не найдено — пустой список, а не все задачи', () => {
    assert.deepStrictEqual(filterJiraIssues(ISSUES, 'кракозябра', EPICS, EPIC_FIELD), []);
});

test('задача без эпика ищется по своим полям и не падает', () => {
    assert.deepStrictEqual(keys(filterJiraIssues(ISSUES, 'отчёт', EPICS, EPIC_FIELD)), ['MISC-3']);
});

test('эпик в виде объекта разбирается так же, как строкой', () => {
    const списком = [{ key: 'X-1', fields: { summary: 'Задача', [EPIC_FIELD]: { key: 'PAY-1' } } }];
    assert.deepStrictEqual(keys(filterJiraIssues(списком, 'платежи', EPICS, EPIC_FIELD)), ['X-1']);
});

test('пустой список задач и отсутствующие поля не роняют поиск', () => {
    assert.deepStrictEqual(filterJiraIssues([], 'что-нибудь', EPICS, EPIC_FIELD), []);
    assert.deepStrictEqual(filterJiraIssues(undefined, 'что-нибудь'), []);
    assert.deepStrictEqual(filterJiraIssues([{}], 'что-нибудь'), []);
    assert.deepStrictEqual(filterJiraIssues([{ key: 'A-1' }], 'a-1').length, 1);
});
