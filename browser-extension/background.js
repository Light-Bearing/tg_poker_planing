// PP Jira Bridge — background script
// Работает в Chrome и Firefox благодаря polyfill

// Используем browser API (работает в обоих браузерах с polyfill)
const runtime = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;
const storage = typeof browser !== 'undefined' ? browser.storage : chrome.storage;

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
      headers: { 'Authorization': `Bearer ${jiraToken}` },
    })
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(data => sendResponse({ ok: true, displayName: data.displayName }))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Получить список полей (чтобы найти Story Points)
  if (message.type === 'getFields') {
    const { jiraUrl, jiraToken } = message;
    fetch(`${jiraUrl}/rest/api/2/field`, {
      headers: { 'Authorization': `Bearer ${jiraToken}` },
    })
      .then(r => r.json())
      .then(data => sendResponse({ ok: true, fields: data }))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Поиск задач по JQL
  if (message.type === 'searchIssues') {
    const { jiraUrl, jiraToken, jql, maxResults = 50, fields = 'summary,description' } = message;
    const fieldsParam = fields.split(',').map(f => f.trim()).filter(Boolean).join(',');
    fetch(`${jiraUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=${encodeURIComponent(fieldsParam)}`, {
      headers: { 'Authorization': `Bearer ${jiraToken}` },
    })
      .then(r => r.json())
      .then(data => sendResponse({ ok: true, issues: data.issues || [] }))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Установить оценку (story points) задаче
  if (message.type === 'setEstimate') {
    const { jiraUrl, jiraToken, issueKey, fieldId, value } = message;
    fetch(`${jiraUrl}/rest/api/2/issue/${issueKey}`, {
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
      .then(data => sendResponse(data))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Добавить комментарий к задаче
  if (message.type === 'addComment') {
    const { jiraUrl, jiraToken, issueKey, comment } = message;
    fetch(`${jiraUrl}/rest/api/2/issue/${issueKey}/comment`, {
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
      .then(data => sendResponse(data))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

console.log('PP Jira Bridge background script loaded');
