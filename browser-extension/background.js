// PP Jira Bridge — background script
// Работает в Chrome (MV3) и Firefox (MV2)

// В браузере это browser.* (Firefox) или chrome.* (Chrome). В Node (юнит-тесты хелпера)
// браузерных API нет — тогда слушатель не регистрируется, наружу отдаётся только чистая функция.
const api = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);
const runtime = api ? api.runtime : null;
const storage = api ? api.storage : null;

// Хелпер для заголовков запросов к Jira.
// X-Atlassian-Token: no-check — стандартная практика для Jira Server: для REST-запросов
// с токеном заголовок безвреден и на части инстансов снимает отказ на PUT/POST.
// Одного его мало: проверку происхождения в Jira он не отключает, см. снятие Origin ниже.
// atlassianToken = null убирает заголовок совсем — нужно диагностической пробе,
// которая проверяет, разбирают ли его на этом инстансе вообще.
function jiraAuth(token, extra = {}, atlassianToken = 'no-check') {
    const headers = { ...extra, 'Authorization': `Bearer ${token}` };
    if (atlassianToken !== null) headers['X-Atlassian-Token'] = atlassianToken;
    return headers;
}

// --- Правка исходящих заголовков (только Firefox) ---
//
// Измерено на живой Jira Server (project.samokat.ru) набором проб, каждая из которых
// меняла ровно одно условие. Результат:
//
//   Firefox, Origin: moz-extension://<uuid>  — 403 «XSRF check failed»
//   Firefox, Origin снят                     — 403 «XSRF check failed»
//   Firefox, Origin = https://project…       — 404, запрос дошёл до Jira
//   Chrome, Origin не отправляется вовсе     — 404, запрос дошёл до Jira
//
// Значит проверке нужен Origin, совпадающий с адресом Jira. Чужой Origin она отвергает,
// а на снятие не поддаётся: Firefox добавляет заголовок обратно уже после
// onBeforeSendHeaders, поэтому удаление из списка ничего не меняет — работает только
// подмена значения. В Chrome заголовка нет изначально, поэтому там всё и работало.
//
// Заголовок X-Atlassian-Token на этом инстансе ни на что не влияет: пробы с no-check,
// с nocheck и без него вовсе дали одинаковый ответ. Отправлять его продолжаем — на других
// инстансах Jira он нужен, и вреда от него нет.
//
// Режим правки передаётся заголовком-меткой X-PP-Probe, которую слушатель снимает —
// до Jira она не доходит.
//
// Правка применяется только к запросам самого расширения (сверка по originUrl) и только
// на хосте настроенной Jira. Вкладки пользователя с Jira не затрагиваются: там работает
// его сессия, и ослаблять её защиту от подделки запросов нельзя.
//
// Требует разрешений webRequest и webRequestBlocking; они добавлены только в
// manifest-firefox.json. В Chrome api.webRequest отсутствует, и код становится пустышкой.

// Метка режима правки. Снимается слушателем, наружу не уходит.
const PROBE_HEADER = 'X-PP-Probe';

// Режим по умолчанию для боевых запросов: Origin = адрес самой Jira.
// Это то, что измерено пробой 6 — единственное условие, при котором запись доходит.
const DEFAULT_HEADER_MODE = 'jira-origin';

// Возвращает шаблон адреса для фильтра слушателя. null, если адрес не разбирается.
function jiraOriginPattern(jiraUrl) {
    try {
        const u = new URL(jiraUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return `${u.protocol}//${u.host}/*`;
    } catch (_) {
        return null;
    }
}

// Свой ли это запрос. Вкладки с самой Jira трогать нельзя: там работает обычная
// сессия пользователя, и снятие Origin ослабило бы её защиту от подделки запросов.
function isOwnRequest(details, selfPrefix) {
    if (!selfPrefix) return false;
    const origin = details.originUrl || details.documentUrl || '';
    return typeof origin === 'string' && origin.startsWith(selfPrefix);
}

// Убирает Origin и наш собственный Referer вида moz-extension://…
// Referer чужой (например, страницы Jira) не трогаем — он не наш.
function withoutOriginHeaders(requestHeaders, selfPrefix) {
    return (requestHeaders || []).filter(h => {
        const name = String(h.name).toLowerCase();
        if (name === 'origin') return false;
        if (name === 'referer' && selfPrefix && String(h.value || '').startsWith(selfPrefix)) return false;
        return true;
    });
}

// Режим правки, заказанный пробой. Без метки — боевой режим.
function probeMode(requestHeaders) {
    const marker = (requestHeaders || []).find(h => String(h.name).toLowerCase() === PROBE_HEADER.toLowerCase());
    return marker ? String(marker.value) : DEFAULT_HEADER_MODE;
}

// Правит исходящие заголовки под режим пробы. Чистая функция — покрыта тестами.
//
//   jira-origin  — подменить Origin на адрес самой Jira (боевой режим)
//   keep-origin  — оставить Origin как есть: с ним Firefox и получал отказ
//   strip-origin — снять Origin: измерено, что от отказа это не спасает
//   bare         — снять Origin и все Sec-Fetch-*
//
// Метка режима снимается всегда, свой Referer — тоже: он такой же moz-extension://.
function applyHeaderMode(requestHeaders, mode, selfPrefix, jiraOrigin) {
    const kept = (requestHeaders || []).filter(h => {
        const name = String(h.name).toLowerCase();
        if (name === PROBE_HEADER.toLowerCase()) return false;
        if (name === 'referer' && selfPrefix && String(h.value || '').startsWith(selfPrefix)) return false;
        if (name === 'origin') return mode === 'keep-origin' || mode === 'jira-origin';
        if (name.startsWith('sec-fetch-') && mode === 'bare') return false;
        return true;
    });

    if (mode !== 'jira-origin' || !jiraOrigin) return kept;

    // Origin мог и не прийти — тогда добавляем его сами
    const hasOrigin = kept.some(h => String(h.name).toLowerCase() === 'origin');
    if (!hasOrigin) return kept.concat([{ name: 'Origin', value: jiraOrigin }]);
    return kept.map(h => (String(h.name).toLowerCase() === 'origin' ? { name: h.name, value: jiraOrigin } : h));
}

// Схема и хост настроенной Jira — значение для режима jira-origin
function jiraOriginValue(jiraUrl) {
    try {
        const u = new URL(jiraUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return `${u.protocol}//${u.host}`;
    } catch (_) {
        return null;
    }
}

// Состояние для вывода в диагностике: понятно, правятся заголовки или нет
let originStripState = 'unsupported';
let originStripListener = null;

// Сколько раз слушатель реально сработал. Без этого счётчика «включено» означает лишь
// «addListener не бросил исключение», а не «правка дошла до запроса» — и одинаковые
// ответы проб пришлось бы объяснять догадками.
let headerEditCount = 0;

function supportsOriginStrip() {
    return Boolean(
        api && api.webRequest && api.webRequest.onBeforeSendHeaders &&
        runtime && runtime.getManifest && runtime.getManifest().manifest_version === 2
    );
}

// Перерегистрирует слушатель под текущий адрес Jira. Фильтр по адресу узкий
// намеренно: блокирующий слушатель на <all_urls> замедлял бы весь браузер.
function refreshOriginStrip(jiraUrl) {
    if (!supportsOriginStrip()) {
        originStripState = 'unsupported';
        return;
    }
    if (originStripListener) {
        api.webRequest.onBeforeSendHeaders.removeListener(originStripListener);
        originStripListener = null;
    }
    originStripState = 'inactive';

    const pattern = jiraOriginPattern(jiraUrl);
    if (!pattern) return;

    const selfPrefix = runtime.getURL('');
    const jiraOrigin = jiraOriginValue(jiraUrl);
    originStripListener = (details) => {
        if (!isOwnRequest(details, selfPrefix)) return {};
        headerEditCount += 1;
        const mode = probeMode(details.requestHeaders);
        return { requestHeaders: applyHeaderMode(details.requestHeaders, mode, selfPrefix, jiraOrigin) };
    };
    try {
        api.webRequest.onBeforeSendHeaders.addListener(
            originStripListener,
            { urls: [pattern] },
            ['blocking', 'requestHeaders']
        );
        originStripState = 'active';
    } catch (err) {
        // Разрешения нет или шаблон не принят — работаем как раньше, но говорим об этом
        originStripListener = null;
        originStripState = `ошибка: ${String(err && err.message ? err.message : err)}`;
    }
}

// Разбирает тело ошибочного ответа Jira в читаемое сообщение.
// Чистая функция от (status, text) — покрыта тестами в tests/js/jira-error.test.js.
// Код ответа выводится всегда: за Jira может стоять nginx или WAF, и тогда тело —
// HTML-страница или пустота, а важен именно код.
function describeJiraError(status, text) {
    const prefix = `HTTP ${status}`;
    const raw = typeof text === 'string' ? text : '';
    if (!raw.trim()) return prefix;

    // Запасной вариант: сам текст со схлопнутыми пробелами и обрезкой —
    // и для не-JSON (страница nginx длинная и с переводами строк), и для JSON без знакомых полей.
    const plain = raw.replace(/\s+/g, ' ').trim().slice(0, 300);

    // Схлопывание и обрезка нужны и для разобранного JSON: {"message":"…5000 символов…"}
    // иначе уедет целиком в тост
    const tidy = s => String(s).replace(/\s+/g, ' ').trim().slice(0, 300);

    let detail = '';
    try {
        const body = JSON.parse(raw);
        if (body && typeof body === 'object') {
            if (Array.isArray(body.errorMessages) && body.errorMessages.length) {
                detail = body.errorMessages.filter(Boolean).join('; ');
            } else if (body.errors && typeof body.errors === 'object') {
                detail = Object.values(body.errors).filter(Boolean).join('; ');
            } else if (body.errors) {
                detail = String(body.errors);
            } else if (body.message) {
                detail = String(body.message);
            }
        }
    } catch (_) {
        // Не JSON — покажем сам текст
    }

    return `${prefix}: ${detail ? tidy(detail) : plain}`;
}

// Читает тело ошибочного ответа и формирует сообщение.
// r.json() на ошибочном ответе не вызываем никогда: не-JSON тело бросит исключение,
// и пользователь увидит SyntaxError вместо кода ответа.
function jiraErrorFromResponse(r) {
    return r.text().then(
        text => describeJiraError(r.status, text),
        () => `HTTP ${r.status}`
    );
}

// Пробы диагностики. Ни одна ничего не меняет в Jira: PUT идёт на заведомо
// несуществующую задачу ZZZZ-99999 с пустым набором полей, POST — это поиск,
// который писать не умеет физически.
//
// Пробы 1-4 отвечают на вопрос «доходит ли запись до Jira»: 404 в пробе 3 значит, что
// PUT дошёл и дело в правах или поле; 403 значит, что режут раньше.
//
// Пробы 5-9 меняют ровно по одному условию относительно пробы 3 и остаются в наборе
// как охрана от возврата: если Jira перенастроят, будет видно, какое именно условие
// поменялось, а не общее «опять не работает».
//
//   5 — Origin оставлен как есть (Firefox: moz-extension://…). Измерено: 403.
//   6 — Origin снят совсем. Измерено: 403 — снятия недостаточно.
//   7 — значение заголовка nocheck вместо no-check. Измерено: без разницы.
//   8 — заголовка X-Atlassian-Token нет вовсе. Измерено: без разницы.
//   9 — без Origin и без Sec-Fetch-*. Измерено: 403 — дело не в Sec-Fetch-*.
//
// Пробы с правкой заголовков работают только в Firefox; в Chrome они помечаются
// невыполненными, а не молча искажают картину.
const PUT_PROBE = { method: 'PUT', path: '/rest/api/2/issue/ZZZZ-99999', payload: { fields: {} } };

const DIAGNOSE_PROBES = [
    { step: 1, method: 'GET', path: '/rest/api/2/myself', payload: null, note: 'базовая проверка токена' },
    { step: 2, method: 'GET', path: '/rest/api/2/field', payload: null, note: 'чтение справочника полей' },
    { ...PUT_PROBE, step: 3, note: 'боевые условия отправки оценки (Origin = адрес Jira)' },
    {
        step: 4, method: 'POST', path: '/rest/api/2/search',
        payload: { jql: 'issuekey = ZZZZ-99999', maxResults: 0 },
        note: 'то же для метода POST',
    },
    { ...PUT_PROBE, step: 5, note: 'Origin оставлен как есть', mode: 'keep-origin', firefoxOnly: true },
    { ...PUT_PROBE, step: 6, note: 'Origin снят совсем', mode: 'strip-origin', firefoxOnly: true },
    { ...PUT_PROBE, step: 7, note: 'X-Atlassian-Token: nocheck', token: 'nocheck' },
    { ...PUT_PROBE, step: 8, note: 'без заголовка X-Atlassian-Token', token: null },
    { ...PUT_PROBE, step: 9, note: 'без Origin и без Sec-Fetch-*', mode: 'bare', firefoxOnly: true },
];

// Заголовки ответа, по которым видно, кто ответил — Jira или прокси перед ней
const DIAGNOSE_HEADERS = ['Server', 'X-Seraph-LoginReason', 'X-Authentication-Denied-Reason', 'X-AUSERNAME'];

// Страховка: токен не должен попасть в диагностический вывод ни при каких обстоятельствах.
// Вызывать до обрезки: иначе разрез может прийтись на середину токена и оставить его начало.
function stripToken(text, token) {
    if (!token || token.length < 8) return String(text);
    return String(text).split(token).join('***');
}

// Маскируем токен, и только потом режем — порядок важен
function safeSnippet(text, token, limit = 200) {
    return stripToken(text, token).replace(/\s+/g, ' ').trim().slice(0, limit);
}

// Выполняет все пробы подряд. Каждая выполняется всегда, даже если предыдущие упали, —
// смысл именно в сравнении кодов ответа между собой.
async function runDiagnostics(jiraUrl, jiraToken) {
    const results = [];
    headerEditCount = 0;
    for (const probe of DIAGNOSE_PROBES) {
        const url = `${jiraUrl}${probe.path}`;
        const result = {
            step: probe.step, method: probe.method, url, note: probe.note,
            status: 0, ok: false, body: '', headers: {},
        };

        // Пробе нужна правка заголовков, а механизма нет — честно говорим, что не выполнили
        if (probe.firefoxOnly && originStripState !== 'active') {
            result.body = 'не выполнена: правка заголовков доступна только в Firefox';
            result.skipped = true;
            results.push(result);
            continue;
        }

        try {
            const extra = probe.payload ? { 'Content-Type': 'application/json' } : {};
            if (probe.mode) extra[PROBE_HEADER] = probe.mode;
            const atlassianToken = 'token' in probe ? probe.token : 'no-check';
            const init = {
                method: probe.method,
                headers: jiraAuth(jiraToken, extra, atlassianToken),
                credentials: 'omit',
            };
            if (probe.payload) init.body = JSON.stringify(probe.payload);

            const r = await fetch(url, init);
            const text = await r.text().catch(() => '');
            result.status = r.status;
            result.ok = r.ok;
            result.body = safeSnippet(text, jiraToken);
            // Заголовки читаются целиком: фоновый запрос идёт с host permissions.
            // При 403 именно они отвечают на главный вопрос — ответила Jira или прокси.
            for (const name of DIAGNOSE_HEADERS) {
                const value = r.headers.get(name);
                if (value) result.headers[name] = safeSnippet(value, jiraToken);
            }
        } catch (err) {
            // Сети нет, CORS, обрыв — код ответа остаётся 0, это тоже результат
            result.body = safeSnippet(friendlyError(err), jiraToken);
        }
        results.push(result);
    }
    return results;
}

// Преобразует Firefox TypeError (не-ASCII в заголовках) в понятное сообщение
function friendlyError(err) {
    const msg = typeof err === 'string' ? err : String(err);
    if (msg.includes('ByteString') || msg.includes('greater than 255')) {
        return 'Токен содержит недопустимые символы. Используйте только латинские буквы и цифры.';
    }
    return msg;
}

function handleMessage(message, sender, sendResponse) {
    // Сохранить настройки
    if (message.type === 'saveSettings') {
        // Адрес Jira поменялся — слушатель Origin должен слушать новый хост
        refreshOriginStrip(message.jiraUrl);
        storage.local.set({
            jiraUrl: message.jiraUrl,
            jiraToken: message.jiraToken,
            jiraFilter: message.jiraFilter,
            storyPointsField: message.storyPointsField,
            epicLinkField: message.epicLinkField || '',
        }).then(() => sendResponse({ ok: true }));
        return true;
    }

    // Получить настройки
    if (message.type === 'getSettings') {
        storage.local.get(['jiraUrl', 'jiraToken', 'jiraFilter', 'storyPointsField', 'epicLinkField'], (result) => {
            sendResponse(result);
        });
        return true;
    }

    // Проверить подключение к Jira
    if (message.type === 'testConnection') {
        const { jiraUrl, jiraToken } = message;
        // credentials: 'omit' — аутентифицируемся Bearer-токеном и на сессионные куки
        // не полагаемся. Если браузер приложит куку сессии Jira, Jira Server может
        // предпочесть сессию токену и включить XSRF-защиту на изменяющих запросах.
        fetch(`${jiraUrl}/rest/api/2/myself`, {
            headers: jiraAuth(jiraToken),
            credentials: 'omit',
        })
            .then(r => {
                if (r.ok) return r.json();
                return jiraErrorFromResponse(r).then(msg => Promise.reject(msg));
            })
            .then(data => sendResponse({ ok: true, displayName: data.displayName }))
            .catch(err => sendResponse({ ok: false, error: friendlyError(err) }));
        return true;
    }

    // Получить список полей (чтобы найти Story Points)
    if (message.type === 'getFields') {
        const { jiraUrl, jiraToken } = message;
        fetch(`${jiraUrl}/rest/api/2/field`, {
            headers: jiraAuth(jiraToken),
            credentials: 'omit',
        })
            .then(r => r.json())
            .then(data => sendResponse({ ok: true, fields: data }))
            .catch(err => sendResponse({ ok: false, error: friendlyError(err) }));
        return true;
    }

    // Поиск задач по JQL
    if (message.type === 'searchIssues') {
        const { jiraUrl, jiraToken, jql, maxResults = 50, fields = 'summary,description' } = message;
        const fieldsParam = fields.split(',').map(f => f.trim()).filter(Boolean).join(',');
        fetch(
            `${jiraUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=${encodeURIComponent(fieldsParam)}`,
            { headers: jiraAuth(jiraToken), credentials: 'omit' }
        )
            .then(r => r.json())
            .then(data => sendResponse({ ok: true, issues: data.issues || [] }))
            .catch(err => sendResponse({ ok: false, error: friendlyError(err) }));
        return true;
    }

    // Диагностика: четыре пробы, чтобы понять, где именно рвётся отправка оценки
    if (message.type === 'diagnose') {
        const { jiraUrl, jiraToken } = message;
        // Пробы должны идти в тех же условиях, что и отправка оценки: адрес в поле мог
        // отличаться от сохранённого, а слушатель Origin привязан к хосту.
        refreshOriginStrip(jiraUrl);
        runDiagnostics(jiraUrl, jiraToken)
            .then(results => sendResponse({
                ok: true, results, originStrip: originStripState, headerEdits: headerEditCount,
            }))
            .catch(err => sendResponse({ ok: false, error: friendlyError(err) }));
        return true;
    }

    // Установить оценку (story points) задаче
    if (message.type === 'setEstimate') {
        const { jiraUrl, jiraToken, issueKey, fieldId, value } = message;
        fetch(`${jiraUrl}/rest/api/2/issue/${issueKey}`, {
            method: 'PUT',
            headers: jiraAuth(jiraToken, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ fields: { [fieldId]: value } }),
            credentials: 'omit',
        })
            .then(r => {
                if (r.ok || r.status === 204) return { ok: true };
                return jiraErrorFromResponse(r).then(msg => Promise.reject(msg));
            })
            .then(data => sendResponse(data))
            .catch(err => sendResponse({ ok: false, error: friendlyError(err) }));
        return true;
    }

    // Добавить комментарий к задаче
    if (message.type === 'addComment') {
        const { jiraUrl, jiraToken, issueKey, comment } = message;
        fetch(`${jiraUrl}/rest/api/2/issue/${issueKey}/comment`, {
            method: 'POST',
            headers: jiraAuth(jiraToken, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ body: comment }),
            credentials: 'omit',
        })
            .then(r => {
                if (r.ok || r.status === 201) return { ok: true };
                return jiraErrorFromResponse(r).then(msg => Promise.reject(msg));
            })
            .then(data => sendResponse(data))
            .catch(err => sendResponse({ ok: false, error: friendlyError(err) }));
        return true;
    }
}

if (runtime) {
    runtime.onMessage.addListener(handleMessage);
    // При старте поднимаем слушатель под сохранённый адрес: отправка оценки идёт
    // с сохранённых настроек, popup для неё открывать не обязательно.
    if (storage) {
        Promise.resolve(storage.local.get(['jiraUrl']))
            .then(result => refreshOriginStrip(result && result.jiraUrl))
            .catch(() => {});
    }
    console.log('PP Jira Bridge background script loaded');
}

// Экспорт для юнит-тестов: в браузере module не определён, ветка не выполняется
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        describeJiraError, stripToken, safeSnippet, DIAGNOSE_PROBES,
        jiraOriginPattern, isOwnRequest, withoutOriginHeaders,
        jiraAuth, jiraOriginValue, probeMode, applyHeaderMode, PROBE_HEADER,
    };
}