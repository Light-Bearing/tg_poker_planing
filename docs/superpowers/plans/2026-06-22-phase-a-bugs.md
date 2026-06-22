# Phase A — Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 3 bugs in Planning Poker: (A1) remove incorrect scale change on join, (A2) fix initiator transfer with ws_username_map + kick mechanism, (A3) fix custom scale loading in Telegram bot.

**Architecture:** Backend changes in `connection.py`, `websocket_handler.py`, `web_api.py`, `telegram_bot.py`. Frontend in `script.js` + `styles.css`. No new files — all changes to existing code.

**Tech Stack:** Python 3.10+, asyncio, Starlette, WebSocket, Vanilla JS, pytest-asyncio

## Global Constraints

- All Python code must pass `ruff check .` and `ruff format .`
- All existing tests must pass after each task
- Use `async`/`await` for all I/O-bound operations
- Follow existing patterns (e.g., `ConnectionManager` class with dicts)
- Tests use pytest-asyncio with `asyncio_mode = "auto"`
- Use `from unittest.mock import AsyncMock, MagicMock, patch` for test mocks

---

## File Structure

**Modified files:**
- `connection.py` — `ws_username_map`, `ws_connections`, `register_ws_connection`, `unregister_ws_connection`, `kick_user`
- `websocket_handler.py` — wire ws_connection calls, add kick handler, fix `transfer_initiator_if_needed`
- `web_api.py` — add `POST /api/sessions/{session_id}/kick` endpoint
- `web/static/script.js` — remove scale change on join, add kick UI, handle `kicked` message
- `web/static/styles.css` — kick button styles
- `telegram_bot.py` — load custom_points on scale cycle to custom
- `tests/test_websocket.py` — tests for ws_username_map, kick, transfer fixes
- `tests/test_api.py` — tests for kick REST endpoint
- `tests/test_telegram_bot.py` — tests for custom scale on handle_scale_click

---

### Task 1: A1 — Remove scale change on room join

**Files:**
- Modify: `web/static/script.js:2295-2320`
- Test: manual (no JS tests exist)

**Interfaces:**
- Consumes: (none)
- Produces: (none — removes dead code)

- [ ] **Step 1: Read current code**

Open `web/static/script.js` around line 2295, find the `joinOrCreateSession` function, `if (sessionId)` block.

- [ ] **Step 2: Remove the scale override block**

Remove this code block (inside the `if (sessionId)` branch):
```js
// If the selected scale differs from the room's current scale, update it
if (scaleName !== (data.scale_name || 'custom')) {
    const scaleResp = await fetch(`/api/sessions/${sessionId}/scale`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ scale_name: scaleName })
    });
    if (scaleResp.ok) {
        const updatedData = await scaleResp.json();
        Object.assign(data, updatedData);
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add web/static/script.js
git commit -m "fix: remove scale override on room join — scale is set once at creation"
```

---

### Task 2: A2a — Add ws_username_map and ws_connections to ConnectionManager

**Files:**
- Modify: `connection.py`
- Modify: `websocket_handler.py`
- Modify: `tests/test_websocket.py`

**Interfaces:**
- Consumes: `ConnectionManager` class
- Produces:
  - `manager.register_ws_connection(session_id, username, websocket)` — track active WS
  - `manager.unregister_ws_connection(session_id, username)` — remove on disconnect
  - `manager.is_ws_connected(session_id, username) -> bool` — check active WS
  - `manager.get_active_ws_usernames(session_id) -> set[str]` — list connected users
  - `manager.get_ws_by_username(session_id, username) -> WebSocket | None` — get user's WS

- [ ] **Step 1: Write failing tests**

Add to `tests/test_websocket.py`:

```python
class TestWsUsernameMap:
    def test_register_ws_connection_adds_user(self):
        manager.register_ws_connection("s1", "alice", MagicMock())
        assert "alice" in manager.ws_username_map["s1"]

    def test_register_ws_connection_stores_websocket(self):
        ws = MagicMock()
        manager.register_ws_connection("s1", "alice", ws)
        assert manager.get_ws_by_username("s1", "alice") is ws

    def test_register_ws_connection_overwrites_old_ws(self):
        old_ws = MagicMock()
        new_ws = MagicMock()
        manager.register_ws_connection("s1", "alice", old_ws)
        manager.register_ws_connection("s1", "alice", new_ws)
        assert manager.get_ws_by_username("s1", "alice") is new_ws

    def test_unregister_ws_connection_removes_user(self):
        manager.register_ws_connection("s1", "alice", MagicMock())
        manager.register_ws_connection("s1", "bob", MagicMock())
        manager.unregister_ws_connection("s1", "alice")
        assert manager.ws_username_map["s1"] == {"bob"}
        assert manager.get_ws_by_username("s1", "alice") is None

    def test_unregister_ws_connection_removes_empty_set(self):
        manager.register_ws_connection("s1", "alice", MagicMock())
        manager.unregister_ws_connection("s1", "alice")
        assert "s1" not in manager.ws_username_map
        assert "s1" not in manager._ws_connections

    def test_unregister_ws_connection_unknown_session_does_nothing(self):
        manager.unregister_ws_connection("nonexistent", "alice")  # no error

    def test_is_ws_connected_returns_true(self):
        manager.register_ws_connection("s1", "alice", MagicMock())
        assert manager.is_ws_connected("s1", "alice") is True

    def test_is_ws_connected_returns_false(self):
        assert manager.is_ws_connected("s1", "alice") is False

    def test_get_active_ws_usernames_returns_set(self):
        manager.register_ws_connection("s1", "alice", MagicMock())
        manager.register_ws_connection("s1", "bob", MagicMock())
        assert manager.get_active_ws_usernames("s1") == {"alice", "bob"}

    def test_get_active_ws_usernames_unknown_returns_empty_set(self):
        assert manager.get_active_ws_usernames("nonexistent") == set()
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing
.venv/bin/python -m pytest tests/test_websocket.py::TestWsUsernameMap -v --tb=short
```
Expected: FAIL (attributes not found)

- [ ] **Step 3: Implement in connection.py**

In `ConnectionManager.__init__`, add:
```python
self.ws_username_map: dict[str, set[str]] = {}
self._ws_connections: dict[str, dict[str, WebSocket]] = {}  # session_id → {username: WebSocket}
```

Add methods:
```python
def register_ws_connection(self, session_id: str, username: str, websocket: WebSocket):
    """Track a user's active WebSocket connection."""
    if session_id not in self.ws_username_map:
        self.ws_username_map[session_id] = set()
        self._ws_connections[session_id] = {}
    self.ws_username_map[session_id].add(username)
    self._ws_connections[session_id][username] = websocket

def unregister_ws_connection(self, session_id: str, username: str):
    """Remove user from active WS tracking."""
    if session_id in self.ws_username_map:
        self.ws_username_map[session_id].discard(username)
        self._ws_connections[session_id].pop(username, None)
        if not self.ws_username_map[session_id]:
            del self.ws_username_map[session_id]
            del self._ws_connections[session_id]

def is_ws_connected(self, session_id: str, username: str) -> bool:
    return username in self.ws_username_map.get(session_id, set())

def get_active_ws_usernames(self, session_id: str) -> set[str]:
    return self.ws_username_map.get(session_id, set()).copy()

def get_ws_by_username(self, session_id: str, username: str) -> WebSocket | None:
    return self._ws_connections.get(session_id, {}).get(username)
```

- [ ] **Step 4: Run tests**

```bash
.venv/bin/python -m pytest tests/test_websocket.py::TestWsUsernameMap -v --tb=short
```
Expected: all PASS

- [ ] **Step 5: Wire ws_username_map into websocket_endpoint**

In `websocket_handler.py`:

In the `"join"` handler (after `manager.register_user`), pass the websocket:
```python
manager.register_ws_connection(session_id, username, websocket)
```

In `except WebSocketDisconnect` (before `transfer_initiator_if_needed`):
```python
manager.unregister_ws_connection(session_id, username)
```

Also in `except Exception` handler:
```python
manager.unregister_ws_connection(session_id, username)
```

- [ ] **Step 6: Fix transfer_initiator_if_needed**

Replace the `active_participants` check:
```python
# Old — counts all registered users:
active_participants = [
    u for u, data in manager.session_users[session_id].items()
    if data.get("status") in ["pending", "voted"]
]

# New — count only users with active WS connections:
active_participants = [
    u for u in manager.session_users.get(session_id, {})
    if manager.is_ws_connected(session_id, u)
]
```

- [ ] **Step 7: Add transfer tests**

Add to `TestTransferInitiator` in `tests/test_websocket.py`:

```python
@pytest.mark.asyncio
async def test_transfers_when_initiator_disconnects_and_bob_has_active_ws(self):
    game = state.storage.new_game(
        "web", "s5", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
    )
    await state.storage.save_game(game)
    manager.register_user("s5", "alice")
    manager.register_user("s5", "bob")
    manager.register_ws_connection("s5", "bob", MagicMock())
    manager.unregister_ws_connection("s5", "alice")

    with patch("connection.manager.broadcast", new=AsyncMock()) as mock_broadcast:
        await transfer_initiator_if_needed("s5", "alice")
        updated = await state.storage.get_game("web", "s5")
        assert updated.initiator["id"] == "web_bob"
        mock_broadcast.assert_awaited_once()

@pytest.mark.asyncio
async def test_does_not_transfer_when_bob_has_no_active_ws(self):
    game = state.storage.new_game(
        "web", "s6", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
    )
    await state.storage.save_game(game)
    manager.register_user("s6", "alice")
    manager.register_user("s6", "bob")
    # bob is in session_users but has NO active WS

    with patch("connection.manager.broadcast", new=AsyncMock()):
        await transfer_initiator_if_needed("s6", "alice")
        updated = await state.storage.get_game("web", "s6")
        assert updated.initiator["id"] == "web_alice"  # unchanged
```

- [ ] **Step 8: Run all websocket tests**

```bash
.venv/bin/python -m pytest tests/test_websocket.py -v --tb=short
```
Expected: All pass

- [ ] **Step 9: Commit**

```bash
git add connection.py websocket_handler.py tests/test_websocket.py
git commit -m "fix: add ws_username_map for tracking active connections, fix transfer_initiator"
```

---

### Task 3: A2b — Kick mechanism (backend: connection + API + WS handler)

**Files:**
- Modify: `connection.py`
- Modify: `websocket_handler.py`
- Modify: `web_api.py`
- Modify: `tests/test_websocket.py`
- Modify: `tests/test_api.py`

**Interfaces:**
- `manager.kick_user(session_id, target_username) -> bool` — removes user, returns True if found
- WS `{"type": "kick_user", "username": "alice", "target_username": "bob"}` — kick via WS
- REST `POST /api/sessions/{session_id}/kick` with `{username, target_username}`
- Server sends `{"type": "kicked"}` to the kicked user's WS
- Server broadcasts `{"type": "user_kicked", "username": "bob", "data": ...}` to remaining

- [ ] **Step 1: Write tests for ConnectionManager.kick_user**

Add to `tests/test_websocket.py`:

```python
class TestKick:
    def test_kick_user_removes_from_session_users(self):
        manager.register_user("s1", "alice")
        manager.register_user("s1", "bob")
        result = manager.kick_user("s1", "bob")
        assert result is True
        assert "bob" not in manager.session_users["s1"]

    def test_kick_user_removes_from_ws_username_map(self):
        manager.register_user("s1", "alice")
        manager.register_user("s1", "bob")
        manager.register_ws_connection("s1", "bob", MagicMock())
        manager.kick_user("s1", "bob")
        assert manager.is_ws_connected("s1", "bob") is False

    def test_kick_user_unknown_user_returns_false(self):
        manager.register_user("s1", "alice")
        result = manager.kick_user("s1", "nonexistent")
        assert result is False

    def test_kick_user_unknown_session_returns_false(self):
        result = manager.kick_user("nonexistent", "bob")
        assert result is False

    def test_kick_user_removes_empty_ws_map(self):
        manager.register_ws_connection("s1", "alice", MagicMock())
        manager.register_ws_connection("s1", "bob", MagicMock())
        manager.kick_user("s1", "alice")
        manager.kick_user("s1", "bob")
        assert "s1" not in manager.ws_username_map
```

- [ ] **Step 2: Run to verify they fail**

```bash
.venv/bin/python -m pytest tests/test_websocket.py::TestKick -v --tb=short
```
Expected: FAIL

- [ ] **Step 3: Implement ConnectionManager.kick_user**

In `connection.py`:
```python
def kick_user(self, session_id: str, target_username: str) -> bool:
    """Remove a user from the session. Returns True if user was found and removed."""
    if session_id not in self.session_users:
        return False
    if target_username not in self.session_users[session_id]:
        return False
    del self.session_users[session_id][target_username]
    if not self.session_users[session_id]:
        del self.session_users[session_id]
    # Clean up WS tracking
    if session_id in self.ws_username_map:
        self.ws_username_map[session_id].discard(target_username)
    if session_id in self._ws_connections:
        self._ws_connections[session_id].pop(target_username, None)
    # Clean up empty session WS tracking
    if session_id in self.ws_username_map and not self.ws_username_map[session_id]:
        del self.ws_username_map[session_id]
    if session_id in self._ws_connections and not self._ws_connections[session_id]:
        del self._ws_connections[session_id]
    return True
```

- [ ] **Step 4: Run tests**

```bash
.venv/bin/python -m pytest tests/test_websocket.py::TestKick -v --tb=short
```
Expected: all PASS

- [ ] **Step 5: Write WebSocket kick tests**

Add to `tests/test_websocket.py`:

```python
class TestWebSocketKick:
    @pytest.mark.asyncio
    async def test_kick_user_by_initiator(self, ws):
        game = state.storage.new_game(
            "web", "test-session", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
        )
        await state.storage.save_game(game)
        manager.register_user("test-session", "alice")
        manager.register_user("test-session", "bob")
        manager.register_ws_connection("test-session", "alice", MockWs())
        manager.register_ws_connection("test-session", "bob", MockWs())

        ws.receive_text.side_effect = [
            '{"type": "join", "username": "alice"}',
            '{"type": "kick_user", "username": "alice", "target_username": "bob"}',
            WebSocketDisconnect(),
        ]
        await websocket_endpoint(ws)
        assert "bob" not in manager.session_users.get("test-session", {})

    @pytest.mark.asyncio
    async def test_kick_user_non_initiator_rejected(self, ws):
        game = state.storage.new_game(
            "web", "test-session", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
        )
        await state.storage.save_game(game)
        manager.register_user("test-session", "alice")
        manager.register_user("test-session", "bob")
        manager.register_ws_connection("test-session", "bob", MockWs())

        ws.receive_text.side_effect = [
            '{"type": "join", "username": "bob"}',
            '{"type": "kick_user", "username": "bob", "target_username": "alice"}',
            WebSocketDisconnect(),
        ]
        await websocket_endpoint(ws)
        assert "alice" in manager.session_users.get("test-session", {})
```

Need a helper at the top of the test file:
```python
class MockWs:
    """Minimal WebSocket mock for kick testing."""
    async def send_json(self, data): pass
    async def close(self, code=1000): pass
```

- [ ] **Step 6: Run to verify they fail**

```bash
.venv/bin/python -m pytest tests/test_websocket.py::TestWebSocketKick -v --tb=short
```
Expected: FAIL

- [ ] **Step 7: Add kick_user handler to websocket_endpoint**

In `websocket_handler.py`, inside the `while True` loop, add after `set_scale` handler:

```python
elif msg_type == "kick_user":
    target_username = msg.get("target_username", "")
    kicker_username = msg.get("username", "")
    if game and target_username and kicker_username:
        if f"web_{kicker_username}" != game.initiator.get("id"):
            await websocket.send_json(
                {"type": "error", "message": "Только инициатор может исключать участников"}
            )
        elif target_username == kicker_username:
            await websocket.send_json(
                {"type": "error", "message": "Нельзя исключить себя"}
            )
        else:
            # Send "kicked" message to the kicked user
            kicked_ws = manager.get_ws_by_username(session_id, target_username)
            if kicked_ws:
                try:
                    await kicked_ws.send_json({
                        "type": "kicked",
                        "message": f"Вы были исключены инициатором {kicker_username}"
                    })
                except Exception:
                    pass  # connection may already be dead

            # Remove the user
            if manager.kick_user(session_id, target_username):
                updated_data = enrich_session_response(game, session_id)
                await manager.broadcast(session_id, {
                    "type": "user_kicked",
                    "username": target_username,
                    "data": updated_data,
                })
```

- [ ] **Step 8: Write tests for REST kick endpoint**

Add to `tests/test_api.py`:

```python
class TestKick:
    def test_kick_user(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]

        # Register Bob as a participant
        from connection import manager
        manager.register_user(session_id, "bob")

        resp = client.post(f"/api/sessions/{session_id}/kick",
            json={"username": "Alice", "target_username": "bob"})
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("ok") is True

    def test_kick_user_non_initiator_forbidden(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]

        manager.register_user(session_id, "bob")
        manager.register_user(session_id, "charlie")

        resp = client.post(f"/api/sessions/{session_id}/kick",
            json={"username": "bob", "target_username": "charlie"})
        assert resp.status_code == 403

    def test_kick_user_not_found(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]

        resp = client.post(f"/api/sessions/{session_id}/kick",
            json={"username": "Alice", "target_username": "nonexistent"})
        assert resp.status_code == 404
```

- [ ] **Step 9: Add REST endpoint**

In `web_api.py`, add before the last helper functions:

```python
async def api_kick_user(request: Request):
    session_id = request.path_params["session_id"]
    try:
        data = await request.json()
        username = data.get("username", "").strip()
        target_username = data.get("target_username", "").strip()
        if not username or not target_username:
            return JSONResponse({"error": "username and target_username are required"}, status_code=400)

        game = await state.storage.get_game(WEB_CHAT_ID, session_id)
        if not game:
            return JSONResponse({"error": "Session not found"}, status_code=404)

        if f"web_{username}" != game.initiator.get("id"):
            return JSONResponse({"error": "Only initiator can kick users"}, status_code=403)

        if target_username == username:
            return JSONResponse({"error": "Cannot kick yourself"}, status_code=400)

        # Send "kicked" message if they have active WS
        kicked_ws = manager.get_ws_by_username(session_id, target_username)
        if kicked_ws:
            try:
                await kicked_ws.send_json({
                    "type": "kicked",
                    "message": f"Вы были исключены инициатором {username}"
                })
            except Exception:
                pass

        if not manager.kick_user(session_id, target_username):
            return JSONResponse({"error": "User not found in session"}, status_code=404)

        await manager.broadcast(session_id, {
            "type": "user_kicked",
            "username": target_username,
            "data": enrich_session_response(game, session_id),
        })

        logger.info(f"User {target_username} kicked from session {session_id} by {username}")
        return JSONResponse({"ok": True})
    except Exception as e:
        logger.error(f"Error kicking user: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)
```

Register route in `app.py`:
```python
Route("/api/sessions/{session_id}/kick", api_kick_user, methods=["POST"])
```

- [ ] **Step 10: Run all API tests**

```bash
.venv/bin/python -m pytest tests/test_api.py -v --tb=short
```
Expected: all pass

- [ ] **Step 11: Commit**

```bash
git add connection.py websocket_handler.py web_api.py app.py tests/test_websocket.py tests/test_api.py
git commit -m "feat(kick): add kick mechanism — initiator can remove participants via WS and REST"
```

---

### Task 4: A2b — Kick mechanism (frontend)

**Files:**
- Modify: `web/static/script.js`
- Modify: `web/static/styles.css`

- [ ] **Step 1: Add kickParticipant function**

In `web/static/script.js`, add:
```js
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
```

- [ ] **Step 2: Handle kicked/user_kicked in WS onmessage**

In `state.ws.onmessage`, add before the `init/update` handler:
```js
if (message.type === 'kicked') {
    toast.error(message.message || 'Вы были исключены из комнаты', 'ИСКЛЮЧЕНИЕ');
    setTimeout(() => leaveSession(), 2000);
    return;
}

if (message.type === 'user_kicked') {
    updateSessionDisplay(message.data);
    return;
}
```

- [ ] **Step 3: Add kick button to participant rendering**

Find the participant rendering code in `updateSessionDisplay` or similar. Inside the participant loop, after the username display but before closing the participant item div, add:
```js
if (state.isInitiator && p.username !== state.username) {
    html += `<button class="kick-btn" data-username="${p.username}" onclick="kickParticipant('${p.username}')" title="Исключить">✕</button>`;
}
```

- [ ] **Step 4: Add CSS**

In `web/static/styles.css`:
```css
.kick-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 12px;
    opacity: 0;
    transition: opacity 0.15s, background 0.15s, color 0.15s;
    margin-left: auto;
    flex-shrink: 0;
}
.participant-item:hover .kick-btn {
    opacity: 0.6;
}
.kick-btn:hover {
    opacity: 1 !important;
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
}
```

- [ ] **Step 5: Commit**

```bash
git add web/static/script.js web/static/styles.css
git commit -m "feat(kick): add kick button UI for initiator, handle kicked WS message"
```

---

### Task 5: A3 — Custom scale in Telegram bot

**Files:**
- Modify: `telegram_bot.py`
- Modify: `tests/test_telegram_bot.py`

- [ ] **Step 1: Write tests**

Add to `tests/test_telegram_bot.py`:

```python
class TestHandleScaleClickCustomScale:
    @pytest.mark.asyncio
    async def test_switching_to_custom_loads_saved_points(self):
        from telegram_bot import handle_scale_click
        await state.storage.save_custom_scale("1", ["10", "20", "30", "50", "100"])

        game = state.storage.new_game(-100, "scale_custom1",
            {"id": 1, "first_name": "A", "username": "a"}, "task")
        game.scale_name = "fibonacci"
        await state.storage.save_game(game)

        query = AsyncMock()
        query.data = "scale-cycle-scale_custom1"
        query.message.chat_id = -100
        query.from_user.id = 1
        query.answer = AsyncMock()
        query.edit_message_text = AsyncMock()

        await handle_scale_click(query, query.data, -100)
        updated = await state.storage.get_game(-100, "scale_custom1")
        assert updated.scale_name == "custom"
        assert updated.custom_points == ["10", "20", "30", "50", "100"]

    @pytest.mark.asyncio
    async def test_switching_to_custom_without_saved_points_uses_defaults(self):
        from telegram_bot import handle_scale_click

        game = state.storage.new_game(-100, "scale_custom2",
            {"id": 1, "first_name": "A", "username": "a"}, "task")
        game.scale_name = "tshirt"
        await state.storage.save_game(game)

        query = AsyncMock()
        query.data = "scale-cycle-scale_custom2"
        query.message.chat_id = -100
        query.from_user.id = 1
        query.answer = AsyncMock()
        query.edit_message_text = AsyncMock()

        await handle_scale_click(query, query.data, -100)
        updated = await state.storage.get_game(-100, "scale_custom2")
        assert updated.scale_name == "custom"
        assert updated.custom_points == []
```

- [ ] **Step 2: Run to see them fail**

```bash
.venv/bin/python -m pytest tests/test_telegram_bot.py::TestHandleScaleClickCustomScale -v --tb=short
```

- [ ] **Step 3: Modify handle_scale_click in telegram_bot.py**

In `telegram_bot.py`, inside `handle_scale_click`, after advancing the scale (after `game.scale_name = scale_keys[next_idx]`), add:

```python
# If switching to custom scale, load saved custom points
if game.scale_name == "custom":
    initiator_key = str(game.initiator.get("id", ""))
    if initiator_key:
        saved_points = await state.storage.get_custom_scale(initiator_key)
        if saved_points:
            game.custom_points = saved_points
        else:
            game.custom_points = []
```

- [ ] **Step 4: Run tests**

```bash
.venv/bin/python -m pytest tests/test_telegram_bot.py::TestHandleScaleClickCustomScale -v --tb=short
```
Expected: PASS

- [ ] **Step 5: Run all tests**

```bash
.venv/bin/python -m pytest tests/ -v --tb=short
```
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add telegram_bot.py tests/test_telegram_bot.py
git commit -m "fix: load saved custom_points when cycling to custom scale in Telegram bot"
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - A1 (remove scale change on join) → Task 1 ✅
   - A2a (ws_username_map + fix transfer_initiator) → Task 2 ✅
   - A2b (kick mechanism backend) → Task 3 ✅
   - A2b (kick mechanism frontend) → Task 4 ✅
   - A3 (custom scale in Telegram bot) → Task 5 ✅

2. **Placeholder scan:** No TBD/TODO — every step has exact code, file paths, and commands.

3. **Type consistency:** `ws_username_map` is `dict[str, set[str]]`, `_ws_connections` is `dict[str, dict[str, WebSocket]]`, `kick_user` returns `bool` — consistent across all tasks.

4. **Test patterns:** Follow existing conventions — `AsyncMock`, `MagicMock`, `pytest-asyncio`, `state.storage` fixtures.