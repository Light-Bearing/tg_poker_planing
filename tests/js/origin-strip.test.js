// Снятие заголовка Origin у запросов расширения (Firefox).
// Firefox добавляет к запросам расширения Origin: moz-extension://<uuid>, и Jira Server
// отвечает на изменяющие методы 403 «XSRF check failed». Чистые части этой логики
// проверяются здесь; регистрацию слушателя проверить в Node нельзя.

const { test } = require('node:test');
const assert = require('node:assert');

const {
    jiraOriginPattern,
    isOwnRequest,
    withoutOriginHeaders,
} = require('../../browser-extension/background.js');

const SELF = 'moz-extension://11112222-3333-4444-5555-666677778888/';

test('шаблон адреса строится из протокола и хоста', () => {
    assert.strictEqual(jiraOriginPattern('https://project.example.ru'), 'https://project.example.ru/*');
});

test('путь и слеш на конце в шаблон не попадают', () => {
    assert.strictEqual(jiraOriginPattern('https://project.example.ru/'), 'https://project.example.ru/*');
    assert.strictEqual(jiraOriginPattern('https://project.example.ru/jira'), 'https://project.example.ru/*');
});

test('порт сохраняется — иначе слушатель не поймает запросы', () => {
    assert.strictEqual(jiraOriginPattern('https://jira.example.ru:8443'), 'https://jira.example.ru:8443/*');
});

test('мусор и чужие схемы дают null, слушатель не регистрируется', () => {
    assert.strictEqual(jiraOriginPattern(''), null);
    assert.strictEqual(jiraOriginPattern(undefined), null);
    assert.strictEqual(jiraOriginPattern('не адрес'), null);
    assert.strictEqual(jiraOriginPattern('file:///etc/passwd'), null);
});

test('свой запрос узнаётся по originUrl расширения', () => {
    assert.strictEqual(isOwnRequest({ originUrl: `${SELF}_generated_background_page.html` }, SELF), true);
});

test('запрос из вкладки самой Jira своим не считается', () => {
    // Главное свойство: сессию пользователя в его собственных вкладках не ослабляем
    assert.strictEqual(isOwnRequest({ originUrl: 'https://project.example.ru/browse/ABC-1' }, SELF), false);
});

test('запрос другого расширения своим не считается', () => {
    const alien = 'moz-extension://99999999-0000-0000-0000-000000000000/background.html';
    assert.strictEqual(isOwnRequest({ originUrl: alien }, SELF), false);
});

test('запрос без originUrl своим не считается', () => {
    assert.strictEqual(isOwnRequest({}, SELF), false);
    assert.strictEqual(isOwnRequest({ originUrl: `${SELF}popup.html` }, ''), false);
});

test('Origin удаляется, остальные заголовки остаются нетронутыми', () => {
    const headers = [
        { name: 'Authorization', value: 'Bearer t' },
        { name: 'Origin', value: SELF.slice(0, -1) },
        { name: 'X-Atlassian-Token', value: 'no-check' },
    ];
    assert.deepStrictEqual(withoutOriginHeaders(headers, SELF), [
        { name: 'Authorization', value: 'Bearer t' },
        { name: 'X-Atlassian-Token', value: 'no-check' },
    ]);
});

test('регистр имени заголовка значения не имеет', () => {
    const headers = [{ name: 'origin', value: 'x' }, { name: 'ORIGIN', value: 'y' }];
    assert.deepStrictEqual(withoutOriginHeaders(headers, SELF), []);
});

test('свой Referer удаляется, чужой остаётся', () => {
    const headers = [
        { name: 'Referer', value: `${SELF}popup.html` },
        { name: 'Accept', value: 'application/json' },
    ];
    assert.deepStrictEqual(withoutOriginHeaders(headers, SELF), [{ name: 'Accept', value: 'application/json' }]);

    const foreign = [{ name: 'Referer', value: 'https://project.example.ru/browse/ABC-1' }];
    assert.deepStrictEqual(withoutOriginHeaders(foreign, SELF), foreign);
});

test('пустой список заголовков не роняет фильтр', () => {
    assert.deepStrictEqual(withoutOriginHeaders(undefined, SELF), []);
    assert.deepStrictEqual(withoutOriginHeaders([], SELF), []);
});
