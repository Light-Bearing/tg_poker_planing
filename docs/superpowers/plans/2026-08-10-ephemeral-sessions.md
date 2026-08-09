# Эфемерные веб-сессии — план реализации

**Спека:** `docs/superpowers/specs/2026-08-10-ephemeral-sessions-design.md`
**Ветка:** `feat/ephemeral-sessions` (от `main`, уже создана)

**Цель:** веб-сессия удаляется из БД и памяти через 5 минут после ухода последнего участника; `GET /api/sessions` убирается совсем.

## Global Constraints

- Ветка `feat/ephemeral-sessions`. Не переключаться, не пушить, историю не переписывать.
- **Telegram-игры не удалять никогда.** Правило касается только записей с `chat_id == WEB_CHAT_ID`. У Telegram-игр WebSocket нет вообще, и правило «нет подключений — удалить» уничтожило бы их все.
- Питоновский набор: сейчас 285 passed. Задача удаляет эндпоинт, поэтому часть тестов удаляется, часть добавляется — итоговое число назвать в отчёте.
- JS-тесты не трогаются: `node --test 'tests/js/*.test.js'` → 97 passed.
- `.venv/bin/ruff check .` → чисто. Запуск pytest: `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest -q`.
- Комментарии, docstring и сообщения коммитов — на русском.
- `browser-extension/`, фронт и парсеры — вне scope.

---

## Task 1: Метка осиротевшей сессии в ConnectionManager

**Files:** `connection.py`, `tests/test_session_cleanup.py`

**Produces:** `manager._orphaned_at: dict[str, float]`; `manager.orphaned_web_sessions(ttl: float) -> list[str]`.

- [ ] **Шаг 1: тесты**

В `tests/test_session_cleanup.py` добавить класс `TestOrphanTracking`:

```python
class TestOrphanTracking:
    def test_метка_ставится_когда_ушёл_последний(self):
        ws = MagicMock()
        asyncio.run(manager.connect("s1", ws))
        manager.disconnect("s1", ws)
        assert "s1" in manager._orphaned_at

    def test_метка_не_ставится_пока_кто_то_остаётся(self):
        a, b = MagicMock(), MagicMock()
        asyncio.run(manager.connect("s1", a))
        asyncio.run(manager.connect("s1", b))
        manager.disconnect("s1", a)
        assert "s1" not in manager._orphaned_at

    def test_новое_подключение_снимает_метку(self):
        ws = MagicMock()
        asyncio.run(manager.connect("s1", ws))
        manager.disconnect("s1", ws)
        assert "s1" in manager._orphaned_at
        asyncio.run(manager.connect("s1", MagicMock()))
        assert "s1" not in manager._orphaned_at

    def test_созревшая_метка_попадает_в_список(self):
        ws = MagicMock()
        asyncio.run(manager.connect("s1", ws))
        manager.disconnect("s1", ws)
        manager._orphaned_at["s1"] = time.time() - 600
        assert manager.orphaned_web_sessions(300) == ["s1"]

    def test_свежая_метка_не_попадает(self):
        ws = MagicMock()
        asyncio.run(manager.connect("s1", ws))
        manager.disconnect("s1", ws)
        assert manager.orphaned_web_sessions(300) == []

    def test_сессия_с_подключением_не_попадает(self):
        ws = MagicMock()
        asyncio.run(manager.connect("s1", ws))
        manager._orphaned_at["s1"] = time.time() - 600
        assert manager.orphaned_web_sessions(300) == []
```

Импорты `time`, `MagicMock`, `asyncio` добавить, если их нет. Фикстура `_reset` в этом файле должна дополнительно очищать `manager._orphaned_at`.

- [ ] **Шаг 2:** убедиться, что падают. Ожидаемо `AttributeError: _orphaned_at`.

- [ ] **Шаг 3: реализация в `connection.py`**

Добавить `import time`. В `__init__`: `self._orphaned_at: dict[str, float] = {}`.

В `connect()` после регистрации подключения — снять метку: `self._orphaned_at.pop(session_id, None)`.

В `disconnect()` в самом конце — если у сессии не осталось активных подключений, поставить метку:

```python
        if not self.active_connections.get(session_id):
            self._orphaned_at[session_id] = time.time()
```

Новый метод:

```python
    def orphaned_web_sessions(self, ttl: float) -> list[str]:
        """Сессии без активных подключений, осиротевшие дольше ttl секунд."""
        now = time.time()
        return [
            sid for sid, since in self._orphaned_at.items()
            if not self.active_connections.get(sid) and now - since >= ttl
        ]
```

В `cleanup_session()` дополнительно: `self._orphaned_at.pop(session_id, None)`.

В `cleanup_old_sessions()` метку **не трогать** — она должна пережить очистку памяти, иначе запись в БД останется навсегда.

- [ ] **Шаг 4:** тесты зелёные. **Шаг 5:** коммит `feat: отметка времени, когда сессия осталась без участников`.

---

## Task 2: Удаление записи из БД

**Files:** `ppbot/game.py`, `tests/test_game_persistence.py`

**Produces:** `GameRegistry.delete_game(chat_id, game_id)`.

- [ ] **Шаг 1: тесты** в `tests/test_game_persistence.py`:

```python
async def test_delete_game_удаляет_запись(tmp_path):
    reg = GameRegistry()
    await reg.init_db(str(tmp_path / "t.db"))
    game = reg.new_game("web", "s1", Initiator.from_web("alice"), "task")
    await reg.save_game(game)
    assert await reg.get_game("web", "s1") is not None
    await reg.delete_game("web", "s1")
    assert await reg.get_game("web", "s1") is None
    await reg.close()


async def test_delete_game_не_трогает_чужие(tmp_path):
    reg = GameRegistry()
    await reg.init_db(str(tmp_path / "t.db"))
    web = reg.new_game("web", "s1", Initiator.from_web("alice"), "web-задача")
    tg = reg.new_game("-100500", "s1", Initiator.from_web("bob"), "telegram-задача")
    await reg.save_game(web)
    await reg.save_game(tg)
    await reg.delete_game("web", "s1")
    assert await reg.get_game("web", "s1") is None
    assert await reg.get_game("-100500", "s1") is not None
    await reg.close()
```

Второй тест важен: `game_id` у разных чатов может совпадать, удаление обязано различать их по `chat_id`.

- [ ] **Шаг 2:** убедиться, что падают. **Шаг 3: реализация:**

```python
    async def delete_game(self, chat_id, game_id: str) -> None:
        """Удаляет игру. Используется при истечении срока жизни веб-сессии."""
        await self._db.execute("DELETE FROM games WHERE chat_id = ? AND game_id = ?", (chat_id, game_id))
        await self._db.commit()
```

- [ ] **Шаг 4:** зелёные. **Шаг 5:** коммит `feat: удаление игры из хранилища`.

---

## Task 3: Уборщик удаляет созревшие сессии

**Files:** `config.py`, `app.py`, `tests/test_session_cleanup.py`

- [ ] **Шаг 1: тесты** — класс `TestPurgeExpired` в `tests/test_session_cleanup.py`. Каждый тест: поднять `GameRegistry` на `tmp_path`, положить игру, выставить метку, вызвать `purge_expired_sessions()` из `app`, проверить БД.

Обязательные случаи: созревшая веб-сессия удаляется из БД; свежая не удаляется; сессия с активным подключением не удаляется; **игра с `chat_id="-100500"` не удаляется, даже если метка древняя и подключений нет** (Telegram-игра); после удаления `manager._orphaned_at` и `manager.session_users` о ней не помнят.

- [ ] **Шаг 2:** убедиться, что падают (`ImportError: purge_expired_sessions`).

- [ ] **Шаг 3:** в `config.py` рядом с `SESSION_CLEANUP_INTERVAL`:

```python
SESSION_TTL_SECONDS = float(os.getenv("SESSION_TTL_SECONDS", 300))
```

- [ ] **Шаг 4:** в `app.py` добавить функцию и вызвать её из существующего цикла:

```python
async def purge_expired_sessions() -> None:
    """Удаляет веб-сессии, из которых все ушли дольше SESSION_TTL_SECONDS назад.

    Только веб-сессии: у игр из Telegram нет WebSocket-подключений, и под правило
    «нет подключений — удалить» они попадать не должны.
    """
    for session_id in manager.orphaned_web_sessions(SESSION_TTL_SECONDS):
        await state.storage.delete_game(WEB_CHAT_ID, session_id)
        await manager.cleanup_session(session_id)
        logger.info("Сессия %s удалена: участников нет дольше %.0f с", session_id, SESSION_TTL_SECONDS)
```

Импортировать `SESSION_TTL_SECONDS` и `WEB_CHAT_ID` из `config`, `state` уже импортирован.

В `session_cleanup_loop` вызвать `await purge_expired_sessions()` **перед** `manager.cleanup_old_sessions()` — внутри существующего `try`, чтобы сбой одного тика не убивал цикл.

- [ ] **Шаг 5:** зелёные. **Шаг 6:** коммит `feat: удалять веб-сессии через 5 минут после ухода всех`.

---

## Task 4: Убрать GET /api/sessions

**Files:** `app.py`, `web_api.py`, `ppbot/game.py`, `tests/test_api.py`, `tests/test_app.py`, `README.md`

- [ ] **Шаг 1: тест**, что маршрута нет. В `tests/test_app.py` — по образцу существующего теста на маршруты `build_app()`: среди `app.routes` нет `Route` с путём `/api/sessions` и методом `GET`, при этом `POST /api/sessions` остаётся.

- [ ] **Шаг 2:** убедиться, что падает.

- [ ] **Шаг 3:** удалить:
  - в `app.py` — строку `Route("/api/sessions", api_list_sessions, methods=["GET"])` и `api_list_sessions` из импорта;
  - в `web_api.py` — функцию `api_list_sessions` целиком;
  - в `ppbot/game.py` — метод `list_all_sessions` (используется только удаляемым эндпоинтом). **`count_sessions` оставить** — его использует `health`;
  - в `tests/test_api.py` — импорт `api_list_sessions`, маршрут в фикстуре `client` и тесты этого эндпоинта;
  - в `tests/test_app.py` — `test_api_list_sessions_exception`;
  - в `README.md` — упоминание эндпоинта в разделе API, если оно там есть (`grep -n "api/sessions" README.md`).

- [ ] **Шаг 4:** зелёные, ruff чист. **Шаг 5:** коммит `feat: убрать GET /api/sessions`.

---

## Task 5: Документация

**Files:** `README.md`, `.env.example`

- [ ] Описать поведение в README рядом с разделом про переменные окружения: веб-сессия удаляется через `SESSION_TTL_SECONDS` (по умолчанию 300) после ухода последнего участника; фактическое время — от TTL до TTL плюс `SESSION_CLEANUP_INTERVAL`; на публичном стенде интервал разумно снизить до 60. Telegram-игры не удаляются.
- [ ] Добавить `SESSION_TTL_SECONDS` в таблицу переменных README и в `.env.example` в том же стиле, что и `SESSION_CLEANUP_INTERVAL`.
- [ ] Коммит `docs: описать срок жизни веб-сессий`.

## Финальная проверка

- `PP_BOT_TOKEN=test:token .venv/bin/python -m pytest -q` и `node --test 'tests/js/*.test.js'` зелёные, `.venv/bin/ruff check .` чист.
- `grep -rn "list_all_sessions\|api_list_sessions" --include='*.py' .` — пусто.
- `git diff main --stat` — тронуты только `config.py`, `app.py`, `web_api.py`, `connection.py`, `ppbot/game.py`, `tests/`, `README.md`, `.env.example`, `docs/superpowers/`.
