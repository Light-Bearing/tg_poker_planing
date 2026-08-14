// ========================================================================
// MODULE 1: GAME CORE — State, Session, WebSocket, Voting, Task Display
// ========================================================================

// ========== CONSTANTS ==========
const RECONNECT_MAX_ATTEMPTS = 5;
const PING_INTERVAL_MS = 15000;
const JIRA_AUTO_CONNECT_TIMEOUT = 30000;
const JIRA_AUTO_CONNECT_DELAY = 2000;
const AUTO_RESTORE_FOCUS_DELAY = 50;
const RECONNECT_BASE_DELAY = 2000;
const MAX_RECENT_ROOMS = 5;
const MAX_TOASTS_ON_SCREEN = 4;
const TOAST_DURATION_DEFAULT = 4000;
const TOAST_DURATION_ERROR = 5000;

let state = {
    username: localStorage.getItem('pp_username') || '',
    sessionId: null,
    isInitiator: false,
    selectedPoint: null,
    ws: null,
    reconnectAttempts: 0,
    wasRevealed: false,
    session: null,          // последняя сессия с сервера: нужна окну настроек шкалы
    soundEnabled: localStorage.getItem('pp_sound_enabled') !== 'false'
};

// ==================== TOAST NOTIFICATION SYSTEM ====================
class ToastManager {
    constructor() {
        this.container = null;
        this.queue = [];
    }
    
    init() {
        this.container = document.getElementById('toastContainer');
    }
    
    _createToast(type, title, message, duration = 4000) {
        if (!this.container) this.init();
        
        const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
        const safeTitle = escapeHtml(title);
        const safeMessage = escapeHtml(message);
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.setAttribute('role', 'alert');
        toast.innerHTML = `
            <div class="toast-icon">${icons[type] || 'ℹ'}</div>
            <div class="toast-body">
                <div class="toast-title">${safeTitle}</div>
                <div class="toast-message">${safeMessage}</div>
            </div>
            <button class="toast-close" onclick="this.parentElement.remove()">✕</button>
            <div class="toast-progress" style="animation-duration: ${duration}ms;"></div>
        `;
        
        this.container.appendChild(toast);
        
        // Ограничиваем количество toast'ов на экране
        const toasts = this.container.querySelectorAll('.toast');
        if (toasts.length > MAX_TOASTS_ON_SCREEN) {
            toasts[0].remove();
        }
        
        // Автоскрытие
        setTimeout(() => {
            if (toast.parentElement) {
                toast.classList.add('removing');
                setTimeout(() => toast.remove(), 250);
            }
        }, duration);
    }
    
    success(message, title = 'УСПЕХ') { this._createToast('success', title, message); }
    error(message, title = 'ОШИБКА') { this._createToast('error', title, message, 5000); }
    warning(message, title = 'ВНИМАНИЕ') { this._createToast('warning', title, message); }
    info(message, title = 'ИНФО') { this._createToast('info', title, message); }
}

// ==================== CONFIRM MODAL SYSTEM ====================
class ConfirmManager {
    constructor() {
        this.resolvePromise = null;
        this.previousFocus = null;
    }
    
    show(message, title = 'ПОДТВЕРЖДЕНИЕ', okText = 'ПОДТВЕРДИТЬ', cancelText = 'ОТМЕНА') {
        return new Promise(resolve => {
            this.resolvePromise = resolve;
            this.previousFocus = document.activeElement;
            const modal = document.getElementById('confirmModal');
            document.getElementById('confirmTitle').textContent = title;
            document.getElementById('confirmMessage').textContent = message;
            document.getElementById('confirmOkBtn').textContent = okText;
            modal.classList.remove('hidden');
            
            // Фокус на кнопку ОК для быстрых действий с клавиатуры
            setTimeout(() => document.getElementById('confirmOkBtn').focus(), 50);
        });
    }
    
    close(result) {
        const modal = document.getElementById('confirmModal');
        modal.classList.add('hidden');
        if (this.previousFocus) {
            this.previousFocus.focus();
            this.previousFocus = null;
        }
        if (this.resolvePromise) {
            this.resolvePromise(result);
            this.resolvePromise = null;
        }
    }
}

const toast = new ToastManager();
const confirmDialog = new ConfirmManager();

// ========================================================================
// MODULE 3: JIRA INTEGRATION — Connection, Issues, Tree, Estimate Send
// ========================================================================

// ==================== JIRA STATE ====================
// Настройки Jira, доступные странице. Токена среди них нет и быть не может: он живёт
// только в хранилище расширения, а запросы к Jira собирает background. Страница видит
// адрес Jira (нужен для ссылок на задачи), фильтр, идентификаторы полей и признак того,
// что расширение настроено.
let jiraSettings = JSON.parse(localStorage.getItem('pp_jira_settings') || '{}');

// Разовая чистка: прежние версии клали токен в localStorage, откуда его достала бы
// любая XSS на странице. Удаляем при первом же запуске новой версии.
if (jiraSettings.jiraToken) {
    delete jiraSettings.jiraToken;
    jiraPersistSettings();
}
let jiraIssues = [];          // все задачи (включая эпики)
let jiraEpics = [];           // только эпики (для совместимости)
let jiraSelectedIssue = null;
let jiraEpicLinkField = '';   // customfield_ID для связи с эпиком
let jiraConnected = false;     // флаг успешного подключения к Jira
let jiraAutoConnecting = false;// идёт автоподключение
let jiraAccessError = '';      // расширение не обслуживает адрес этой страницы
let epicMap = {};             // маппинг ключ эпика -> имя эпика
let currentJiraIssue = null;  // текущая задача из Jira {key, summary, description, url}
let currentTaskText = '';     // текущий текст задачи (для не-Jira задач)

let _jiraMsgId = 0;
const _jiraPending = new Map();
const JIRA_EXT_TIMEOUT = 20000; // сколько ждём ответа расширения, мс

function hasJiraExt() {
    return document.documentElement.dataset.ppJiraExt !== undefined;
}

// Расширение может сигналить о готовности (если DOMContentLoaded уже прошёл)
document.addEventListener('pp-jira-ready', () => {
    if (!document.documentElement.dataset.ppJiraExt) {
        document.documentElement.dataset.ppJiraExt = '1.0';
    }
    // Даём service worker'у расширения время на инициализацию
    setTimeout(() => {
        if (typeof jiraAutoConnect === 'function' && !jiraConnected && !jiraAutoConnecting) {
console.log('Jira: starting auto-connect (delayed after pp-jira-ready)');
                    jiraAutoConnect();
                }
            }, JIRA_AUTO_CONNECT_DELAY);
});

// Слушаем ответы от расширения (через postMessage)
// event.source не проверяем — content script и страница в разных изолированных мирах
window.addEventListener('message', (event) => {
    if (!event.data || event.data.source !== 'pp-jira-ext') return;

    const { msgId, response } = event.data;
    const pending = _jiraPending.get(msgId);
    if (pending) {
        _jiraPending.delete(msgId);
        // Снимаем таймер: иначе он выстрелит позже уже по пустому месту
        clearTimeout(pending.timer);
        pending.resolve(response);
    }
});

function jiraSendMessage(msg) {
    return new Promise((resolve) => {
        if (!hasJiraExt()) {
            resolve({ ok: false, error: 'EXTENSION_NOT_FOUND' });
            return;
        }
        const msgId = ++_jiraMsgId;
        // Без таймаута промис не разрешится никогда, если расширение выгружено
        // или сообщение потерялось: кнопка навсегда зависнет в «⏳ ОТПРАВКА...»
        const timer = setTimeout(() => {
            _jiraPending.delete(msgId);
            resolve({
                ok: false,
                // Причина может быть и в расширении, и в зависшем запросе к Jira —
                // не уводим владельца копаться только в about:debugging
                error: 'Расширение или Jira не ответили за 20 с. Проверьте, что расширение включено, и попробуйте ещё раз.',
            });
        }, JIRA_EXT_TIMEOUT);
        _jiraPending.set(msgId, {
            // Расширение обслуживает только адреса, которые владелец разрешил в его popup.
            // Показываем адрес этой страницы: его и надо туда вставить.
            resolve: (response) => {
                if (response && response.error === 'ORIGIN_NOT_ALLOWED') {
                    jiraAccessError = `Расширение не обслуживает этот адрес. Откройте popup расширения и добавьте ${window.location.origin} в «Адреса Planning Poker».`;
                    resolve({ ...response, blocked: true, error: jiraAccessError });
                    return;
                }
                jiraAccessError = '';
                resolve(response);
            },
            timer,
        });
        // postMessage использует structured clone — надёжно работает в Chrome и Firefox
        window.postMessage({
            source: 'pp-jira-page',
            msg,
            msgId,
        }, '*');
    });
}

function toggleJiraPanel() {
    const panel = document.getElementById('jiraPanel');
    const isOpen = !panel.classList.contains('hidden');
    panel.classList.toggle('hidden');

    if (!isOpen) {
        // Настройки живут в расширении и могли поменяться, пока вкладка была открыта:
        // владелец обычно настраивает popup уже после того, как открыл страницу.
        // Без этого запроса признак configured остался бы снимком времени загрузки.
        jiraRefreshSettings().then(renderJiraPanel);
        renderJiraPanel();
    } else {
        document.getElementById('jiraSettings').style.display = 'none';
        document.getElementById('jiraNoExt').style.display = 'block';
        document.getElementById('jiraSessionSection').style.display = 'none';
    }
}

// Забирает у расширения актуальные настройки: адрес Jira, фильтр, поля и признак
// configured. Токена среди них нет — расширение его не отдаёт.
//
// Признак configured — факт о постороннем процессе, а не состояние страницы, поэтому
// в localStorage он не сохраняется: протухший true врал бы так же, как протухший false.
async function jiraRefreshSettings() {
    if (!hasJiraExt()) return false;

    const ext = await jiraSendMessage({ type: 'getSettings' });
    if (!ext || ext.blocked || !ext.jiraUrl) return false;

    const local = { ...jiraSettings };
    jiraSettings = {
        ...ext,
        // Поля могло найти автоопределение и сохранить локально раньше, чем в расширение
        storyPointsField: ext.storyPointsField || local.storyPointsField || '',
        epicLinkField: ext.epicLinkField || local.epicLinkField || '',
    };
    if (jiraSettings.epicLinkField) {
        jiraEpicLinkField = jiraSettings.epicLinkField;
    }
    jiraPersistSettings();
    updateJiraHeaderBtn();
    return Boolean(jiraSettings.configured);
}

// Сохраняет настройки страницы, кроме признака configured
function jiraPersistSettings() {
    const { configured, ...persistent } = jiraSettings;
    localStorage.setItem('pp_jira_settings', JSON.stringify(persistent));
}

function renderJiraPanel() {
    const noExt = document.getElementById('jiraNoExt');
    const settings = document.getElementById('jiraSettings');
    const sessionSection = document.getElementById('jiraSessionSection');
    const preview = document.getElementById('jiraIssuePreview');
    if (preview) preview.style.display = 'none';

    noExt.style.display = hasJiraExt() ? 'none' : 'block';
    settings.style.display = hasJiraExt() ? 'block' : 'none';
    sessionSection.style.display = 'none';

    if (hasJiraExt()) {
        document.getElementById('jiraFilter').value = jiraSettings.jiraFilter || 'assignee = currentUser() AND resolution = Unresolved ORDER BY priority DESC, updated DESC';

        const urlEl = document.getElementById('jiraConfiguredUrl');
        if (urlEl) {
            urlEl.textContent = jiraSettings.configured
                ? `Настроено: ${jiraSettings.jiraUrl}`
                : 'Пока не настроено.';
        }

        // Показываем актуальный статус подключения
        const statusEl = document.getElementById('jiraStatus');
        if (jiraAccessError) {
            // Без этого расширение выглядит установленным, но молча ничего не делает
            statusEl.className = 'jira-status err';
            statusEl.textContent = jiraAccessError;
        } else if (jiraConnected) {
            if (!statusEl.textContent.includes('Подключено')) {
                statusEl.className = 'jira-status ok';
                statusEl.textContent = '✅ Подключено';
            }
        } else if (jiraAutoConnecting) {
            statusEl.className = 'jira-status';
            statusEl.textContent = '⏳ Подключение...';
        } else if (jiraSettings.configured) {
            statusEl.className = 'jira-status';
            statusEl.textContent = '💡 Нажмите ПРОВЕРИТЬ';
        } else {
            statusEl.textContent = '';
        }

        if (jiraSettings.storyPointsField) {
            showJiraFieldSelect();
            // Если селект пустой — пытаемся заполнить
            const select = document.getElementById('jiraFieldSelect');
            if (select && select.options.length === 0 && jiraSettings.storyPointsField) {
                select.innerHTML = `<option value="${jiraSettings.storyPointsField}">${jiraSettings.storyPointsField}</option>`;
            }
        }

        if (jiraSettings.epicLinkField) {
            jiraEpicLinkField = jiraSettings.epicLinkField;
        }

        if (state.sessionId) {
            sessionSection.style.display = 'block';
            // Если задачи уже загружены — рендерим дерево
            if (jiraIssues.length > 0) {
                renderJiraIssueTree();
            }
            // Показываем статус загрузки, если есть
            const statusEl = document.getElementById('jiraSessionStatus');
            if (jiraIssues.length > 0) {
                statusEl.className = 'jira-status ok';
                statusEl.textContent = `✅ ${jiraIssues.length} задач, ${jiraEpics.length} эпиков`;
            } else if (jiraConnected) {
                statusEl.textContent = '🔄 загрузка...';
            }
        }

        updateJiraHeaderBtn();
    }
}

async function jiraTestConnection() {
    const statusEl = document.getElementById('jiraStatus');

    const btn = document.getElementById('jiraTestBtn');
    btn.disabled = true;
    btn.textContent = '...';
    statusEl.className = 'jira-status';

    // Подтянуть настройки перед проверкой: удавшееся подключение доказывает, что
    // расширение настроено, и оставлять признак configured протухшим после этого нельзя
    await jiraRefreshSettings();

    // Адрес и токен берёт background из своего хранилища — страница их не знает
    const resp = await jiraSendMessage({ type: 'testConnection' });
    if (resp.ok) {
        jiraConnected = true;
        statusEl.className = 'jira-status ok';
        statusEl.textContent = `✅ Подключено: ${resp.displayName}`;
        const fieldsResp = await jiraSendMessage({ type: 'getFields' });
        if (fieldsResp.ok) {
            jiraPopulateFieldSelect(fieldsResp.fields);
            // Ищем поле Epic Link по нескольким критериям
            let epicLinkField = fieldsResp.fields.find(f =>
                f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-epic-link'
            );
            // Альтернативный поиск по имени
            if (!epicLinkField) {
                epicLinkField = fieldsResp.fields.find(f =>
                    f.name?.toLowerCase() === 'epic link' || f.name?.toLowerCase() === 'epic-link'
                );
            }
            console.log('[Jira] Found epicLinkField:', epicLinkField ? epicLinkField.id + ' (' + epicLinkField.name + ')' : 'NOT FOUND');
            jiraEpicLinkField = epicLinkField ? epicLinkField.id : '';
            // Сохраняем найденные поля
            jiraSettings.epicLinkField = jiraEpicLinkField;
            const select = document.getElementById('jiraFieldSelect');
            if (select && select.value) {
                jiraSettings.storyPointsField = select.value;
            }
            jiraPersistSettings();
            jiraSendMessage({ type: 'saveSettings', ...jiraSettings });
        }
        // Показываем дерево задач на экране входа
        showJiraJoinTree();
        await jiraLoadIssues();
    } else {
        statusEl.className = 'jira-status err';
        statusEl.textContent = `❌ ${resp.error}`;
        jiraConnected = false;
    }

    btn.disabled = false;
    btn.textContent = 'ПРОВЕРИТЬ';
}

function jiraPopulateFieldSelect(fields) {
    const storyFields = fields.filter(f =>
        f.name.toLowerCase().includes('story point') ||
        f.name.toLowerCase().includes('story point estimate') ||
        f.name.toLowerCase().includes('оценка') ||
        f.name.toLowerCase().includes('estimate') ||
        f.name.toLowerCase().includes('estimation')
    );
    const select = document.getElementById('jiraFieldSelect');
    if (!select) return;
    select.innerHTML = storyFields.map(f =>
        `<option value="${f.id}">${f.name} (${f.id})</option>`
    ).join('');
    if (storyFields.length === 0) {
        select.innerHTML = fields
            .filter(f => f.custom && f.schema?.type === 'number')
            .slice(0, 20)
            .map(f => `<option value="${f.id}">${f.name} (${f.id})</option>`).join('');
    }
    document.getElementById('jiraFieldGroup').style.display = 'block';
    if (jiraSettings.storyPointsField) {
        select.value = jiraSettings.storyPointsField;
    }
}

function showJiraFieldSelect() {
    document.getElementById('jiraFieldGroup').style.display = 'block';
}

async function jiraSaveSettings() {
    const filter = document.getElementById('jiraFilter').value.trim();
    const fieldSelect = document.getElementById('jiraFieldSelect');
    const fieldId = fieldSelect.value || '';

    if (!jiraSettings.configured && !await jiraRefreshSettings()) {
        toast.warning(jiraAccessError || 'Сначала укажите адрес Jira и токен в popup расширения');
        return;
    }

    // Страница сохраняет только несекретное: фильтр и выбранные поля.
    // Адрес и токен живут в расширении, отсюда они не отправляются и не приходят.
    jiraSettings = { ...jiraSettings, jiraFilter: filter, storyPointsField: fieldId, epicLinkField: jiraEpicLinkField };
    jiraPersistSettings();

    const resp = await jiraSendMessage({
        type: 'saveSettings',
        jiraFilter: filter,
        storyPointsField: fieldId,
        epicLinkField: jiraEpicLinkField,
    });
    if (resp.ok) {
        toast.success('Настройки Jira сохранены');
    } else if (resp.error === 'EXTENSION_NOT_FOUND') {
        toast.warning('Настройки сохранены локально. Установите расширение для работы с Jira.');
    }

    document.getElementById('jiraStatus').className = 'jira-status';
    document.getElementById('jiraStatus').textContent = '';
    updateJiraHeaderBtn();
}

function updateJiraHeaderBtn() {
    const btn = document.getElementById('jiraBtn');
    if (!btn) return;
    if (jiraSettings.configured) {
        btn.classList.add('has-settings');
    } else {
        btn.classList.remove('has-settings');
    }
}

// ==================== AUTO-CONNECT JIRA ====================
async function jiraAutoConnect() {
    if (jiraAutoConnecting || jiraConnected) return;
    if (!hasJiraExt()) return;
    // Спрашиваем расширение сами, если признак ещё не известен.
    // В Chrome content script появляется после DOMContentLoaded, поэтому путь, который
    // узнаёт настройки при загрузке, вообще не отрабатывает: расширения тогда ещё нет.
    // Автоподключение выходило молча, и задачи не грузились никогда.
    if (!jiraSettings.configured && !(await jiraRefreshSettings())) return;

    jiraAutoConnecting = true;
    console.log('Jira: auto-connecting...');

    // Таймаут на весь авто-коннект (30 секунд — Jira бывает медленной)
    let timeoutId = setTimeout(() => {
        console.warn('Jira: auto-connect timed out after 30s');
        jiraAutoConnecting = false;
        updateJiraHeaderBtn();
        const panel = document.getElementById('jiraPanel');
        if (panel && !panel.classList.contains('hidden')) renderJiraPanel();
    }, JIRA_AUTO_CONNECT_TIMEOUT);

    try {
        // Восстанавливаем epicLinkField из сохранённых настроек
        if (jiraSettings.epicLinkField) {
            jiraEpicLinkField = jiraSettings.epicLinkField;
        }

        // Тихий тест подключения (без UI-фидбека)
        const resp = await jiraSendMessage({
            type: 'testConnection',
        });

        if (resp.ok) {
            jiraConnected = true;
            console.log('Jira: connected as', resp.displayName);

            // Показываем статус в панели (если она открыта)
            const statusEl = document.getElementById('jiraStatus');
            if (statusEl) {
                statusEl.className = 'jira-status ok';
                statusEl.textContent = `✅ Подключено: ${resp.displayName}`;
            }

            // Загружаем поля, если ещё не выбрано storyPointsField
            if (!jiraSettings.storyPointsField || !jiraEpicLinkField) {
                const fieldsResp = await jiraSendMessage({
                    type: 'getFields',
                });
                if (fieldsResp.ok) {
                    // Заполняем селект полей (чтобы при открытии панели не был пустым)
                    jiraPopulateFieldSelect(fieldsResp.fields);

                    if (!jiraSettings.storyPointsField) {
                        // jiraPopulateFieldSelect уже выбрал подходящее поле,
                        // берём его из селекта
                        const select = document.getElementById('jiraFieldSelect');
                        if (select && select.value) {
                            jiraSettings.storyPointsField = select.value;
                        }
                    }
                    if (!jiraEpicLinkField) {
                        const epicField = fieldsResp.fields.find(f =>
                            f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-epic-link'
                        );
                        jiraEpicLinkField = epicField ? epicField.id : '';
                        jiraSettings.epicLinkField = jiraEpicLinkField;
                    }
                    jiraPersistSettings();
                    // Синхронизируем поля с расширением, чтобы при след. загрузке не терялись
                    jiraSendMessage({ type: 'saveSettings', ...jiraSettings });
                }
            } else {
                // Поле уже выбрано — показываем селект, если панель открыта
                if (jiraSettings.storyPointsField) {
                    showJiraFieldSelect();
                    const select = document.getElementById('jiraFieldSelect');
                    if (select && select.options.length === 0) {
                        // Селект пуст — подгрузим поля из Jira
                        const fieldsResp = await jiraSendMessage({
                            type: 'getFields',
                        });
                        if (fieldsResp.ok) {
                            jiraPopulateFieldSelect(fieldsResp.fields);
                        }
                    } else if (select) {
                        select.value = jiraSettings.storyPointsField;
                    }
                }
            }

            // Показываем дерево на экране входа
            showJiraJoinTree();
            // Загружаем задачи
            await jiraLoadIssues();
        } else {
            console.log('Jira: auto-connect failed:', resp.error);
            showJiraJoinTree(); // скрываем дерево, показываем текстовое поле
        }
    } catch (err) {
        console.error('Jira: auto-connect error:', err);
        showJiraJoinTree();
    }

    clearTimeout(timeoutId);
    jiraAutoConnecting = false;
    updateJiraHeaderBtn();
    // Если панель открыта — обновляем UI
    const panel = document.getElementById('jiraPanel');
    if (panel && !panel.classList.contains('hidden')) {
        renderJiraPanel();
    }
}

function showJiraJoinTree() {
    const container = document.getElementById('jiraJoinTreeContainer');
    const taskGroup = document.getElementById('taskGroup');
    if (!container || !taskGroup) return;

    if (jiraConnected && !state.sessionId) {
        container.style.display = 'block';
        taskGroup.style.display = 'none';
    } else {
        container.style.display = 'none';
        taskGroup.style.display = 'block';
    }
}

async function jiraRefreshJoinTree() {
    await jiraLoadIssues();
    renderJiraJoinTree();
}

function renderJiraTree(container, options = {}) {
    const { onSelect, showPriority = false, prepopulateWithEpics = false, issues = jiraIssues, emptyMessage = '— нет задач —', selectedKey = null } = options;
    if (!container) return;
    if (issues.length === 0) {
        container.innerHTML = '<div class="jira-tree-empty">' + escapeHtml(emptyMessage) + '</div>';
        return;
    }

    const groups = {};
    if (prepopulateWithEpics) {
        for (const epic of jiraEpics) {
            groups[epic.key] = { epic, children: [] };
        }
    }
    for (const issue of issues) {
        if (issue.fields?.issuetype?.name === 'Epic') continue;
        let epicKey = null;
        if (jiraEpicLinkField && issue.fields?.[jiraEpicLinkField]) {
            const epicLinkValue = issue.fields[jiraEpicLinkField];
            if (typeof epicLinkValue === 'object') {
                epicKey = epicLinkValue.key;
            } else if (typeof epicLinkValue === 'string') {
                epicKey = epicLinkValue.trim();
            }
        }
        if (!epicKey || (prepopulateWithEpics && !groups[epicKey])) {
            epicKey = '__no_epic__';
        }
        if (!groups[epicKey]) {
            groups[epicKey] = { epic: null, children: [] };
        }
        groups[epicKey].children.push(issue);
    }

    const groupKeys = Object.keys(groups).sort((a, b) => {
        if (a === '__no_epic__') return 1;
        if (b === '__no_epic__') return -1;
        return 0;
    });

    let html = '';
    for (const groupKey of groupKeys) {
        const group = groups[groupKey];
        const isNoEpic = groupKey === '__no_epic__';
        const epicName = epicMap[groupKey];
        const groupLabel = isNoEpic 
            ? '📋 Без эпика' 
            : (epicName ? `📌 ${groupKey} — ${escapeHtml(epicName)}` : `📌 ${escapeHtml(groupKey)}`);
        html += `<div class="jira-tree-group">`;
        html += `<div class="jira-tree-epic" onclick="toggleJiraTreeGroup(this)">
                    <span class="jira-tree-toggle">▶</span>
                    <span class="jira-tree-epic-label">${groupLabel}</span>
                    <span class="jira-tree-count">${group.children.length}</span>
                 </div>`;
        html += `<div class="jira-tree-children">`;
        for (const issue of group.children) {
            const key = issue.key || '';
            const summary = issue.fields?.summary || '';
            const priorityIcon = showPriority && issue.fields?.priority?.iconUrl
                ? `<img src="${issue.fields.priority.iconUrl}" class="jira-tree-priority-icon" alt="${issue.fields.priority.name}" title="${issue.fields.priority.name}">`
                : '';
            const selected = key === selectedKey ? ' selected' : '';
            html += `<div class="jira-tree-item${selected}" data-key="${key}">
                        ${priorityIcon}
                        <span class="jira-tree-item-key">${key}</span>
                        <span class="jira-tree-item-summary">${escapeHtml(summary)}</span>
                     </div>`;
        }
        html += `</div></div>`;
    }
    container.innerHTML = html;

    container.querySelectorAll('.jira-tree-item').forEach(el => {
        el.addEventListener('click', () => {
            if (onSelect) onSelect(el, el.dataset.key);
        });
    });

    const selectedItem = container.querySelector('.jira-tree-item.selected');
    if (selectedItem) {
        const parentGroup = selectedItem.closest('.jira-tree-group');
        if (parentGroup) {
            parentGroup.querySelector('.jira-tree-children').classList.add('open');
            parentGroup.querySelector('.jira-tree-toggle').textContent = '▼';
        }
    } else {
        const firstGroup = container.querySelector('.jira-tree-group');
        if (firstGroup) {
            firstGroup.querySelector('.jira-tree-children').classList.add('open');
            firstGroup.querySelector('.jira-tree-toggle').textContent = '▼';
        }
    }
}

function renderJiraJoinTree() {
    renderJiraTree(document.getElementById('jiraJoinTree'), {
        onSelect: (el, key) => selectJoinJiraIssue(el, key),
        emptyMessage: 'Нет задач. Настройте JQL-фильтр в ⚡ JIRA',
    });
}

function selectJoinJiraIssue(el, key) {
    document.querySelectorAll('#jiraJoinTree .jira-tree-item').forEach(i => i.classList.remove('selected'));
    el.classList.add('selected');

    const issue = jiraIssues.find(i => i.key === key);
    if (!issue) return;

    const summary = issue.fields?.summary || '';
    const description = issue.fields?.description || '';
    const jiraUrl = jiraSettings.jiraUrl || '';
    const linked = parseJiraIssueLinks(issue);
    
    // Получаем ключ эпика
    let epicKey = '';
    if (jiraEpicLinkField && issue.fields?.[jiraEpicLinkField]) {
        const ev = issue.fields[jiraEpicLinkField];
        epicKey = typeof ev === 'string' ? ev : (ev?.key || '');
    }
    
    // Сохраняем полную информацию о задаче как currentJiraIssue
    currentJiraIssue = {
        key: key,
        epicKey: epicKey,
        summary: summary,
        description: description,
        url: `${jiraUrl}/browse/${key}`,
        jiraUrl: jiraUrl,
        linked: linked
    };
    jiraSelectedIssue = key;
    
    // Формируем полный JSON для передачи через сервер
    const jiraData = JSON.stringify({
        type: 'jira',
        key: key,
        epicKey: epicKey,
        summary: summary,
        description: description,
        url: currentJiraIssue.url,
        jiraUrl: jiraUrl,
        linked: linked
    });
    const taskValue = `__JIRA__${jiraData}`;
    document.getElementById('taskText').value = taskValue;

    // Если username заполнен — показываем кнопку "СОЗДАТЬ КОМНАТУ"
    const username = document.getElementById('username').value.trim() || state.username;
    if (username) {
        toast.info(`Выбрана задача ${key}. Нажмите «▸ СОЗДАТЬ КОМНАТУ»`, 'JIRA');
    }
}

// ==================== JIRA ISSUES (внутри сессии) ====================
async function jiraLoadIssues() {
    // Настройки могли появиться после загрузки страницы — спрашиваем расширение,
    // прежде чем отказывать. Раньше отказ был окончательным до перезагрузки вкладки.
    if (!jiraSettings.configured && !await jiraRefreshSettings()) {
        toast.warning(jiraAccessError || 'Сначала укажите адрес Jira и токен в popup расширения');
        return;
    }

    const btn = document.getElementById('jiraLoadBtn');
    const statusEl = document.getElementById('jiraSessionStatus');
    btn.disabled = true;
    btn.textContent = '⏳ ЗАГРУЗКА...';
    statusEl.className = 'jira-status';
    statusEl.textContent = '';

    const jql = jiraSettings.jiraFilter || 'assignee = currentUser() AND resolution = Unresolved ORDER BY priority DESC';

    // Пробуем получить имя эпика сразу через специальные поля
    let additionalFields = 'summary,description,issuetype,priority,project,issuelinks';
    if (jiraEpicLinkField) {
        additionalFields += ',' + jiraEpicLinkField;
        // Пробуем добавить поля эпика (работает в Jira Software)
        additionalFields += ',epic-name,epic-color';
    }

    console.log('[Jira] JQL filter used:', jql);

    const resp = await jiraSendMessage({
        type: 'searchIssues',
        jql,
        maxResults: 50,
        fields: additionalFields,
    });

    console.log('[Jira] searchIssues response:', resp.ok ? `OK (${(resp.issues || []).length} issues)` : `ERROR: ${resp.error}`);

    if (!resp.ok) {
        btn.disabled = false;
        btn.textContent = '🔄 ЗАГРУЗИТЬ ЗАДАЧИ';
        statusEl.className = 'jira-status err';
        statusEl.textContent = `❌ ${resp.error}`;
        jiraIssues = [];
        jiraEpics = [];
        epicMap = {};
        renderJiraIssueTree();
        renderJiraJoinTree();
        showJiraJoinTree();
        return;
    }

    // Собираем уникальные ключи эпиков
    const epicKeys = new Set();
    if (jiraEpicLinkField) {
        for (const issue of resp.issues) {
            const epicLinkValue = issue.fields?.[jiraEpicLinkField];
            if (epicLinkValue) {
                const epicKey = typeof epicLinkValue === 'string' ? epicLinkValue : (epicLinkValue?.key || '');
                if (epicKey) {
                    epicKeys.add(epicKey);
                }
            }
        }
    }

    // Запрашиваем ВСЕ эпики ОДИН РАЗ через key in (...)
    epicMap = {};
    const epicKeysList = Array.from(epicKeys);
    
    if (epicKeysList.length > 0) {
        // Формируем JQL: key in ("E077-6863", "E077-1234", ...)
        const epicJql = `key in (${epicKeysList.map(k => `"${k}"`).join(', ')})`;
        
        const epicResp = await jiraSendMessage({
            type: 'searchIssues',
            jql: epicJql,
            maxResults: 100,
            fields: 'summary,issuetype'
        });
        
        if (epicResp.ok && epicResp.issues) {
            for (const epic of epicResp.issues) {
                const summary = epic.fields?.summary || epic.key;
                epicMap[epic.key] = summary;
            }
        }
        
        // Для эпиков, которые не нашлись, используем ключ
        for (const epicKey of epicKeysList) {
            if (!epicMap[epicKey]) {
                epicMap[epicKey] = epicKey;
            }
        }
    }

    let epicIssues = [];

    btn.disabled = false;
    btn.textContent = '🔄 ЗАГРУЗИТЬ ЗАДАЧИ';

    if (resp.ok) {
        const allIssues = [...epicIssues, ...(resp.issues || [])];
        const seen = new Set();
        jiraIssues = [];
        for (const issue of allIssues) {
            if (!seen.has(issue.key)) {
                seen.add(issue.key);
                jiraIssues.push(issue);
            }
        }
        jiraEpics = jiraIssues.filter(i => i.fields?.issuetype?.name === 'Epic');

        renderJiraIssueTree();
        if (jiraIssues.length === 0) {
            statusEl.className = 'jira-status';
            statusEl.textContent = 'Нет задач по вашему JQL-фильтру';
        } else {
            const name = jiraSettings.jiraUrl.replace(/https?:\/\//, '').split('.')[0];
            statusEl.className = 'jira-status ok';
            statusEl.textContent = `✅ ${jiraIssues.length} задач, ${jiraEpics.length} эпиков из ${name}`;
        }
        // Обновляем дерево на экране входа
        renderJiraJoinTree();
        showJiraJoinTree();
    } else {
        statusEl.className = 'jira-status err';
        statusEl.textContent = `❌ ${resp.error}`;
        jiraIssues = [];
        jiraEpics = [];
        renderJiraIssueTree();
        renderJiraJoinTree();
        // Всё равно показываем дерево (с сообщением об ошибке), если Jira подключена
        showJiraJoinTree();
    }
}

function renderJiraIssueTree() {
    const container = document.getElementById('jiraIssueTree');
    if (!container) return;
    document.getElementById('jiraSessionActions').style.display = jiraIssues.length > 0 ? 'block' : 'none';
    renderJiraTree(container, {
        onSelect: (el, key) => selectJiraTreeIssue(el, key),
        showPriority: true,
        selectedKey: jiraSelectedIssue,
        emptyMessage: '— нет задач —',
    });
    if (!jiraSelectedIssue || !jiraIssues.find(i => i.key === jiraSelectedIssue)) {
        const firstItem = container.querySelector('.jira-tree-item');
        if (firstItem) {
            selectJiraTreeIssue(firstItem, firstItem.dataset.key);
        }
    }
}

function toggleJiraTreeGroup(el) {
    const children = el.parentElement.querySelector('.jira-tree-children');
    const toggle = el.querySelector('.jira-tree-toggle');
    const isOpen = children.classList.contains('open');
    children.classList.toggle('open');
    toggle.textContent = isOpen ? '▶' : '▼';
}

function selectJiraTreeIssue(el, key) {
    document.querySelectorAll('.jira-tree-item').forEach(i => i.classList.remove('selected'));
    el.classList.add('selected');
    jiraSelectedIssue = key;
    document.getElementById('jiraSessionActions').style.display = 'block';
    const issue = jiraIssues.find(i => i.key === key);
    if (issue) {
        showJiraIssuePreview(issue);
    }
}

function showJiraIssuePreview(issue) {
    const preview = document.getElementById('jiraIssuePreview');
    if (!preview) return;
    const summary = issue.fields?.summary || '';
    const description = issue.fields?.description || '';
    const key = issue.key || '';
    const url = `${jiraSettings.jiraUrl}/browse/${key}`;
    const linked = parseJiraIssueLinks(issue);

    let linkedHtml = '';
    if (linked.length > 0) {
        linkedHtml = '<div class="jira-preview-links"><div class="jira-preview-links-title">🔗 Связанные задачи:</div>' +
            linked.map(l => {
                const linkUrl = `${jiraSettings.jiraUrl}/browse/${l.key}`;
                return `<div class="jira-preview-link-item">
                    <span class="jira-preview-link-direction">${escapeHtml(l.direction)}</span>
                    <a href="${linkUrl}" target="_blank" class="jira-preview-link-key">${escapeHtml(l.key)}</a>
                    <span class="jira-preview-link-summary">${escapeHtml(l.summary)}</span>
                </div>`;
            }).join('') + '</div>';
    }

    preview.innerHTML = `
        <div class="jira-preview-header">
            <a href="${url}" target="_blank" class="jira-preview-link">${key}</a>
            <span class="jira-preview-summary">${escapeHtml(summary)}</span>
        </div>
        ${description ? `<div class="jira-preview-desc">${parseJiraDescription(description)}</div>` : ''}
        ${linkedHtml}
    `;
    preview.style.display = 'block';
}

function parseJiraIssueLinks(issue) {
    const links = issue.fields?.issuelinks || [];
    const result = [];
    for (const link of links) {
        const type = link.type || {};
        if (link.inwardIssue && link.inwardIssue.key !== issue.key) {
            result.push({
                key: link.inwardIssue.key,
                summary: link.inwardIssue.fields?.summary || '',
                direction: type.inward || 'relates to',
                status: link.inwardIssue.fields?.status?.name || '',
                duedate: link.inwardIssue.fields?.duedate || '',
            });
        }
        if (link.outwardIssue && link.outwardIssue.key !== issue.key) {
            result.push({
                key: link.outwardIssue.key,
                summary: link.outwardIssue.fields?.summary || '',
                direction: type.outward || 'relates to',
                status: link.outwardIssue.fields?.status?.name || '',
                duedate: link.outwardIssue.fields?.duedate || '',
            });
        }
    }
    return result;
}

function formatLinkedIssues(linked, jiraBaseUrl) {
    if (!linked || linked.length === 0) return '';
    
    const baseUrl = jiraBaseUrl || jiraSettings?.jiraUrl || '';
    
    // Группируем по типу связи
    const groups = {};
    for (const link of linked) {
        const dir = link.direction || 'relates to';
        if (!groups[dir]) groups[dir] = [];
        groups[dir].push(link);
    }
    
    // Цвета для статусов (Jira-like)
    const statusColors = {
        'done': { bg: 'rgba(74,222,128,0.15)', text: '#4ade80', border: 'rgba(74,222,128,0.3)' },
        'closed': { bg: 'rgba(74,222,128,0.15)', text: '#4ade80', border: 'rgba(74,222,128,0.3)' },
        'resolved': { bg: 'rgba(74,222,128,0.15)', text: '#4ade80', border: 'rgba(74,222,128,0.3)' },
        'in progress': { bg: 'rgba(96,165,250,0.15)', text: '#60a5fa', border: 'rgba(96,165,250,0.3)' },
        'in review': { bg: 'rgba(251,191,36,0.15)', text: '#fbbf24', border: 'rgba(251,191,36,0.3)' },
        'open': { bg: 'rgba(192,132,252,0.15)', text: '#c084fc', border: 'rgba(192,132,252,0.3)' },
        'to do': { bg: 'rgba(156,163,175,0.1)', text: '#9ca3af', border: 'rgba(156,163,175,0.2)' },
        'backlog': { bg: 'rgba(107,114,128,0.1)', text: '#6b7280', border: 'rgba(107,114,128,0.2)' },
    };
    function getStatusColors(status) {
        return statusColors[(status || '').toLowerCase()] || { bg: 'var(--bg-input)', text: 'var(--text-secondary)', border: 'var(--border)' };
    }
    
    let html = '<div style="margin-top: 8px; border-top: 1px solid var(--border);">';
    html += '<div style="font-size: 0.8em; color: var(--text-secondary); padding: 6px 0 4px; letter-spacing: 1px; text-transform: uppercase;">🔄 Связанные задачи</div>';
    html += '<div style="max-height: 120px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--border) transparent; padding-right: 4px;">';
    
    for (const [direction, items] of Object.entries(groups)) {
        html += `<div style="margin: 2px 0 1px; font-size: 0.75em; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.8;">${escapeHtml(direction)}</div>`;
        for (const item of items) {
            const linkUrl = baseUrl ? `${baseUrl}/browse/${item.key}` : '#';
            const sc = getStatusColors(item.status);
            
            let dateHtml = '';
            if (item.duedate) {
                const isOverdue = item.duedate && new Date(item.duedate) < new Date() && item.status?.toLowerCase() !== 'done' && item.status?.toLowerCase() !== 'closed';
                dateHtml = `<span style="font-size: 0.8em; color: ${isOverdue ? '#ef4444' : 'var(--text-secondary)'}; flex-shrink: 0;">${isOverdue ? '⚠ ' : '📅 '}${item.duedate}</span>`;
            }
            
            html += `<div style="display: flex; align-items: center; gap: 5px; padding: 2px 0;">
                <a href="${linkUrl}" target="_blank" style="color: var(--accent); font-weight: 600; text-decoration: none; font-family: var(--font-mono); font-size: 0.85em; flex-shrink: 0;">${escapeHtml(item.key)}</a>
                <span style="color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.85em; min-width: 0;">${escapeHtml(item.summary)}</span>
                ${item.status ? `<span style="display: inline-block; padding: 1px 8px; border-radius: 3px; font-size: 0.78em; font-weight: 600; flex-shrink: 0; background: ${sc.bg}; color: ${sc.text}; border: 1px solid ${sc.border};">${escapeHtml(item.status)}</span>` : ''}
                ${dateHtml}
            </div>`;
        }
    }
    
    html += '</div></div>';
    return html;
}



function jiraApplyTask() {
    if (!jiraSelectedIssue) return;
    const issue = jiraIssues.find(i => i.key === jiraSelectedIssue);
    if (!issue) return;

    const summary = issue.fields?.summary || '';
    const description = issue.fields?.description || '';
    const taskValue = `[${issue.key}] ${summary}`;
    const issueUrl = `${jiraSettings.jiraUrl}/browse/${issue.key}`;
    const taskHtml = `<a href="${issueUrl}" target="_blank" class="task-jira-link">${escapeHtml(issue.key)}</a> ${escapeHtml(summary)}`;

    if (state.sessionId) {
        jiraSelectedIssue = issue.key;
        document.getElementById('taskDisplay').innerHTML = taskHtml;
        document.getElementById('taskDisplay').dataset.jiraDesc = description;
        updateTaskDescriptionWithJira(description, parseJiraIssueLinks(issue));
        toggleJiraPanel();
        jiraSendEstimate();
        return;
    }

    document.getElementById('taskText').value = taskValue;
    toggleJiraPanel();

    const username = document.getElementById('username').value.trim() || state.username;
    const sessionId = document.getElementById('sessionId').value.trim();

    if (!username) {
        toast.success(`Задача ${issue.key} подставлена в описание`, 'JIRA');
        document.getElementById('username').focus();
        return;
    }

    if (sessionId) {
        toast.success(`Задача ${issue.key} подставлена. Нажмите «▸ ВОЙТИ В КОМНАТУ»`, 'JIRA');
        return;
    }

    document.getElementById('username').value = username;
    joinOrCreateSession();
}

function updateTaskDescriptionWithJira(description, linked = []) {
    const taskDisplay = document.getElementById('taskDisplay');
    let descEl = document.getElementById('taskJiraDesc');
    if (!descEl) {
        descEl = document.createElement('div');
        descEl.id = 'taskJiraDesc';
        descEl.className = 'task-jira-desc';
        taskDisplay.parentElement.appendChild(descEl);
    }

    let html = '';
    if (description) {
        html += '<div class="task-jira-desc-text">' + parseJiraDescription(description) + '</div>';
    }
    if (linked.length > 0) {
        html += '<div class="task-jira-links">' +
            linked.map(l => {
                const linkUrl = `${jiraSettings.jiraUrl}/browse/${l.key}`;
                return `<div class="task-jira-link-item">
                    <span class="task-jira-link-direction">${escapeHtml(l.direction)}</span>
                    <a href="${linkUrl}" target="_blank" class="task-jira-link-key">${escapeHtml(l.key)}</a>
                    <span class="task-jira-link-summary">${escapeHtml(l.summary)}</span>
                </div>`;
            }).join('') +
        '</div>';
    }
    descEl.innerHTML = html;
    descEl.style.display = html ? 'block' : 'none';
}

async function jiraSendEstimate() {
    // Настройки могли появиться после загрузки страницы — переспрашиваем расширение,
    // прежде чем отказать. Иначе отказ был окончательным до перезагрузки вкладки.
    if (!jiraSettings.configured) await jiraRefreshSettings();

    if (!jiraSettings.configured || !jiraSettings.storyPointsField) {
        toast.warning(jiraAccessError || 'Сначала укажите адрес Jira, токен и поле Story Points');
        toggleJiraPanel();
        return;
    }

    if (!jiraSelectedIssue && !currentJiraIssue?.key) return;
    const issueKey = jiraSelectedIssue || currentJiraIssue.key;

    const rawValue = document.getElementById('resultValue').textContent.trim();
    const value = parseFloat(rawValue);
    if (isNaN(value) || value <= 0) {
        toast.warning('Введите корректное число в поле результата');
        return;
    }

    const btn = document.getElementById('jiraSendBtn');
    btn.classList.add('sending');
    btn.textContent = '⏳ ОТПРАВКА...';

    const resp = await jiraSendMessage({
        type: 'setEstimate',
        issueKey: issueKey,
        fieldId: jiraSettings.storyPointsField,
        value,
    });

    btn.classList.remove('sending');
    btn.textContent = '⚡ ОТПРАВИТЬ В JIRA';

    if (resp.ok) {
        toast.success(`Оценка ${value} отправлена в ${issueKey}`, 'JIRA');
        setTimeout(() => jiraLoadIssues(), 2000);
    } else {
        const errMsg = typeof resp.error === 'string' ? resp.error : JSON.stringify(resp.error);
        // Если ошибка про поле, подсказываем пользователю
        if (errMsg.includes('cannot be set') || errMsg.includes('not on the appropriate screen')) {
            toast.error(
                `Поле Story Points (${jiraSettings.storyPointsField}) недоступно для этой задачи. Выберите другое поле в ⚡ JIRA`,
                'JIRA'
            );
            // Открываем панель Jira чтобы пользователь мог выбрать поле
            if (document.getElementById('jiraPanel').classList.contains('hidden')) {
                toggleJiraPanel();
            }
            document.getElementById('jiraFieldGroup').style.display = 'block';
        } else {
            toast.error(errMsg || 'Ошибка отправки в Jira', 'JIRA');
        }
        console.error('[Jira] Send estimate error:', resp);
    }
}

// ==================== JIRA NEW TASK MODAL ====================
let _newTaskModalSelected = null;

function openNewTaskModal() {
    const modal = document.getElementById('newTaskModal');
    if (!modal) return;

    // Обновляем данные задач перед открытием
    jiraLoadIssues().then(() => {
        modal.classList.remove('hidden');
        _newTaskModalSelected = null;
        document.getElementById('newTaskApplyBtn').disabled = true;

        const search = document.getElementById('newTaskSearch');
        if (search) {
            search.value = '';
            search.focus();
        }
        renderNewTaskTree();
    });
}

// Рисует дерево окна выбора с учётом строки поиска.
// Отдельная функция, потому что дерево перерисовывается на каждое нажатие клавиши.
function renderNewTaskTree() {
    const treeContainer = document.getElementById('newTaskTree');
    if (!treeContainer) return;

    const search = document.getElementById('newTaskSearch');
    const query = search ? search.value : '';
    const filtered = filterJiraIssues(jiraIssues, query, epicMap, jiraEpicLinkField);

    renderJiraTree(treeContainer, {
        onSelect: (el, key) => selectNewTaskTreeItem(el, key),
        issues: filtered,
        emptyMessage: query.trim()
            ? 'Ничего не найдено. Попробуйте другой запрос'
            : 'Нет задач. Нажмите 🔄 ОБНОВИТЬ',
    });

    // При поиске разворачиваем группы: иначе найденное прячется за свёрнутым эпиком
    if (query.trim()) {
        treeContainer.querySelectorAll('.jira-tree-children').forEach(el => el.classList.add('open'));
        treeContainer.querySelectorAll('.jira-tree-toggle').forEach(el => { el.textContent = '▼'; });
    }

    treeContainer.querySelectorAll('.jira-tree-item').forEach(el => {
        el.addEventListener('dblclick', () => {
            const key = el.dataset.key;
            if (key) applyNewTaskFromModal();
        });
    });

    updateNewTaskSearchCount(filtered.length, jiraIssues.length, query);

    // Автовыбор первого элемента: с поиском из одной задачи выбирать вручную незачем
    setTimeout(() => {
        const firstItem = treeContainer.querySelector('.jira-tree-item');
        if (firstItem) firstItem.click();
    }, 100);
}

function updateNewTaskSearchCount(shown, total, query) {
    const el = document.getElementById('newTaskSearchCount');
    if (!el) return;
    if (!query.trim() || total === 0) {
        el.textContent = '';
        return;
    }
    el.textContent = `Найдено ${shown} из ${total} ${pluralTasks(total)}`;
}

function pluralTasks(n) {
    const tail = n % 100;
    if (tail >= 11 && tail <= 14) return 'задач';
    switch (n % 10) {
        case 1: return 'задачи';
        case 2:
        case 3:
        case 4: return 'задач';
        default: return 'задач';
    }
}

// Поиск идёт по уже загруженным задачам, поэтому перерисовка мгновенна
// и придерживать ввод таймером незачем.
function onNewTaskSearchInput() {
    renderNewTaskTree();
}

function closeNewTaskModal() {
    document.getElementById('newTaskModal').classList.add('hidden');
    document.getElementById('newTaskPreview').style.display = 'none';
    _newTaskModalSelected = null;
}

async function jiraRefreshIssuesForModal() {
    const btn = document.getElementById('newTaskRefreshBtn');
    btn.disabled = true;
    btn.textContent = '⏳';
    await jiraLoadIssues();
    btn.disabled = false;
    btn.textContent = '🔄 ОБНОВИТЬ';
    // Перерисовываем через тот же путь, что и поиск: иначе обновление сбрасывало
    // введённый запрос и показывало все задачи заново
    renderNewTaskTree();
}

async function applyNewTaskFromModal() {
    if (!_newTaskModalSelected) return;
    const issue = jiraIssues.find(i => i.key === _newTaskModalSelected);
    if (!issue) return;

    const key = issue.key;
    const summary = issue.fields?.summary || '';
    const description = issue.fields?.description || '';
    const jiraUrl = jiraSettings.jiraUrl;
    const linked = parseJiraIssueLinks(issue);
    
    // Получаем ключ эпика
    let epicKey = '';
    if (jiraEpicLinkField && issue.fields?.[jiraEpicLinkField]) {
        const ev = issue.fields[jiraEpicLinkField];
        epicKey = typeof ev === 'string' ? ev : (ev?.key || '');
    }
    
    // Сохраняем информацию о задаче
    currentJiraIssue = {
        key: key,
        epicKey: epicKey,
        summary: summary,
        description: description,
        url: `${jiraUrl}/browse/${key}`,
        linked: linked
    };
    
    // Устанавливаем выбранную задачу для отправки в Jira
    jiraSelectedIssue = key;

    closeNewTaskModal();

    // Формируем JSON для передачи всем участникам через сервер
    const jiraData = JSON.stringify({
        type: 'jira',
        key: key,
        epicKey: epicKey,
        summary: summary,
        description: description,
        url: currentJiraIssue.url,
        jiraUrl: jiraUrl,
        linked: linked
    });
    const newText = `__JIRA__${jiraData}`;
    
    // Обновляем taskDisplay и сбрасываем голосование
    await restartSession(newText);
}


function selectNewTaskTreeItem(el, key) {
    document.querySelectorAll('#newTaskTree .jira-tree-item').forEach(i => i.classList.remove('selected'));
    el.classList.add('selected');
    _newTaskModalSelected = key;
    document.getElementById('newTaskApplyBtn').disabled = false;
}

// Глобальная функция для модалки (используется в onclick)
function closeConfirmModal(result) {
    confirmDialog.close(result);
}

// ========================================================================
// MODULE 4: SCALES — Scale Selector, Custom Scale Editor, Join Screen
// ========================================================================

// ==================== JOIN SCREEN HELPERS ====================
let SERVER_SCALE_NAMES = {};       // populated from server: {custom: "Custom", fibonacci: "Fibonacci", ...}
let CURRENT_SCALE_NAME = localStorage.getItem('pp_last_scale') || "custom";  // current scale for this session
const SPECIAL_POINTS = ["❔", "☕"];

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function saveRecentRoom(sessionId, taskText) {
    let recent = JSON.parse(localStorage.getItem('pp_recent_rooms') || '[]');
    recent = recent.filter(r => r.id !== sessionId);
    recent.unshift({
        id: sessionId,
        task: taskText || 'Без описания',
        time: Date.now()
    });
    recent = recent.slice(0, MAX_RECENT_ROOMS);
    localStorage.setItem('pp_recent_rooms', JSON.stringify(recent));
}

function loadRecentRooms() {
    try {
        return JSON.parse(localStorage.getItem('pp_recent_rooms') || '[]');
    } catch {
        return [];
    }
}

function formatRecentTime(timestamp) {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    
    if (minutes < 1) return 'только что';
    if (minutes < 60) return `${minutes} мин. назад`;
    if (hours < 24) return `${hours} ч. назад`;
    if (days < 7) return `${days} дн. назад`;
    return new Date(timestamp).toLocaleDateString('ru-RU');
}

function renderRecentRooms() {
    const recent = loadRecentRooms();
    const container = document.getElementById('recentRooms');
    const list = document.getElementById('recentList');
    const clearBtn = document.getElementById('clearRecentBtn');
    
    if (!recent.length) {
        clearBtn.style.display = 'none';
        list.innerHTML = '<div class="recent-empty">Здесь появятся ваши последние комнаты</div>';
        return;
    }
    
    clearBtn.style.display = 'inline-block';
    
    // Если имя есть — кнопка "▸ ВОЙТИ" (быстрый вход), иначе "ВОЙТИ"
    const hasUsername = !!state.username;
    
    list.innerHTML = recent.map(room => `
        <div class="recent-item" onclick="joinRecentRoom('${room.id}')">
            <div class="recent-info">
                <div class="recent-id">⟁ ${room.id}</div>
                <div class="recent-task">${escapeHtml(room.task)}</div>
            </div>
            <div class="recent-time">${formatRecentTime(room.time)}</div>
            <button class="recent-enter">${hasUsername ? '▸ ВОЙТИ' : 'ВОЙТИ'}</button>
        </div>
    `).join('');
}

// ✅ Новая функция очистки истории
async function clearRecentRooms() {
    const confirmed = await confirmDialog.show(
        'Вся история последних комнат будет удалена без возможности восстановления.',
        'ОЧИСТКА ИСТОРИИ',
        'ОЧИСТИТЬ',
        'ОТМЕНА'
    );
    if (!confirmed) return;
    
    localStorage.removeItem('pp_recent_rooms');
    renderRecentRooms();
    toast.info('История комнат очищена');
}

function joinRecentRoom(sessionId) {
    // Если у пользователя уже есть идентификатор — сразу подключаемся к комнате
    if (state.username) {
        document.getElementById('sessionId').value = sessionId;
        document.getElementById('taskGroup').style.display = 'none';
        joinOrCreateSession();
    } else {
        // Если имени ещё нет — подставляем ID и просим ввести имя
        document.getElementById('sessionId').value = sessionId;
        toggleTaskField();
        document.getElementById('username').focus();
        document.getElementById('username').scrollIntoView({ behavior: 'smooth', block: 'center' });
        toast.info('Введите идентификатор и нажмите ИНИЦИАЛИЗИРОВАТЬ', 'ПОДКЛЮЧЕНИЕ');
    }
}

function renderScalePoints(scaleName) {
    const container = document.getElementById('scalePoints');
    if (!container) return;
    // Use SERVER_SCALES if available, else fallback
    const scales = typeof SERVER_SCALES !== 'undefined' ? SERVER_SCALES : null;
    let points;
    if (scales && scaleName && scales[scaleName]) {
        points = scales[scaleName];
    } else {
        points = (typeof SERVER_AVAILABLE_POINTS !== 'undefined' ? SERVER_AVAILABLE_POINTS : ["1","2","3","5","8","13","21","❔","☕"]);
    }
    container.innerHTML = points.map(point => {
        const isSpecial = SPECIAL_POINTS.includes(point);
        return `<div class="scale-point ${isSpecial ? 'special' : ''}">${point}</div>`;
    }).join('');
}

// Сводка шкалы на экране входа: название и число значений вместо всего блока
function renderJoinScaleSelector() {
    const summary = document.getElementById('joinScaleSummary');
    if (summary) {
        summary.textContent = describeScale(CURRENT_SCALE_NAME, scalePointsFor(CURRENT_SCALE_NAME));
    }
    // Окно настроек может быть открыто прямо сейчас — держим его в согласии
    if (isScaleSettingsOpen()) renderScaleSettings();
}

// Название шкалы и число значений: «Fibonacci · 9 значений»
function describeScale(scaleName, points) {
    const names = typeof SERVER_SCALE_NAMES !== 'undefined' ? SERVER_SCALE_NAMES : {};
    const label = (names && names[scaleName]) || scaleName || '—';
    const count = (points || []).length;
    return `${label} · ${count} ${pluralValues(count)}`;
}

function pluralValues(n) {
    const tail = n % 100;
    if (tail >= 11 && tail <= 14) return 'значений';
    switch (n % 10) {
        case 1: return 'значение';
        case 2:
        case 3:
        case 4: return 'значения';
        default: return 'значений';
    }
}

// Значения выбранной шкалы. Один источник для сводки, превью и окна настроек.
function scalePointsFor(scaleName) {
    const scales = typeof SERVER_SCALES !== 'undefined' ? SERVER_SCALES : null;
    if (scales && scaleName && scales[scaleName]) return scales[scaleName];
    return typeof SERVER_AVAILABLE_POINTS !== 'undefined'
        ? SERVER_AVAILABLE_POINTS
        : ['1', '2', '3', '5', '8', '13', '21', '❔', '☕'];
}

function onJoinScaleClick(scaleName) {
    CURRENT_SCALE_NAME = scaleName;
    localStorage.setItem('pp_last_scale', scaleName);
    renderJoinScaleSelector();
    renderScalePoints(scaleName);
}

// ==================== ОКНО НАСТРОЕК ШКАЛЫ ====================
//
// Выбор вида, значения и переход в редактор Custom вынесены из обоих экранов сюда:
// на экране входа длинная шкала растягивала страницу, а в комнате ряд кнопок
// занимал панель управления.
//
// Контекст решает, куда уходит выбор: 'join' — только в этот браузер (комнаты ещё нет),
// 'session' — на сервер, всей комнате.
let scaleSettingsContext = 'join';

function isScaleSettingsOpen() {
    const modal = document.getElementById('scaleSettingsModal');
    return Boolean(modal) && !modal.classList.contains('hidden');
}

function openScaleSettings(context = 'join') {
    const modal = document.getElementById('scaleSettingsModal');
    if (!modal) return;
    scaleSettingsContext = context;
    renderScaleSettings();
    modal.classList.remove('hidden');
    modal.focus();
}

function closeScaleSettings() {
    const modal = document.getElementById('scaleSettingsModal');
    if (modal) modal.classList.add('hidden');
}

// Какая шкала выбрана сейчас — в комнате её задаёт сессия, на входе локальный выбор
function currentScaleName() {
    if (scaleSettingsContext === 'session' && state.session && state.session.scale_name) {
        return state.session.scale_name;
    }
    return CURRENT_SCALE_NAME;
}

function renderScaleSettings() {
    const buttons = document.getElementById('scaleSettingsButtons');
    const points = document.getElementById('scaleSettingsPoints');
    const hint = document.getElementById('scaleSettingsHint');
    if (!buttons || !points) return;

    const inSession = scaleSettingsContext === 'session';
    const names = (inSession && state.session && state.session.scale_names) || SERVER_SCALE_NAMES || {};
    const selected = currentScaleName();

    const entries = Object.entries(names).sort((a, b) => {
        if (a[0] === 'custom') return 1;
        if (b[0] === 'custom') return -1;
        return 0;
    });

    buttons.innerHTML = entries.map(([key, label]) => {
        const active = key === selected ? ' active' : '';
        return `<button class="scale-btn${active}" data-scale="${escapeHtml(key)}">${escapeHtml(label)}</button>`;
    }).join('') + (names.custom !== undefined
        ? '<button class="scale-edit-btn visible" id="scaleSettingsEditBtn" title="Редактировать пользовательскую шкалу">✏️</button>'
        : '');

    points.innerHTML = scalePointsFor(selected).map(point => {
        const isSpecial = SPECIAL_POINTS.includes(point);
        return `<div class="scale-point ${isSpecial ? 'special' : ''}">${escapeHtml(point)}</div>`;
    }).join('');

    if (hint) {
        hint.textContent = inSession
            ? 'Смена шкалы сбрасывает голоса и видна всей команде.'
            : 'Выбор запомнится в этом браузере и применится к новой комнате.';
    }
}

function onScaleSettingsClick(event) {
    const editBtn = event.target.closest('#scaleSettingsEditBtn');
    if (editBtn) {
        openCustomScaleEditor();
        return;
    }
    const btn = event.target.closest('.scale-btn');
    if (!btn) return;

    const scaleName = btn.dataset.scale;
    if (scaleSettingsContext === 'session') {
        setScale(scaleName);
    } else {
        onJoinScaleClick(scaleName);
    }
    renderScaleSettings();
}

// В комнате — та же сводка: название шкалы и кнопка, открывающая окно настроек
function renderSessionScaleSelector(session) {
    const container = document.getElementById('sessionScaleSelector');
    const summary = document.getElementById('sessionScaleSummary');
    if (!container || !summary) return;

    const scaleNames = session.scale_names || SERVER_SCALE_NAMES || {};
    if (Object.keys(scaleNames).length <= 1) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'flex';
    const label = scaleNames[session.scale_name] || session.scale_name || '—';
    const count = (session.available_points || scalePointsFor(session.scale_name)).length;
    summary.textContent = `📐 ${label} · ${count} ${pluralValues(count)}`;

    // Шкалу могли сменить с другого места — окно, если открыто, должно это показать
    if (isScaleSettingsOpen() && scaleSettingsContext === 'session') renderScaleSettings();
}

// ==================== CUSTOM SCALE EDITOR ====================
let customScaleBuffer = [];

function openCustomScaleEditor() {
    const modal = document.getElementById('scaleEditorModal');
    if (!modal) return;

    // Load current custom points: first try from saved, then fall back to SERVER_SCALES.custom
    customScaleBuffer = [...(getCurrentCustomPoints())];
    renderCustomScaleEditorList();
    modal.classList.remove('hidden');
    document.getElementById('scaleEditorNewPoint').focus();
}

function closeCustomScaleEditor() {
    document.getElementById('scaleEditorModal').classList.add('hidden');
}

function getCurrentCustomPoints() {
    if (typeof SERVER_SCALES !== 'undefined' && SERVER_SCALES && SERVER_SCALES.custom) {
        // Filter out special points
        return SERVER_SCALES.custom.filter(p => !SPECIAL_POINTS.includes(p));
    }
    return ['1', '2', '3', '5', '8', '13', '21'];
}

function renderCustomScaleEditorList() {
    const list = document.getElementById('scaleEditorList');
    if (!list) return;
    if (customScaleBuffer.length === 0) {
        list.innerHTML = '<div class="scale-editor-empty">Нет значений. Добавьте не меньше шести.</div>';
        return;
    }
    // Стрелки нужны, потому что значения встают в порядке ввода: добавил 64, потом
    // 48 — и карты голосования пойдут «…40, 64, 48…». Раньше поправить это можно
    // было только снеся всё после ошибки и набив заново.
    list.innerHTML = customScaleBuffer.map((point, idx) => `
        <div class="scale-editor-item">
            <span class="scale-editor-item-value">${escapeHtml(point)}</span>
            <button class="scale-editor-item-move" onclick="moveCustomPoint(${idx}, -1)"
                    title="Сдвинуть ${escapeHtml(point)} влево" ${idx === 0 ? 'disabled' : ''}>↑</button>
            <button class="scale-editor-item-move" onclick="moveCustomPoint(${idx}, 1)"
                    title="Сдвинуть ${escapeHtml(point)} вправо" ${idx === customScaleBuffer.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="scale-editor-item-remove" onclick="removeCustomPoint(${idx})" title="Удалить ${escapeHtml(point)}">✕</button>
        </div>
    `).join('');
}

// Сдвиг значения на одну позицию. shift = -1 к началу, +1 к концу.
function moveCustomPoint(idx, shift) {
    const цель = idx + shift;
    if (цель < 0 || цель >= customScaleBuffer.length) return;
    const [значение] = customScaleBuffer.splice(idx, 1);
    customScaleBuffer.splice(цель, 0, значение);
    renderCustomScaleEditorList();
}

// Те же правила, что и на сервере (web_api.SCALE_POINT_RE и MIN_SCALE_POINTS).
// Держим их и здесь, чтобы отказ приходил в момент ввода, а не после того, как
// человек набрал всю шкалу: раньше слишком длинное значение редактор молча
// принимал, а сервер отвергал шкалу целиком — и по-английски.
const SCALE_POINT_RE = /^[\p{L}\p{N}_.,:;!?+\-*/½∞❔☕ ]{1,8}$/u;
const MIN_SCALE_POINTS = 8;

function addCustomPoint() {
    const input = document.getElementById('scaleEditorNewPoint');
    const value = input.value.trim();
    if (!value) return;
    if (SPECIAL_POINTS.includes(value)) {
        toast.warning('❔ и ☕ добавляются автоматически');
        return;
    }
    if (!SCALE_POINT_RE.test(value)) {
        toast.warning('Значение: от 1 до 8 символов — буквы, цифры и . , : ; ! ? + - * /');
        return;
    }
    if (customScaleBuffer.includes(value)) {
        toast.warning('Такое значение уже есть');
        return;
    }
    customScaleBuffer.push(value);
    renderCustomScaleEditorList();
    input.value = '';
    input.focus();
}

function removeCustomPoint(idx) {
    customScaleBuffer.splice(idx, 1);
    renderCustomScaleEditorList();
}

async function saveCustomScale() {
    // Сервер считает вместе с ❔ и ☕, поэтому свои значения — минимум MIN - 2
    const нужноСвоих = MIN_SCALE_POINTS - SPECIAL_POINTS.length;
    if (customScaleBuffer.length < нужноСвоих) {
        toast.warning(`Нужно не меньше ${нужноСвоих} значений: сейчас ${customScaleBuffer.length}`);
        return;
    }

    const points = [...customScaleBuffer, ...SPECIAL_POINTS];
    const username = document.getElementById('username').value.trim() || state.username;
    if (!username) {
        toast.warning('Введите идентификатор');
        return;
    }

    try {
        const response = await fetch('/api/custom-scale', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username, points })
        });
        if (!response.ok) {
            const err = await response.json();
            toast.error(err.error || 'Ошибка сохранения');
            return;
        }

        const data = await response.json();
        // Update SERVER_SCALES.custom in memory
        if (typeof SERVER_SCALES !== 'undefined') {
            SERVER_SCALES.custom = data.points;
        }
        // Обновляем и значения, и сводку: раньше сетка уже показывала новую шкалу,
        // а подпись рядом оставалась прежней — «Custom · 20 значений» при 28 картах
        renderScalePoints('custom');
        // renderJoinScaleSelector заодно освежает открытое окно настроек
        renderJoinScaleSelector();
        closeCustomScaleEditor();
        toast.success('Пользовательская шкала сохранена');
    } catch (error) {
        toast.error(error.message, 'НЕТ СВЯЗИ');
    }
}



// ==================== SOUND MANAGER ====================
class SoundManager {
    constructor() {
        this.audioContext = null;
        this.enabled = true;
    }
    
    init() {
        if (!this.audioContext) {
            try {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            } catch (e) {
                console.warn('Web Audio API not supported');
            }
        }
    }
    
    // Звук вскрытия карт - восходящая мелодия
    playReveal() {
        if (!this.enabled || !this.audioContext) return;
        
        const now = this.audioContext.currentTime;
        const notes = [523.25, 659.25, 783.99, 1046.50];
        
        notes.forEach((freq, i) => {
            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);
            
            oscillator.frequency.value = freq;
            oscillator.type = 'sine';
            
            gainNode.gain.setValueAtTime(0, now + i * 0.1);
            gainNode.gain.linearRampToValueAtTime(0.3, now + i * 0.1 + 0.05);
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + i * 0.1 + 0.3);
            
            oscillator.start(now + i * 0.1);
            oscillator.stop(now + i * 0.1 + 0.3);
        });
    }
    
    // Звук нового голоса - короткий бип
    playVote() {
        if (!this.enabled || !this.audioContext) return;
        
        const oscillator = this.audioContext.createOscillator();
        const gainNode = this.audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(this.audioContext.destination);
        
        oscillator.frequency.value = 880;
        oscillator.type = 'sine';
        
        const now = this.audioContext.currentTime;
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(0.2, now + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
        
        oscillator.start(now);
        oscillator.stop(now + 0.15);
    }
    
    // Звук сброса - нисходящий тон
    playReset() {
        if (!this.enabled || !this.audioContext) return;
        
        const oscillator = this.audioContext.createOscillator();
        const gainNode = this.audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(this.audioContext.destination);
        
        oscillator.type = 'sawtooth';
        
        const now = this.audioContext.currentTime;
        oscillator.frequency.setValueAtTime(600, now);
        oscillator.frequency.exponentialRampToValueAtTime(200, now + 0.3);
        
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(0.15, now + 0.02);
        gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
        
        oscillator.start(now);
        oscillator.stop(now + 0.3);
    }
    
    // ✅ НОВОЕ: Звук входа - восходящий двутоновый "приветственный"
    playJoin() {
        if (!this.enabled || !this.audioContext) return;
        
        const now = this.audioContext.currentTime;
        const notes = [659.25, 880]; // E5 -> A5
        
        notes.forEach((freq, i) => {
            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);
            
            oscillator.frequency.value = freq;
            oscillator.type = 'sine';
            
            gainNode.gain.setValueAtTime(0, now + i * 0.12);
            gainNode.gain.linearRampToValueAtTime(0.18, now + i * 0.12 + 0.02);
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + i * 0.12 + 0.2);
            
            oscillator.start(now + i * 0.12);
            oscillator.stop(now + i * 0.12 + 0.2);
        });
    }
    
    // ✅ НОВОЕ: Звук выхода - нисходящий двутоновый "прощальный"
    playLeave() {
        if (!this.enabled || !this.audioContext) return;
        
        const now = this.audioContext.currentTime;
        const notes = [880, 659.25]; // A5 -> E5
        
        notes.forEach((freq, i) => {
            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);
            
            oscillator.frequency.value = freq;
            oscillator.type = 'sine';
            
            gainNode.gain.setValueAtTime(0, now + i * 0.12);
            gainNode.gain.linearRampToValueAtTime(0.18, now + i * 0.12 + 0.02);
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + i * 0.12 + 0.2);
            
            oscillator.start(now + i * 0.12);
            oscillator.stop(now + i * 0.12 + 0.2);
        });
    }
    
    setEnabled(enabled) {
        this.enabled = enabled;
        if (enabled && !this.audioContext) {
            this.init();
        }
    }
}

const soundManager = new SoundManager();

// === SESSION SCREEN — Theme, hotkeys, join/create, leave ===

function initTheme() {
    const savedTheme = localStorage.getItem('pp_theme') || 'dark';
    if (savedTheme === 'light') {
        document.body.classList.add('light-theme');
        updateThemeButton(true);
    } else {
        updateThemeButton(false);
    }
}

function toggleTheme() {
    const isLight = document.body.classList.toggle('light-theme');
    localStorage.setItem('pp_theme', isLight ? 'light' : 'dark');
    updateThemeButton(isLight);
}

function updateThemeButton(isLight) {
    document.getElementById('themeIcon').textContent = isLight ? '☾' : '☀';
    document.getElementById('themeText').textContent = isLight ? 'ТЁМНАЯ' : 'СВЕТЛАЯ';
}

function toggleSound() {
    state.soundEnabled = !state.soundEnabled;
    localStorage.setItem('pp_sound_enabled', state.soundEnabled);
    soundManager.setEnabled(state.soundEnabled);
    updateSoundButton();
    
    if (state.soundEnabled) {
        soundManager.init();
        soundManager.playVote();
    }
}

function updateSoundButton() {
    const btn = document.querySelector('.sound-btn');
    const icon = document.getElementById('soundIcon');
    const text = document.getElementById('soundText');
    
    if (!btn) return;
    
    if (state.soundEnabled) {
        btn.classList.remove('muted');
        icon.textContent = '🔊';
        if (text) text.textContent = 'ЗВУК';
    } else {
        btn.classList.add('muted');
        icon.textContent = '🔇';
        if (text) text.textContent = 'ТИХО';
    }
}

function toggleTaskField() {
    const sessionId = document.getElementById('sessionId').value.trim();
    const taskGroup = document.getElementById('taskGroup');
    const jiraTree = document.getElementById('jiraJoinTreeContainer');
    if (sessionId) {
        taskGroup.classList.add('collapsed');
        if (jiraTree) jiraTree.style.display = 'none';
    } else {
        taskGroup.classList.remove('collapsed');
        // Если Jira подключена и нет sessionId — показываем дерево
        if (jiraConnected && !state.sessionId) {
            showJiraJoinTree();
        }
    }
    updateJoinButtonText();
}

function updateJoinButtonText() {
    const btn = document.querySelector('.btn-primary');
    if (!btn) return;
    const sessionId = document.getElementById('sessionId').value.trim();
    btn.innerHTML = sessionId
        ? '▸ ВОЙТИ В КОМНАТУ'
        : '▸ СОЗДАТЬ КОМНАТУ';
}

function formatTaskText(text) {
    if (!text) return '';
    // Сначала экранируем весь текст от HTML
    let html = escapeHtml(text);
    // Потом заменяем URL на ссылки (в безопасном HTML)
    const urlRegex = /(https?:\/\/[^\s<>"']+)/g;
    html = html.replace(urlRegex, url =>
        `<a href="${url}" target="_blank" class="jira-desc-link" style="word-break: break-all;">${url}</a>`
    );
    return html;
}



function updateTaskDisplay() {
    const taskDisplay = document.getElementById('taskDisplay');
    const jiraTaskLink = document.getElementById('jiraTaskLink');
    const jiraTaskLinkUrl = document.getElementById('jiraTaskLinkUrl');
    const epicMeta = document.getElementById('epicMeta');
    const epicLinkUrl = document.getElementById('epicLinkUrl');
    if (!taskDisplay) return;
    
    // Если есть задача из Jira
    if (currentJiraIssue) {
        const { key, epicKey, summary, description, url } = currentJiraIssue;
        
        // Показываем ссылку на задачу в заголовке
        if (jiraTaskLink && jiraTaskLinkUrl) {
            jiraTaskLink.style.display = 'inline';
            jiraTaskLinkUrl.textContent = key;
            jiraTaskLinkUrl.href = url;
        }
        
        // Показываем ссылку на эпик в заголовке
        if (epicMeta && epicLinkUrl) {
            if (epicKey) {
                epicMeta.style.display = 'inline-flex';
                epicLinkUrl.textContent = epicKey;
                epicLinkUrl.href = `${currentJiraIssue.jiraUrl || jiraSettings.jiraUrl || ''}/browse/${epicKey}`;
            } else {
                epicMeta.style.display = 'none';
            }
        }
        
        // Единый блок: summary + описание скроллятся, связанные задачи прижаты к низу
        const linkedHtml = formatLinkedIssues(currentJiraIssue.linked, currentJiraIssue.jiraUrl);
        const taskHtml = `
            <div style="flex: 1; overflow-y: auto; min-height: 0; padding-right: 4px; scrollbar-width: thin; scrollbar-color: var(--border) transparent;">
                ${summary ? `<div style="font-weight: 500; margin-bottom: ${description ? '6px' : '0'}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-primary); font-size: 0.95em;">${escapeHtml(summary)}</div>` : ''}
                ${description ? `<div class="jira-description" style="color: var(--text-primary); font-size: 0.95em;">${parseJiraDescription(description)}</div>` : ''}
            </div>
            ${linkedHtml}
        `;
        
        taskDisplay.innerHTML = taskHtml;
    } else {
        // Обычный текст задачи (не Jira)
        if (jiraTaskLink) {
            jiraTaskLink.style.display = 'none';
        }
        if (epicMeta) {
            epicMeta.style.display = 'none';
        }
        taskDisplay.innerHTML = formatTaskText(currentTaskText);
    }
}

async function loadJiraIssueDescription(issueKey) {
    if (!jiraSettings.configured) return;
    
    // Проверяем, есть ли уже описание в кэше задач
    const cachedIssue = jiraIssues.find(i => i.key === issueKey);
    if (cachedIssue?.fields?.description && currentJiraIssue && currentJiraIssue.key === issueKey) {
        currentJiraIssue.description = cachedIssue.fields.description;
        updateTaskDisplay();
        console.log('[Jira] Description from cache for', issueKey);
        return;
    }
    
    try {
        const resp = await jiraSendMessage({
            type: 'searchIssues',
            jql: `key = "${issueKey}"`,
            maxResults: 1,
            fields: 'description'
        });
        
        if (resp.ok && resp.issues && resp.issues.length > 0) {
            const description = resp.issues[0].fields?.description || '';
            if (description && currentJiraIssue && currentJiraIssue.key === issueKey) {
                currentJiraIssue.description = description;
                updateTaskDisplay();
                console.log('[Jira] Loaded description for', issueKey);
            }
        }
    } catch (error) {
        console.error('[Jira] Error loading description:', error);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    updateSoundButton();

    // Инициализируем названия шкал из серверных данных
    if (typeof SERVER_SCALE_NAMES_JSON !== 'undefined') {
        SERVER_SCALE_NAMES = SERVER_SCALE_NAMES_JSON;
    }
    
    // Рендерим превью шкалы, селектор шкалы и последние комнаты
    renderJoinScaleSelector();
    renderScalePoints(CURRENT_SCALE_NAME);
    renderRecentRooms();

    // Kick-кнопки рисуются динамически, поэтому слушатель вешается на контейнер.
    // dataset автоматически декодирует HTML-сущности, возвращая исходное имя.
    const participantsList = document.getElementById('participantsList');
    if (participantsList) {
        participantsList.addEventListener('click', (e) => {
            const btn = e.target.closest('.kick-btn');
            if (btn) kickParticipant(btn.dataset.username);
            const rename = e.target.closest('.rename-btn');
            if (rename) requestRename();
        });
    }

    // Кнопки шкалы рисуются заново при каждом открытии окна — слушатель на контейнере
    const scaleSettingsButtons = document.getElementById('scaleSettingsButtons');
    if (scaleSettingsButtons) {
        scaleSettingsButtons.addEventListener('click', onScaleSettingsClick);
    }

    // ✅ Инициализируем AudioContext только если звук включен (по умолчанию)
    if (state.soundEnabled) {
        // AudioContext создается при первом клике пользователя (требование браузеров)
        document.addEventListener('click', function initAudioOnce() {
            soundManager.init();
            document.removeEventListener('click', initAudioOnce);
        }, { once: true });
    }
    soundManager.setEnabled(state.soundEnabled);

    // Проверяем расширение Jira
    if (!hasJiraExt()) {
        console.log('PP Jira Bridge extension not detected');
        showJiraJoinTree();
    } else {
        console.log('PP Jira Bridge extension detected');
        jiraRefreshSettings().then((configured) => {
            if (!configured) {
                showJiraJoinTree();
                return;
            }
            // Автоподключение с задержкой (даём service worker'у инициализироваться)
            setTimeout(() => {
                if (!jiraConnected && !jiraAutoConnecting) {
                    console.log('Jira: starting auto-connect (delayed after DOMContentLoaded)');
                    jiraAutoConnect();
                }
            }, JIRA_AUTO_CONNECT_DELAY);
        });
    }
    
    document.getElementById('username').value = state.username;
    
    const urlParams = new URLSearchParams(window.location.search);
    const sessionId = urlParams.get('session');
    if (sessionId) {
        document.getElementById('sessionId').value = sessionId;
        document.getElementById('taskGroup').classList.add('collapsed');
    }
    
    updateJoinButtonText();
    
    if (state.username && sessionId) joinOrCreateSession();
    
    // Esc закрывает верхний из открытых слоёв, Enter подтверждает поле.
    //
    // Прежде Esc знал только два окна из пяти: окно выбора задачи, настройки шкалы
    // и панель Jira приходилось закрывать мышью. Порядок здесь важен — закрываем
    // тот слой, который лежит выше: редактор шкалы открывается поверх её настроек.
    const слоиПоУбываниюГлубины = [
        ['confirmModal', () => closeConfirmModal(false)],
        ['scaleEditorModal', closeCustomScaleEditor],
        ['scaleSettingsModal', closeScaleSettings],
        ['newTaskModal', closeNewTaskModal],
    ];

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            for (const [id, закрыть] of слоиПоУбываниюГлубины) {
                const слой = document.getElementById(id);
                if (слой && !слой.classList.contains('hidden')) {
                    закрыть();
                    return;
                }
            }
            const панель = document.getElementById('jiraPanel');
            if (панель && !панель.classList.contains('hidden')) toggleJiraPanel();
            return;
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            const активное = document.activeElement;

            const новаяЗадача = document.getElementById('newTaskText');
            if (активное === новаяЗадача && новаяЗадача.value.trim()) {
                e.preventDefault();
                startNewTask();
                return;
            }

            // Экран входа: Enter в имени или в номере комнаты делает то же, что кнопка
            const наЭкранеВхода = !document.getElementById('joinScreen').classList.contains('hidden');
            if (наЭкранеВхода && (активное === document.getElementById('username')
                                  || активное === document.getElementById('sessionId'))) {
                e.preventDefault();
                joinOrCreateSession();
                return;
            }

            // Набивать шкалу по одному значению без Enter мучительно
            const новоеЗначение = document.getElementById('scaleEditorNewPoint');
            if (активное === новоеЗначение && новоеЗначение.value.trim()) {
                e.preventDefault();
                addCustomPoint();
            }
        }
    });
    
    // Редактируемый результат: при изменении значения обновляем кнопку Jira
    const resultValue = document.getElementById('resultValue');
    if (resultValue) {
        resultValue.addEventListener('input', () => {
            // Разрешаем только цифры, точку и запятую
            let val = resultValue.textContent.trim();
            // Заменяем запятую на точку
            val = val.replace(',', '.');
            // Удаляем всё кроме цифр, точки и минуса
            val = val.replace(/[^\d.-]/g, '');
            // Оставляем только одну точку
            const dotIndex = val.indexOf('.');
            if (dotIndex !== -1) {
                const beforeDot = val.substring(0, dotIndex + 1);
                const afterDot = val.substring(dotIndex + 1).replace(/\./g, '');
                // Не больше одного знака после точки
                val = beforeDot + afterDot.substring(0, 1);
            }
            resultValue.textContent = val;
            
            const btn = document.getElementById('jiraSendBtn');
            if (btn && btn.style.display !== 'none') {
                btn.textContent = val ? `⚡ ${val} → JIRA` : '⚡ В JIRA';
            }
            
            // Перемещаем курсор в конец
            const range = document.createRange();
            const sel = window.getSelection();
            range.selectNodeContents(resultValue);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        resultValue.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                resultValue.blur();
            }
        });
        resultValue.addEventListener('blur', () => {
            let val = resultValue.textContent.trim().replace(',', '.');
            if (!val) {
                resultValue.textContent = resultValue.dataset.lastValid || '0';
                return;
            }
            const num = parseFloat(val);
            if (isNaN(num) || num < 0) {
                resultValue.textContent = resultValue.dataset.lastValid || '0';
                toast.warning('Введите положительное число');
                return;
            }
            // Округляем до десятых
            const rounded = Math.round(num * 10) / 10;
            resultValue.textContent = rounded;
            resultValue.dataset.lastValid = String(rounded);
        });
    }
    
    // Горячие клавиши
    document.addEventListener('keydown', (e) => {
        // Не срабатываем если фокус на поле ввода
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
        
        const key = e.key;
        
        // 1-9 — голосование
        if (/^[1-9]$/.test(key)) {
            const pointBtn = document.querySelector(`.point-btn[data-point="${key}"]`);
            if (pointBtn) {
                pointBtn.click();
                e.preventDefault();
            }
            return;
        }
        
        // R — рестарт
        if (key === 'r' || key === 'R') {
            if (state.isInitiator) {
                restartSession();
                e.preventDefault();
            }
            return;
        }
        
        // O — открыть карты
        if (key === 'o' || key === 'O') {
            if (state.isInitiator && state.sessionId) {
                revealCards();
                e.preventDefault();
            }
            return;
        }
        
        // N — новая задача
        if (key === 'n' || key === 'N') {
            if (state.isInitiator) {
                toggleNewTaskInput();
                e.preventDefault();
            }
            return;
        }
        
        // J — отправить в Jira
        if (key === 'j' || key === 'J') {
            if (state.isInitiator && document.getElementById('jiraSendBtn').style.display !== 'none') {
                jiraSendEstimate();
                e.preventDefault();
            }
            return;
        }
    });
});

async function joinOrCreateSession() {
    const username = document.getElementById('username').value.trim();
    const sessionId = document.getElementById('sessionId').value.trim();
    const taskText = document.getElementById('taskText').value.trim();
    const scaleName = CURRENT_SCALE_NAME || 'custom';
    
    if (!username) { 
        toast.warning('Введите идентификатор пользователя');
        document.getElementById('username').focus();
        return; 
    }
    
    state.username = username;
    localStorage.setItem('pp_username', username);
    
    const btn = document.querySelector('.btn-primary');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('loading');
    btn.innerHTML = '<span class="spinner"></span>';
    
    try {
        if (sessionId) {
            const response = await fetch(`/api/sessions/${sessionId}`);
            if (!response.ok) throw new Error('Комната не найдена');
            const data = await response.json();
            
            // ✅ Определяем, являемся ли мы инициатором из данных сервера
            const isMeInitiator = data.initiator_id === `web_${username}`;
            enterSession(sessionId, data, isMeInitiator);
            toast.success(
                isMeInitiator ? 'С возвращением, оператор!' : 'Подключение к комнате установлено',
                isMeInitiator ? 'ОПЕРАТОР' : 'ПОДКЛЮЧЕНИЕ'
            );
        } else {
            if (!taskText) { 
                toast.warning('Опишите задачу для оценки');
                document.getElementById('taskText').focus();
                return; 
            }
            const response = await fetch('/api/sessions', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ username, text: taskText, scale_name: scaleName })
            });
            if (!response.ok) throw new Error('Ошибка создания комнаты');
            const data = await response.json();
            enterSession(data.session_id, data, true);
            toast.success('Комната создана. Готовы к оценке!');
        }
    } catch (error) {
        toast.error(error.message, 'НЕ УДАЛОСЬ');
    } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
        btn.innerHTML = originalHtml;
        updateJoinButtonText();
    }
}

function enterSession(sessionId, session, isInitiator) {
    state.sessionId = sessionId;
    state.isInitiator = isInitiator;
    state.wasRevealed = session.revealed;
    
    // ✅ НОВОЕ: Сохраняем комнату в историю
    saveRecentRoom(sessionId, session.text);
    
    document.getElementById('joinScreen').classList.add('hidden');
    document.getElementById('sessionScreen').classList.remove('hidden');
    document.getElementById('leaveBtn').classList.remove('hidden');
    
    window.history.pushState({ sessionId }, '', `${window.location.pathname}?session=${sessionId}`);
    updateSessionDisplay(session);
    connectWebSocket(sessionId);
}

// Связь потеряна окончательно: говорим прямо и даём способ вернуться
function showReconnectFailed() {
    const баннер = document.getElementById('reconnectFailed');
    if (баннер) баннер.classList.remove('hidden');
    toast.error('Связь с комнатой потеряна. Обновите страницу, чтобы вернуться.', 'НЕТ СВЯЗИ');
}

function hideReconnectFailed() {
    const баннер = document.getElementById('reconnectFailed');
    if (баннер) баннер.classList.add('hidden');
}

function connectWebSocket(sessionId) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    state.ws = new WebSocket(`${protocol}//${window.location.host}/ws/${sessionId}`);
    
    updateConnectionStatus('connecting');
    state.ws.onopen = () => {
        updateConnectionStatus('connected');
        hideReconnectFailed();
        state.reconnectAttempts = 0;
        state.ws.send(JSON.stringify({ type: 'join', username: state.username }));
        
        // Улучшенный ping-pong для поддержания соединения
        clearInterval(state.pingInterval);
        state.pingInterval = setInterval(() => {
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send('ping');
            }
        }, PING_INTERVAL_MS);
        
        // Дополнительный heartbeat при возвращении на вкладку
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send('ping');
            }
        });
    };
    
    state.ws.onmessage = (event) => {
        try {
            // Пропускаем pong ответы (не JSON)
            if (event.data === 'pong') return;
            
            const message = JSON.parse(event.data);
            
            // ✅ Обработка reconnect - пользователь вернулся после разрыва
            if (message.type === 'reconnected') {
                console.log('✅ Переподключение успешно');
                updateSessionDisplay(message.data);
                return;
            }
            
            // ✅ Обработка входа/выхода участников
            if (message.type === 'user_joined') {
                // Не играем звук для собственного входа
                if (message.username !== state.username) {
                    soundManager.playJoin();
                }
                updateSessionDisplay(message.data);
            } else if (message.type === 'user_left') {
                // НЕ показываем уведомление о выходе - это может быть временный разрыв
                // soundManager.playLeave();
                updateSessionDisplay(message.data);
            } else if (message.type === 'error') {
                toast.error(message.message || 'Ошибка сервера', 'ОШИБКА');
                return;
            } else if (message.type === 'kicked') {
                toast.error(message.message || 'Вы были исключены из комнаты', 'ИСКЛЮЧЕНИЕ');
                setTimeout(() => leaveSession(), 2000);
                return;
            } else if (message.type === 'user_kicked') {
                updateSessionDisplay(message.data);
                return;
            } else if (message.type === 'renamed') {
                // Своё имя запоминаем везде, где оно живёт: под ним же мы
                // переподключаемся и голосуем
                if (message.old_username === state.username) {
                    state.username = message.new_username;
                    localStorage.setItem('pp_username', state.username);
                    const поле = document.getElementById('username');
                    if (поле) поле.value = state.username;
                    toast.success(`Теперь вы ${message.new_username}`);
                } else {
                    toast.info(`${message.old_username} теперь ${message.new_username}`);
                }
                updateSessionDisplay(message.data);
            } else if (message.type === 'init' || message.type === 'update') {
                const prevVoteCount = document.getElementById('voteCount').textContent;
                updateSessionDisplay(message.data);
                
                const newVoteCount = message.data.vote_count;
                if (message.type === 'update' && newVoteCount > prevVoteCount) {
                    soundManager.playVote();
                }
            }
        } catch (e) { console.error('Parse error:', e); }
    };
    
    state.ws.onclose = () => {
        updateConnectionStatus('disconnected');
        clearInterval(state.pingInterval);
        // Автоматическое переподключение с экспоненциальной задержкой
        if (state.sessionId && state.reconnectAttempts < RECONNECT_MAX_ATTEMPTS) {
            state.reconnectAttempts++;
            const delay = RECONNECT_BASE_DELAY * state.reconnectAttempts;
            console.log(`🔄 Переподключение через ${delay}мс (попытка ${state.reconnectAttempts})`);
            setTimeout(() => { 
                if (state.sessionId) {
                    connectWebSocket(state.sessionId);
                }
            }, delay);
        } else if (state.sessionId) {
            // Попытки исчерпаны. Молчать здесь нельзя: карты и кнопки по-прежнему
            // нажимаются, комната выглядит живой, а связи с ней нет — человек
            // голосует в пустоту и узнаёт об этом в лучшем случае от соседа.
            showReconnectFailed();
        }
    };
}

function updateConnectionStatus(status) {
    const el = document.getElementById('connectionStatus');
    el.className = 'connection-status ' + status;
    el.textContent = { 'connected': 'ONLINE', 'disconnected': 'OFFLINE', 'connecting': 'CONNECTING' }[status] || status;
}

function setScale(scaleName) {
    if (!state.isInitiator) return;
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({
            type: 'set_scale',
            scale_name: scaleName,
            username: state.username
        }));
    }
}

function toggleAutoReveal() {
    const checkbox = document.getElementById('autoRevealToggle');
    const autoReveal = checkbox.checked;
    // Берём username из state, localStorage или поля ввода (fallback chain)
    const username = state.username || localStorage.getItem('pp_username') || document.getElementById('username')?.value?.trim() || '';
    if (!username) {
        toast.error('Идентификатор пользователя не найден', 'ОШИБКА');
        checkbox.checked = !autoReveal;
        return;
    }
    
    fetch(`/api/sessions/${state.sessionId}/auto-reveal`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ auto_reveal: autoReveal, username })
    })
    .then(response => response.json())
    .then(data => {
        if (data.ok) {
            toast.success(
                autoReveal ? 'Автооткрытие включено' : 'Автооткрытие выключено',
                'НАСТРОЙКА'
            );
        } else {
            toast.error(data.error || 'Ошибка', 'ОШИБКА');
            checkbox.checked = !autoReveal;
        }
    })
    .catch(error => {
        toast.error('Не удалось изменить настройку', 'ОШИБКА');
        checkbox.checked = !autoReveal;
    });
}

// ========== СОБСТВЕННЫЙ ВЫБОР (подсветка своей карты) ==========
// До вскрытия сервер намеренно не отдаёт real_point (тайна голосования),
// поэтому свой выбор помним на клиенте и переживаем перезагрузку страницы.
function myVoteStorageKey() {
    if (!state.sessionId || !state.username) return null;
    return `pp_my_vote_${state.sessionId}_${state.username}`;
}

function rememberMyVote(point) {
    state.selectedPoint = point || null;
    const key = myVoteStorageKey();
    if (!key) return;
    try {
        if (state.selectedPoint === null) localStorage.removeItem(key);
        else localStorage.setItem(key, state.selectedPoint);
    } catch (e) {
        // localStorage недоступен (приватный режим) — обходимся памятью
    }
}

function readStoredVote() {
    const key = myVoteStorageKey();
    if (!key) return null;
    try {
        return localStorage.getItem(key);
    } catch (e) {
        return null;
    }
}

function highlightSelectedCard() {
    document.querySelectorAll('.point-btn').forEach(b => {
        b.classList.toggle('selected', b.dataset.point === state.selectedPoint);
    });
}

// Синхронизирует state.selectedPoint с состоянием сессии перед отрисовкой грида.
function syncMyVoteFromSession(session) {
    const myVote = (session.votes || []).find(v => v.user_id === `web_${state.username}`);
    if (!myVote) {
        // Голоса нет: рестарт раунда или смена шкалы — старая подсветка неверна.
        rememberMyVote(null);
    } else if (myVote.real_point) {
        // Карты вскрыты — сервер отдал реальное значение, берём его как истину.
        rememberMyVote(myVote.real_point);
    } else if (state.selectedPoint === null) {
        // Голос есть, но значение скрыто: восстанавливаем свой выбор из хранилища.
        state.selectedPoint = readStoredVote();
    }
    if (state.selectedPoint !== null && !(session.available_points || []).includes(state.selectedPoint)) {
        rememberMyVote(null);
    }
}

function updateSessionDisplay(session) {
    state.session = session;
    state.isInitiator = (session.initiator_id === `web_${state.username}`);

    if (session.revealed && !state.wasRevealed) {
        document.body.classList.add('reveal-effect');
        setTimeout(() => document.body.classList.remove('reveal-effect'), 1600);
        state.wasRevealed = true;
        
        soundManager.playReveal();
    } else if (!session.revealed) {
        state.wasRevealed = false;
    }
    
    // Обновляем состояние чекбокса автооткрытия
    const autoRevealToggle = document.getElementById('autoRevealToggle');
    if (autoRevealToggle) {
        autoRevealToggle.checked = session.auto_reveal || false;
    }

    // Парсим данные задачи (JSON от Jira или старый формат [KEY] Summary)
    const taskText = session.text || '';
    currentTaskText = taskText;
    let isJiraTask = false;
    
    if (taskText.startsWith('__JIRA__')) {
        try {
            const jiraData = JSON.parse(taskText.slice(8));
            currentJiraIssue = {
                key: jiraData.key,
                epicKey: jiraData.epicKey || '',
                summary: jiraData.summary || '',
                description: jiraData.description || '',
                url: jiraData.url || '#',
                jiraUrl: jiraData.jiraUrl || '',
                linked: jiraData.linked || []
            };
            isJiraTask = true;
        } catch (e) {
            console.error('[Jira] Failed to parse task JSON:', e);
        }
    }
    
    if (!isJiraTask) {
        // Старый формат: [PROJ-123] Summary (backward compatibility)
        const jiraMatch = taskText.match(/^\[([A-Z]+-\d+)\]\s*(.*)/s);
        if (jiraMatch) {
            const oldKey = jiraMatch[1];
            let oldEpicKey = '';
            // Пробуем найти эпик из кэша
            const cachedIssue = jiraIssues.find(i => i.key === oldKey);
            if (cachedIssue && jiraEpicLinkField && cachedIssue.fields?.[jiraEpicLinkField]) {
                const ev = cachedIssue.fields[jiraEpicLinkField];
                oldEpicKey = typeof ev === 'string' ? ev : (ev?.key || '');
            }
            currentJiraIssue = {
                key: oldKey,
                epicKey: oldEpicKey,
                summary: jiraMatch[2],
                description: '',
                url: jiraSettings.jiraUrl ? `${jiraSettings.jiraUrl}/browse/${oldKey}` : '#',
                linked: []
            };
            isJiraTask = true;
        }
    }
    
    if (isJiraTask) {
        updateTaskDisplay();
        // Устанавливаем выбранную задачу для отправки в Jira
        if (currentJiraIssue?.key) {
            jiraSelectedIssue = currentJiraIssue.key;
        }
    } else {
        currentJiraIssue = null;
        updateTaskDisplay();
    }
    document.getElementById('initiatorDisplay').textContent = session.initiator_name;
    document.getElementById('sessionIdDisplay').textContent = state.sessionId;

    // Показываем кнопку Jira в хедере
    document.getElementById('jiraBtn').classList.remove('hidden');
    updateJiraHeaderBtn();
    
    syncMyVoteFromSession(session);
    const grid = document.getElementById('pointsGrid');
    grid.innerHTML = '';
    session.available_points.forEach(point => {
        const btn = document.createElement('button');
        btn.className = 'point-btn';
        btn.textContent = point;
        btn.setAttribute('data-point', point);
        btn.onclick = () => castVote(point);
        grid.appendChild(btn);
    });
    highlightSelectedCard();

    document.getElementById('voteCount').textContent = session.vote_count;
    const averageCard = document.getElementById('averageCard');
    const resultCard = document.getElementById('resultCard');
    
    if (session.revealed && session.average > 0) {
        averageCard.style.display = 'block';
        document.getElementById('averageValue').textContent = session.average.toFixed(1);
        resultCard.style.display = 'block';
        resultCard.style.cursor = 'default';
        const resultVal = Math.round(Math.ceil(session.average) * 10) / 10;
        document.getElementById('resultValue').textContent = resultVal;
        document.getElementById('resultValue').dataset.lastValid = resultVal;
        // Редактировать результат может только инициатор и только для Jira задач
        const isJiraTask = !!currentJiraIssue?.key;
        document.getElementById('resultValue').contentEditable = state.isInitiator && isJiraTask;
        document.getElementById('resultLabel').textContent = state.isInitiator && isJiraTask ? 'КЛИК — ПРАВКА' : 'ИТОГ';
        // Кнопка Jira — только для инициатора и если есть задача из Jira
        const jiraSendBtn = document.getElementById('jiraSendBtn');
        const canSendToJira = state.isInitiator && isJiraTask && (
            (hasJiraExt() && jiraSettings.configured) ||
            (currentJiraIssue.jiraUrl && jiraSettings.configured)
        );
        if (canSendToJira) {
            jiraSendBtn.style.display = 'inline-flex';
            jiraSendBtn.textContent = `⚡ В JIRA`;
            jiraSendBtn.title = `Отправить оценку в ${currentJiraIssue.key}`;
        } else {
            jiraSendBtn.style.display = 'none';
        }
        renderHistogram(session);
    } else {
        averageCard.style.display = 'none';
        resultCard.style.display = 'none';
        resultCard.style.cursor = 'default';
        document.getElementById('histogramContainer').innerHTML = '';
    }
    
    const totalConnected = session.participants ? session.participants.filter(p => p.online).length : 0;
    let percent = 0;
    let labelText = '';
    if (totalConnected === 0) {
        percent = 0;
        labelText = '— / — ОЖИДАНИЕ УЧАСТНИКОВ';
    } else {
        percent = Math.min(100, (session.vote_count / totalConnected) * 100);
        labelText = `${session.vote_count} / ${totalConnected} ПРОГОЛОСОВАЛО`;
    }
    document.getElementById('progressFill').style.width = percent + '%';
    document.getElementById('progressLabel').textContent = labelText;
    
    renderParticipants(session);
    
    const controlCard = document.getElementById('initiatorControlCard');
    controlCard.style.display = state.isInitiator ? 'block' : 'none';
    if (state.isInitiator) renderSessionScaleSelector(session);

    const votingSection = document.getElementById('votingSection');
    votingSection.style.opacity = session.revealed ? '0.4' : '1';
    votingSection.style.pointerEvents = session.revealed ? 'none' : 'auto';
}

// Смена имени, не выходя из комнаты. Переносом занимается сервер: имя служит
// ключом в учёте участников и в идентификаторе голоса, и разъехаться им нельзя.
function requestRename() {
    const текущее = state.username || '';
    const новое = (prompt('Как вас называть?', текущее) || '').trim();
    if (!новое || новое === текущее) return;

    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        toast.error('Нет связи с комнатой');
        return;
    }
    state.ws.send(JSON.stringify({ type: 'rename', new_username: новое }));
}

function renderParticipants(session) {
    let participants = session.participants || [];
    const uniqueParticipants = {};
    
    participants.forEach(p => { uniqueParticipants[p.user_id] = p; });
    let pList = Object.values(uniqueParticipants).map(p => ({ ...p, isYou: p.user_id === `web_${state.username}` }));

    // Сортировка
    if (session.revealed) {
        const getSortValue = (point) => {
            if (!point) return 999;
            if (point === '❔') return 99;
            if (point === '☕') return 100;
            return parseFloat(point) || 0;
        };
        pList.sort((a, b) => {
            const valA = a.vote ? getSortValue(a.vote.real_point) : 999;
            const valB = b.vote ? getSortValue(b.vote.real_point) : 999;
            return valA - valB;
        });
    } else {
        pList.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
    }

    // ✅ НОВОЕ: Считаем мин/макс для подсветки
    let minPoint = null;
    let maxPoint = null;
    let hasVariation = false;
    
    if (session.revealed) {
        const numericPoints = pList
            .map(p => p.vote?.real_point)
            .filter(p => p && p !== '❔' && p !== '☕')
            .map(p => parseFloat(p))
            .filter(p => !isNaN(p));
        
        const uniqueNumeric = [...new Set(numericPoints)];
        hasVariation = uniqueNumeric.length > 1;
        
        if (hasVariation) {
            minPoint = Math.min(...uniqueNumeric);
            maxPoint = Math.max(...uniqueNumeric);
        }
    }

    const grid = document.getElementById('participantsList');
    document.getElementById('participantCount').textContent = pList.length;

    if (pList.length === 0) {
        grid.innerHTML = '<p class="empty-message">Ожидание подключений...</p>';
        return;
    }

    grid.innerHTML = pList.map(p => {
        const safeName = escapeHtml(p.username);
        let voteDisplay;
        if (!p.vote) {
            voteDisplay = '<span class="vote-status pending">ОЖИДАЕТ</span>';
        } else if (!session.revealed) {
            const suit = p.vote.point || '♠';
            voteDisplay = `<span class="vote-value masked">${suit}</span>`;
        } else {
            const point = p.vote.real_point || p.vote.point;
            
            // ✅ Определяем класс мин/макс
            let extraClass = '';
            if (hasVariation && point !== '❔' && point !== '☕') {
                const numPoint = parseFloat(point);
                if (!isNaN(numPoint)) {
                    if (numPoint === minPoint) extraClass = ' min';
                    else if (numPoint === maxPoint) extraClass = ' max';
                }
            }
            
            // extraClass — внутреннее значение, а point приходит из шкалы: экранируем
            voteDisplay = `<span class="vote-value revealed${extraClass}">${escapeHtml(point)}</span>`;
        }

        const hasVoted = !!p.vote;
        const votedClass = !session.revealed && hasVoted ? 'voted' : '';
        return `
            <div class="participant-card ${p.online ? 'online' : 'offline'} ${p.isYou ? 'you' : ''} ${votedClass}">
                <div class="participant-card-header">
                    <div class="participant-indicator ${p.online ? 'online' : 'offline'}"></div>
                    <span class="participant-name" title="${safeName}">${safeName}</span>
                    ${p.isYou ? '<span class="participant-badge">ВЫ</span>' : ''}
                    ${p.isYou ? '<button class="rename-btn" title="Сменить имя">✎</button>' : ''}
                    ${state.isInitiator && p.username !== state.username ? `<button class="kick-btn" data-username="${safeName}" title="Исключить">✕</button>` : ''}
                    ${!session.revealed && hasVoted ? '<span class="vote-dot" title="Проголосовал"></span>' : ''}
                </div>
                <div class="participant-vote-area">
                    ${voteDisplay}
                </div>
            </div>
        `;
    }).join('');
}

function renderHistogram(session) {
    const container = document.getElementById('histogramContainer');
    if (!container || !session.revealed) {
        if (container) container.innerHTML = '';
        return;
    }

    // Count votes per point value
    const counts = {};
    let maxCount = 0;
    for (const v of session.votes) {
        const point = v.real_point || v.point;
        counts[point] = (counts[point] || 0) + 1;
        if (counts[point] > maxCount) maxCount = counts[point];
    }

    const entries = Object.entries(counts).sort((a, b) => {
        const na = parseFloat(a[0]);
        const nb = parseFloat(b[0]);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        if (!isNaN(na)) return -1;
        if (!isNaN(nb)) return 1;
        return a[0].localeCompare(b[0]);
    });

    container.innerHTML = entries.map(([point, count]) => {
        const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
        const isSpecial = SPECIAL_POINTS.includes(point);
        return `
            <div class="histogram-row">
                <span class="histogram-label ${isSpecial ? 'special' : ''}">${escapeHtml(point)}</span>
                <div class="histogram-bar-track">
                    <div class="histogram-bar" style="width: ${pct}%"></div>
                </div>
                <span class="histogram-count">${count}</span>
            </div>
        `;
    }).join('');
}

async function castVote(point) {
    if (!state.sessionId) return;
    const previousPoint = state.selectedPoint;
    // Запоминаем выбор сразу: свой голос обратно не приходит (real_point скрыт
    // до вскрытия), а грид перерисовывается на каждом broadcast.
    rememberMyVote(point);
    highlightSelectedCard();
    try {
        const response = await fetch(`/api/sessions/${state.sessionId}/vote`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username: state.username, point: point })
        });
        if (!response.ok) {
            const err = await response.json();
            toast.error(err.error || 'Неизвестная ошибка', 'ОШИБКА ГОЛОСА');
            rememberMyVote(previousPoint);
            highlightSelectedCard();
        } else {
            soundManager.playVote();
        }
    } catch (error) {
        toast.error(error.message, 'НЕТ СВЯЗИ');
        rememberMyVote(previousPoint);
        highlightSelectedCard();
    }
}

function toggleNewTaskInput() {
    // Если Jira подключена — открываем модалку выбора задачи
    if (jiraConnected && jiraIssues.length > 0) {
        openNewTaskModal();
        return;
    }

    // Иначе старый inline-режим
    const container = document.getElementById('newTaskInline');
    const input = document.getElementById('newTaskText');
    if (container.style.display === 'none' || !container.style.display) {
        container.style.display = 'block';
        setTimeout(() => input.focus(), 50);
    } else {
        container.style.display = 'none';
        input.value = '';
    }
}

async function startNewTask() {
    const newText = document.getElementById('newTaskText').value.trim();
    if (!newText) { 
        toast.warning('Опишите новую задачу');
        return; 
    }
    const container = document.getElementById('newTaskInline');
    container.style.display = 'none';
    document.getElementById('newTaskText').value = '';
    // Убираем jira-описание
    const descEl = document.getElementById('taskJiraDesc');
    if (descEl) descEl.style.display = 'none';
    await restartSession(newText);
}

async function restartSession(newText = null) {
    // Для сброса без новой задачи - запрашиваем подтверждение
    if (!newText) {
        const confirmed = await confirmDialog.show(
            'Все текущие голоса будут сброшены. Продолжить?',
            'СБРОС ГОЛОСОВ',
            'СБРОСИТЬ',
            'ОТМЕНА'
        );
        if (!confirmed) return;
    }
    
    const btn = document.querySelector('.btn-warning');
    if (btn) btn.disabled = true;
    
    try {
        const payload = { username: state.username };
        if (newText) payload.new_text = newText;
        const response = await fetch(`/api/sessions/${state.sessionId}/restart`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const err = await response.json();
            toast.error(err.error || 'Неизвестная ошибка', 'НЕ УДАЛОСЬ');
            return;
        }
        
        // Обновляем отображение задачи (currentJiraIssue уже установлен в applyNewTaskFromModal)
        updateTaskDisplay();
        
        soundManager.playReset();
        toast.info('Голосование перезапущено');
        
        document.body.classList.remove('reveal-effect', 'reset-effect');
        void document.body.offsetWidth;
        document.body.classList.add('reset-effect');
        setTimeout(() => document.body.classList.remove('reset-effect'), 1400);
    } catch (error) { 
        toast.error(error.message, 'НЕТ СВЯЗИ');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// ==================== AUTO-REVEAL (клиент больше не инициирует — только реагирует на сервер) ====================
// Сервер автоматически открывает карты при полном наборе голосов,
// клиент получает update через WebSocket и обновляет отображение.

async function kickParticipant(targetUsername) {
    const confirmed = await confirmDialog.show(
        `Исключить участника ${targetUsername}?`,
        'ИСКЛЮЧЕНИЕ',
        'ИСКЛЮЧИТЬ',
        'ОТМЕНА'
    );
    if (!confirmed) return;

    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({
            type: 'kick_user',
            username: state.username,
            target_username: targetUsername
        }));
    }
}

async function revealCards() {
    const btn = document.querySelector('.btn-success');
    btn.disabled = true;
    try {
        const response = await fetch(`/api/sessions/${state.sessionId}/reveal`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username: state.username })
        });
        if (!response.ok) {
            const err = await response.json();
            toast.error(err.error || 'Неизвестная ошибка', 'НЕ УДАЛОСЬ ОТКРЫТЬ');
        }
    } catch (error) { 
        toast.error(error.message, 'НЕТ СВЯЗИ');
    } finally {
        btn.disabled = false;
    }
}

async function leaveSession() {
    const confirmed = await confirmDialog.show(
        'Вы действительно хотите выйти из комнаты? Все несохранённые голоса будут потеряны.',
        'ВЫХОД ИЗ КОМНАТЫ',
        'ВЫЙТИ',
        'ОСТАТЬСЯ'
    );
    if (!confirmed) return;

    state.sessionId = null; // очищаем ДО закрытия сокета, чтобы onclose не переподключался
    if (state.ws) state.ws.close();
    state.isInitiator = false; 
    state.selectedPoint = null; 
    state.wasRevealed = false;
    
    document.getElementById('joinScreen').classList.remove('hidden');
    document.getElementById('sessionScreen').classList.add('hidden');
    document.getElementById('leaveBtn').classList.add('hidden');

    // ✅ НОВОЕ: Очищаем форму подключения
    document.getElementById('sessionId').value = '';
    document.getElementById('taskText').value = '';
    document.getElementById('taskGroup').style.display = 'block';
    
    // Убираем jira-описание если было
    const descEl = document.getElementById('taskJiraDesc');
    if (descEl) descEl.style.display = 'none';
    
    // ✅ НОВОЕ: Обновляем историю комнат при возвращении
    renderRecentRooms();
    
    window.history.pushState({}, '', window.location.pathname);
    
    // Прокручиваем joinScreen наверх, чтобы было видно заголовок
    document.getElementById('joinScreen').scrollTop = 0;
    document.getElementById('username').focus();

    // Восстанавливаем дерево Jira на экране входа
    if (jiraConnected && !state.sessionId) {
        renderJiraJoinTree();
        showJiraJoinTree();
    }
}

async function copySessionLink() {
    const link = `${window.location.origin}?session=${state.sessionId}`;
    if (await copyText(link)) {
        toast.success('Ссылка на комнату скопирована', 'ССЫЛКА');
    } else {
        // Показываем сам адрес: скопировать вручную всё же можно
        toast.error(`Не удалось скопировать. Адрес: ${link}`);
    }
}

async function copySessionId(event) {
    // ✅ Останавливаем всплытие, чтобы не сработал обработчик родителя
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    
    const sessionId = state.sessionId;
    if (!sessionId) return;
    
    if (!(await copyText(sessionId))) {
        toast.error(`Не удалось скопировать. ID комнаты: ${sessionId}`);
        return;
    }
    const el = document.getElementById('sessionIdDisplay');
    const original = el.textContent;
    el.textContent = '✓ СКОПИРОВАНО';
    el.classList.add('copied');
    toast.success('ID комнаты скопирован', 'КОМНАТА');
    setTimeout(() => {
        el.textContent = original;
        el.classList.remove('copied');
    }, 2000);
}

async function copyResult() {
    const val = document.getElementById('resultValue').textContent;
    if (val === '-') return;

    const rounded = Math.ceil(parseFloat(val));

    if (!(await copyText(rounded))) {
        toast.error(`Не удалось скопировать. Оценка: ${rounded}`);
        return;
    }
    const label = document.getElementById('resultLabel');
    const original = label.textContent;
    label.textContent = '✓ СКОПИРОВАНО В БУФЕР!';
    label.style.color = 'var(--success)';
    toast.success(`Оценка ${rounded} скопирована`, 'РЕЗУЛЬТАТ');
    setTimeout(() => {
        label.textContent = original;
        label.style.color = 'var(--text-secondary)';
    }, 2000);
}