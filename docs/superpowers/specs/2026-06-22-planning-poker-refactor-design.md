# Planning Poker — Bug fixes, Refactoring & Improvements

## Context

[Planning Poker](https://github.com/user/tg_poker_planing) — Telegram Bot + Web Interface для командной оценки задач по методике Planning Poker.
Стек: Python 3.10+ / Starlette / WebSocket / Vanilla JS / SQLite.

Проект активно развивается (последние коммиты: Jira integration, UI/UX improvements).
Требуется пройтись по трём направлениям последовательно: баги → рефакторинг → улучшения.

---

## Phase A — Bug Fixes (🐛)

### A1. Убрать смену шкалы при входе в комнату

**Проблема:** `script.js:2306-2315` при join существующей комнаты пытается перезаписать шкалу:
```js
// script.js — при join существующей комнаты
if (scaleName !== (data.scale_name || 'custom')) {
    await fetch(`/api/sessions/${sessionId}/scale`, {
        method: 'POST',
        body: JSON.stringify({ scale_name: scaleName })  // без username → 400
    });
}
```
По бизнес-логике шкала задаётся один раз при создании комнаты. При join не меняется.

**Решение:** Удалить блок `if (scaleName !== ...)` при join. Селектор шкалы на экране входа продолжает работать **только** при создании новой комнаты.

**Файлы:** `web/static/script.js`

---

### A2. Transfer инициатора + механизм кика отвалившихся

**Проблема:** `transfer_initiator_if_needed` использует `session_users` для определения «кто онлайн».
Но `session_users` НЕ чистится при дисконнекте — это сделано намеренно, чтобы авто-вскрытие
работало корректно (ждёт голоса всех зарегистрированных, включая отвалившихся).
В результате `transfer_initiator` может ошибочно посчитать отключившегося как активного участника.

**Сценарий:**
1. Alice создала комнату (initiator)
2. Bob зашёл, проголосовал, у него отвалился интернет (в `session_users`: `status: "voted"`)
3. Alice вышла (disconnect)
4. `transfer_initiator_if_needed` видит Bob'а в `session_users` со статусом `"voted"` → не передаёт инициатор
5. При reconnect Bob — нет initiator'а, никто не может открыть/рестартнуть

**Решение (два изменения):**

**A2a. Трекинг активных WS-подключений:**
Добавить в `ConnectionManager` отдельный трекер — какие username имеют активное WebSocket.
`session_users` остаётся как есть (для авто-вскрытия).

```python
class ConnectionManager:
    def __init__(self):
        self.active_connections: dict[str, list[WebSocket]] = {}
        self.session_users: dict[str, dict[str, dict]] = {}     # кто зарегистрирован (живёт сквозь реконнекты)
        self.ws_username_map: dict[str, set[str]] = {}           # session_id → {username с активным WS}
```

- `connection.py`: добавить `ws_username_map`, методы `register_ws_connection`, `unregister_ws_connection`
- `websocket_handler.py`: при `join(username)` → `register_ws_connection`;
  при `WebSocketDisconnect` → `unregister_ws_connection`
- `transfer_initiator_if_needed` → проверять `ws_username_map`, а не `session_users`

**A2b. Механизм кика участников (инициатор):**
Инициатор может кикнуть **любого** участника комнаты (не только отвалившихся).
Нужно для: удаление "зависших", случайно зашедших, тех кто мешает голосованию.

- **WebSocket:** новый тип сообщения `{"type": "kick_user", "target_username": "bob"}`, проверка что отправитель — initiator
- **REST:** `POST /api/sessions/{session_id}/kick` с `{username, target_username}`
- **Действие при кике:**
  1. Удалить пользователя из `session_users[session_id]`
  2. Удалить из `ws_username_map[session_id]`
  3. Разорвать его WebSocket-соединение (если активно), отправив ему `{"type": "kicked"}`
  4. Разослать всем `{"type": "user_kicked", "username": "...", "data": ...}`
- **UI (initiator):** рядом с именем любого участника (кроме себя) появляется кнопка ✕;
  при кике — подтверждение через `ConfirmManager`

**Файлы:** `connection.py`, `websocket_handler.py`, `web_api.py`, `web/static/script.js`

---

### A3. Custom scale в Telegram боте при handle_scale_click

**Проблема:** В Telegram боте `handle_scale_click` циклически переключает шкалы (`custom → fibonacci → powers_of_2 → tshirt → custom → ...`). При переходе на `"custom"` не загружаются сохранённые `custom_points` пользователя.

**Решение:** При переключении на `"custom"` — загружать `custom_points` через `GameRegistry.get_custom_scale()` для данного initiator'а.

**Файлы:** `telegram_bot.py`

---

## Phase B — Refactoring (🔧)

### B1. Дедупликация Jira-деревьев (script.js)

**Проблема:** В `script.js` 3 практически идентичных функции рендеринга Jira Issue Tree:
- `renderJiraJoinTree()` (строка ~503)
- `renderJiraIssueTree()` (строка ~806)
- `renderJiraTreeInContainer()` (строка ~1346)

Плюс логика группировки по эпикам дублируется внутри каждой.

**Решение:** Выделить общий метод `renderJiraTree(container, options)`:
```js
function renderJiraTree(container, { onSelect, showPriority, showEpicHeader = true, epicMap, issues }) {
    // 1. Группировка по эпикам (единая логика)
    // 2. Рендеринг HTML
    // 3. onSelect callback
}
```

**Файлы:** `web/static/script.js`

---

### B2. Выделить vote logic из дубля REST/WS

**Проблема:** Логика голосования дублируется в `web_api.py` (REST) и `websocket_handler.py` (WebSocket). Оба делают:
- `game.add_vote()`
- `state.storage.save_game()`
- `manager.update_user_vote()`
- `manager.broadcast()`

**Решение:** Выделить общий метод в `connection.py` или новый модуль:
```python
async def process_vote(session_id, game, username, point) -> dict:
    user_id = f"web_{username}"
    vote_data = {"user_id": user_id, ...}
    game.add_vote(..., point)
    await state.storage.save_game(game)
    manager.update_user_vote(session_id, username, vote_data)
    updated = enrich_session_response(game, session_id)
    await manager.broadcast(session_id, {"type": "update", "data": updated})
    # check_auto_reveal
    return updated
```

**Файлы:** `web_api.py`, `websocket_handler.py`

---

### B3. Типизировать initiator

**Проблема:** `initiator: dict` используется повсеместно:
```python
initiator = {
    "id": "web_alice",
    "first_name": "Alice",
    "username": "alice"
}
```
Никакой типизации. Ошибки в ключах — runtime.

**Решение:** Добавить `Initiator` dataclass и использовать его вместо голого `dict`:
```python
from dataclasses import dataclass, field

@dataclass
class Initiator:
    id: str
    first_name: str
    username: str = ""
    
    @classmethod
    def from_telegram_user(cls, user) -> "Initiator":
        return cls(id=str(user.id), first_name=user.first_name, username=user.username or "")
    
    @classmethod
    def from_web(cls, username: str) -> "Initiator":
        return cls(id=f"web_{username}", first_name=username, username=username)
```

**Файлы:** `ppbot/game.py` (Game), `web_api.py`, `telegram_bot.py`, `tests/`

---

### B4. Разбить script.js на модули

**Проблема:** 2500+ строк в одном `<script>`. Нет разделения на зоны ответственности.

**Решение:** Разделить на функциональные блоки в том же файле (пока без бандлера), через чёткие разделители и IIFE/модульный паттерн:

1. **Game Core** — `state`, `Session` управление, `WebSocket`, голосование
2. **UI Components** — `ToastManager`, `ConfirmManager`, `SoundManager`, тема, история
3. **Jira Integration** — все Jira-функции
4. **Scales & Custom Scale Editor** — управление шкалами

На данном этапе — структурное разделение внутри одного файла с комментариями-секциями. Фактическое вынесение в отдельные `.js` — когда появится сборка.

**Файлы:** `web/static/script.js`

---

### B5. connection.py — рефакторинг ws_user_map

По сути выполнено в A2. Дополнительно:
- Убрать закомментированный код (строки 26-40)
- Добавить docstring на методы
- Разделить ответственность: `session_users` для авто-вскрытия, `ws_username_map` для определения текущих подключений

---

## Phase C — Improvements (🚀)

### C1. SQLite WAL mode

**Проблема:** Нет `PRAGMA journal_mode=WAL`. При конкурентном чтении/записи могут быть блокировки.

**Решение:** Добавить в `GameRegistry.init_db()`:
```python
await self._db.execute("PRAGMA journal_mode=WAL")
await self._db.execute("PRAGMA busy_timeout=5000")
```

**Файлы:** `ppbot/game.py`

---

### C2. Валидация голосов

**Проблема:** `api_vote` и `websocket_handler` принимают любой `point` без проверки на принадлежность к шкале.

**Решение:** В `Game.add_vote()` / или перед вызовом — проверять, есть ли `point` в `game.get_points()`:
```python
if point not in game.get_points():
    raise ValueError(f"Point {point} is not in the current scale")
```

**Файлы:** `web_api.py`, `websocket_handler.py`, `ppbot/game.py`

---

### C3. pre-commit + mypy

**Проблема:** В `.pre-commit-config.yaml` есть только `ruff`. Нет type-checker'а.

**Решение:** Добавить `mypy` в pre-commit. Для начала — `--ignore-missing-imports`.

**Файлы:** `.pre-commit-config.yaml`

---

### C4. CORS для production

**Проблема:** `allow_origins=["*"]`. В production — опасно.

**Решение:** Добавить в config переменную окружения `CORS_ORIGINS` (по умолчанию `*` для dev).
```python
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "*").split(",")
```

**Файлы:** `config.py`, `app.py`

---

## Порядок имплементации

```
Phase A (баги)        → A1 → A2 → A3
Phase B (рефакторинг) → B5 (после A2) → B2 → B3 → B1 → B4
Phase C (улучшения)   → C1 → C2 → C3 → C4
```

После каждой фазы — прогон тестов.