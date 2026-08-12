// PP Jira Bridge — popup script
// Работает в Chrome и Firefox благодаря polyfill

let browserType = 'unknown';

// Определить тип браузера по схеме собственного адреса расширения.
//
// Прежняя проверка смотрела на наличие глобального browser — и всегда говорила
// «Firefox», в том числе в Chrome: browser там создаёт browser-polyfill.min.js,
// подключённый к этому же popup. Проверка опровергала сама себя.
//
// Схема адреса подделке не поддаётся: moz-extension:// в Firefox,
// chrome-extension:// в Chrome и других Chromium.
function browserTypeFromUrl(url) {
  const text = String(url || '');
  if (text.startsWith('moz-extension://')) return 'firefox';
  if (text.startsWith('chrome-extension://')) return 'chrome';
  return 'unknown';
}

function detectBrowser() {
  const runtime = (typeof browser !== 'undefined' && browser.runtime)
    ? browser.runtime
    : (typeof chrome !== 'undefined' ? chrome.runtime : null);
  try {
    browserType = browserTypeFromUrl(runtime && runtime.getURL(''));
  } catch (e) {
    browserType = 'unknown';
  }
  return browserType;
}

// Показать номер версии в заголовке.
// Нужен, чтобы отличить свежую сборку от старой, оставшейся в браузере:
// временное расширение Firefox переустанавливают вручную, и легко загрузить
// прошлую распакованную папку, не заметив этого.
function showVersion() {
  const el = document.getElementById('extVersion');
  if (!el) return;
  const runtime = (typeof browser !== 'undefined' && browser.runtime) ? browser.runtime : chrome.runtime;
  try {
    el.textContent = `v${runtime.getManifest().version}`;
  } catch (e) {
    el.textContent = '';
  }
}

// Показать адреса, которым расширение отказало, и предложить разрешить их кнопкой.
// Набирать адрес руками не нужно: он уже приведён к нужному виду, без гадания про схему.
async function showBlockedOrigins() {
  const box = document.getElementById('blockedOrigins');
  if (!box) return;

  let resp;
  try {
    resp = await browser.runtime.sendMessage({ type: 'blockedOrigins' });
  } catch (err) {
    return;
  }

  const origins = (resp && resp.origins) || [];
  const known = new Set(document.getElementById('allowedOrigins').value.split(/[\s,;]+/).filter(Boolean));
  const свежие = origins.filter(o => !known.has(o));

  if (свежие.length === 0) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }

  box.textContent = '';
  const заголовок = document.createElement('div');
  заголовок.innerHTML = '<strong>Эти страницы просили доступ, и он был отклонён.</strong> '
    + 'Разрешайте только свой Planning Poker.';
  box.appendChild(заголовок);

  for (const origin of свежие) {
    const row = document.createElement('div');
    row.className = 'blocked-origin-row';

    const name = document.createElement('span');
    name.className = 'blocked-origin-name';
    // textContent, а не innerHTML: адрес приходит со стороны и в разметку не вставляется
    name.textContent = origin;
    row.appendChild(name);

    const btn = document.createElement('button');
    btn.className = 'btn-primary';
    btn.textContent = 'Разрешить';
    btn.addEventListener('click', () => allowOrigin(origin));
    row.appendChild(btn);

    box.appendChild(row);
  }
  box.classList.remove('hidden');
}

// Добавляет адрес в список и сразу сохраняет — иначе кнопка обещала бы больше, чем делает.
// Сохраняем только список адресов: разрешить адрес можно и до того, как заполнены
// адрес Jira с токеном, а общее сохранение без них отказывает.
async function allowOrigin(origin) {
  const field = document.getElementById('allowedOrigins');
  const строки = field.value.split(/\n/).map(s => s.trim()).filter(Boolean);
  if (!строки.includes(origin)) строки.push(origin);
  field.value = строки.join('\n');

  const resp = await browser.runtime.sendMessage({ type: 'saveSettings', allowedOrigins: field.value });
  if (!resp || !resp.ok) {
    showStatus('connectionStatus', 'Не удалось сохранить список адресов', 'error');
    return;
  }
  await loadSettings();
  await showBlockedOrigins();
  showStatus('connectionStatus', `Адрес ${origin} разрешён. Обновите страницу Planning Poker.`, 'success');
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
      'epicLinkField',
      'allowedOrigins'
    ]);

    document.getElementById('jiraUrl').value = result.jiraUrl || '';
    document.getElementById('jiraToken').value = result.jiraToken || '';
    document.getElementById('jiraFilter').value = result.jiraFilter || '';
    document.getElementById('storyPointsField').value = result.storyPointsField || '';
    document.getElementById('epicLinkField').value = result.epicLinkField || '';
    document.getElementById('allowedOrigins').value = (result.allowedOrigins || []).join('\n');
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
  const allowedOrigins = document.getElementById('allowedOrigins').value;

  if (!jiraUrl || !jiraToken) {
    showStatus('connectionStatus', 'Укажите URL Jira и API Token', 'error');
    return;
  }

  try {
    // Сохраняем через background, а не в хранилище напрямую: там же разбирается список
    // адресов и переподнимается слушатель заголовков под новый хост Jira.
    const resp = await browser.runtime.sendMessage({
      type: 'saveSettings',
      jiraUrl,
      jiraToken,
      jiraFilter,
      storyPointsField,
      epicLinkField,
      allowedOrigins,
    });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'нет ответа');
    // Показываем разобранный список: опечатку в адресе видно сразу, а не при отказе
    await loadSettings();
    await showBlockedOrigins();

    const выброшено = resp.droppedOrigins || [];
    if (выброшено.length > 0) {
      showStatus('connectionStatus', `Сохранено, но не понял адрес: ${выброшено.join(', ')}`, 'error');
    } else {
      showStatus('connectionStatus', 'Настройки сохранены!', 'success');
    }
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
  document.getElementById('allowedOrigins').value = '';
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

  // Запрос идёт через background, а не отсюда напрямую: там собраны заголовки,
  // credentials: 'omit', подмена Origin и разбор тела ошибки. Свои fetch в popup
  // жили без всего этого и показывали «HTTP 403» вместо причины отказа.
  const resp = await browser.runtime.sendMessage({ type: 'testConnection', jiraUrl, jiraToken });
  if (resp && resp.ok) {
    showStatus('connectionStatus', `✅ Подключено как: ${resp.displayName}`, 'success');
  } else {
    showStatus('connectionStatus', `❌ Ошибка: ${(resp && resp.error) || 'нет ответа'}`, 'error');
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
    const resp = await browser.runtime.sendMessage({ type: 'getFields', jiraUrl, jiraToken });
    if (!resp || !resp.ok) {
      throw new Error((resp && resp.error) || 'нет ответа');
    }

    const fields = resp.fields || [];

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

// Ответила ли Jira: у неё тело всегда JSON. HTML-страница — это прокси перед ней
function looksLikeJira(result) {
  if (!result.body) return false;
  try {
    JSON.parse(result.body);
    return true;
  } catch (_) {
    // Тело обрезано до 200 символов, поэтому длинный JSON распарсить не удастся —
    // но его начало всё равно опознаётся по первому символу
    return /^[[{]/.test(result.body.trim());
  }
}

// Короткая расшифровка результата пробы — чтобы владелец понял вывод без нас
function explainProbe(result) {
  if (result.status === 0) return 'нет ответа: сеть, прокси или CORS';
  if (result.status === 401) return 'токен не принят';
  if (result.status === 403) return 'запрет: XSRF, права или фильтр перед Jira';
  if (result.status === 404 && result.method !== 'GET') {
    return looksLikeJira(result)
      ? 'запрос дошёл до Jira: задачи нет — это ожидаемо и хорошо'
      : '404, но ответ не похож на Jira: тело не JSON, отвечает что-то по пути';
  }
  if (result.status === 404) return 'адрес не найден: проверьте URL Jira';
  if (result.ok) return 'успех';
  return 'см. тело ответа';
}

// Диагностика: четыре пробы через background, результат текстом в <pre>
// Состояние правки исходящих заголовков понятными словами.
// Правка идёт через webRequest и доступна только в Firefox.
function describeOriginStrip(state) {
  if (state === 'active') return 'включена';
  if (state === 'inactive') return 'выключена (адрес Jira не разобран)';
  if (state === 'unsupported') return 'не нужна (Chrome не добавляет Origin)';
  return state || 'неизвестно';
}

async function runDiagnose() {
  // Адрес берём ровно в том виде, в каком его использует отказавший путь: saveSettings
  // делает только trim(), страница шлёт jiraSettings.jiraUrl как есть. Нормализуй мы тут
  // слеш на конце — пробы пошли бы не по тому URL, и диагностика соврала бы зелёным.
  const jiraUrl = document.getElementById('jiraUrl').value.trim();
  const jiraToken = document.getElementById('jiraToken').value.trim();

  if (!jiraUrl || !jiraToken) {
    showStatus('connectionStatus', 'Укажите URL Jira и API Token', 'error');
    return;
  }

  const outEl = document.getElementById('diagnoseOutput');
  outEl.classList.remove('hidden');
  outEl.textContent = 'Выполняются пробы...';

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

  const version = document.getElementById('extVersion').textContent || 'версия неизвестна';
  const lines = [
    `Расширение: ${version}`,
    `Jira: ${jiraUrl}`,
    `Правка заголовков: ${describeOriginStrip(resp.originStrip)}, сработала ${resp.headerEdits} раз`,
    '',
  ];
  resp.results.forEach((r) => {
    const path = r.url.startsWith(jiraUrl) ? r.url.slice(jiraUrl.length) : r.url;
    lines.push(`${r.step}. ${r.method} ${path}${r.note ? ` — ${r.note}` : ''}`);
    if (r.skipped) {
      lines.push(`   ${r.body}`);
      lines.push('');
      return;
    }
    const code = r.status === 0 ? 'нет ответа' : `HTTP ${r.status}`;
    lines.push(`   ${code} — ${explainProbe(r)}`);
    const headers = Object.entries(r.headers || {}).map(([k, v]) => `${k}: ${v}`);
    lines.push(`   ${headers.length ? headers.join(' | ') : '(нужных заголовков нет)'}`);
    lines.push(`   ${r.body || '(пустое тело)'}`);
    lines.push('');
  });
  lines.push('Все PUT идут на несуществующую задачу ZZZZ-99999 с пустым набором полей,');
  lines.push('проба 4 — поиск. Ни одна ничего не меняет в Jira.');
  lines.push('Проба 3 — боевые условия. Пробы 5-9 отличаются от неё ровно одним условием.');
  lines.push('Ожидается: 3 даёт 404 (запись доходит), 5, 6 и 9 — 403 (проверке нужен');
  lines.push('Origin, совпадающий с адресом Jira). 403 в пробе 3 — отправка снова сломана.');
  lines.push('«сработала 0 раз» при включённой правке — значит слушатель не отработал,');
  lines.push('и пробы 5, 6, 9 ничего не проверили.');
  lines.push('Строка заголовков говорит, кто ответил: Jira (X-AUSERNAME, X-Seraph-*) или прокси (Server).');

  outEl.textContent = lines.join('\n');
}

// Показать статус
function showStatus(elementId, message, type) {
  const el = document.getElementById(elementId);
  el.textContent = message;
  el.className = `status ${type}`;
  el.classList.remove('hidden');
}

// Event listeners. Условие нужно юнит-тестам: в Node документа нет, и файл
// загружается только ради чистых функций.
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
  // Определить браузер и показать инструкцию
  browserType = detectBrowser();
  showBrowserInstruction();
  showVersion();
  showBlockedOrigins();
  
  // Загрузить сохраненные настройки
  loadSettings();

  // Кнопки
  document.getElementById('saveSettings').addEventListener('click', saveSettings);
  document.getElementById('clearSettings').addEventListener('click', clearSettings);
  document.getElementById('testConnection').addEventListener('click', testConnection);
  document.getElementById('runDiagnose').addEventListener('click', runDiagnose);
  document.getElementById('loadFields').addEventListener('click', loadFields);
  });
}

// Экспорт для юнит-тестов: в браузере module не определён, ветка не выполняется
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { browserTypeFromUrl };
}
