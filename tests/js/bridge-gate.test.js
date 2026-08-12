// Ворота моста на настоящем обработчике сообщений background.js.
//
// Отдельные функции проверены в origin-allowlist.test.js, но дыра была не в них, а в том,
// что обработчик вообще никого не спрашивал. Поэтому здесь поднимается подставной
// браузерный API и дёргается тот же handleMessage, что и в браузере.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const BACKGROUND = path.resolve(__dirname, '../../browser-extension/background.js');

const EVIL = { tab: { id: 1 }, url: 'https://evil.example/page' };
const APP = { tab: { id: 2 }, url: 'https://planning.example.ru/room/1' };
const POPUP = { url: 'chrome-extension://id/popup.html' };

let store;
let handler;

beforeEach(() => {
    store = {
        jiraUrl: 'https://jira.example.ru',
        jiraToken: 'SECRET-TOKEN-123',
        allowedOrigins: [],
    };
    handler = null;
    global.chrome = {
        runtime: {
            onMessage: { addListener: (fn) => { handler = fn; } },
            getManifest: () => ({ manifest_version: 3 }),
            getURL: () => 'chrome-extension://id/',
        },
        storage: {
            local: {
                get: (keys) => Promise.resolve(Object.fromEntries(keys.map(k => [k, store[k]]))),
                set: (obj) => { Object.assign(store, obj); return Promise.resolve(); },
            },
        },
    };
    delete require.cache[BACKGROUND];
    require(BACKGROUND);
});

const ask = (message, sender) => new Promise(resolve => handler(message, sender, resolve));

test('пока список пуст, токен не получает никто — в том числе само приложение', async () => {
    for (const sender of [EVIL, APP]) {
        const resp = await ask({ type: 'getSettings' }, sender);
        assert.strictEqual(resp.error, 'ORIGIN_NOT_ALLOWED');
        assert.ok(!('jiraToken' in resp));
    }
});

test('разрешённый адрес получает настройки, посторонний — нет', async () => {
    await ask({ type: 'saveSettings', jiraUrl: store.jiraUrl, jiraToken: store.jiraToken, allowedOrigins: 'https://planning.example.ru' }, POPUP);

    const allowed = await ask({ type: 'getSettings' }, APP);
    assert.strictEqual(allowed.jiraUrl, 'https://jira.example.ru');
    assert.strictEqual(allowed.configured, true);

    const blocked = await ask({ type: 'getSettings' }, EVIL);
    assert.strictEqual(blocked.error, 'ORIGIN_NOT_ALLOWED');
    assert.ok(!('jiraToken' in blocked));
});

test('токен не отдаётся никому — ни странице, ни popup', async () => {
    await ask({ type: 'saveSettings', jiraUrl: store.jiraUrl, jiraToken: store.jiraToken, allowedOrigins: 'https://planning.example.ru' }, POPUP);
    for (const sender of [APP, POPUP]) {
        const resp = await ask({ type: 'getSettings' }, sender);
        assert.ok(!('jiraToken' in resp), JSON.stringify(resp));
        assert.ok(!JSON.stringify(resp).includes('SECRET-TOKEN-123'));
    }
});

test('страница не может подменить адрес Jira и увести токен на чужой хост', async () => {
    await ask({ type: 'saveSettings', jiraUrl: store.jiraUrl, jiraToken: store.jiraToken, allowedOrigins: 'https://planning.example.ru' }, POPUP);
    await ask({ type: 'saveSettings', jiraUrl: 'https://evil.example', jiraToken: 'подменыш', jiraFilter: 'x' }, APP);
    assert.strictEqual(store.jiraUrl, 'https://jira.example.ru');
    assert.strictEqual(store.jiraToken, 'SECRET-TOKEN-123');
    // Несекретное страница сохранить по-прежнему может
    assert.strictEqual(store.jiraFilter, 'x');
});

test('посторонняя страница не может разрешить себя сама', async () => {
    await ask({ type: 'saveSettings', jiraUrl: store.jiraUrl, jiraToken: store.jiraToken, allowedOrigins: 'https://planning.example.ru' }, POPUP);
    await ask({ type: 'saveSettings', allowedOrigins: 'https://evil.example' }, EVIL);
    assert.deepStrictEqual(store.allowedOrigins, ['https://planning.example.ru']);
});

test('разрешённая страница не может дописать себе соседей', async () => {
    await ask({ type: 'saveSettings', jiraUrl: store.jiraUrl, jiraToken: store.jiraToken, allowedOrigins: 'https://planning.example.ru' }, POPUP);
    // Страница шлёт настройки без поля allowedOrigins — background его и не читает
    await ask({
        type: 'saveSettings',
        jiraUrl: store.jiraUrl, jiraToken: store.jiraToken,
        allowedOrigins: 'https://planning.example.ru\nhttps://evil.example',
    }, APP);
    assert.deepStrictEqual(store.allowedOrigins, ['https://planning.example.ru']);
});

test('popup работает всегда — у его сообщений нет вкладки', async () => {
    const resp = await ask({ type: 'getSettings' }, POPUP);
    assert.strictEqual(resp.configured, true);
    assert.ok(!('error' in resp));
});

test('сохранение из popup не стирает поля, заданные на странице', async () => {
    // Настройки пишут двое: popup владеет адресом и токеном, страница — фильтром
    // и полями. Пока saveSettings писал все ключи подряд, каждый затирал чужое:
    // владелец задавал поле Story Points на странице, жал «Сохранить» в popup —
    // и поле обнулялось.
    await ask({ type: 'saveSettings', jiraUrl: store.jiraUrl, jiraToken: store.jiraToken, allowedOrigins: 'https://planning.example.ru' }, POPUP);
    await ask({ type: 'saveSettings', jiraFilter: 'project = X', storyPointsField: 'customfield_10016' }, APP);

    await ask({ type: 'saveSettings', jiraUrl: store.jiraUrl, jiraToken: store.jiraToken }, POPUP);

    assert.strictEqual(store.jiraFilter, 'project = X');
    assert.strictEqual(store.storyPointsField, 'customfield_10016');
});

test('сохранение со страницы не стирает адрес и токен', async () => {
    await ask({ type: 'saveSettings', jiraUrl: store.jiraUrl, jiraToken: store.jiraToken, allowedOrigins: 'https://planning.example.ru' }, POPUP);
    await ask({ type: 'saveSettings', jiraFilter: 'project = X' }, APP);

    assert.strictEqual(store.jiraUrl, 'https://jira.example.ru');
    assert.strictEqual(store.jiraToken, 'SECRET-TOKEN-123');
});

test('пустое значение стирает поле осознанно — если его прислали', async () => {
    // Отличать «ключа нет» от «ключ пустой» обязательно: иначе очистить фильтр
    // станет нельзя
    await ask({ type: 'saveSettings', jiraUrl: store.jiraUrl, jiraToken: store.jiraToken, allowedOrigins: 'https://planning.example.ru' }, POPUP);
    await ask({ type: 'saveSettings', jiraFilter: 'project = X' }, APP);
    await ask({ type: 'saveSettings', jiraFilter: '' }, APP);

    assert.strictEqual(store.jiraFilter, '');
});

test('учётные данные для запроса берутся из хранилища, а не из сообщения страницы', async () => {
    await ask({ type: 'saveSettings', jiraUrl: store.jiraUrl, jiraToken: store.jiraToken, allowedOrigins: 'https://planning.example.ru' }, POPUP);

    let captured = null;
    global.fetch = async (url, init) => {
        captured = { url, init };
        return { ok: true, status: 200, json: async () => ({ issues: [] }) };
    };

    // Страница пытается увести запрос с токеном на свой хост
    const resp = await ask({
        type: 'searchIssues',
        jiraUrl: 'https://evil.example',
        jiraToken: 'подменыш',
        jql: 'project = X',
    }, APP);

    assert.strictEqual(resp.ok, true);
    assert.ok(captured.url.startsWith('https://jira.example.ru/'), captured.url);
    assert.strictEqual(captured.init.headers['Authorization'], 'Bearer SECRET-TOKEN-123');
});

test('без настроек запрос не уходит, а объясняет, чего не хватает', async () => {
    store.jiraToken = '';
    await ask({ type: 'saveSettings', jiraUrl: 'https://jira.example.ru', jiraToken: '', allowedOrigins: 'https://planning.example.ru' }, POPUP);

    let called = false;
    global.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };

    const resp = await ask({ type: 'searchIssues', jql: 'project = X' }, APP);
    assert.strictEqual(resp.ok, false);
    assert.match(resp.error, /не настроено/);
    assert.strictEqual(called, false);
});

test('отказ называет адрес, который надо разрешить', async () => {
    const resp = await ask({ type: 'getSettings' }, EVIL);
    assert.strictEqual(resp.origin, 'https://evil.example');
});
