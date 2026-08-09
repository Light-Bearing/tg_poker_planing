// PP Jira Bridge — background script
// Работает в Chrome (MV3) и Firefox (MV2)

// В браузере это browser.* (Firefox) или chrome.* (Chrome). В Node (юнит-тесты хелпера)
// браузерных API нет — тогда слушатель не регистрируется, наружу отдаётся только чистая функция.
const api = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);
const runtime = api ? api.runtime : null;
const storage = api ? api.storage : null;

// Хелпер для заголовков запросов к Jira.
// X-Atlassian-Token: no-check — стандартная практика для Jira Server: для REST-запросов
// с токеном заголовок безвреден, а при включённой XSRF-защите снимает отказ на PUT/POST.
function jiraAuth(token, extra = {}) {
    return { ...extra, 'Authorization': `Bearer ${token}`, 'X-Atlassian-Token': 'no-check' };
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

// Четыре пробы диагностики. Ни одна ничего не меняет в Jira.
// Проба 3 — PUT на заведомо несуществующую задачу с пустым набором полей: даже если такая
// задача найдётся, Jira отвергнет пустой fields и ничего не изменит. Смысл: если PUT
// доходит до Jira, она ответит 404 (задача не найдена) — значит метод и авторизация в
// порядке, а причина в правах или в поле. Если вернётся 403 или HTML-страница — запрос
// режет nginx/WAF или срабатывает XSRF, до Jira он не доходит.
// Проба 4 — POST поиска: проверяет ровно то же для метода POST (проходит ли через прокси
// POST с JSON-телом), но писать не может физически. Это отличает «режут PUT» от
// «режут любой изменяющий метод».
const DIAGNOSE_PROBES = [
    { step: 1, method: 'GET', path: '/rest/api/2/myself', payload: null },
    { step: 2, method: 'GET', path: '/rest/api/2/field', payload: null },
    { step: 3, method: 'PUT', path: '/rest/api/2/issue/ZZZZ-99999', payload: { fields: {} } },
    { step: 4, method: 'POST', path: '/rest/api/2/search', payload: { jql: 'issuekey = ZZZZ-99999', maxResults: 0 } },
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

// Выполняет все четыре пробы подряд. Пробы 3 и 4 выполняются всегда, даже если 1 и 2
// упали, — важно именно сравнение кодов ответа между GET и изменяющими методами.
async function runDiagnostics(jiraUrl, jiraToken) {
    const results = [];
    for (const probe of DIAGNOSE_PROBES) {
        const url = `${jiraUrl}${probe.path}`;
        const result = {
            step: probe.step, method: probe.method, url,
            status: 0, ok: false, body: '', headers: {},
        };
        try {
            const init = {
                method: probe.method,
                headers: probe.payload
                    ? jiraAuth(jiraToken, { 'Content-Type': 'application/json' })
                    : jiraAuth(jiraToken),
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
        runDiagnostics(jiraUrl, jiraToken)
            .then(results => sendResponse({ ok: true, results }))
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
    console.log('PP Jira Bridge background script loaded');
}

// Экспорт для юнит-тестов: в браузере module не определён, ветка не выполняется
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { describeJiraError, stripToken, safeSnippet, DIAGNOSE_PROBES };
}