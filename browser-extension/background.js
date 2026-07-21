// PP Jira Bridge — background script
// Работает в Chrome (MV3) и Firefox (MV2)

const runtime = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;
const storage = typeof browser !== 'undefined' ? browser.storage : chrome.storage;

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Хелпер для заголовков запросов к Jira
function jiraAuth(token, extra = {}) {
    return { ...extra, 'Authorization': `Bearer ${token}` };
}

// Firefox: перехватываем HTTP-запросы к Jira API и подменяем User-Agent
// (через headers в fetch — forbidden, браузер игнорирует)
if (typeof browser !== 'undefined' && browser.webRequest) {
    console.log('[PP] webRequest listener registered');
    browser.webRequest.onBeforeSendHeaders.addListener(
        (details) => {
            console.log('[PP] Intercepted:', details.url, 'method:', details.method);
            // Логируем текущие заголовки перед изменением
            for (const h of details.requestHeaders) {
                console.log('[PP]   req header:', h.name, '=', h.value.slice(0, 80));
            }
            const ua = details.requestHeaders.find(h => h.name.toLowerCase() === 'user-agent');
            if (ua) {
                console.log('[PP] Replacing UA:', ua.value, '->', CHROME_UA);
                ua.value = CHROME_UA;
            } else {
                console.log('[PP] No UA header found, adding:', CHROME_UA);
                details.requestHeaders.push({ name: 'User-Agent', value: CHROME_UA });
            }
            return { requestHeaders: details.requestHeaders };
        },
        { urls: ['<all_urls>'] },
        ['blocking', 'requestHeaders']
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

runtime.onMessage.addListener((message, sender, sendResponse) => {
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
                // Читаем тело ответа как текст, чтобы увидеть что вернула Jira
                return r.text().then(text => {
                    let msg = `HTTP ${r.status}`;
                    try {
                        const body = JSON.parse(text);
                        if (body.errorMessages && body.errorMessages.length) {
                            msg = body.errorMessages.join('; ');
                        } else if (body.message) {
                            msg = body.message;
                        }
                    } catch (_) {
                        // Не JSON — может HTML-страница ошибки
                        if (text && text.length < 300) msg = text;
                    }
                    return Promise.reject(msg);
                });
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
                return r.json().then(e => {
                    let errMsg = '';
                    if (e.errorMessages && e.errorMessages.length > 0) {
                        errMsg = e.errorMessages.join('; ');
                    } else if (e.errors && typeof e.errors === 'object') {
                        errMsg = Object.values(e.errors).filter(Boolean).join('; ');
                    } else if (e.errors) {
                        errMsg = String(e.errors);
                    }
                    return Promise.reject(errMsg || `HTTP ${r.status}`);
                });
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
                return r.json().then(e => Promise.reject(e.errors || e.errorMessages?.[0] || `HTTP ${r.status}`));
            })
            .then(data => sendResponse(data))
            .catch(err => sendResponse({ ok: false, error: friendlyError(err) }));
        return true;
    }
});

console.log('PP Jira Bridge background script loaded');