// Копирование в буфер обмена.
//
// На стенде по http кнопка копирования молчала: navigator.clipboard в незащищённом
// контексте отсутствует, обращение к нему бросало TypeError синхронно, и .catch()
// не срабатывал — пользователь не видел ни текста в буфере, ни ошибки.

const { test } = require('node:test');
const assert = require('node:assert');

const { copyText } = require('../../web/static/clipboard.js');

/** Подставной документ: запоминает, что попало в поле и вызывался ли execCommand */
function fakeDocument({ execOk = true } = {}) {
    const state = { copied: null, execCalled: false, детей: 0 };
    return {
        state,
        body: {
            appendChild() { state.детей += 1; },
            removeChild() { state.детей -= 1; },
        },
        createElement() {
            return {
                style: {},
                setAttribute() {},
                select() {},
                setSelectionRange() {},
                set value(v) { state.copied = v; },
                get value() { return state.copied; },
            };
        },
        execCommand() {
            state.execCalled = true;
            return execOk;
        },
    };
}

test('в защищённом контексте пишет через navigator.clipboard', async () => {
    let written = null;
    const navigator = { clipboard: { writeText: async (v) => { written = v; } } };
    const doc = fakeDocument();

    assert.strictEqual(await copyText('текст', { navigator, document: doc }), true);
    assert.strictEqual(written, 'текст');
    assert.strictEqual(doc.state.execCalled, false, 'запасной путь трогать было незачем');
});

test('без navigator.clipboard не падает, а копирует запасным путём', async () => {
    // Ровно случай стенда по http
    const doc = fakeDocument();
    assert.strictEqual(await copyText('http://стенд:8000?session=ABC', { navigator: {}, document: doc }), true);
    assert.strictEqual(doc.state.copied, 'http://стенд:8000?session=ABC');
    assert.strictEqual(doc.state.execCalled, true);
});

test('отказ clipboard переводит на запасной путь, а не роняет', async () => {
    const navigator = { clipboard: { writeText: async () => { throw new Error('отказано'); } } };
    const doc = fakeDocument();
    assert.strictEqual(await copyText('текст', { navigator, document: doc }), true);
    assert.strictEqual(doc.state.copied, 'текст');
});

test('когда не вышло совсем — честное false, а не тихий успех', async () => {
    const doc = fakeDocument({ execOk: false });
    assert.strictEqual(await copyText('текст', { navigator: {}, document: doc }), false);
});

test('временное поле убирается за собой при любом исходе', async () => {
    for (const execOk of [true, false]) {
        const doc = fakeDocument({ execOk });
        await copyText('текст', { navigator: {}, document: doc });
        assert.strictEqual(doc.state.детей, 0, 'поле осталось в документе');
    }
});

test('число и пустое значение не роняют копирование', async () => {
    const doc = fakeDocument();
    assert.strictEqual(await copyText(13, { navigator: {}, document: doc }), true);
    assert.strictEqual(doc.state.copied, '13');
    await copyText(null, { navigator: {}, document: doc });
    assert.strictEqual(doc.state.copied, '');
});
