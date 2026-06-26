# Planning Poker — ADF Parser, E2E Tests, Browser Extension Fixes & Auto-Reveal Bugfix

**Date:** 2026-06-26
**Project:** tg_poker_planing — Planning Poker (Telegram Bot + Web Interface)

---

## Context

[Planning Poker](https://github.com/user/tg_poker_planing) — инструмент для командной оценки задач. Стек: Python 3.10+ / Starlette / SQLite / Vanilla JS / WebSocket.

Предыдущая фаза (spec 2026-06-22) покрыла баги, рефакторинг и улучшения (фазы A-C).
Текущая фаза: улучшение интеграции с Jira (ADF-парсер), E2E-тестирование, фиксы browser extension и бага автооткрытия.

---

## 1. ADF-парсер + Wiki-разметка (JS frontend)

### Проблема

Сейчас `formatJiraDescription()` обрабатывает только:
- `[text|url]` ссылки
- `[PROJ-123]` и PROJ-123 автоссылки
- Обычные URL
- Переносы строк

Jira Cloud API возвращает описание в формате ADF (Atlassian Document Format) — JSON-дерево. Текущий код приводит его к строке `String(desc)` и экранирует, теряя всю структуру.
Jira Server может возвращать wiki-разметку — её поддержка тоже неполная.

### Решение

Новый модуль `web/static/adf-parser.js` — рекурсивный конвертер ADF (JSON) → HTML + wiki-разметки → HTML.

### Архитектура

```
web/static/
├── adf-parser.js       ← новый файл
├── script.js
└── styles.css
```

**ADF → HTML (рекурсивный обход нод):**

| ADF node type | HTML output |
|---|---|
| `doc` | `<div class="jira-doc">` |
| `paragraph` | `<p>` |
| `heading` (level 1-6) | `<h1>`..`<h6>` |
| `bulletList` / `orderedList` | `<ul>` / `<ol>` |
| `listItem` | `<li>` |
| `codeBlock` | `<pre class="jira-code"><code>` |
| `blockquote` | `<blockquote>` |
| `rule` | `<hr>` |
| `hardBreak` | `<br>` |
| `text` | текст + marks |
| `table` / `tableRow` / `tableHeader` / `tableCell` | `<table>` / `<tr>` / `<th>` / `<td>` |
| `media` / `mediaSingle` / `mediaGroup` | placeholder (`<div class="jira-media-placeholder">📎 media</div>`) |
| `mention` | `<span class="jira-mention">@user</span>` |
| unknown | `escapeHtml(JSON.stringify(node))` |

**Text marks:**

| Mark | HTML |
|---|---|
| `strong` | `<strong>` |
| `em` | `<em>` |
| `code` | `<code>` |
| `strike` | `<s>` |
| `underline` | `<u>` |
| `link` | `<a href="..." target="_blank">` |
| `subsup` (sub/sup) | `<sub>` / `<sup>` |
| `textColor` | `<span style="color: ...">` |
| `backgroundColor` | `<span style="background: ...">` |

**Wiki → HTML (для старых Jira Server):**

| Wiki | HTML |
|---|---|
| `*bold*` | `<strong>` |
| `_italic_` | `<em>` |
| `{{monospaced}}` | `<code>` |
| `-strikethrough-` | `<s>` |
| `+underline+` | `<u>` |
| `^superscript^` | `<sup>` |
| `~subscript~` | `<sub>` |
| `h1.` / `h2.` / … | `<h1>`..`<h6>` |
| `* ` / `- ` / `# ` списки | `<ul>` / `<ol>` |
| `{code}` / `{noformat}` | `<pre><code>` |
| `{quote}` | `<blockquote>` |
| `|| h || c ||` таблицы | `<table>` |
| `!image.png!` | placeholder |
| Существующие: `[text\|url]`, `[PROJ-123]` | уже работают |

**Детекция формата на входе:**

```js
function parseJiraDescription(desc) {
    if (!desc) return '';
    if (typeof desc === 'object' && desc?.type === 'doc') {
        return adfToHtml(desc);             // ADF (Jira Cloud)
    }
    if (typeof desc === 'string') {
        const wikiHtml = parseWikiMarkup(desc);
        // wikiHtml уже содержит обработанные ссылки / переносы
        return wikiHtml;
    }
    return escapeHtml(String(desc));        // fallback
}
```

**Интеграция:**
- `adf-parser.js` загружается в `<head>` перед `script.js`
- `formatJiraDescription` заменяется на `parseJiraDescription`
- Существующие CSS-стили (`.jira-description`, `.jira-code`, `.jira-desc-link`) уже покрывают 90% оформления

### Тестирование парсера

Playwright-тесты в `tests/e2e/adf-parser.test.ts` (или `specs/`):
- Набор ADF-примеров (plain text, заголовки, списки, codeBlock, таблицы, смешанные)
- Набор wiki-примеров
- Проверка HTML-вывода

---

## 2. E2E-тесты (Playwright)

### Проблема

Проект имеет только backend unit/integration тесты (pytest). Frontend не тестируется вообще. Нет автоматической проверки критических пользовательских сценариев.

### Решение

Playwright тесты в `tests/e2e/`.

### Структура

```
tests/e2e/
├── playwright.config.ts      # конфиг (baseURL, browser, webServer)
├── fixtures/
│   ├── adf-samples.ts        # тестовые ADF-документы
│   └── wiki-samples.ts       # тестовые wiki-строки
├── pages/
│   ├── join-page.ts          # Page Object: экран входа
│   └── session-page.ts       # Page Object: экран сессии
├── specs/
│   ├── core-flow.spec.ts     # create → join → vote → reveal → restart
│   ├── websocket.spec.ts     # join/leave/reconnect, real-time sync
│   ├── scales.spec.ts        # switch scale, custom scale editor
│   ├── jira.spec.ts          # Jira panel, task tree, apply, send
│   ├── auto-reveal.spec.ts   # auto-reveal on/off sync
│   └── adf-parser.spec.ts    # ADF→HTML / wiki→HTML unit tests
└── package.json              # dev-зависимость: @playwright/test
```

### Тест-кейсы

#### core-flow.spec.ts
- Создать комнату → проверить отображение задачи и шкалы
- Войти в комнату вторым пользователем (две вкладки)
- Проголосовать → проверить маскировку
- Открыть карты → проверить показ результатов и среднего
- Рестарт → проверить сброс голосов
- Кик участника → проверить уведомление

#### websocket.spec.ts
- Присоединение: получить `user_joined` у других участников
- Отключение: проверка `user_left` / статуса offline
- Переподключение: реконнект после разрыва
- Ping/pong heartbeat

#### scales.spec.ts
- Создать с fibonacci → проверить точки
- Поменять на tshirt → проверить XS-XXL
- Custom scale: открыть редактор → добавить значения → сохранить → проверить отображение

#### jira.spec.ts
- Открыть Jira-панель → проверить отображение формы настроек
- **Mock**: подменить Jira API-ответы (issues, epics, fields)
- Выбрать задачу из дерева → проверить что описание подставилось
- Отправить оценку → проверить PUT запрос к Jira API

#### auto-reveal.spec.ts
- Включить auto-reveal → все голосуют → карты открываются автоматически
- Выключить auto-reveal → все голосуют → карты **не** открываются
- Reveal не сбрасывает чекбокс auto-reveal
- После restart auto-reveal сохраняет своё состояние

#### adf-parser.spec.ts
- ADF `{type:"doc", content: [{type:"paragraph", content: [{type:"text", text:"hello"}]}]}` → `<p>hello</p>`
- ADF с marks (strong, em, code, link)
- ADF codeBlock → `<pre class="jira-code"><code>...</code></pre>`
- Wiki `*bold*` → `<strong>bold</strong>`
- Wiki `h2. Title` → `<h2>Title</h2>`
- Wiki `{code}...{code}` → `<pre class="jira-code"><code>...</code></pre>`
- Fallback на plain text

### Конфигурация Playwright

```ts
// playwright.config.ts
export default defineConfig({
    webServer: {
        command: 'python3 main.py',       // или uvicorn app:app
        port: 8000,
        reuseExistingServer: !process.env.CI,
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    ],
});
```

---

## 3. Browser Extension Fixes

### 3.1 Firefox manifest rename

**Проблема:** `build.sh` копирует `manifest-firefox.json` в `build-firefox/`, но не переименовывает в `manifest.json`. Firefox ожидает `manifest.json`.

**Fix в `build.sh`:**

```bash
# Было:
cp manifest-firefox.json browser-polyfill.min.js ... build-firefox/

# Стало:
cp manifest-firefox.json build-firefox/manifest.json
cp browser-polyfill.min.js background.js content.js popup.html popup.js README.md build-firefox/
cp -r icons build-firefox/
```

### 3.2 Endpoint /extension/download — детект браузера

**Проблема:** Сейчас всегда отдаёт `pp-jira-bridge-all.zip`, независимо от браузера пользователя.

**Fix в `web_api.py`:**

```python
async def download_extension(request: Request):
    user_agent = request.headers.get("user-agent", "").lower()
    
    if "firefox" in user_agent:
        zip_path = "browser-extension/pp-jira-bridge-firefox.zip"
    elif "edg" in user_agent:
        zip_path = "browser-extension/pp-jira-bridge-chrome.zip"
    else:
        # Chrome, Chromium, Safari, etc.
        zip_path = "browser-extension/pp-jira-bridge-chrome.zip"
    
    return FileResponse(zip_path, media_type="application/zip", filename="pp-jira-bridge.zip")
```

HTML-инструкции (`?download=html`) остаются без изменений.

### 3.3 build_extension.py

Устарел: создаёт `pp-jira-bridge.zip` путём запаковки всего каталога (включая build-директории и старые зипы). Варианты:
- **Удалить** — `build.sh` полностью покрывает сборку
- **Синхронизировать** — заменить на вызов `build.sh`

---

## 4. Auto-Reveal Bugfix

### Баг 4.1: checkAutoReveal игнорирует флаг auto_reveal

**Файл:** `web/static/script.js`

`checkAutoReveal()` вызывается при каждом обновлении и открывает карты, когда все онлайн-участники проголосовали — **независимо от того, включён ли чекбокс auto_reveal**.

**Fix:** добавить проверку флага:

```js
function checkAutoReveal(session) {
    if (session.revealed || !state.isInitiator) return;
    if (!session.auto_reveal) return;                   // <-- добавить
    const totalOnline = session.participants
        ? session.participants.filter(p => p.online).length : 0;
    if (totalOnline <= 1) return;
    if (session.vote_count >= totalOnline) {
        if (autoRevealTimer) return;
        autoRevealTimer = setTimeout(() => {
            autoRevealTimer = null;
            revealCards();
            toast.info('Все проголосовали — карты открыты', 'AUTO');
        }, 1000);
    } else {
        if (autoRevealTimer) {
            clearTimeout(autoRevealTimer);
            autoRevealTimer = null;
        }
    }
}
```

### Баг 4.2: Чекбокс сбрасывается при reveal'е

**Файл:** `web/static/script.js`

После `revealCards()` → `api_reveal` → broadcast → `updateSessionDisplay` синхронизирует чекбокс. Потенциальная причина: `session.auto_reveal` может не доезжать до клиента.

**Fix в `updateSessionDisplay()`:** принудительная установка вместо условной:

```js
// Было:
const sessionAutoReveal = session.auto_reveal || false;
if (autoRevealToggle.checked !== sessionAutoReveal) {
    autoRevealToggle.checked = sessionAutoReveal;
}

// Стало — безусловная синхронизация:
autoRevealToggle.checked = session.auto_reveal || false;
```

---

## Порядок имплементации

```
1. ADF-парсер (adf-parser.js + интеграция в script.js)
2. Auto-reveal bugfix (checkAutoReveal + checkbox sync)
3. Browser extension (build.sh rename + download endpoint)
4. E2E-тесты (Playwright setup + all specs)
5. build_extension.py cleanup
```