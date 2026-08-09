// PP Jira Bridge — background script
// Работает в Chrome (MV3) и Firefox (MV2)

// В браузере это browser.* (Firefox) или chrome.* (Chrome). В Node (юнит-тесты хелпера)
// браузерных API нет — тогда слушатель не регистрируется, наружу отдаётся только чистая функция.
const api = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);
const runtime = api ? api.runtime : null;
const storage = api ? api.storage : null;

// Хелпер для заголовков запросов к Jira
function jiraAuth(token, extra = {}) {
    return { ...extra, 'Authorization': `Bearer ${token}` };
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

    return `${prefix}: ${detail || plain}`;
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
        fetch(`${jiraUrl}/rest/api/2/myself`, {
            headers: jiraAuth(jiraToken),
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
            { headers: jiraAuth(jiraToken) }
        )
            .then(r => r.json())
            .then(data => sendResponse({ ok: true, issues: data.issues || [] }))
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
    module.exports = { describeJiraError };
}