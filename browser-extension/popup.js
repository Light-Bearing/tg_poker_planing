// PP Jira Bridge — popup script
// Работает в Chrome и Firefox благодаря polyfill

let browserType = 'unknown';

// Определить тип браузера
function detectBrowser() {
  if (typeof chrome !== 'undefined' && chrome.runtime) {
    if (typeof browser !== 'undefined') {
      // Firefox (с polyfill)
      browserType = 'firefox';
    } else if (chrome.runtime.getManifest && chrome.runtime.getManifest().manifest_version === 3) {
      // Chrome Manifest V3
      browserType = 'chrome';
    } else {
      // Chrome Manifest V2 или другой
      browserType = 'chrome';
    }
  } else if (typeof browser !== 'undefined') {
    // Firefox нативный
    browserType = 'firefox';
  }
  return browserType;
}

// Показать инструкцию для браузера
function showBrowserInstruction() {
  const noteEl = document.getElementById('browserNote');
  
  if (browserType === 'firefox') {
    noteEl.innerHTML = `
      <strong>⚠️ Firefox Detected</strong><br>
      Если расширение не работает, возможно оно не подписано.<br>
      Для разработки: зайдите в <code>about:debugging</code> → "This Firefox" → "Load Temporary Add-on"<br>
      Для продакшена: расширению нужна подпись от Mozilla (<a href="https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/Signboarding" target="_blank">инструкция</a>)
    `;
    noteEl.classList.remove('hidden');
  } else if (browserType === 'chrome') {
    noteEl.innerHTML = `
      <strong>✅ Chrome Detected</strong><br>
      Расширение работает напрямую. Для разработки: <code>chrome://extensions</code> → "Developer mode" → "Load unpacked"
    `;
    noteEl.classList.remove('hidden');
  }
}

// Загрузить настройки
async function loadSettings() {
  try {
    const result = await browser.storage.local.get([
      'jiraUrl',
      'jiraToken',
      'jiraFilter',
      'storyPointsField',
      'epicLinkField'
    ]);
    
    document.getElementById('jiraUrl').value = result.jiraUrl || '';
    document.getElementById('jiraToken').value = result.jiraToken || '';
    document.getElementById('jiraFilter').value = result.jiraFilter || '';
    document.getElementById('storyPointsField').value = result.storyPointsField || '';
    document.getElementById('epicLinkField').value = result.epicLinkField || '';
  } catch (err) {
    console.error('Error loading settings:', err);
  }
}

// Сохранить настройки
async function saveSettings() {
  const jiraUrl = document.getElementById('jiraUrl').value.trim();
  const jiraToken = document.getElementById('jiraToken').value.trim();
  const jiraFilter = document.getElementById('jiraFilter').value.trim();
  const storyPointsField = document.getElementById('storyPointsField').value.trim();
  const epicLinkField = document.getElementById('epicLinkField').value.trim();

  if (!jiraUrl || !jiraToken) {
    showStatus('connectionStatus', 'Укажите URL Jira и API Token', 'error');
    return;
  }

  try {
    await browser.storage.local.set({
      jiraUrl,
      jiraToken,
      jiraFilter,
      storyPointsField,
      epicLinkField
    });
    showStatus('connectionStatus', 'Настройки сохранены!', 'success');
  } catch (err) {
    showStatus('connectionStatus', `Ошибка сохранения: ${err.message}`, 'error');
  }
}

// Очистить настройки
async function clearSettings() {
  await browser.storage.local.clear();
  document.getElementById('jiraUrl').value = '';
  document.getElementById('jiraToken').value = '';
  document.getElementById('jiraFilter').value = '';
  document.getElementById('storyPointsField').value = '';
  document.getElementById('epicLinkField').value = '';
  document.getElementById('connectionStatus').classList.add('hidden');
  document.getElementById('fieldsList').classList.add('hidden');
  showStatus('connectionStatus', 'Настройки очищены', 'success');
}

// Проверить подключение к Jira
async function testConnection() {
  const jiraUrl = document.getElementById('jiraUrl').value.trim();
  const jiraToken = document.getElementById('jiraToken').value.trim();

  if (!jiraUrl || !jiraToken) {
    showStatus('connectionStatus', 'Укажите URL Jira и API Token', 'error');
    return;
  }

  showStatus('connectionStatus', 'Проверка подключения...', 'success');

  try {
    const response = await fetch(`${jiraUrl}/rest/api/2/myself`, {
      headers: jiraAuth(jiraToken)
    });

    if (response.ok) {
      const data = await response.json();
      showStatus('connectionStatus', `✅ Подключено как: ${data.displayName}`, 'success');
    } else {
      showStatus('connectionStatus', `❌ Ошибка: HTTP ${response.status}`, 'error');
    }
  } catch (err) {
    showStatus('connectionStatus', `❌ Ошибка: ${err.message}`, 'error');
  }
}

// Загрузить список полей
async function loadFields() {
  const jiraUrl = document.getElementById('jiraUrl').value.trim();
  const jiraToken = document.getElementById('jiraToken').value.trim();

  if (!jiraUrl || !jiraToken) {
    showStatus('connectionStatus', 'Укажите URL Jira и API Token', 'error');
    return;
  }

  const fieldsListEl = document.getElementById('fieldsList');
  fieldsListEl.innerHTML = 'Загрузка...';
  fieldsListEl.classList.remove('hidden');

  try {
    const response = await fetch(`${jiraUrl}/rest/api/2/field`, {
      headers: jiraAuth(jiraToken)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const fields = await response.json();
    
    // Сортируем: сначала кастомные поля (customfield_), потом стандартные
    const sortedFields = fields.sort((a, b) => {
      const aCustom = a.id.startsWith('customfield_') ? 0 : 1;
      const bCustom = b.id.startsWith('customfield_') ? 0 : 1;
      return aCustom - bCustom || a.name.localeCompare(b.name);
    });

    // Фильтруем поля, которые могут быть Story Points
    const candidateFields = sortedFields.filter(f => 
      f.name.toLowerCase().includes('story') || 
      f.name.toLowerCase().includes('estimate') ||
      f.name.toLowerCase().includes('points')
    );

    let html = '<strong>Поля, подходящие для Story Points:</strong><br>';
    candidateFields.forEach(f => {
      html += `<div style="margin: 4px 0; padding: 4px; background: #e8f5e9; border-radius: 3px;">
        <code>${f.id}</code> — ${f.name} (${f.type})
      </div>`;
    });

    html += '<br><strong>Все кастомные поля:</strong><br>';
    sortedFields.filter(f => f.id.startsWith('customfield_')).slice(0, 20).forEach(f => {
      html += `<div style="margin: 2px 0; font-size: 11px;">
        <code>${f.id}</code> — ${f.name}
      </div>`;
    });

    if (sortedFields.filter(f => f.id.startsWith('customfield_')).length > 20) {
      html += '<div style="margin: 4px 0; color: #888; font-size: 11px;">... и еще много полей</div>';
    }

    fieldsListEl.innerHTML = html;
    showStatus('connectionStatus', `Загружено ${fields.length} полей`, 'success');
  } catch (err) {
    fieldsListEl.innerHTML = `Ошибка: ${err.message}`;
    showStatus('connectionStatus', `Ошибка загрузки полей: ${err.message}`, 'error');
  }
}

function jiraAuth(token, extra = {}) {
    return { ...extra, 'Authorization': `Bearer ${token}` };
}

// Короткая расшифровка результата пробы — чтобы владелец понял вывод без нас
function explainProbe(result) {
  if (result.status === 0) return 'нет ответа: сеть, прокси или CORS';
  if (result.status === 401) return 'токен не принят';
  if (result.status === 403) return 'запрет: XSRF, права или фильтр перед Jira';
  if (result.status === 404 && result.method !== 'GET') return 'запрос дошёл до Jira: задачи нет — это ожидаемо и хорошо';
  if (result.status === 404) return 'адрес не найден: проверьте URL Jira';
  if (result.ok) return 'успех';
  return 'см. тело ответа';
}

// Диагностика: четыре пробы через background, результат текстом в <pre>
async function runDiagnose() {
  const jiraUrl = document.getElementById('jiraUrl').value.trim().replace(/\/+$/, '');
  const jiraToken = document.getElementById('jiraToken').value.trim();

  if (!jiraUrl || !jiraToken) {
    showStatus('connectionStatus', 'Укажите URL Jira и API Token', 'error');
    return;
  }

  const outEl = document.getElementById('diagnoseOutput');
  outEl.classList.remove('hidden');
  outEl.textContent = 'Выполняются четыре пробы...';

  let resp;
  try {
    resp = await browser.runtime.sendMessage({ type: 'diagnose', jiraUrl, jiraToken });
  } catch (err) {
    outEl.textContent = `Расширение не ответило: ${err.message}`;
    return;
  }

  if (!resp || !resp.ok) {
    outEl.textContent = `Диагностика не выполнена: ${(resp && resp.error) || 'нет ответа'}`;
    return;
  }

  const lines = [`Jira: ${jiraUrl}`, ''];
  resp.results.forEach((r) => {
    const path = r.url.startsWith(jiraUrl) ? r.url.slice(jiraUrl.length) : r.url;
    const code = r.status === 0 ? 'нет ответа' : `HTTP ${r.status}`;
    lines.push(`${r.step}. ${r.method} ${path}`);
    lines.push(`   ${code} — ${explainProbe(r)}`);
    lines.push(`   ${r.body || '(пустое тело)'}`);
    lines.push('');
  });
  lines.push('Пробы 3 и 4 идут на несуществующую задачу ZZZZ-99999 и ничего не меняют.');
  lines.push('404 на них — хорошо: запись доходит до Jira. 403 или HTML — режут по пути.');

  outEl.textContent = lines.join('\n');
}

// Показать статус
function showStatus(elementId, message, type) {
  const el = document.getElementById(elementId);
  el.textContent = message;
  el.className = `status ${type}`;
  el.classList.remove('hidden');
}

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
  // Определить браузер и показать инструкцию
  browserType = detectBrowser();
  showBrowserInstruction();
  
  // Загрузить сохраненные настройки
  loadSettings();

  // Кнопки
  document.getElementById('saveSettings').addEventListener('click', saveSettings);
  document.getElementById('clearSettings').addEventListener('click', clearSettings);
  document.getElementById('testConnection').addEventListener('click', testConnection);
  document.getElementById('runDiagnose').addEventListener('click', runDiagnose);
  document.getElementById('loadFields').addEventListener('click', loadFields);
});
