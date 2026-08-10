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
    assert.strictEqual(allowed.jiraToken, 'SECRET-TOKEN-123');

    const blocked = await ask({ type: 'getSettings' }, EVIL);
    assert.strictEqual(blocked.error, 'ORIGIN_NOT_ALLOWED');
    assert.ok(!('jiraToken' in blocked));
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
    assert.strictEqual(resp.jiraToken, 'SECRET-TOKEN-123');
});

test('отказ называет адрес, который надо разрешить', async () => {
    const resp = await ask({ type: 'getSettings' }, EVIL);
    assert.strictEqual(resp.origin, 'https://evil.example');
});
