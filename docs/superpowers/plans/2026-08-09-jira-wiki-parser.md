# Jira Wiki Parser Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Переписать разбор Jira wiki-разметки так, чтобы она отображалась корректно, и покрыть его автотестами, запускаемыми без установки зависимостей.

**Architecture:** Вместо цепочки `String.replace` по одной строке — три раздельных шага: блочный разбор строит список блоков, инлайновый разбор превращает текст блока в список узлов, и только третий шаг собирает HTML, экранируя текст при выводе. HTML не существует до последнего шага, поэтому ни одно правило не может испортить результат другого. Wiki-парсер живёт в отдельном файле; `adf-parser.js` сохраняет ADF-ветку и точку входа-диспетчер.

**Tech Stack:** Vanilla JS без сборки и зависимостей; `node --test` (встроен в Node, в системе v26) для тестов; существующие стили в `web/static/styles.css`.

**Спека:** `docs/superpowers/specs/2026-08-09-jira-wiki-parser-design.md`

## Global Constraints

- Ветка `fix/jira-wiki-parser` (от `main` после слияния PR #1). Не переключаться, не пушить, историю не переписывать.
- Никаких новых зависимостей: ни npm-пакетов, ни сборщика. В корне репозитория нет и не появляется `package.json`.
- Файлы в `web/static/` остаются обычными `<script>` для страницы и одновременно импортируются в Node — через хвост с двойным экспортом.
- **Команда запуска JS-тестов: `node --test 'tests/js/*.test.js'`** (кавычки обязательны). Аргумент-каталог (`node --test tests/js`) в Node v26 не работает — он пытается исполнить каталог как файл и падает. Проверено.
- Питоновский набор не должен пострадать: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest -q` — **285 passed**, `.venv/bin/ruff check .` — `All checks passed!`. `pytest` собирает только `test_*.py`, JS-тесты ему не видны.
- Классы вывода сохраняются, потому что на них завязаны стили: `jira-doc`, `jira-code`, `jira-table`, `jira-panel`, `jira-panel-<тип>`, `jira-panel-title`, `jira-panel-icon`, `jira-panel-content`, `jira-desc-link`, `jira-task-ref`.
- ADF-ветка сохраняет поведение; в ней меняется только `escapeHtml` (на чистую функцию) и добавляется экспорт.
- Комментарии и сообщения коммитов — на русском, как принято в репозитории.
- `browser-extension/`, `web/static/script.js` (кроме отсутствия правок вовсе) и питоновский код — вне scope.

## Ключевое проектное решение, которого нет в тексте спеки

Стили таблиц в `web/static/styles.css:492-499` заданы **только** внутри `.jira-doc`
(`.jira-doc table.jira-table th` и т. д.). ADF-ветка оборачивает вывод в
`<div class="jira-doc">`, а wiki-ветка сейчас отдаёт голый HTML — поэтому таблицы
из wiki-разметки не стилизованы вообще. Новый wiki-парсер **тоже оборачивает вывод
в `<div class="jira-doc">`**. Это приводит обе ветки к общему оформлению и ничего
не ломает: `.jira-description .jira-doc` вкладывается нормально.

## Структура файлов

```
web/static/
├── wiki-parser.js   ← создаётся: блочный разбор, инлайновый разбор, сборка HTML
├── adf-parser.js    ← ADF-ветка + диспетчер parseJiraDescription; wiki-часть удаляется
└── styles.css       ← не меняется

web/templates/
└── index.html       ← добавляется <script> для wiki-parser.js перед adf-parser.js

tests/js/
├── wiki-parser.test.js   ← создаётся: тесты wiki-парсера
└── dispatcher.test.js    ← создаётся: тесты parseJiraDescription
```

## Внутренние структуры данных

Их используют все задачи — имена и поля обязаны совпадать.

**Блок** — простой объект с полем `type`:

```js
{ type: 'paragraph', text: '...' }                    // text разбирается инлайново при сборке
{ type: 'heading', level: 1..6, text: '...' }
{ type: 'code', text: '...', language: 'java' | null } // text выводится дословно
{ type: 'quote', blocks: [ ...блоки... ] }
{ type: 'panel', title: '...' | null, blocks: [ ...блоки... ] }
{ type: 'rule' }
{ type: 'list', ordered: true|false, items: [ { text: '...', children: <блок list> | null } ] }
{ type: 'table', rows: [ { header: true|false, cells: [ '...', '...' ] } ] }
```

**Инлайновый узел:**

```js
{ type: 'text', text: '...' }
{ type: 'strong' | 'em' | 'strike' | 'underline' | 'sup' | 'sub', children: [ ...узлы... ] }
{ type: 'code', text: '...' }                          // {{...}} — выводится дословно
{ type: 'link', href: '...', children: [ ...узлы... ] }// href непрозрачен, инлайново не разбирается
{ type: 'color', color: '...', children: [ ...узлы... ] }
{ type: 'issue', key: 'ABC-123' }
{ type: 'break' }                                      // \\
```

---

## Task 1: Тестовый каркас и чистое экранирование

Первая задача делает набор запускаемым и снимает зависимость ADF-ветки от DOM. Без неё остальные задачи нечем проверять.

**Files:**
- Modify: `web/static/adf-parser.js` (функция `escapeHtml`, строки 8-12; хвост файла)
- Create: `tests/js/dispatcher.test.js`

**Interfaces:**
- Consumes: ничего
- Produces: `escapeHtml(text) -> string` — чистая, без DOM, экранирует `& < > " '`. `module.exports` из `adf-parser.js` содержит `{ parseJiraDescription, escapeHtml }`.

- [ ] **Step 1: Написать падающие тесты**

Создать `tests/js/dispatcher.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');

const { parseJiraDescription, escapeHtml } = require('../../web/static/adf-parser.js');

test('escapeHtml экранирует все пять опасных символов', () => {
    assert.strictEqual(
        escapeHtml(`<a href="x" class='y'>&</a>`),
        '&lt;a href=&quot;x&quot; class=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
    );
});

test('escapeHtml не требует браузера и переваривает не-строки', () => {
    assert.strictEqual(escapeHtml(42), '42');
    assert.strictEqual(escapeHtml(''), '');
});

test('диспетчер: пустое описание даёт пустую строку', () => {
    assert.strictEqual(parseJiraDescription(''), '');
    assert.strictEqual(parseJiraDescription(null), '');
    assert.strictEqual(parseJiraDescription(undefined), '');
});

test('диспетчер: объект ADF идёт в ADF-ветку', () => {
    const html = parseJiraDescription({
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'привет' }] }],
    });
    assert.match(html, /<div class="jira-doc">/);
    assert.match(html, /<p>привет<\/p>/);
});

test('ADF: ссылка и код сохраняют адрес и текст', () => {
    const html = parseJiraDescription({
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [
            { type: 'text', text: 'дока', marks: [{ type: 'link', attrs: { href: 'https://wiki.corp/api_v2_spec' } }] },
            { type: 'text', text: 'user_name_id', marks: [{ type: 'code' }] },
        ] }],
    });
    assert.match(html, /href="https:\/\/wiki\.corp\/api_v2_spec"/);
    assert.match(html, /<code>user_name_id<\/code>/);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test 'tests/js/*.test.js'`
Expected: FAIL — `Cannot find module` либо `document is not defined`, потому что `adf-parser.js` пока ничего не экспортирует и использует DOM.

- [ ] **Step 3: Заменить escapeHtml на чистую функцию**

В `web/static/adf-parser.js` заменить:

```js
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
```

на:

```js
    // Чистая реализация: не требует DOM (нужно для запуска в Node) и, в отличие
    // от прежней через createElement, экранирует кавычки — результат подставляется
    // в том числе в значения атрибутов.
    function escapeHtml(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
```

- [ ] **Step 4: Добавить двойной экспорт**

В конце `web/static/adf-parser.js`, перед закрывающей строкой IIFE `})();`, добавить:

```js
    // Файл работает и как обычный <script> на странице, и как модуль в Node —
    // это нужно, чтобы парсер можно было тестировать без браузера и без сборщика.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { parseJiraDescription, escapeHtml };
    }
```

Обратите внимание: `parseJiraDescription` сейчас объявлена как `window.parseJiraDescription = function parseJiraDescription(desc) {...}`. В Node глобального `window` нет, поэтому эту строку надо переписать так, чтобы функция сначала объявлялась, а на `window` вешалась только при его наличии:

```js
    function parseJiraDescription(desc) {
        if (!desc) return '';
        if (typeof desc === 'object' && desc !== null && desc.type === 'doc') {
            return adfToHtml(desc);
        }
        if (typeof desc === 'string') {
            return parseWikiMarkup(desc);
        }
        return escapeHtml(String(desc));
    }

    if (typeof window !== 'undefined') {
        window.parseJiraDescription = parseJiraDescription;
    }
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `node --test 'tests/js/*.test.js'`
Expected: 5 passed

- [ ] **Step 6: Убедиться, что питоновский набор и линтер не задеты**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest -q && .venv/bin/ruff check .`
Expected: `285 passed`, `All checks passed!`

- [ ] **Step 7: Проверить страницу в браузере**

Поднять дев-сервер (см. «Дев-сервер» в конце плана), открыть страницу и выполнить в консоли:

```js
parseJiraDescription({type:'doc',version:1,content:[{type:'paragraph',content:[{type:'text',text:'ок'}]}]})
```

Expected: возвращается `<div class="jira-doc"><p>ок</p></div>`, в консоли нет ошибок. Это подтверждает, что правка не сломала загрузку файла как обычного скрипта.

- [ ] **Step 8: Commit**

```bash
git add web/static/adf-parser.js tests/js/dispatcher.test.js
git commit -m "test: подключить node --test и убрать зависимость парсера от DOM"
```

---

## Task 2: Инлайновый разбор

Сердце исправления: сканер, который не даёт правилам портить чужой вывод и уважает границы слов.

**Files:**
- Create: `web/static/wiki-parser.js`
- Create: `tests/js/wiki-parser.test.js`

**Interfaces:**
- Consumes: ничего
- Produces: из `wiki-parser.js` экспортируется `{ parseInline }`. `parseInline(text) -> [инлайновый узел]` по структурам из раздела «Внутренние структуры данных». Задача 4 добавит к экспорту `parseBlocks` и `parseJiraWiki`.

- [ ] **Step 1: Написать падающие тесты**

Создать `tests/js/wiki-parser.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');

const { parseInline } = require('../../web/static/wiki-parser.js');

// Хелпер: собирает из узлов плоскую строку вида "text|strong(text)" для читаемых сравнений
function shape(nodes) {
    return nodes.map(function walk(n) {
        if (n.type === 'text') return n.text;
        if (n.type === 'code') return 'code(' + n.text + ')';
        if (n.type === 'issue') return 'issue(' + n.key + ')';
        if (n.type === 'break') return 'break';
        if (n.type === 'link') return 'link[' + n.href + '](' + n.children.map(walk).join('') + ')';
        if (n.type === 'color') return 'color:' + n.color + '(' + n.children.map(walk).join('') + ')';
        return n.type + '(' + n.children.map(walk).join('') + ')';
    }).join('');
}

test('простой текст остаётся текстом', () => {
    assert.strictEqual(shape(parseInline('просто текст')), 'просто текст');
});

test('жирный, курсив, зачёркнутый, подчёркнутый', () => {
    assert.strictEqual(shape(parseInline('это *жирный* текст')), 'это strong(жирный) текст');
    assert.strictEqual(shape(parseInline('это _курсив_ текст')), 'это em(курсив) текст');
    assert.strictEqual(shape(parseInline('это -зачёркнутый- текст')), 'это strike(зачёркнутый) текст');
    assert.strictEqual(shape(parseInline('это +подчёркнутый+ текст')), 'это underline(подчёркнутый) текст');
});

test('верхний и нижний индекс пишутся вплотную к основанию', () => {
    assert.strictEqual(shape(parseInline('x^2^ и H~2~O')), 'xsup(2) и Hsub(2)O');
});

test('моноширинный не разбирается внутри', () => {
    assert.strictEqual(shape(parseInline('{{a_b_c}}')), 'code(a_b_c)');
    assert.strictEqual(shape(parseInline('{{*не жирный*}}')), 'code(*не жирный*)');
});

// --- правило границ: то, ради чего всё затевалось ---

test('подчёркивания внутри идентификатора не создают курсив', () => {
    assert.strictEqual(shape(parseInline('Поле user_name_id пустое')), 'Поле user_name_id пустое');
});

test('плюсы в C++ и Java+Kotlin не создают подчёркивание', () => {
    assert.strictEqual(shape(parseInline('Нужно C++ и Java+Kotlin')), 'Нужно C++ и Java+Kotlin');
});

test('дефис в числовом диапазоне не создаёт зачёркивание', () => {
    assert.strictEqual(shape(parseInline('Срок 5-10 дней')), 'Срок 5-10 дней');
});

test('маркер после открывающей скобки работает', () => {
    assert.strictEqual(shape(parseInline('(*жирный*)')), '(strong(жирный))');
});

test('незакрытый маркер остаётся текстом', () => {
    assert.strictEqual(shape(parseInline('это *не закрыт')), 'это *не закрыт');
});

// --- ссылки: адрес непрозрачен ---

test('ссылка с текстом сохраняет адрес дословно', () => {
    const nodes = parseInline('[Дока|https://wiki.corp/api_v2_spec]');
    assert.strictEqual(nodes.length, 1);
    assert.strictEqual(nodes[0].type, 'link');
    assert.strictEqual(nodes[0].href, 'https://wiki.corp/api_v2_spec');
    assert.strictEqual(shape(nodes[0].children), 'Дока');
});

test('ссылка без текста использует адрес как подпись', () => {
    const nodes = parseInline('[https://example.com/a_b]');
    assert.strictEqual(nodes[0].type, 'link');
    assert.strictEqual(nodes[0].href, 'https://example.com/a_b');
    assert.strictEqual(shape(nodes[0].children), 'https://example.com/a_b');
});

test('адрес без схемы получает https://', () => {
    assert.strictEqual(parseInline('[текст|wiki.corp/x]')[0].href, 'https://wiki.corp/x');
});

test('голый URL с подчёркиваниями становится ссылкой целиком', () => {
    const nodes = parseInline('см. https://wiki.corp/api_v2_spec тут');
    const link = nodes.find(n => n.type === 'link');
    assert.strictEqual(link.href, 'https://wiki.corp/api_v2_spec');
});

test('тильда внутри голого URL не превращается в нижний индекс', () => {
    const nodes = parseInline('см. https://example.com/~user/a~b тут');
    const link = nodes.find(n => n.type === 'link');
    assert.strictEqual(link.href, 'https://example.com/~user/a~b');
    assert.ok(!nodes.some(n => n.type === 'sub'), 'внутри адреса не должно быть разметки');
});

// --- прочее ---

test('ключ задачи распознаётся', () => {
    assert.strictEqual(shape(parseInline('см. ABC-123 подробнее')), 'см. issue(ABC-123) подробнее');
});

test('цвет разбирается и содержит вложенную разметку', () => {
    assert.strictEqual(shape(parseInline('{color:red}важно{color}')), 'color:red(важно)');
});

test('перенос строки', () => {
    assert.strictEqual(shape(parseInline('раз\\\\два')), 'разbreakдва');
});

test('неизвестный макрос отдаёт внутренний текст', () => {
    assert.strictEqual(shape(parseInline('{unknown}текст{unknown}')), 'текст');
});
```

Обратите внимание: индексы пишутся вплотную к основанию (`x^2^`, `H~2~O`), поэтому в ожидаемой строке между `x` и `sup(2)` пробела нет. Это же объясняет, почему `^` и `~` исключены из правила границ — см. следующий шаг.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test 'tests/js/*.test.js'`
Expected: FAIL — `Cannot find module '../../web/static/wiki-parser.js'`

- [ ] **Step 3: Создать файл и реализовать сканер**

Создать `web/static/wiki-parser.js`. Каркас файла — IIFE с двойным экспортом, как в `adf-parser.js`:

```js
// web/static/wiki-parser.js
// Разбор Jira wiki-разметки. Три шага: блоки -> инлайн -> HTML.
// HTML появляется только на последнем шаге, поэтому правила не могут
// испортить результат друг друга.

(function () {
    'use strict';

    // ... реализация ...

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { parseInline };
    }
    if (typeof window !== 'undefined') {
        window.parseJiraWiki = parseJiraWiki;
    }
})();
```

`parseJiraWiki` появится в задаче 4 — пока в `window`-строке её не упоминайте, добавьте только экспорт `parseInline` в `module.exports`.

Правило границ — ключевая часть, привожу дословно:

```js
    // Символы, после которых маркер может ОТКРЫВАТЬСЯ, и перед которыми — ЗАКРЫВАТЬСЯ.
    // Так ведёт себя сама Jira: маркер вплотную к букве или цифре разметкой не считается.
    // Именно это правило не даёт превратить user_name_id в курсив, а C++ — в подчёркивание.
    const OPEN_BEFORE = /[\s(\[{«"'—–-]/;   // начало строки тоже годится
    const CLOSE_AFTER = /[\s)\]}»"'.,;:!?—–-]/; // конец строки тоже годится

    function canOpenAt(text, i) {
        return i === 0 || OPEN_BEFORE.test(text[i - 1]);
    }

    function canCloseAt(text, i) {
        return i === text.length - 1 || CLOSE_AFTER.test(text[i + 1]);
    }
```

Маркеры и типы узлов:

```js
    const MARKERS = {
        '*': 'strong',
        '_': 'em',
        '-': 'strike',
        '+': 'underline',
        '^': 'sup',
        '~': 'sub',
    };

    // Правило границ применяется НЕ ко всем маркерам. Верхний и нижний индекс в
    // Jira пишутся вплотную к основанию — x^2^, H~2~O, — поэтому требование
    // «перед маркером пробел» их бы просто сломало.
    const BOUNDARY_SENSITIVE = new Set(['*', '_', '-', '+']);
```

То есть проверки `canOpenAt`/`canCloseAt` вызываются только для маркеров из `BOUNDARY_SENSITIVE`; для `^` и `~` достаточно найти парный символ с непустым содержимым между ними.

Сканер `parseInline(text)` идёт по строке слева направо и на каждой позиции пробует, в этом порядке:

1. `{{` — найти ближайшее `}}`; если найдено, выдать `{type:'code', text: <между>}` и перескочить за закрывающее. Внутрь не заходить.
2. `\\` — выдать `{type:'break'}`.
3. `[` — найти ближайшее `]` в пределах текущей строки. Содержимое разбить по первому `|`: слева подпись, справа адрес; если `|` нет, адрес и подпись совпадают. Адрес нормализовать: если не начинается с `http://`, `https://` или `mailto:`, добавить `https://`. Выдать `{type:'link', href, children: parseInline(<подпись>)}` — подпись разбирается рекурсивно, **адрес не разбирается никогда**.
4. `http://` или `https://` — забрать URL до пробела или одного из `<>"’)]`, выдать `{type:'link', href: url, children:[{type:'text', text: url}]}`. **Голые URL распознаются раньше маркеров намеренно:** иначе `~` внутри адреса вроде `https://example.com/~user/a~b` был бы съеден как нижний индекс — он ведь исключён из правила границ. Сделав URL непрозрачным заранее, мы снимаем весь этот класс проблем.
5. `{color:` — найти `}`, затем ближайшее `{color}`; выдать `{type:'color', color, children: parseInline(<между>)}`. Значение цвета валидировать тем же выражением, что и раньше: `/^(inherit|initial|revert|unset|[a-z]+|#[\da-f]{3,8})$/i`, иначе `inherit`.
6. Прочий `{макрос}` — найти `}`; если дальше встречается парный `{макрос}`, выдать содержимое как результат `parseInline`, иначе оставить текст как есть.
7. Символ из `MARKERS` — искать парный такой же символ правее, между которыми непустое содержимое. Для маркеров из `BOUNDARY_SENSITIVE` дополнительно требуется `canOpenAt` в начальной позиции и `canCloseAt` в конечной. Нашли — выдать узел соответствующего типа с `children: parseInline(<между>)`. Не нашли — символ становится обычным текстом.
8. Ключ задачи — совпадение `/^[A-Z]{2,6}-\d+\b/` в позиции, где `canOpenAt` истинно — выдать `{type:'issue', key}`.
9. Иначе — накапливать обычный текст.

Накопленный текст сбрасывается в узел `{type:'text'}` перед добавлением любого другого узла и в конце.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `node --test 'tests/js/*.test.js'`
Expected: все тесты `wiki-parser.test.js` зелёные, `dispatcher.test.js` по-прежнему зелёный

- [ ] **Step 5: Commit**

```bash
git add web/static/wiki-parser.js tests/js/wiki-parser.test.js
git commit -m "feat: инлайновый разбор wiki-разметки с правилом границ"
```

---

## Task 3: Блочный разбор

**Files:**
- Modify: `web/static/wiki-parser.js`
- Modify: `tests/js/wiki-parser.test.js`

**Interfaces:**
- Consumes: `parseInline` из задачи 2
- Produces: к `module.exports` добавляется `parseBlocks`. `parseBlocks(text) -> [блок]` по структурам из раздела «Внутренние структуры данных».

- [ ] **Step 1: Написать падающие тесты**

Дописать в `tests/js/wiki-parser.test.js`. Заменить первую строку импорта на:

```js
const { parseInline, parseBlocks } = require('../../web/static/wiki-parser.js');
```

и добавить в конец файла:

```js
test('абзацы разделяются пустой строкой', () => {
    const blocks = parseBlocks('первый\n\nвторой');
    assert.deepStrictEqual(blocks.map(b => b.type), ['paragraph', 'paragraph']);
    assert.strictEqual(blocks[0].text, 'первый');
    assert.strictEqual(blocks[1].text, 'второй');
});

test('соседние строки склеиваются в один абзац', () => {
    const blocks = parseBlocks('первая\nвторая');
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].text, 'первая\nвторая');
});

test('заголовки h1..h6', () => {
    const blocks = parseBlocks('h2. Заголовок');
    assert.deepStrictEqual(blocks, [{ type: 'heading', level: 2, text: 'Заголовок' }]);
});

test('блок кода сохраняет содержимое дословно', () => {
    const blocks = parseBlocks('{code}\nif (a*b) { return x_y_z; }\nhttps://example.com\n{code}');
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].type, 'code');
    assert.strictEqual(blocks[0].text, 'if (a*b) { return x_y_z; }\nhttps://example.com');
});

test('блок кода с языком', () => {
    const blocks = parseBlocks('{code:java}int x = 1;{code}');
    assert.strictEqual(blocks[0].language, 'java');
    assert.strictEqual(blocks[0].text, 'int x = 1;');
});

test('noformat даёт такой же блок кода', () => {
    const blocks = parseBlocks('{noformat}a*b{noformat}');
    assert.strictEqual(blocks[0].type, 'code');
    assert.strictEqual(blocks[0].text, 'a*b');
});

test('незакрытый блок кода поглощает текст до конца', () => {
    const blocks = parseBlocks('{code}\nхвост без закрытия');
    assert.strictEqual(blocks[0].type, 'code');
    assert.strictEqual(blocks[0].text, 'хвост без закрытия');
});

test('цитата содержит вложенные блоки', () => {
    const blocks = parseBlocks('{quote}текст цитаты{quote}');
    assert.strictEqual(blocks[0].type, 'quote');
    assert.strictEqual(blocks[0].blocks[0].type, 'paragraph');
    assert.strictEqual(blocks[0].blocks[0].text, 'текст цитаты');
});

test('панель с заголовком и без', () => {
    const withTitle = parseBlocks('{panel:title=Важно}Текст{panel}')[0];
    assert.strictEqual(withTitle.type, 'panel');
    assert.strictEqual(withTitle.title, 'Важно');
    assert.strictEqual(withTitle.blocks[0].text, 'Текст');

    const noTitle = parseBlocks('{panel}Текст{panel}')[0];
    assert.strictEqual(noTitle.title, null);
});

test('горизонтальная линия', () => {
    assert.deepStrictEqual(parseBlocks('----'), [{ type: 'rule' }]);
});

test('пустой ввод даёт пустой список блоков', () => {
    assert.deepStrictEqual(parseBlocks(''), []);
    assert.deepStrictEqual(parseBlocks('   \n  \n'), []);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test 'tests/js/*.test.js'`
Expected: FAIL — `parseBlocks is not a function`

- [ ] **Step 3: Реализовать блочный разбор**

В `web/static/wiki-parser.js` добавить `parseBlocks(text)`: разбить ввод на строки по `\n` и идти по ним с индексом, распознавая в этом порядке:

1. **Открытие `{code}` / `{code:язык}` / `{noformat}`** — определяется по началу строки. Собрать строки до строки, содержащей закрывающий маркер (`{code}` или `{noformat}` соответственно); если закрытия нет — до конца ввода. Выдать `{type:'code', text, language}`, где `text` — собранные строки, соединённые `\n`, без обрамляющих маркеров, с обрезанными пустыми строками по краям. Открывающая и закрывающая разметка может быть на той же строке, что и содержимое (`{code}x{code}`) — этот случай обработать отдельно, до многострочного.
2. **`{quote}` … `{quote}`** и **`{panel[:title=…]}` … `{panel}`** — собрать содержимое так же, но затем разобрать его рекурсивным вызовом `parseBlocks`. Для панели вынуть `title` из `title=` в открывающем маркере, иначе `null`.
3. **`----`** (строка целиком из четырёх и более дефисов) — `{type:'rule'}`.
4. **`h1.`–`h6.` плюс пробел** — `{type:'heading', level, text}`.
5. **Строка начинается с `|`** — таблица; передать управление обработчику из задачи 4. **До задачи 4 такие строки трактовать как обычный текст** — тест на таблицы появится в задаче 4.
6. **Строка начинается с серии `*`, `-` или `#`, за которой пробел** — список; так же передать обработчику из задачи 4, до неё — обычный текст.
7. **Пустая строка** — завершает текущий абзац.
8. **Прочее** — накапливать в текущий абзац; строки внутри абзаца соединяются `\n`.

Экспорт дополнить: `module.exports = { parseInline, parseBlocks };`

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `node --test 'tests/js/*.test.js'`
Expected: все зелёные

- [ ] **Step 5: Commit**

```bash
git add web/static/wiki-parser.js tests/js/wiki-parser.test.js
git commit -m "feat: блочный разбор wiki-разметки"
```

---

## Task 4: Списки, таблицы, сборка HTML и публичная функция

Самая крупная задача: два самых сломанных блочных типа плюс вывод.

**Files:**
- Modify: `web/static/wiki-parser.js`
- Modify: `tests/js/wiki-parser.test.js`

**Interfaces:**
- Consumes: `parseInline`, `parseBlocks`
- Produces: к `module.exports` добавляется `parseJiraWiki`. `parseJiraWiki(text) -> string` — готовый HTML, обёрнутый в `<div class="jira-doc">`. На `window` вешается `window.parseJiraWiki`.

- [ ] **Step 1: Написать падающие тесты**

Заменить строку импорта в `tests/js/wiki-parser.test.js` на:

```js
const { parseInline, parseBlocks, parseJiraWiki } = require('../../web/static/wiki-parser.js');
```

и дописать в конец:

```js
// --- списки ---

test('маркированный список без br между пунктами', () => {
    const html = parseJiraWiki('* первый\n* второй');
    assert.match(html, /<ul><li>первый<\/li><li>второй<\/li><\/ul>/);
    assert.ok(!/<ul>[\s\S]*<br>[\s\S]*<\/ul>/.test(html), 'внутри списка не должно быть <br>');
});

test('нумерованный список даёт корректно вложенные теги', () => {
    const html = parseJiraWiki('# раз\n# два');
    assert.match(html, /<ol><li>раз<\/li><li>два<\/li><\/ol>/);
});

test('вложенный список', () => {
    const html = parseJiraWiki('* внешний\n** внутренний');
    assert.match(html, /<ul><li>внешний<ul><li>внутренний<\/li><\/ul><\/li><\/ul>/);
});

test('дефис тоже маркер списка', () => {
    assert.match(parseJiraWiki('- пункт'), /<ul><li>пункт<\/li><\/ul>/);
});

// --- таблицы ---

test('таблица: заголовок в th, строки данных отрисованы', () => {
    const html = parseJiraWiki('||Имя||Тип||\n|user_id|int|\n|name|string|');
    assert.match(html, /<th>Имя<\/th><th>Тип<\/th>/);
    assert.match(html, /<td>user_id<\/td><td>int<\/td>/);
    assert.match(html, /<td>name<\/td><td>string<\/td>/);
    assert.ok(!/<tbody>[\s\S]*<br>[\s\S]*<\/tbody>/.test(html), 'внутри таблицы не должно быть <br>');
});

test('таблица без заголовочной строки', () => {
    const html = parseJiraWiki('|a|b|');
    assert.match(html, /<td>a<\/td><td>b<\/td>/);
    assert.ok(!/<th>/.test(html));
});

// --- регрессии на найденные поломки ---

test('регрессия: идентификатор с подчёркиваниями цел', () => {
    const html = parseJiraWiki('Поле user_name_id пустое');
    assert.match(html, /user_name_id/);
    assert.ok(!/<em>/.test(html));
});

test('регрессия: адрес ссылки не искажается', () => {
    const html = parseJiraWiki('[Дока|https://wiki.corp/api_v2_spec]');
    assert.match(html, /href="https:\/\/wiki\.corp\/api_v2_spec"/);
    assert.ok(!/&lt;em&gt;/.test(html));
});

test('регрессия: C++ и Java+Kotlin целы', () => {
    const html = parseJiraWiki('Нужно C++ и Java+Kotlin');
    assert.match(html, /C\+\+/);
    assert.ok(!/<u>/.test(html));
});

test('регрессия: классы панели не повреждены', () => {
    const html = parseJiraWiki('{panel:title=Важно}Текст панели{panel}');
    assert.match(html, /class="jira-panel jira-panel-info"/);
    assert.match(html, /class="jira-panel-title"/);
    assert.ok(!/<s>/.test(html), 'дефисы в именах классов не должны стать зачёркиванием');
});

test('регрессия: содержимое блока кода дословно', () => {
    const html = parseJiraWiki('{code}\nif (a*b) { return x_y_z; }\nhttps://example.com\n{code}');
    assert.match(html, /<pre class="jira-code"><code>/);
    assert.ok(!/<a /.test(html), 'URL внутри кода не должен стать ссылкой');
    assert.ok(!/<br>/.test(html), 'переводы строк внутри кода не должны стать <br>');
    assert.match(html, /x_y_z/);
});

// --- вывод и экранирование ---

test('вывод обёрнут в jira-doc', () => {
    assert.match(parseJiraWiki('текст'), /^<div class="jira-doc">/);
});

test('опасные символы экранируются', () => {
    const html = parseJiraWiki('<script>alert(1)</script> & "кавычки"');
    assert.ok(!/<script>/.test(html));
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&amp;/);
});

test('пустой ввод даёт пустую строку', () => {
    assert.strictEqual(parseJiraWiki(''), '');
});

// --- то, что работало раньше, продолжает работать (из tests/e2e/fixtures/wiki-samples.ts) ---

test('образцы из wiki-samples по-прежнему разбираются', () => {
    assert.match(parseJiraWiki('This is *bold* text'), /<strong>bold<\/strong>/);
    assert.match(parseJiraWiki('This is _italic_ text'), /<em>italic<\/em>/);
    assert.match(parseJiraWiki('Use {{var}} here'), /<code>var<\/code>/);
    assert.match(parseJiraWiki('-deleted- text'), /<s>deleted<\/s>/);
    const h = parseJiraWiki('h2. Title');
    assert.match(h, /<h2>/); assert.match(h, /Title/); assert.match(h, /<\/h2>/);
    const cb = parseJiraWiki('{code}print("hi"){code}');
    assert.match(cb, /<pre class="jira-code">/); assert.match(cb, /<code>/); assert.match(cb, /print/);
    const link = parseJiraWiki('[text|https://example.com]');
    assert.match(link, /<a href="https:\/\/example\.com"/); assert.match(link, /text/);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test 'tests/js/*.test.js'`
Expected: FAIL — `parseJiraWiki is not a function`

- [ ] **Step 3: Реализовать списки и таблицы в блочном разборе**

**Списки.** Строка вида `^(\s*)([*\-#]+)\s+(.*)$`. Глубина — длина серии маркеров. Тип уровня — по **первому** символу серии: `#` даёт `ordered: true`, `*` и `-` — `ordered: false`. Собрать подряд идущие строки-пункты в дерево: пункт глубины `n+1` становится элементом `children` последнего пункта глубины `n`. Результат — блок `{type:'list', ordered, items}`, где каждый `item` это `{text, children}`, а `children` — либо вложенный блок `list`, либо `null`.

**Таблицы.** Подряд идущие строки, начинающиеся с `|`. Для каждой: если строка начинается с `||`, это заголовочная строка, ячейки разделены `||`; иначе обычная, ячейки разделены `|`. Обрамляющие разделители отбрасываются, каждая ячейка обрезается по краям. Результат — `{type:'table', rows}`.

**Важно:** в задаче 3 строки, начинающиеся с `|` и с маркеров списка, временно трактовались как обычный текст — теперь эти ветки надо задействовать по-настоящему.

- [ ] **Step 4: Реализовать сборку HTML**

Добавить `renderBlocks(blocks)` и `renderInline(nodes)`; экранирование только здесь, функцией.

Эта функция намеренно повторяет одноимённую из `adf-parser.js`. Общего модуля у файлов нет: оба — обычные `<script>` без сборщика, и вынесение шестистрочной чистой функции в третий файл добавило бы ещё одну зависимость по порядку загрузки ради экономии шести строк. Дублирование здесь дешевле связанности.

```js
    function escapeHtml(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
```

Соответствие блоков и разметки — эти классы завязаны на существующие стили, менять нельзя:

| Блок | HTML |
|---|---|
| `paragraph` | `<p>…</p>` |
| `heading` | `<h1>`…`<h6>` |
| `code` | `<pre class="jira-code"><code>` + экранированный текст дословно + `</code></pre>`; при наличии языка — `<code data-language="…">` |
| `quote` | `<blockquote>` + вложенные блоки + `</blockquote>` |
| `panel` | `<div class="jira-panel jira-panel-info">` + при наличии заголовка `<div class="jira-panel-title">…</div>` + `<div class="jira-panel-content">` + вложенные блоки + `</div></div>` |
| `rule` | `<hr>` |
| `list` | `<ul>`/`<ol>` + для каждого пункта `<li>` + инлайн + вложенный список, если есть + `</li>` |
| `table` | `<table class="jira-table"><tbody>` + строки + `</tbody></table>`; ячейки `<th>` для заголовочных строк, `<td>` для обычных |

Инлайновые узлы: `text` → экранированный текст; `strong`/`em`/`strike`/`underline`/`sup`/`sub` → `<strong>`/`<em>`/`<s>`/`<u>`/`<sup>`/`<sub>`; `code` → `<code>` с экранированным текстом; `link` → `<a href="…" target="_blank" class="jira-desc-link">` с экранированным адресом; `color` → `<span style="color:…">`; `issue` → `<span class="jira-task-ref">`; `break` → `<br>`.

Публичная функция:

```js
    function parseJiraWiki(text) {
        if (!text) return '';
        const blocks = parseBlocks(String(text));
        if (blocks.length === 0) return '';
        return '<div class="jira-doc">' + renderBlocks(blocks) + '</div>';
    }
```

Экспорт: `module.exports = { parseInline, parseBlocks, parseJiraWiki };` и `window.parseJiraWiki = parseJiraWiki;`

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `node --test 'tests/js/*.test.js'`
Expected: все зелёные

- [ ] **Step 6: Commit**

```bash
git add web/static/wiki-parser.js tests/js/wiki-parser.test.js
git commit -m "feat: списки, таблицы и сборка HTML в wiki-парсере"
```

---

## Task 5: Подключение и удаление старого кода

**Files:**
- Modify: `web/static/adf-parser.js` (удалить `parseWikiMarkup`, переключить диспетчер)
- Modify: `web/templates/index.html:432`
- Modify: `tests/js/dispatcher.test.js`

**Interfaces:**
- Consumes: `parseJiraWiki` из задачи 4
- Produces: ничего для последующих задач

- [ ] **Step 1: Написать падающие тесты**

Дописать в `tests/js/dispatcher.test.js`:

```js
const { parseJiraWiki } = require('../../web/static/wiki-parser.js');

test('диспетчер: строка идёт в wiki-ветку', () => {
    assert.strictEqual(parseJiraDescription('*жирный*'), parseJiraWiki('*жирный*'));
});

test('диспетчер: не строка и не ADF приводится к экранированной строке', () => {
    assert.strictEqual(parseJiraDescription(42), '42');
});

test('диспетчер: wiki-ветка больше не искажает адреса', () => {
    const html = parseJiraDescription('[Дока|https://wiki.corp/api_v2_spec]');
    assert.match(html, /href="https:\/\/wiki\.corp\/api_v2_spec"/);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test 'tests/js/*.test.js'`
Expected: FAIL — диспетчер пока зовёт старую `parseWikiMarkup`, адрес искажён

- [ ] **Step 3: Переключить диспетчер и удалить старый код**

В `web/static/adf-parser.js`:

- удалить целиком функцию `parseWikiMarkup` (секция `// ========== WIKI → HTML ==========`);
- в `parseJiraDescription` заменить ветку для строки на вызов wiki-парсера, с защитой на случай, если файл не загрузился:

```js
        if (typeof desc === 'string') {
            const wiki = (typeof module !== 'undefined' && module.exports)
                ? require('./wiki-parser.js').parseJiraWiki
                : (typeof window !== 'undefined' ? window.parseJiraWiki : null);
            // Если wiki-parser.js не подключён, отдаём экранированный текст,
            // а не падаем: описание задачи важнее разметки.
            return wiki ? wiki(desc) : escapeHtml(desc);
        }
```

- [ ] **Step 4: Подключить скрипт на странице**

В `web/templates/index.html` перед строкой 432 (`<script src="/static/adf-parser.js"></script>`) добавить:

```html
    <script src="/static/wiki-parser.js"></script>
```

Порядок важен: `adf-parser.js` при загрузке в браузере рассчитывает найти `window.parseJiraWiki`.

- [ ] **Step 5: Убедиться, что все тесты проходят**

Run: `node --test 'tests/js/*.test.js'`
Expected: все зелёные

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest -q && .venv/bin/ruff check .`
Expected: `285 passed`, `All checks passed!`

- [ ] **Step 6: Проверить в браузере на составном описании**

Поднять дев-сервер (см. ниже), открыть страницу, выполнить в консоли:

```js
document.body.insertAdjacentHTML('afterbegin',
  '<div class="jira-description" style="position:fixed;z-index:9999;top:0;left:0;right:0;max-height:60vh;overflow:auto;background:#111;padding:12px">'
  + parseJiraDescription(
      'h2. Заголовок\n\nПоле user_name_id и C++ целы.\n\n'
    + '* первый\n** вложенный\n* второй\n\n'
    + '# раз\n# два\n\n'
    + '||Имя||Тип||\n|user_id|int|\n|name|string|\n\n'
    + '{code}\nif (a*b) { return x_y_z; }\nhttps://example.com\n{code}\n\n'
    + '{panel:title=Важно}Текст панели{panel}\n\n'
    + 'Ссылка [Дока|https://wiki.corp/api_v2_spec] и задача ABC-123.'
    )
  + '</div>');
```

Expected глазами: заголовок крупнее; `user_name_id` и `C++` без искажений; вложенный список отрисован вложенным, без лишних отступов и `<br>`; нумерованный список нумерованный; таблица со шапкой и двумя строками, с рамками; блок кода моноширинный, ссылка внутри него — обычный текст; панель с заливкой и заголовком; ссылка кликабельна и ведёт на `https://wiki.corp/api_v2_spec` (проверить через `document.querySelector('.jira-desc-link').href`); ключ задачи выделен цветом. В консоли нет ошибок.

- [ ] **Step 7: Commit**

```bash
git add web/static/adf-parser.js web/templates/index.html tests/js/dispatcher.test.js
git commit -m "feat: подключить новый wiki-парсер и удалить старый"
```

---

## Дев-сервер для ручных проверок

`python main.py` не годится — требует настоящий токен Telegram и поднимает бота. `uvicorn --factory` тоже — `build_app` корутина, а соединение с SQLite должно жить в том же event loop. Сохранить `/tmp/ppdev.py`:

```python
import asyncio

import uvicorn

from app import build_app


async def main():
    app = await build_app()
    config = uvicorn.Config(app, host="127.0.0.1", port=8010, log_level="warning")
    await uvicorn.Server(config).serve()


asyncio.run(main())
```

Запуск из корня репозитория (шаблоны и статика ищутся по относительным путям):

```bash
PYTHONPATH=/Users/light-bearing/ai-projects/tg_poker_planing PP_BOT_TOKEN=test:token PP_BOT_DB_PATH=/tmp/ppdev-wiki.db .venv/bin/python /tmp/ppdev.py
```

Порт 8010 выбран потому, что 8000 и 8001 на этой машине бывают заняты посторонними процессами. Останавливать — Ctrl+C или `pkill -f ppdev.py`.

## Финальная проверка

- [ ] **Step 1: Полный прогон**

Run: `node --test 'tests/js/*.test.js'`
Expected: все зелёные

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest -q && .venv/bin/ruff check .`
Expected: `285 passed`, `All checks passed!`

- [ ] **Step 2: Проверить состав изменений**

Run: `git diff main --stat`
Expected: изменены только `web/static/wiki-parser.js` (новый), `web/static/adf-parser.js`, `web/templates/index.html`, `tests/js/*` (новые), `docs/superpowers/`. Каталоги `browser-extension/` и питоновский код не тронуты.

- [ ] **Step 3: Убедиться, что старого кода не осталось**

Run: `grep -n "parseWikiMarkup" web/static/*.js`
Expected: совпадений нет
