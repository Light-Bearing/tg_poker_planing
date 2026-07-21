// PP Jira Bridge — background script
// Работает в Chrome (MV3) и Firefox (MV2)

const runtime = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;
const storage = typeof browser !== 'undefined' ? browser.storage : chrome.storage;

// Преобразует Firefox TypeError (не-ASCII в заголовках) в понятное сообщение
function friendlyError(err) {
    const msg = typeof err === 'string' ? err : String(err);
    if (msg.includes('ByteString') || msg.includes('greater than 255')) {
        return 'Токен содержит недопустимые символы. Используйте только латинские буквы и цифры.';
    }
    return msg;
}

// Promise-обёртка для storage.local.get (единый API для Chrome и Firefox)
function storageGet(keys) {
    return new Promise(resolve => {
        storage.local.get(keys, result => resolve(result));
    });
}

// Promise-обёртка для storage.local.set
function storageSet(obj) {
    return new Promise(resolve => {
        storage.local.set(obj, () => resolve({ ok: true }));
    });
}

runtime.onMessage.addListener((message) => {
    // Сохранить настройки
    if (message.type === 'saveSettings') {
        return storageSet({
            jiraUrl: message.jiraUrl,
            jiraToken: message.jiraToken,
            jiraFilter: message.jiraFilter,
            storyPointsField: message.storyPointsField,
            epicLinkField: message.epicLinkField || '',
        });
    }

    // Получить настройки
    if (message.type === 'getSettings') {
        return storageGet(['jiraUrl', 'jiraToken', 'jiraFilter', 'storyPointsField', 'epicLinkField']);
    }

    // Проверить подключение к Jira
    if (message.type === 'testConnection') {
        const { jiraUrl, jiraToken } = message;
        return fetch(`${jiraUrl}/rest/api/2/myself`, {
            headers: { 'Authorization': `Bearer ${jiraToken}` },
        })
            .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
            .then(data => ({ ok: true, displayName: data.displayName }))
            .catch(err => ({ ok: false, error: friendlyError(err) }));
    }

    // Получить список полей (чтобы найти Story Points)
    if (message.type === 'getFields') {
        const { jiraUrl, jiraToken } = message;
        return fetch(`${jiraUrl}/rest/api/2/field`, {
            headers: { 'Authorization': `Bearer ${jiraToken}` },
        })
            .then(r => r.json())
            .then(data => ({ ok: true, fields: data }))
            .catch(err => ({ ok: false, error: friendlyError(err) }));
    }

    // Поиск задач по JQL
    if (message.type === 'searchIssues') {
        const { jiraUrl, jiraToken, jql, maxResults = 50, fields = 'summary,description' } = message;
        const fieldsParam = fields.split(',').map(f => f.trim()).filter(Boolean).join(',');
        return fetch(
            `${jiraUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=${encodeURIComponent(fieldsParam)}`,
            { headers: { 'Authorization': `Bearer ${jiraToken}` } }
        )
            .then(r => r.json())
            .then(data => ({ ok: true, issues: data.issues || [] }))
            .catch(err => ({ ok: false, error: friendlyError(err) }));
    }

    // Установить оценку (story points) задаче
    if (message.type === 'setEstimate') {
        const { jiraUrl, jiraToken, issueKey, fieldId, value } = message;
        return fetch(`${jiraUrl}/rest/api/2/issue/${issueKey}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${jiraToken}`,
                'Content-Type': 'application/json',
            },
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
            .catch(err => ({ ok: false, error: friendlyError(err) }));
    }

    // Добавить комментарий к задаче
    if (message.type === 'addComment') {
        const { jiraUrl, jiraToken, issueKey, comment } = message;
        return fetch(`${jiraUrl}/rest/api/2/issue/${issueKey}/comment`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${jiraToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ body: comment }),
        })
            .then(r => {
                if (r.ok || r.status === 201) return { ok: true };
                return r.json().then(e => Promise.reject(e.errors || e.errorMessages?.[0] || `HTTP ${r.status}`));
            })
            .catch(err => ({ ok: false, error: friendlyError(err) }));
    }
});

console.log('PP Jira Bridge background script loaded');