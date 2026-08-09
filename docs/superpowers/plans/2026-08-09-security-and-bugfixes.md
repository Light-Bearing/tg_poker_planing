# Security Hardening & Bugfixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть XSS через имя участника, утечку голосов до вскрытия карт и секреты в репозитории; починить устаревшее состояние игры в WebSocket, неработающую смену шкалы, теряющиеся WS-ошибки и невызываемую очистку сессий.

**Architecture:** Правки точечные, внутри существующей структуры (`web_api.py`, `websocket_handler.py`, `connection.py`, `app.py`, `web/static/script.js`, `web/templates/index.html`). Новых модулей нет. Защита от XSS делается в два независимых слоя: серверная валидация имени на входе и экранирование при выводе на фронте. Inline-обработчики `onclick` с интерполяцией пользовательских данных заменяются на `data-*` атрибуты плюс делегирование событий.

**Tech Stack:** Python 3.11, Starlette 0.36, aiosqlite, pytest + pytest-asyncio (`asyncio_mode = "auto"`), ruff 0.4.4, vanilla JS.

**Спека:** `docs/superpowers/specs/2026-08-09-security-and-bugfixes-design.md`

## Global Constraints

- Ветка: `fix/security-and-bugs`. Рабочая копия: `/Users/light-bearing/ai-projects/tg_poker_planing`.
- Python 3.11 — на 3.12+ пины из `requirements.txt` не собираются, `Dockerfile` использует `python:3.11-alpine`.
- Обновление зависимостей, CI, разделение prod/dev requirements — **вне scope** этого плана.
- Переделка браузерного расширения (`browser-extension/`) — **вне scope**, отдельная ветка. В этом плане файлы расширения не трогаются.
- Переписывание git-истории — **вне scope**. Ни один шаг не делает `git push --force` и не вызывает `git filter-repo`.
- Аутентификация веб-интерфейса — **вне scope**.
- После каждого коммита прогоняются оба: `pytest` и `ruff check .`.
- Все сообщения об ошибках, видимые пользователю в UI, — на русском (как в существующем коде). Сообщения REST API — на английском (как в существующем коде).
- Существующие 243 теста должны оставаться зелёными, кроме одного, который явно переписывается в Task 4.

## Подготовка окружения (выполнить один раз перед Task 1)

В репозитории нет `.venv`, а системный Python на этой машине — 3.14, на котором `requirements.txt` не ставится (`websockets==12.0` не имеет сборок). Поднимаем 3.11 через `uv`. Домашний каталог `uv` в песочнице недоступен на запись, поэтому пути переопределяются:

```bash
cd /Users/light-bearing/ai-projects/tg_poker_planing
export UV_PYTHON_INSTALL_DIR=/private/tmp/claude-501/-Users-light-bearing-ai-projects/47ac9fd7-cf94-48da-9efc-0de37d071c44/scratchpad/uvpy
export UV_CACHE_DIR=/private/tmp/claude-501/-Users-light-bearing-ai-projects/47ac9fd7-cf94-48da-9efc-0de37d071c44/scratchpad/uvcache
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -r requirements.txt
```

Проверка, что окружение живое (должно быть `243 passed`):

```bash
PP_BOT_TOKEN=test:token .venv/bin/python -m pytest -q
```

`PP_BOT_TOKEN` обязателен: `config.py` бросает `ValueError` при импорте без токена. Значение `test:token` фиктивное, сеть не используется.

`.venv` уже перечислен в `.gitignore` (строка 143) — коммитить его не нужно.

**Команды, используемые дальше по плану:**

- Все тесты: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest -q`
- Один тест: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest tests/test_app.py::TestName::test_name -v`
- Линтер: `.venv/bin/ruff check .`

**Дев-сервер для ручных проверок.** `python main.py` не годится: он поднимает Telegram-бота и требует настоящий токен. `uvicorn --factory app:build_app` тоже не годится: `build_app` — корутина, а `--factory` её не ожидает. Соединение с SQLite создаётся внутри `build_app`, поэтому приложение и сервер должны жить в одном event loop. Рабочий вариант — сохранить в `/tmp/ppdev.py`:

```python
import asyncio

import uvicorn

from app import build_app


async def main():
    app = await build_app()
    config = uvicorn.Config(app, host="127.0.0.1", port=8000, log_level="info")
    await uvicorn.Server(config).serve()


asyncio.run(main())
```

и запускать из корня репозитория (шаблоны и статика ищутся по относительным путям):

```bash
PP_BOT_TOKEN=test:token PP_BOT_DB_PATH=/tmp/ppdev.db .venv/bin/python /tmp/ppdev.py
```

Дальше по плану этот запуск упоминается как «поднять дев-сервер». Останавливать — Ctrl+C.

---

## Task 1: Секреты — вычистить `.env.example` и поставить заслон

Закрывает S1 спеки. Тестов нет: изменения затрагивают только конфигурационные файлы и документацию.

**Files:**
- Modify: `.env.example` (целиком переписывается)
- Modify: `.pre-commit-config.yaml`
- Modify: `README.md` (раздел «Настройка переменных окружения», около строки 66)

**Interfaces:**
- Consumes: ничего
- Produces: ничего для последующих задач

- [ ] **Step 1: Переписать `.env.example` на плейсхолдеры**

Текущий файл содержит настоящий токен Telegram-бота и настоящий VK-токен в закомментированных «примерах». Заменить содержимое файла целиком на:

```bash
# Обязательные переменные
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here

# Путь к файлу базы данных
PP_BOT_DB_PATH=/tmp/tg_pp_bot.db

# Порт веб-сервера
PORT=8000

# Прокси для Telegram (опционально, HTTP или SOCKS5)
# PROXY_URL=http://127.0.0.1:8080
# PROXY_URL=socks5://username:password@proxy.example.com:1080

# URL для webhook-режима (опционально)
# WEBHOOK_URL=https://your-domain.com

# Разрешённые CORS-origin через запятую (по умолчанию *)
# CORS_ORIGINS=https://poker.example.com
```

Обратить внимание: старый файл использовал переменные `DB_LOCATION`, `DB_NAME` и `PP_BOT_TOKEN`, которых нет в `config.py` (там читаются `PP_BOT_DB_PATH` и `TELEGRAM_BOT_TOKEN`/`PP_BOT_TOKEN`). Новый файл приведён в соответствие с `config.py`.

- [ ] **Step 2: Добавить gitleaks в pre-commit**

В `.pre-commit-config.yaml` добавить блок перед `- repo: local`:

```yaml
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.4
    hooks:
      - id: gitleaks
```

- [ ] **Step 3: Предупреждение в README**

В `README.md` в разделе «### 3. Настройка переменных окружения», сразу после строки `Создайте файл `.env` в корне проекта:`, вставить:

> ⚠️ **Никогда не коммитьте `.env` и не вписывайте реальные токены в `.env.example`.** `.env` уже в `.gitignore`. В репозитории настроен hook `gitleaks` — установите его командой `pre-commit install`, чтобы коммит с секретом не прошёл. Если токен всё же попал в историю, его нужно отозвать: для бота — команда `/revoke` у [@BotFather](https://t.me/BotFather).

- [ ] **Step 4: Проверить, что в рабочем дереве не осталось секретов**

Run: `grep -rn "AAHqPK\|vk1\.a\." --exclude-dir=.git --exclude-dir=.venv .`
Expected: пусто (совпадений нет). Если что-то нашлось — удалить.

Историю git этот шаг не проверяет и не меняет: токены там остаются, и это осознанное решение из спеки.

- [ ] **Step 5: Прогнать тесты и линтер**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest -q && .venv/bin/ruff check .`
Expected: `243 passed`, `All checks passed!`

- [ ] **Step 6: Commit**

```bash
git add .env.example .pre-commit-config.yaml README.md
git commit -m "security: remove real tokens from .env.example, add gitleaks hook"
```

---

## Task 2: Серверная валидация имени участника

Закрывает первый слой S3. Имя участника попадает в `game.votes` (как `web_{username}`), в `manager.session_users` и в каждый broadcast. Сейчас оно принимается как есть.

**Files:**
- Modify: `web_api.py` (добавить `validate_username`; применить в `api_create_session`, `api_vote`, `api_restart`, `api_reveal`, `api_kick_user`)
- Modify: `websocket_handler.py` (ветка `join` в `websocket_endpoint`)
- Test: `tests/test_app.py` (юнит-тесты `validate_username`)
- Test: `tests/test_api.py` (интеграционные тесты REST)

**Interfaces:**
- Consumes: ничего
- Produces: `validate_username(raw: str) -> str | None` в `web_api.py` — возвращает нормализованное (обрезанное по краям) имя или `None`, если имя недопустимо. Используется в Task 6 не будет; это финальная точка для валидации имён.

- [ ] **Step 1: Написать падающие юнит-тесты**

В `tests/test_app.py` добавить в конец файла:

```python
class TestValidateUsername:
    def test_accepts_plain_latin(self):
        from web_api import validate_username

        assert validate_username("alice") == "alice"

    def test_accepts_cyrillic(self):
        from web_api import validate_username

        assert validate_username("Аня") == "Аня"

    def test_accepts_spaces_hyphen_dot_underscore(self):
        from web_api import validate_username

        assert validate_username("Jean-Luc P. ivanov_1") == "Jean-Luc P. ivanov_1"

    def test_strips_surrounding_whitespace(self):
        from web_api import validate_username

        assert validate_username("  bob  ") == "bob"

    def test_rejects_empty(self):
        from web_api import validate_username

        assert validate_username("") is None
        assert validate_username("   ") is None

    def test_rejects_html_tags(self):
        from web_api import validate_username

        assert validate_username("<img src=x onerror=alert(1)>") is None

    def test_rejects_quote_used_for_js_breakout(self):
        from web_api import validate_username

        assert validate_username("'),alert(1)//") is None

    def test_rejects_newline(self):
        from web_api import validate_username

        assert validate_username("bob\nadmin") is None

    def test_rejects_too_long(self):
        from web_api import validate_username

        assert validate_username("a" * 33) is None

    def test_accepts_max_length(self):
        from web_api import validate_username

        assert validate_username("a" * 32) == "a" * 32
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest tests/test_app.py::TestValidateUsername -v`
Expected: FAIL — `ImportError: cannot import name 'validate_username' from 'web_api'`

- [ ] **Step 3: Реализовать `validate_username`**

В `web_api.py` добавить `import re` к существующим импортам вверху файла (порядок: `re`, `time`, `uuid` — ruff правило `I` требует алфавитного порядка в блоке stdlib), и вставить сразу после блока `# ========== SIMPLE RATE LIMITER ==========` … `_check_rate_limit`, перед `game_to_web_response`:

```python
# ========== USERNAME VALIDATION ==========
# \w покрывает буквы любого алфавита и цифры; дополнительно разрешены пробел,
# дефис и точка. Всё остальное (< > " ' & перевод строки) отсекается, потому что
# имя попадает в HTML и в JS-контекст на фронте.
USERNAME_RE = re.compile(r"[\w \-.]{1,32}", re.UNICODE)


def validate_username(raw: str) -> str | None:
    """Нормализует имя участника. Возвращает None, если имя недопустимо."""
    name = (raw or "").strip()
    if not USERNAME_RE.fullmatch(name):
        return None
    return name
```

- [ ] **Step 4: Убедиться, что юнит-тесты проходят**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest tests/test_app.py::TestValidateUsername -v`
Expected: 10 passed

- [ ] **Step 5: Написать падающие интеграционные тесты**

В `tests/test_api.py` добавить в конец файла:

```python
BAD_NAME = "<img src=x onerror=alert(1)>"
NAME_ERROR = "Username must be 1-32 characters: letters, digits, spaces, - . _"


class TestUsernameValidation:
    def test_create_session_rejects_bad_username(self, client):
        r = client.post("/api/sessions", json={"username": BAD_NAME, "text": "task"})
        assert r.status_code == 400
        assert r.json()["error"] == NAME_ERROR

    def test_create_session_accepts_cyrillic(self, client):
        r = client.post("/api/sessions", json={"username": "Аня", "text": "task"})
        assert r.status_code == 200
        assert r.json()["initiator_name"] == "Аня"

    def test_vote_rejects_bad_username(self, client):
        created = client.post("/api/sessions", json={"username": "alice", "text": "task"}).json()
        r = client.post(f"/api/sessions/{created['session_id']}/vote", json={"username": BAD_NAME, "point": "5"})
        assert r.status_code == 400
        assert r.json()["error"] == NAME_ERROR

    def test_kick_rejects_bad_target_username(self, client):
        created = client.post("/api/sessions", json={"username": "alice", "text": "task"}).json()
        r = client.post(
            f"/api/sessions/{created['session_id']}/kick",
            json={"username": "alice", "target_username": BAD_NAME},
        )
        assert r.status_code == 400
        assert r.json()["error"] == NAME_ERROR
```

- [ ] **Step 6: Убедиться, что интеграционные тесты падают**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest tests/test_api.py::TestUsernameValidation -v`
Expected: FAIL — сервер возвращает 200 вместо 400 (имя принимается как есть)

- [ ] **Step 7: Применить валидацию в `web_api.py`**

Добавить константу рядом с `USERNAME_RE`:

```python
USERNAME_ERROR = "Username must be 1-32 characters: letters, digits, spaces, - . _"
```

В `api_create_session` заменить:

```python
        username, text = data.get("username", "").strip(), data.get("text", "").strip()
        if not username:
            return JSONResponse({"error": "Username is required"}, status_code=400)
```

на:

```python
        username = validate_username(data.get("username", ""))
        text = data.get("text", "").strip()
        if not username:
            return JSONResponse({"error": USERNAME_ERROR}, status_code=400)
```

В `api_vote` заменить:

```python
        username, point = data.get("username", "").strip(), data.get("point", "").strip()
        if not username or not point:
            return JSONResponse({"error": "Username and point are required"}, status_code=400)
```

на:

```python
        username = validate_username(data.get("username", ""))
        point = data.get("point", "").strip()
        if not username:
            return JSONResponse({"error": USERNAME_ERROR}, status_code=400)
        if not point:
            return JSONResponse({"error": "Username and point are required"}, status_code=400)
```

Сообщение `"Username and point are required"` сохранено дословно: существующий тест на пустой `point` его проверяет.

В `api_restart` заменить:

```python
        username, new_text = data.get("username", "").strip(), data.get("new_text", "").strip()
```

на:

```python
        username = validate_username(data.get("username", ""))
        new_text = data.get("new_text", "").strip()
        if not username:
            return JSONResponse({"error": USERNAME_ERROR}, status_code=400)
```

В `api_reveal` заменить:

```python
        username = data.get("username", "").strip()
```

на:

```python
        username = validate_username(data.get("username", ""))
        if not username:
            return JSONResponse({"error": USERNAME_ERROR}, status_code=400)
```

Проверка имени встаёт перед чтением игры из БД. Существующие тесты `test_reveal_session_not_found` и `test_restart_session_not_found` подают валидное имя `Alice`, поэтому продолжают получать 404, а не 400.

В `api_kick_user` заменить:

```python
        username = data.get("username", "").strip()
        target_username = data.get("target_username", "").strip()
        if not username or not target_username:
            return JSONResponse({"error": "username and target_username are required"}, status_code=400)
```

на:

```python
        username = validate_username(data.get("username", ""))
        target_username = validate_username(data.get("target_username", ""))
        if not username or not target_username:
            return JSONResponse({"error": USERNAME_ERROR}, status_code=400)
```

- [ ] **Step 8: Применить валидацию в WebSocket-ветке `join`**

В `websocket_handler.py` расширить импорт из `web_api`:

```python
from web_api import enrich_session_response, process_web_vote, validate_username
```

В `websocket_endpoint` в ветке `if msg_type == "join":` заменить:

```python
                        username = msg.get("username")
                        if username:
```

на:

```python
                        username = validate_username(msg.get("username", ""))
                        if not username:
                            await websocket.send_json(
                                {"type": "error", "message": "Недопустимое имя участника"}
                            )
                        else:
```

Важно: при невалидном имени переменная `username` остаётся `None`, и `except`-ветки внизу корректно пропустят `unregister_ws_connection` и `transfer_initiator_if_needed` — они уже под `if username:`.

- [ ] **Step 9: Прогнать все тесты и линтер**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest -q && .venv/bin/ruff check .`
Expected: 257 passed, `All checks passed!`

Если падает какой-то из ранее существовавших тестов — он подавал имя, не проходящее валидацию. Проверить: если имя в тесте безобидное (например, `web_alice` — подчёркивание разрешено), проблема в регулярке; если имя намеренно странное, поправить тест.

- [ ] **Step 10: Commit**

```bash
git add web_api.py websocket_handler.py tests/test_app.py tests/test_api.py
git commit -m "security: validate participant username on server side"
```

---

## Task 3: Экранирование имени участника на фронте

Закрывает второй слой S3. Даже с серверной валидацией вывод должен экранироваться — это независимая линия обороны, и она снимает весь класс проблем со вставкой в JS-контекст.

**Files:**
- Modify: `web/static/script.js` (`renderParticipants`, около строк 2504–2542; блок `DOMContentLoaded`, около строки 1877)

**Interfaces:**
- Consumes: `escapeHtml(text)` — уже существует в `script.js:1285`
- Produces: делегированный слушатель на `#participantsList`, читающий `data-username` у `.kick-btn`

- [ ] **Step 1: Экранировать имя в `renderParticipants`**

В `web/static/script.js` в `grid.innerHTML = pList.map(p => {` в самое начало колбэка, перед `let voteDisplay;`, добавить:

```js
        const safeName = escapeHtml(p.username);
```

Затем в возвращаемом шаблоне заменить три интерполяции. Было:

```js
                    <span class="participant-name" title="${p.username}">${p.username}</span>
                    ${p.isYou ? '<span class="participant-badge">ВЫ</span>' : ''}
                    ${state.isInitiator && p.username !== state.username ? `<button class="kick-btn" data-username="${p.username}" onclick="kickParticipant('${p.username}')" title="Исключить">✕</button>` : ''}
```

Стало:

```js
                    <span class="participant-name" title="${safeName}">${safeName}</span>
                    ${p.isYou ? '<span class="participant-badge">ВЫ</span>' : ''}
                    ${state.isInitiator && p.username !== state.username ? `<button class="kick-btn" data-username="${safeName}" title="Исключить">✕</button>` : ''}
```

Inline-обработчик `onclick` удалён полностью: HTML-экранирования недостаточно для JS-строкового контекста, поэтому такой паттерн не чинится, а убирается.

- [ ] **Step 2: Добавить делегированный обработчик клика**

В блоке `document.addEventListener('DOMContentLoaded', () => {` (около строки 1877), сразу после строки `renderRecentRooms();`, добавить:

```js
    // Kick-кнопки рисуются динамически, поэтому слушатель вешается на контейнер.
    // dataset автоматически декодирует HTML-сущности, возвращая исходное имя.
    const participantsList = document.getElementById('participantsList');
    if (participantsList) {
        participantsList.addEventListener('click', (e) => {
            const btn = e.target.closest('.kick-btn');
            if (btn) kickParticipant(btn.dataset.username);
        });
    }
```

- [ ] **Step 3: Проверить вручную в браузере**

Поднять дев-сервер (см. «Подготовка окружения»).

Открыть `http://127.0.0.1:8000`, создать комнату под именем `alice`. Сервер теперь отвергает `<img src=x onerror=alert(1)>` (Task 2), поэтому для проверки именно фронтового слоя подать имя в обход UI, из консоли вкладки:

```js
renderParticipants({participants:[{user_id:'web_x',username:'<img src=x onerror=alert(1)>',online:true,vote:null}],revealed:false,vote_count:0});
```

Expected: в списке участников видна текстовая строка `<img src=x onerror=alert(1)>`, картинка не подгружается, `alert` не срабатывает.

Проверить, что kick работает: под инициатором навести на карточку другого участника, нажать `✕` — появляется диалог подтверждения, после подтверждения участник исчезает.

- [ ] **Step 4: Прогнать тесты и линтер**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest -q && .venv/bin/ruff check .`
Expected: 257 passed, `All checks passed!` (ruff не проверяет JS — прогон нужен, чтобы убедиться, что ничего не сломано)

- [ ] **Step 5: Commit**

```bash
git add web/static/script.js
git commit -m "security: escape participant names, drop inline onclick from kick button"
```

---

## Task 4: Не отдавать реальные голоса до вскрытия карт

Закрывает S4. Сейчас `real_point` уходит всем клиентам в каждом broadcast независимо от `revealed`.

**Files:**
- Modify: `web_api.py` (`game_to_web_response`, строки 36–62; `process_web_vote`, строка 215)
- Test: `tests/test_app.py` (переписать `test_game_to_web_response_with_votes`, строка ~354; добавить новые)
- Test: `tests/test_api.py` (интеграционный тест)

**Interfaces:**
- Consumes: ничего
- Produces: изменённый контракт ответа — ключ `real_point` присутствует в элементах `votes` и в `participants[].vote` **только** когда `revealed is True`

- [ ] **Step 1: Переписать существующий тест, закрепляющий утечку**

В `tests/test_app.py` тест `test_game_to_web_response_with_votes` сейчас содержит строку `assert result["votes"][0]["real_point"] == "5"`, то есть фиксирует нежелательное поведение. Заменить тело теста на:

```python
    def test_game_to_web_response_with_votes(self):
        from ppbot.game import Game
        from web_api import game_to_web_response

        game = Game(-100, "s1", {"id": "web_alice", "first_name": "A", "username": "a"}, "task")
        game.add_vote({"id": "web_alice", "first_name": "A", "username": "a"}, "5")
        result = game_to_web_response(game, "s1")
        assert result["vote_count"] == 1
        assert result["votes"][0]["point"] == "♥"  # masked, not revealed
        assert "real_point" not in result["votes"][0]
```

- [ ] **Step 2: Добавить тесты на оба состояния**

В `tests/test_app.py` рядом добавить:

```python
    def test_real_point_present_after_reveal(self):
        from ppbot.game import Game
        from web_api import game_to_web_response

        game = Game(-100, "s1", {"id": "web_alice", "first_name": "A", "username": "a"}, "task")
        game.add_vote({"id": "web_alice", "first_name": "A", "username": "a"}, "5")
        game.revealed = True
        result = game_to_web_response(game, "s1")
        assert result["votes"][0]["real_point"] == "5"
        assert result["votes"][0]["point"] == "5"

    def test_enriched_participants_hide_real_point_before_reveal(self):
        from connection import manager
        from ppbot.game import Game
        from web_api import enrich_session_response

        manager.session_users.clear()
        manager.register_user("s1", "alice")
        game = Game(-100, "s1", {"id": "web_alice", "first_name": "A", "username": "alice"}, "task")
        game.add_vote({"id": "web_alice", "first_name": "A", "username": "alice"}, "8")

        result = enrich_session_response(game, "s1")
        participant = next(p for p in result["participants"] if p["username"] == "alice")
        assert "real_point" not in participant["vote"]
        manager.session_users.clear()
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest tests/test_app.py -k "real_point or with_votes" -v`
Expected: FAIL — `real_point` присутствует, `assert "real_point" not in ...` не выполняется

- [ ] **Step 4: Реализовать в `game_to_web_response`**

В `web_api.py` заменить тело цикла в `game_to_web_response`:

```python
    votes = []
    for user_id, vote in game.votes.items():
        votes.append(
            {
                "user_id": user_id,
                "username": user_id.replace("web_", "") if user_id.startswith("web_") else user_id,
                "point": vote.point if game.revealed else vote.masked,
                "real_point": vote.point,
                "version": vote.version,
            }
        )
```

на:

```python
    votes = []
    for user_id, vote in game.votes.items():
        payload = {
            "user_id": user_id,
            "username": user_id.replace("web_", "") if user_id.startswith("web_") else user_id,
            "point": vote.point if game.revealed else vote.masked,
            "version": vote.version,
        }
        # Реальное значение голоса отдаём только после вскрытия карт —
        # иначе анонимность ломается через DevTools.
        if game.revealed:
            payload["real_point"] = vote.point
        votes.append(payload)
```

`enrich_session_response` менять не нужно: он строит `participants[].vote` из этих же словарей.

- [ ] **Step 5: Убрать `real_point` из `vote_data` в `process_web_vote`**

В `web_api.py` в `process_web_vote` заменить:

```python
    vote_data = {"user_id": user_id, "username": username, "point": point, "real_point": point, "version": 0}
```

на:

```python
    vote_data = {"user_id": user_id, "username": username, "point": point, "version": 0}
```

Эта структура кладётся в `manager.session_users[...]["vote"]` и наружу не отдаётся (ответ строится `enrich_session_response` из объекта игры), но хранить реальный голос там незачем.

- [ ] **Step 6: Убедиться, что тесты проходят**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest tests/test_app.py -k "real_point or with_votes" -v`
Expected: PASS

- [ ] **Step 7: Добавить интеграционный тест**

В `tests/test_api.py` в конец файла:

```python
class TestVoteSecrecy:
    def test_real_point_hidden_until_reveal(self, client):
        created = client.post("/api/sessions", json={"username": "alice", "text": "task"}).json()
        sid = created["session_id"]
        client.post(f"/api/sessions/{sid}/vote", json={"username": "alice", "point": "5"})

        before = client.get(f"/api/sessions/{sid}").json()
        assert before["votes"], "голос должен быть записан"
        assert all("real_point" not in v for v in before["votes"])

        client.post(f"/api/sessions/{sid}/reveal", json={"username": "alice"})

        after = client.get(f"/api/sessions/{sid}").json()
        assert after["votes"][0]["real_point"] == "5"
```

- [ ] **Step 8: Прогнать всё**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest -q && .venv/bin/ruff check .`
Expected: 260 passed, `All checks passed!`

- [ ] **Step 9: Commit**

```bash
git add web_api.py tests/test_app.py tests/test_api.py
git commit -m "security: hide real vote values until cards are revealed"
```

---

## Task 5: Свежее состояние игры в WebSocket

Закрывает F1. Сейчас `game` читается один раз при подключении и переиспользуется до конца соединения, из-за чего `save_game` записывает устаревший снимок и теряет чужие голоса.

**Files:**
- Modify: `websocket_handler.py` (`websocket_endpoint`, строки 100–130)
- Test: `tests/test_websocket.py`

**Interfaces:**
- Consumes: ничего (ветка `join` уже приведена к `validate_username` в Task 2 — эта задача её не трогает)
- Produces: гарантию, что каждый обработчик сообщения работает с игрой, прочитанной из БД в этот момент. Task 6 на неё опирается.

- [ ] **Step 1: Написать падающий тест**

`tests/test_websocket.py` не использует `TestClient` — там вызывается `websocket_endpoint(ws)` напрямую с мок-объектом из фикстуры `ws` (см. класс `TestWebSocketEndpoint`, строка 495). `ws.receive_text.side_effect` задаёт последовательность входящих сообщений и завершается `WebSocketDisconnect()`. `session_id` у этой фикстуры — `"test-session"`, `chat_id` — `"web"`. Новый тест пишется в том же стиле.

Свидетелем «свежести» выбран голос, а не смена шкалы: в Task 6 смена шкалы начнёт сбрасывать голоса, и тест, построенный на ней, сломался бы. Обработчик `vote` голоса не сбрасывает, поэтому проверка остаётся валидной и после Task 6.

Добавить в конец `tests/test_websocket.py`:

```python
class TestWebSocketFreshGame:
    @pytest.mark.asyncio
    async def test_vote_does_not_wipe_votes_cast_after_connect(self, ws):
        """Алиса подключилась, Боб проголосовал «снаружи», Алиса голосует по WS.
        Голос Боба должен уцелеть — значит обработчик читал игру заново."""
        game = state.storage.new_game(
            "web", "test-session", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
        )
        await state.storage.save_game(game)
        manager.register_user("test-session", "alice")

        messages = iter(
            [
                '{"type": "join", "username": "alice"}',
                "__external_vote__",
                '{"type": "vote", "username": "alice", "point": "3"}',
            ]
        )

        async def receive_text():
            try:
                nxt = next(messages)
            except StopIteration:
                raise WebSocketDisconnect() from None
            if nxt == "__external_vote__":
                # Эмулируем голос Боба через REST: отдельное чтение и запись игры
                fresh = await state.storage.get_game("web", "test-session")
                fresh.add_vote({"id": "web_bob", "first_name": "bob", "username": "bob"}, "5")
                await state.storage.save_game(fresh)
                return "ping"
            return nxt

        ws.receive_text.side_effect = receive_text

        await websocket_endpoint(ws)

        saved = await state.storage.get_game("web", "test-session")
        assert "web_bob" in saved.votes, "голос Боба затёрт устаревшим объектом игры"
        assert "web_alice" in saved.votes
        assert saved.votes["web_bob"].point == "5"
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest tests/test_websocket.py::TestWebSocketFreshGame -v`
Expected: FAIL — `AssertionError: голос Боба затёрт устаревшим объектом игры`. Обработчик `vote` работает с объектом, прочитанным при подключении (в нём голоса Боба нет), и `save_game` перезаписывает строку целиком.

- [ ] **Step 3: Перечитывать игру на каждом сообщении**

В `websocket_handler.py` в `websocket_endpoint` изменить начало цикла. Было:

```python
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
            else:
                try:
                    msg = json.loads(data)
                    msg_type = msg.get("type")
```

Стало:

```python
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
            else:
                try:
                    msg = json.loads(data)
                    msg_type = msg.get("type")
                    # Читаем игру заново на каждое сообщение: за время жизни
                    # соединения её могли изменить другие участники.
                    game = await state.storage.get_game(WEB_CHAT_ID, session_id)
```

Начальное чтение `game` перед циклом (строки 105–107, вместе с отправкой `init`) остаётся без изменений — оно нужно и для `init`-снимка, и для того, чтобы переменная `game` была определена, если соединение оборвётся до первого сообщения.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest tests/test_websocket.py -v`
Expected: `TestWebSocketFreshGame` зелёный, остальные тесты файла не сломаны

- [ ] **Step 5: Прогнать всё**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest -q && .venv/bin/ruff check .`
Expected: 261 passed, `All checks passed!`

- [ ] **Step 6: Commit**

```bash
git add websocket_handler.py tests/test_websocket.py
git commit -m "fix: reread game from storage on every websocket message"
```

---

## Task 6: Рабочая смена шкалы внутри сессии

Закрывает F2. Два дефекта: `setScale()` не передаёт `username` (сервер всегда отказывает) и `setScale()` вообще ниоткуда не вызывается — в сессии нет контрола.

**Files:**
- Modify: `websocket_handler.py` (ветка `set_scale`)
- Modify: `web_api.py` (`api_set_scale` — то же поведение для REST)
- Modify: `web/templates/index.html` (`#initiatorControlCard`, строки 179–192)
- Modify: `web/static/script.js` (`setScale` около строки 2251; `updateSessionDisplay` около строки 2442; блок `DOMContentLoaded`)
- Modify: `web/static/styles.css` (стиль для селектора в панели управления)
- Modify: `README.md` (описать сброс голосов)
- Test: `tests/test_websocket.py`, `tests/test_api.py`

**Interfaces:**
- Consumes: свежее чтение игры из Task 5; делегирование событий из Task 3
- Produces: `renderSessionScaleSelector(session)` в `script.js`

- [ ] **Step 1: Написать падающие тесты на сброс голосов**

В `tests/test_api.py` в конец файла:

```python
class TestScaleChangeResetsVotes:
    def test_rest_set_scale_clears_votes(self, client):
        created = client.post("/api/sessions", json={"username": "alice", "text": "task"}).json()
        sid = created["session_id"]
        client.post(f"/api/sessions/{sid}/vote", json={"username": "alice", "point": "5"})
        assert client.get(f"/api/sessions/{sid}").json()["vote_count"] == 1

        r = client.post(f"/api/sessions/{sid}/scale", json={"username": "alice", "scale_name": "fibonacci"})
        assert r.status_code == 200

        after = client.get(f"/api/sessions/{sid}").json()
        assert after["scale_name"] == "fibonacci"
        assert after["vote_count"] == 0
        assert after["revealed"] is False

    def test_rest_set_scale_rejected_for_non_initiator(self, client):
        created = client.post("/api/sessions", json={"username": "alice", "text": "task"}).json()
        sid = created["session_id"]
        r = client.post(f"/api/sessions/{sid}/scale", json={"username": "bob", "scale_name": "fibonacci"})
        assert r.status_code == 403
```

- [ ] **Step 2: Убедиться, что первый тест падает**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest tests/test_api.py::TestScaleChangeResetsVotes -v`
Expected: `test_rest_set_scale_clears_votes` FAIL — `vote_count == 1` вместо `0`; второй тест проходит (проверка инициатора уже есть)

- [ ] **Step 3: Сбрасывать голоса при смене шкалы — REST**

В `web_api.py` в `api_set_scale` заменить:

```python
        game.scale_name = scale_name if scale_name in SCALES else DEFAULT_SCALE
        await state.storage.save_game(game)
```

на:

```python
        game.scale_name = scale_name if scale_name in SCALES else DEFAULT_SCALE
        # Голоса по старой шкале в новой могут отсутствовать — сбрасываем,
        # иначе среднее считается по значениям, которые нельзя переголосовать.
        game.restart()
        await state.storage.save_game(game)
        manager.reset_session_users(session_id)
```

`game.restart()` очищает `votes`, снимает `revealed` и сбрасывает кэш среднего. `manager.reset_session_users` возвращает участникам статус `pending` — как это делает `api_restart`.

- [ ] **Step 4: Сбрасывать голоса при смене шкалы — WebSocket**

В `websocket_handler.py` в ветке `elif msg_type == "set_scale":` заменить:

```python
                                game.scale_name = scale_name
                                await state.storage.save_game(game)
```

на:

```python
                                game.scale_name = scale_name
                                game.restart()
                                await state.storage.save_game(game)
                                manager.reset_session_users(session_id)
```

Загрузку сохранённой пользовательской шкалы при переключении на `custom` здесь намеренно не делаем: сейчас `custom` отдаёт `AVAILABLE_POINTS`, и это существующее поведение, менять которое — отдельная задача.

- [ ] **Step 5: Убедиться, что REST-тесты проходят**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest tests/test_api.py::TestScaleChangeResetsVotes -v`
Expected: 2 passed

- [ ] **Step 6: Добавить WS-тест на смену шкалы**

В `tests/test_websocket.py` добавить в конец файла новый класс, в том же мок-стиле, что и остальной файл (фикстура `ws`, прямой вызов `websocket_endpoint`):

```python
class TestWebSocketSetScale:
    @pytest.mark.asyncio
    async def test_set_scale_by_initiator_applies_and_resets_votes(self, ws):
        game = state.storage.new_game(
            "web", "test-session", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
        )
        game.add_vote({"id": "web_alice", "first_name": "Alice", "username": "alice"}, "5")
        await state.storage.save_game(game)
        manager.register_user("test-session", "alice")
        manager.update_user_vote("test-session", "alice", {"point": "5"})

        ws.receive_text.side_effect = [
            '{"type": "set_scale", "scale_name": "tshirt", "username": "alice"}',
            WebSocketDisconnect(),
        ]
        await websocket_endpoint(ws)

        saved = await state.storage.get_game("web", "test-session")
        assert saved.scale_name == "tshirt"
        assert dict(saved.votes) == {}
        assert saved.revealed is False
        assert manager.session_users["test-session"]["alice"]["status"] == "pending"

    @pytest.mark.asyncio
    async def test_set_scale_by_non_initiator_returns_error(self, ws):
        game = state.storage.new_game(
            "web", "test-session", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
        )
        await state.storage.save_game(game)
        manager.register_user("test-session", "bob")

        ws.receive_text.side_effect = [
            '{"type": "set_scale", "scale_name": "tshirt", "username": "bob"}',
            WebSocketDisconnect(),
        ]
        await websocket_endpoint(ws)

        errors = [c for c in ws.send_json.await_args_list if c[0][0].get("type") == "error"]
        assert errors, "не-инициатор должен получить сообщение об ошибке"
        saved = await state.storage.get_game("web", "test-session")
        assert saved.scale_name == "custom"
```

`dict(saved.votes)` нужен потому, что `Game.votes` — это `collections.defaultdict`, и сравнение напрямую с `{}` читается хуже.

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest tests/test_websocket.py::TestWebSocketSetScale -v`
Expected: 2 passed

- [ ] **Step 7: Починить `setScale` на фронте**

В `web/static/script.js` заменить:

```js
function setScale(scaleName) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'set_scale', scale_name: scaleName }));
    }
}
```

на:

```js
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
```

- [ ] **Step 8: Добавить разметку селектора в панель управления**

В `web/templates/index.html` внутри `<div class="card" id="initiatorControlCard" style="display:none;">`, сразу после `<h2><span class="diamond"></span> УПРАВЛЕНИЕ</h2>`, вставить:

```html
                        <div class="scale-selector session-scale-selector" id="sessionScaleSelector">
                            <span class="scale-selector-label">📐 Шкала</span>
                            <div class="scale-selector-buttons" id="sessionScaleSelectorButtons"></div>
                        </div>
```

- [ ] **Step 9: Отрисовывать селектор в сессии**

В `web/static/script.js` рядом с `renderJoinScaleSelector` (после `onJoinScaleClick`, около строки 1438) добавить:

```js
function renderSessionScaleSelector(session) {
    const container = document.getElementById('sessionScaleSelector');
    const buttonsContainer = document.getElementById('sessionScaleSelectorButtons');
    if (!container || !buttonsContainer) return;

    const scaleNames = session.scale_names || SERVER_SCALE_NAMES || {};
    let entries = Object.entries(scaleNames);
    if (entries.length <= 1) {
        container.style.display = 'none';
        return;
    }

    // Сортируем: custom — в конец (как на экране входа)
    entries.sort((a, b) => {
        if (a[0] === 'custom') return 1;
        if (b[0] === 'custom') return -1;
        return 0;
    });

    container.style.display = 'flex';
    buttonsContainer.innerHTML = entries.map(([key, label]) => {
        const active = key === session.scale_name ? 'active' : '';
        return `<button class="scale-btn ${active}" data-scale="${escapeHtml(key)}">${escapeHtml(label)}</button>`;
    }).join('');
}
```

Ключи и подписи приходят с сервера из `SCALE_NAMES`, но экранируются на общих основаниях — так шаблон остаётся безопасным, если словарь когда-нибудь станет настраиваемым.

- [ ] **Step 10: Вызвать отрисовку и повесить обработчик**

В `web/static/script.js` в `updateSessionDisplay` найти:

```js
    const controlCard = document.getElementById('initiatorControlCard');
    controlCard.style.display = state.isInitiator ? 'block' : 'none';
```

и добавить сразу после:

```js
    if (state.isInitiator) renderSessionScaleSelector(session);
```

В блоке `DOMContentLoaded`, рядом с обработчиком из Task 3, добавить:

```js
    const sessionScaleButtons = document.getElementById('sessionScaleSelectorButtons');
    if (sessionScaleButtons) {
        sessionScaleButtons.addEventListener('click', (e) => {
            const btn = e.target.closest('.scale-btn');
            if (btn) setScale(btn.dataset.scale);
        });
    }
```

- [ ] **Step 11: Стиль для селектора в панели управления**

В `web/static/styles.css` в конец файла добавить:

```css
.session-scale-selector {
    margin-bottom: 10px;
    flex-wrap: wrap;
}
```

Базовые стили `.scale-selector`, `.scale-selector-buttons`, `.scale-btn`, `.scale-btn.active` и `.scale-selector-label` уже определены (строки 1183–1235) и переиспользуются.

- [ ] **Step 12: Проверить вручную**

Поднять дев-сервер (см. «Подготовка окружения»). Открыть две вкладки на одну комнату (в одной — инициатор `alice`, в другой — `bob`).

Expected:
- У инициатора в карточке «УПРАВЛЕНИЕ» виден ряд кнопок шкал, активная подсвечена.
- У `bob` этой панели нет (вся карточка скрыта).
- `bob` голосует, инициатор жмёт «T-shirt» — в обеих вкладках карты для голосования сменились на `XS…XXL`, счётчик голосов обнулился, активная кнопка переехала.
- В консоли браузера нет ошибок.

- [ ] **Step 13: Обновить README**

В `README.md` в разделе «#### Возможности веб-интерфейса» (около строки 219) добавить пункт:

```markdown
- **Смена шкалы на лету**: Инициатор может переключить шкалу прямо в сессии — панель «УПРАВЛЕНИЕ». Голоса при этом сбрасываются, потому что значения старой шкалы могут отсутствовать в новой.
```

- [ ] **Step 14: Прогнать всё**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest -q && .venv/bin/ruff check .`
Expected: 265 passed, `All checks passed!`

Если какой-то из ранее существовавших тестов на `api_set_scale` упал — он проверял, что голоса переживают смену шкалы. Это поведение изменено намеренно; тест переписать под новое.

- [ ] **Step 15: Commit**

```bash
git add websocket_handler.py web_api.py web/templates/index.html web/static/script.js web/static/styles.css README.md tests/test_api.py tests/test_websocket.py
git commit -m "feat: working in-session scale switching, reset votes on scale change"
```

---

## Task 7: Показывать ошибки WebSocket

Закрывает F3. Сервер шлёт `{"type": "error", "message": …}` (невалидное имя, не-инициатор меняет шкалу или кикает, голос вне шкалы), фронт эти сообщения молча отбрасывает.

**Files:**
- Modify: `web/static/script.js` (`state.ws.onmessage`, около строк 2184–2225)

**Interfaces:**
- Consumes: `toast.error(message, title)` — уже существует (`script.js:74`)
- Produces: ничего

- [ ] **Step 1: Добавить ветку обработки**

В `web/static/script.js` в обработчике `state.ws.onmessage` найти ветку `kicked` и добавить перед ней (порядок важен только для читаемости — ветки взаимоисключающие):

```js
            } else if (message.type === 'error') {
                toast.error(message.message || 'Ошибка сервера', 'ОШИБКА');
                return;
```

Итоговая цепочка выглядит так: `user_joined` → `user_left` → `error` → `kicked` → `user_kicked` → `init`/`update`.

- [ ] **Step 2: Проверить вручную**

Поднять дев-сервер (см. «Подготовка окружения»), открыть комнату двумя вкладками (`alice` — инициатор, `bob` — нет). В консоли вкладки `bob` выполнить:

```js
state.ws.send(JSON.stringify({type: 'set_scale', scale_name: 'tshirt', username: 'bob'}));
```

Expected: во вкладке `bob` всплывает тост «ОШИБКА / Только инициатор может менять шкалу». До фикса не происходило ничего.

- [ ] **Step 3: Прогнать тесты и линтер**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest -q && .venv/bin/ruff check .`
Expected: 265 passed, `All checks passed!`

- [ ] **Step 4: Commit**

```bash
git add web/static/script.js
git commit -m "fix: surface websocket error messages to the user"
```

---

## Task 8: Запустить периодическую очистку сессий

Закрывает F4. `ConnectionManager.cleanup_old_sessions()` реализован и покрыт тестами, но не вызывается — словари `session_users`, `ws_username_map`, `_ws_connections` растут всё время работы процесса.

**Files:**
- Modify: `config.py` (константа интервала)
- Modify: `app.py` (`lifespan`, строки 76–80; `shutdown_app`)
- Test: `tests/test_session_cleanup.py`

**Interfaces:**
- Consumes: `manager.cleanup_old_sessions()` — уже существует (`connection.py:163`)
- Produces: `session_cleanup_loop(interval: float) -> None` — корутина в `app.py`, бесконечный цикл `sleep` + `cleanup_old_sessions`; отменяется через `task.cancel()`

- [ ] **Step 1: Написать падающий тест**

В `tests/test_session_cleanup.py` добавить в конец файла:

```python
class TestCleanupLoop:
    def test_loop_removes_stale_sessions(self):
        """session_cleanup_loop периодически вызывает cleanup_old_sessions."""
        import asyncio

        from app import session_cleanup_loop

        async def scenario():
            manager.register_user("stale", "alice")
            manager.ws_username_map["stale"] = {"alice"}
            manager._ws_connections["stale"] = {"alice": None}
            # активных подключений нет → сессия считается протухшей

            task = asyncio.create_task(session_cleanup_loop(0.01))
            await asyncio.sleep(0.05)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

        asyncio.run(scenario())

        assert "stale" not in manager.session_users
        assert "stale" not in manager.ws_username_map
        assert "stale" not in manager._ws_connections

    def test_loop_keeps_sessions_with_active_connections(self):
        import asyncio

        from app import session_cleanup_loop

        async def scenario():
            manager.register_user("live", "alice")
            manager.active_connections["live"] = ["fake-ws"]

            task = asyncio.create_task(session_cleanup_loop(0.01))
            await asyncio.sleep(0.05)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

        asyncio.run(scenario())

        assert "live" in manager.session_users
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest tests/test_session_cleanup.py::TestCleanupLoop -v`
Expected: FAIL — `ImportError: cannot import name 'session_cleanup_loop' from 'app'`

- [ ] **Step 3: Добавить константу интервала**

В `config.py` после строки `CORS_ORIGINS = os.getenv("CORS_ORIGINS", "*").split(",")` добавить:

```python
SESSION_CLEANUP_INTERVAL = float(os.getenv("SESSION_CLEANUP_INTERVAL", 600))
```

- [ ] **Step 4: Реализовать цикл и подключить к lifespan**

В `app.py` расширить импорт из `config`:

```python
from config import CORS_ORIGINS, SESSION_CLEANUP_INTERVAL, logger
```

Добавить функцию перед `shutdown_app`:

```python
async def session_cleanup_loop(interval: float) -> None:
    """Периодически убирает из памяти сессии без активных подключений."""
    while True:
        await asyncio.sleep(interval)
        manager.cleanup_old_sessions()
```

Заменить `lifespan`:

```python
    @asynccontextmanager
    async def lifespan(app):
        yield
        await shutdown_app(app)
```

на:

```python
    @asynccontextmanager
    async def lifespan(app):
        cleanup_task = asyncio.create_task(session_cleanup_loop(SESSION_CLEANUP_INTERVAL))
        try:
            yield
        finally:
            cleanup_task.cancel()
            with suppress(asyncio.CancelledError):
                await cleanup_task
            await shutdown_app(app)
```

Добавить `suppress` к импортам в начале `app.py`:

```python
from contextlib import asynccontextmanager, suppress
```

Задача отменяется до `shutdown_app`, то есть до `state.storage.close()` — цикл не обращается к БД, но порядок сохраняем строгим.

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest tests/test_session_cleanup.py -v`
Expected: все тесты файла зелёные

- [ ] **Step 6: Дописать документацию по переменной**

В `README.md` в таблицу «### Переменные окружения» (около строки 315) добавить строку:

```markdown
| `SESSION_CLEANUP_INTERVAL` | | `600` | Период очистки неактивных сессий из памяти, секунды |
```

И в `.env.example` в конец:

```bash
# Период очистки неактивных сессий из памяти, секунды
# SESSION_CLEANUP_INTERVAL=600
```

- [ ] **Step 7: Прогнать всё**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest -q && .venv/bin/ruff check .`
Expected: 267 passed, `All checks passed!`

- [ ] **Step 8: Commit**

```bash
git add config.py app.py tests/test_session_cleanup.py README.md .env.example
git commit -m "fix: actually run periodic session cleanup"
```

---

## Task 9: Мелкие фиксы — rate-limit store и двойной декоратор

Закрывает F5 и F6. Изменения независимы друг от друга, поэтому идут двумя отдельными коммитами.

**Files:**
- Modify: `web_api.py` (`_check_rate_limit`)
- Modify: `connection.py` (строки 178–179)
- Test: `tests/test_app.py`

**Interfaces:**
- Consumes: ничего
- Produces: ничего

- [ ] **Step 1: Написать падающий тест на очистку rate-limit store**

В `tests/test_app.py` в конец файла:

Ключевая мысль: каждый уникальный IP оставляет в `_rate_limit_store` запись навсегда, потому что ключи никогда не удаляются. Сам `_check_rate_limit` вычистить чужие ключи не может — он видит только свой. Значит нужна отдельная функция обхода, вызываемая по расписанию.

```python
class TestRateLimitEviction:
    def test_evict_removes_idle_keys(self):
        import time

        import web_api
        from web_api import _check_rate_limit, evict_stale_rate_limits, reset_rate_limits

        reset_rate_limits()
        _check_rate_limit("ip:1.2.3.4", max_requests=5, window=0.01)
        assert "ip:1.2.3.4" in web_api._rate_limit_store

        time.sleep(0.02)  # единственная метка этого ключа устарела
        evict_stale_rate_limits(window=0.01)

        assert "ip:1.2.3.4" not in web_api._rate_limit_store
        reset_rate_limits()

    def test_evict_keeps_recent_keys(self):
        import web_api
        from web_api import _check_rate_limit, evict_stale_rate_limits, reset_rate_limits

        reset_rate_limits()
        _check_rate_limit("ip:9.9.9.9", max_requests=5, window=60)

        evict_stale_rate_limits(window=60)

        assert "ip:9.9.9.9" in web_api._rate_limit_store
        reset_rate_limits()
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest tests/test_app.py::TestRateLimitEviction -v`
Expected: FAIL — `ImportError: cannot import name 'evict_stale_rate_limits' from 'web_api'`

- [ ] **Step 3: Реализовать очистку**

В `web_api.py` заменить `_check_rate_limit`:

```python
def _check_rate_limit(key: str, max_requests: int = 30, window: float = 60.0) -> bool:
    """Проверяет rate limit: не более max_requests запросов за window секунд.
    Возвращает True, если запрос разрешён."""
    now = time.time()
    timestamps = _rate_limit_store.get(key, [])
    # Удаляем устаревшие
    timestamps = [t for t in timestamps if now - t < window]
    if len(timestamps) >= max_requests:
        return False
    timestamps.append(now)
    _rate_limit_store[key] = timestamps
    return True
```

на:

```python
def _check_rate_limit(key: str, max_requests: int = 30, window: float = 60.0) -> bool:
    """Проверяет rate limit: не более max_requests запросов за window секунд.
    Возвращает True, если запрос разрешён."""
    now = time.time()
    timestamps = [t for t in _rate_limit_store.get(key, []) if now - t < window]
    if len(timestamps) >= max_requests:
        _rate_limit_store[key] = timestamps
        return False
    timestamps.append(now)
    _rate_limit_store[key] = timestamps
    return True


def evict_stale_rate_limits(window: float = 60.0) -> None:
    """Убирает ключи, по которым за окно не было ни одного запроса.

    Без этого словарь хранит по записи на каждый когда-либо виденный IP.
    """
    now = time.time()
    for key in [k for k, ts in _rate_limit_store.items() if all(now - t >= window for t in ts)]:
        del _rate_limit_store[key]
```

- [ ] **Step 4: Вызывать очистку из периодической задачи**

В `app.py` в `session_cleanup_loop` (создана в Task 8) добавить вызов:

```python
async def session_cleanup_loop(interval: float) -> None:
    """Периодически убирает из памяти сессии без активных подключений
    и протухшие записи rate-limiter'а."""
    from web_api import evict_stale_rate_limits

    while True:
        await asyncio.sleep(interval)
        manager.cleanup_old_sessions()
        evict_stale_rate_limits()
```

Импорт локальный, чтобы не менять порядок импортов на уровне модуля: `app.py` уже импортирует из `web_api` большой блок функций-эндпоинтов, и добавление туда служебной функции размывает смысл этого блока.

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest tests/test_app.py::TestRateLimitEviction -v`
Expected: 2 passed

- [ ] **Step 6: Прогнать всё и закоммитить F5**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest -q && .venv/bin/ruff check .`
Expected: 269 passed, `All checks passed!`

```bash
git add web_api.py app.py tests/test_app.py
git commit -m "fix: evict stale rate-limit entries instead of growing forever"
```

- [ ] **Step 7: Убрать двойной декоратор**

В `connection.py` найти:

```python
    @staticmethod
    @staticmethod
    def _get_enriched_data(session_id: str, game: Optional["Game"] = None) -> dict:
```

Удалить одну из строк `@staticmethod`, оставив:

```python
    @staticmethod
    def _get_enriched_data(session_id: str, game: Optional["Game"] = None) -> dict:
```

- [ ] **Step 8: Прогнать всё и закоммитить F6**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest -q && .venv/bin/ruff check .`
Expected: 269 passed, `All checks passed!`

```bash
git add connection.py
git commit -m "fix: remove duplicated staticmethod decorator"
```

---

## Финальная проверка

- [ ] **Step 1: Полный прогон**

Run: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest -q && .venv/bin/ruff check .`
Expected: 269 passed, `All checks passed!`

Точные числа по задачам: 243 (старт) → 257 (Task 2) → 260 (Task 4) → 261 (Task 5) → 265 (Task 6) → 267 (Task 8) → 269 (Task 9). Расхождение на пару тестов не критично, но резкое падение означает, что что-то сломалось при сборе.

- [ ] **Step 2: Проверить, что в диффе нет лишнего**

Run: `git diff main --stat`
Expected: изменены только `.env.example`, `.pre-commit-config.yaml`, `README.md`, `app.py`, `config.py`, `connection.py`, `web_api.py`, `websocket_handler.py`, `web/static/script.js`, `web/static/styles.css`, `web/templates/index.html`, файлы в `tests/`, `docs/superpowers/`. Каталог `browser-extension/` не тронут.

- [ ] **Step 3: Проверить приложение живьём**

Поднять дев-сервер (см. «Подготовка окружения»), открыть две вкладки и пройти сценарий: создать комнату → второй участник входит → оба голосуют → инициатор меняет шкалу (голоса сбрасываются) → оба голосуют заново → инициатор открывает карты → значения видны.

Во время голосования, до вскрытия, открыть DevTools → Network → WS → Messages и убедиться, что во фреймах нет ключа `real_point`.

- [ ] **Step 4: Отчитаться о том, что осталось владельцу**

Напомнить в финальном сообщении: токены из истории git не удалены осознанно, их нужно **отозвать вручную** — `/revoke` у @BotFather для бота `8209778838` и отзыв ключа группы 239083025 во ВКонтакте. Переделка браузерного расширения (S2 спеки) не делалась и ждёт отдельной ветки.
