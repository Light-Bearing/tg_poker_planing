// Ворота по происхождению страницы.
//
// content.js объявлен на <all_urls> и ретранслирует в background любое сообщение
// с меткой source: 'pp-jira-page'. Без этой проверки любая открытая страница одним
// postMessage получала сохранённый токен Jira по типу getSettings.

const { test } = require('node:test');
const assert = require('node:assert');

const {
    normalizeOrigin,
    parseAllowedOrigins,
    isPageSender,
    senderOrigin,
    isAllowedOrigin,
} = require('../../browser-extension/background.js');

test('адрес приводится к схеме и хосту', () => {
    assert.strictEqual(normalizeOrigin('https://planning.example.ru/room/42?x=1'), 'https://planning.example.ru');
    assert.strictEqual(normalizeOrigin('http://localhost:8000'), 'http://localhost:8000');
    assert.strictEqual(normalizeOrigin('  https://planning.example.ru  '), 'https://planning.example.ru');
});

test('регистр хоста значения не имеет', () => {
    assert.strictEqual(normalizeOrigin('https://Planning.Example.RU'), 'https://planning.example.ru');
});

test('порт различает адреса — localhost:8000 и localhost:9000 не одно и то же', () => {
    assert.notStrictEqual(normalizeOrigin('http://localhost:8000'), normalizeOrigin('http://localhost:9000'));
});

test('не-http схемы и мусор отбрасываются', () => {
    for (const bad of ['', '   ', undefined, null, 'не адрес', 'file:///etc/passwd', 'javascript:alert(1)']) {
        assert.strictEqual(normalizeOrigin(bad), null, String(bad));
    }
});

test('список разбирается по строкам, запятым и пробелам', () => {
    const text = 'https://planning.example.ru\nhttp://localhost:8000, https://pp.example.com';
    assert.deepStrictEqual(parseAllowedOrigins(text), [
        'https://planning.example.ru',
        'http://localhost:8000',
        'https://pp.example.com',
    ]);
});

test('мусорные строки в списке не открывают доступ', () => {
    assert.deepStrictEqual(parseAllowedOrigins('https://ok.example.ru\nне адрес\n\n'), ['https://ok.example.ru']);
    assert.deepStrictEqual(parseAllowedOrigins(''), []);
    assert.deepStrictEqual(parseAllowedOrigins(undefined), []);
});

test('сообщение из вкладки считается пришедшим со страницы', () => {
    assert.strictEqual(isPageSender({ tab: { id: 7 }, url: 'https://evil.example/' }), true);
});

test('сообщение из popup страницей не считается — у него нет вкладки', () => {
    assert.strictEqual(isPageSender({ url: 'moz-extension://uuid/popup.html' }), false);
    assert.strictEqual(isPageSender({}), false);
    assert.strictEqual(isPageSender(undefined), false);
});

test('происхождение берётся из полей браузера, а не из тела сообщения', () => {
    assert.strictEqual(senderOrigin({ origin: 'https://planning.example.ru' }), 'https://planning.example.ru');
    assert.strictEqual(senderOrigin({ url: 'https://planning.example.ru/room/42' }), 'https://planning.example.ru');
    assert.strictEqual(senderOrigin({}), null);
});

test('пустой список закрывает мост для всех страниц', () => {
    assert.strictEqual(isAllowedOrigin('https://planning.example.ru', []), false);
    assert.strictEqual(isAllowedOrigin('https://planning.example.ru', undefined), false);
});

test('разрешён только точный адрес из списка', () => {
    const allowed = ['https://planning.example.ru'];
    assert.strictEqual(isAllowedOrigin('https://planning.example.ru', allowed), true);
    // Ни поддомен, ни похожий домен, ни http вместо https доступа не дают
    assert.strictEqual(isAllowedOrigin('https://evil.planning.example.ru', allowed), false);
    assert.strictEqual(isAllowedOrigin('https://planning.example.ru.evil.com', allowed), false);
    assert.strictEqual(isAllowedOrigin('http://planning.example.ru', allowed), false);
    assert.strictEqual(isAllowedOrigin(null, allowed), false);
});

test('адрес без происхождения не проходит ни при каком списке', () => {
    assert.strictEqual(isAllowedOrigin('', ['https://planning.example.ru']), false);
});

// --- Адрес без схемы ---
//
// Владелец скопировал адрес из строки браузера и вставил «localhost:8000».
// Такая запись молча выбрасывалась: список оставался пустым, расширение
// продолжало отказывать, а popup показывал очищенное поле без объяснений.

const { parseAllowedOriginsDetailed, guessScheme } = require('../../browser-extension/background.js');

test('адрес без схемы принимается, а не выбрасывается молча', () => {
    assert.strictEqual(normalizeOrigin('localhost:8000'), 'http://localhost:8000');
    assert.strictEqual(normalizeOrigin('planning.example.ru'), 'https://planning.example.ru');
});

test('локальным адресам и голым IP подставляется http, доменам https', () => {
    assert.strictEqual(guessScheme('localhost:8000'), 'http:');
    assert.strictEqual(guessScheme('127.0.0.1'), 'http:');
    assert.strictEqual(guessScheme('195.58.52.143:8000'), 'http:');
    assert.strictEqual(guessScheme('planning.example.ru'), 'https:');
    assert.strictEqual(normalizeOrigin('195.58.52.143:8000'), 'http://195.58.52.143:8000');
});

test('явная схема сильнее догадки', () => {
    assert.strictEqual(normalizeOrigin('https://localhost:8000'), 'https://localhost:8000');
    assert.strictEqual(normalizeOrigin('http://planning.example.ru'), 'http://planning.example.ru');
});

test('непонятые строки называются, а не пропадают', () => {
    const разбор = parseAllowedOriginsDetailed('localhost:8000\nне адрес\nfile:///etc/passwd\nадрес');
    assert.deepStrictEqual(разбор.origins, ['http://localhost:8000']);
    // Строка с пробелом показывается целиком: адрес пробелов не содержит,
    // а разбитая на слова она превращалась в пару «валидных» доменов
    assert.deepStrictEqual(разбор.dropped, ['не адрес', 'file:///etc/passwd', 'адрес']);
});

test('повторы схлопываются', () => {
    const разбор = parseAllowedOriginsDetailed('localhost:8000\nhttp://localhost:8000\nLOCALHOST:8000');
    assert.deepStrictEqual(разбор.origins, ['http://localhost:8000']);
});

test('случайное слово доменом не становится', () => {
    // URL принимает любое слово за имя хоста, и «проверка» оседала в списке разрешённых
    assert.strictEqual(normalizeOrigin('проверка'), null);
    assert.strictEqual(normalizeOrigin('adres'), null);
    // Но одиночное имя хоста с портом или схемой — обычный внутренний стенд
    assert.strictEqual(normalizeOrigin('jira:8080'), 'https://jira:8080');
    assert.strictEqual(normalizeOrigin('http://myhost'), 'http://myhost');
});

// --- Память об отклонённых адресах ---

const { mergeBlockedOrigin } = require('../../browser-extension/background.js');

test('последний отклонённый адрес идёт первым и не повторяется', () => {
    let список = mergeBlockedOrigin([], 'http://a');
    список = mergeBlockedOrigin(список, 'http://b');
    список = mergeBlockedOrigin(список, 'http://a');
    assert.deepStrictEqual(список, ['http://a', 'http://b']);
});

test('список ограничен пятью адресами', () => {
    let список = [];
    for (const n of [1, 2, 3, 4, 5, 6, 7]) список = mergeBlockedOrigin(список, `http://${n}`);
    assert.strictEqual(список.length, 5);
    assert.strictEqual(список[0], 'http://7');
});

test('пустой прежний список не роняет слияние', () => {
    assert.deepStrictEqual(mergeBlockedOrigin(undefined, 'http://a'), ['http://a']);
});
