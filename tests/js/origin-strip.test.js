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
    jiraAuth,
    jiraOriginValue,
    probeMode,
    applyHeaderMode,
    PROBE_HEADER,
    DIAGNOSE_PROBES,
} = require('../../browser-extension/background.js');

const SELF = 'moz-extension://11112222-3333-4444-5555-666677778888/';
const JIRA = 'https://project.example.ru';

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

// --- Режимы правки заголовков ---

const withOrigin = () => [
    { name: 'Authorization', value: 'Bearer t' },
    { name: 'Origin', value: SELF.slice(0, -1) },
    { name: 'Sec-Fetch-Site', value: 'cross-site' },
    { name: 'Sec-Fetch-Mode', value: 'cors' },
];

function names(headers) {
    return headers.map(h => h.name);
}

test('режим берётся из метки, без метки — боевой', () => {
    assert.strictEqual(probeMode([{ name: PROBE_HEADER, value: 'jira-origin' }]), 'jira-origin');
    assert.strictEqual(probeMode([{ name: 'x-pp-probe', value: 'bare' }]), 'bare');
    assert.strictEqual(probeMode([{ name: 'Authorization', value: 'Bearer t' }]), 'strip-origin');
    assert.strictEqual(probeMode([]), 'strip-origin');
});

test('метка режима снимается при любом режиме — до Jira она не доходит', () => {
    for (const mode of ['strip-origin', 'keep-origin', 'jira-origin', 'bare']) {
        const headers = [{ name: PROBE_HEADER, value: mode }, { name: 'Accept', value: '*/*' }];
        const out = names(applyHeaderMode(headers, mode, SELF, JIRA));
        assert.ok(!out.some(n => n.toLowerCase() === PROBE_HEADER.toLowerCase()), mode);
        assert.ok(out.includes('Accept'), mode);
    }
});

test('strip-origin убирает Origin и оставляет Sec-Fetch-*', () => {
    const out = applyHeaderMode(withOrigin(), 'strip-origin', SELF, JIRA);
    assert.deepStrictEqual(names(out), ['Authorization', 'Sec-Fetch-Site', 'Sec-Fetch-Mode']);
});

test('keep-origin оставляет Origin нетронутым', () => {
    const out = applyHeaderMode(withOrigin(), 'keep-origin', SELF, JIRA);
    assert.deepStrictEqual(out.find(h => h.name === 'Origin').value, SELF.slice(0, -1));
});

test('jira-origin подменяет значение Origin на адрес Jira', () => {
    const out = applyHeaderMode(withOrigin(), 'jira-origin', SELF, JIRA);
    assert.strictEqual(out.find(h => h.name === 'Origin').value, JIRA);
    assert.strictEqual(out.filter(h => h.name.toLowerCase() === 'origin').length, 1);
});

test('jira-origin добавляет Origin, если браузер его не прислал', () => {
    const out = applyHeaderMode([{ name: 'Accept', value: '*/*' }], 'jira-origin', SELF, JIRA);
    assert.deepStrictEqual(out, [{ name: 'Accept', value: '*/*' }, { name: 'Origin', value: JIRA }]);
});

test('bare убирает и Origin, и все Sec-Fetch-*', () => {
    const out = applyHeaderMode(withOrigin(), 'bare', SELF, JIRA);
    assert.deepStrictEqual(names(out), ['Authorization']);
});

test('адрес Jira для подмены — только схема и хост', () => {
    assert.strictEqual(jiraOriginValue('https://project.example.ru/jira/'), 'https://project.example.ru');
    assert.strictEqual(jiraOriginValue('https://jira.example.ru:8443'), 'https://jira.example.ru:8443');
    assert.strictEqual(jiraOriginValue('не адрес'), null);
});

// --- Заголовок X-Atlassian-Token ---

test('по умолчанию отправляется no-check', () => {
    assert.strictEqual(jiraAuth('tok')['X-Atlassian-Token'], 'no-check');
});

test('значение заголовка заменяется, когда проба просит другое написание', () => {
    assert.strictEqual(jiraAuth('tok', {}, 'nocheck')['X-Atlassian-Token'], 'nocheck');
});

test('null убирает заголовок совсем, авторизация остаётся', () => {
    const headers = jiraAuth('tok', {}, null);
    assert.ok(!('X-Atlassian-Token' in headers));
    assert.strictEqual(headers['Authorization'], 'Bearer tok');
});

// --- Набор проб ---

test('все пробы записи бьют по несуществующей задаче с пустым набором полей', () => {
    const writes = DIAGNOSE_PROBES.filter(p => p.method === 'PUT');
    assert.ok(writes.length >= 5);
    for (const probe of writes) {
        assert.strictEqual(probe.path, '/rest/api/2/issue/ZZZZ-99999');
        assert.deepStrictEqual(probe.payload, { fields: {} });
    }
});

test('пробы 5-9 отличаются от боевой ровно одним условием', () => {
    const base = DIAGNOSE_PROBES.find(p => p.step === 3);
    const varied = DIAGNOSE_PROBES.filter(p => p.step >= 5);
    for (const probe of varied) {
        const diff = ['mode', 'token'].filter(key => (key in probe) !== (key in base) || probe[key] !== base[key]);
        assert.strictEqual(diff.length, 1, `проба ${probe.step} меняет ${diff.length} условий: ${diff}`);
    }
});

test('пробы с правкой заголовков помечены как доступные только в Firefox', () => {
    for (const probe of DIAGNOSE_PROBES) {
        if (probe.mode) assert.strictEqual(probe.firefoxOnly, true, `проба ${probe.step}`);
    }
});

test('у каждой пробы есть пояснение — без него вывод нечитаем', () => {
    for (const probe of DIAGNOSE_PROBES) {
        assert.ok(probe.note && probe.note.length > 5, `проба ${probe.step}`);
    }
});
