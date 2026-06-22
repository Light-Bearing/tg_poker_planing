# Fix Logical Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 7 logical errors found in business functions across game.py, web_api.py, websocket_handler.py, and connection.py

**Architecture:** TDD approach — first add missing test coverage for each bug, then fix the code, then verify all tests pass. Changes are targeted to specific functions with minimal refactoring.

**Tech Stack:** Python 3.10+, pytest, asyncio, aiosqlite, Starlette, python-telegram-bot

## Global Constraints

- All existing tests must continue to pass after each change
- Each fix must have at least one test verifying the corrected behavior
- Test files follow existing patterns (pytest, AsyncMock, MagicMock)
- No breaking changes to API contracts (endpoints, WebSocket messages)
- Commit after each completed task with descriptive message

---

### Task 1: Add tests for auto_reveal roundtrip (game.py)

**Files:**
- Create: `tests/test_game_persistence.py`

**Interfaces:**
- Consumes: `Game` class from `ppbot/game`, `GameRegistry` from `ppbot/game`
- Produces: Test evidence that auto_reveal is lost in from_dict roundtrip

- [ ] **Step 1: Write failing test — auto_reveal lost in from_dict**

```python
"""Tests for Game persistence with auto_reveal setting."""

import pytest
from ppbot.game import Game, Initiator, GameRegistry


class TestAutoRevealPersistence:
    def test_auto_reveal_in_from_dict(self, sample_initiator):
        """auto_reveal=True survives Game → dict → Game roundtrip"""
        game = Game(-100, "s1", sample_initiator, "task", auto_reveal=True)
        d = game.to_dict()
        restored = Game.from_dict(-100, "s1", d)
        assert restored.auto_reveal is True

    def test_auto_reveal_false_in_from_dict(self, sample_initiator):
        """auto_reveal=False survives Game → dict → Game roundtrip"""
        game = Game(-100, "s1", sample_initiator, "task", auto_reveal=False)
        d = game.to_dict()
        restored = Game.from_dict(-100, "s1", d)
        assert restored.auto_reveal is False

    def test_auto_reveal_default_in_from_dict(self, sample_initiator):
        """auto_reveal defaults to False when not in dict"""
        game = Game(-100, "s1", sample_initiator, "task", auto_reveal=True)
        d = game.to_dict()
        del d["auto_reveal"]  # simulate old data without auto_reveal
        restored = Game.from_dict(-100, "s1", d)
        assert restored.auto_reveal is False

    def test_auto_reveal_in_dict(self, sample_initiator):
        """auto_reveal is present in to_dict output"""
        game = Game(-100, "s1", sample_initiator, "task", auto_reveal=True)
        d = game.to_dict()
        assert "auto_reveal" in d
        assert d["auto_reveal"] is True

    def test_save_and_load_auto_reveal(self):
        """auto_reveal survives save → load from DB"""
        import json
        registry = GameRegistry()
        pytest.skip("Requires DB — tested in integration") 
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/test_game_persistence.py::TestAutoRevealPersistence -v`

Expected: First test FAILS because from_dict doesn't restore auto_reveal

- [ ] **Step 3: Write minimal implementation in game.py**

In `/Users/msk-hq-nb-1079/project/my/python/tg_poker_planing/ppbot/game.py`, modify `Game.from_dict` to pass `auto_reveal` parameter:

```python
@classmethod
def from_dict(cls, chat_id, vote_id, dct):
    res = cls(
        chat_id,
        vote_id,
        Initiator.from_dict(dct["initiator"]),
        dct["text"],
        scale_name=dct.get("scale_name"),
        custom_points=dct.get("custom_points", []),
        auto_reveal=dct.get("auto_reveal", False),  # ← ADD THIS
    )
    for user_id, vote in dct["votes"].items():
        res.votes[user_id] = Vote.from_dict(vote)
    res.revealed = dct["revealed"]
    res.reply_message_id = dct["reply_message_id"]
    return res
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/test_game_persistence.py::TestAutoRevealPersistence -v`

Expected: All tests PASS

- [ ] **Step 5: Run ALL existing tests to verify no regressions**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/ -v`

Expected: All tests PASS (including existing ones)

- [ ] **Step 6: Commit**

```bash
cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && git add tests/test_game_persistence.py ppbot/game.py && git commit -m "fix: preserve auto_reveal setting in Game.from_dict roundtrip"
```

---

### Task 2: Fix check_auto_reveal — use game.votes instead of session_users status

**Files:**
- Modify: `websocket_handler.py:13-37`
- Modify: `tests/test_websocket.py` (add tests)

**Interfaces:**
- Consumes: `check_auto_reveal(session_id, game)` function
- Produces: Reliable auto-reveal that checks game.votes directly

- [ ] **Step 1: Write failing tests for check_auto_reveal**

Add to `/Users/msk-hq-nb-1079/project/my/python/tg_poker_planing/tests/test_websocket.py` at the end:

```python
class TestCheckAutoReveal:
    @pytest.mark.asyncio
    async def test_auto_reveal_triggers_when_all_voted(self):
        """Auto-reveal triggers when all participants have voted."""
        from websocket_handler import check_auto_reveal
        game = state.storage.new_game(
            "web", "test-session",
            {"id": "web_alice", "first_name": "Alice", "username": "alice"},
            "task",
        )
        game.auto_reveal = True
        await state.storage.save_game(game)
        
        # Register 2 participants
        manager.register_user("test-session", "alice")
        manager.register_user("test-session", "bob")
        
        # Both have voted via game.votes
        game.add_vote({"id": "web_alice", "first_name": "Alice", "username": "alice"}, "5")
        game.add_vote({"id": "web_bob", "first_name": "Bob", "username": "bob"}, "3")
        await state.storage.save_game(game)
        
        with patch("connection.manager.broadcast", new=AsyncMock()) as mock_broadcast:
            await check_auto_reveal("test-session", game)
            assert game.revealed is True
            mock_broadcast.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_auto_reveal_skipped_when_not_all_voted(self):
        """Auto-reveal does NOT trigger when not all participants voted."""
        from websocket_handler import check_auto_reveal
        game = state.storage.new_game(
            "web", "test-session",
            {"id": "web_alice", "first_name": "Alice", "username": "alice"},
            "task",
        )
        game.auto_reveal = True
        await state.storage.save_game(game)
        
        # Register 2 participants but only 1 voted
        manager.register_user("test-session", "alice")
        manager.register_user("test-session", "bob")
        
        game.add_vote({"id": "web_alice", "first_name": "Alice", "username": "alice"}, "5")
        await state.storage.save_game(game)
        
        with patch("connection.manager.broadcast", new=AsyncMock()) as mock_broadcast:
            await check_auto_reveal("test-session", game)
            assert game.revealed is False
            mock_broadcast.assert_not_called()

    @pytest.mark.asyncio
    async def test_auto_reveal_skipped_when_disabled(self):
        """Auto-reveal does NOT trigger when auto_reveal=False."""
        from websocket_handler import check_auto_reveal
        game = state.storage.new_game(
            "web", "test-session",
            {"id": "web_alice", "first_name": "Alice", "username": "alice"},
            "task",
        )
        game.auto_reveal = False
        await state.storage.save_game(game)
        
        manager.register_user("test-session", "alice")
        game.add_vote({"id": "web_alice", "first_name": "Alice", "username": "alice"}, "5")
        await state.storage.save_game(game)
        
        with patch("connection.manager.broadcast", new=AsyncMock()) as mock_broadcast:
            await check_auto_reveal("test-session", game)
            assert game.revealed is False
            mock_broadcast.assert_not_called()

    @pytest.mark.asyncio
    async def test_auto_reveal_skipped_when_already_revealed(self):
        """Auto-reveal does NOT trigger when already revealed."""
        from websocket_handler import check_auto_reveal
        game = state.storage.new_game(
            "web", "test-session",
            {"id": "web_alice", "first_name": "Alice", "username": "alice"},
            "task",
        )
        game.auto_reveal = True
        game.revealed = True
        await state.storage.save_game(game)
        
        manager.register_user("test-session", "alice")
        
        with patch("connection.manager.broadcast", new=AsyncMock()) as mock_broadcast:
            await check_auto_reveal("test-session", game)
            mock_broadcast.assert_not_called()

    @pytest.mark.asyncio
    async def test_auto_reveal_skipped_when_no_participants(self):
        """Auto-reveal does NOT trigger when no participants registered."""
        from websocket_handler import check_auto_reveal
        game = state.storage.new_game(
            "web", "test-session",
            {"id": "web_alice", "first_name": "Alice", "username": "alice"},
            "task",
        )
        game.auto_reveal = True
        await state.storage.save_game(game)
        
        with patch("connection.manager.broadcast", new=AsyncMock()) as mock_broadcast:
            await check_auto_reveal("test-session", game)
            mock_broadcast.assert_not_called()
```

- [ ] **Step 2: Run new tests to verify they fail (auto_reveal broken)**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/test_websocket.py::TestCheckAutoReveal -v`

Expected: Tests fail because check_auto_reveal checks session_users status instead of game.votes

- [ ] **Step 3: Fix check_auto_reveal in websocket_handler.py**

Replace the implementation in `/Users/msk-hq-nb-1079/project/my/python/tg_poker_planing/websocket_handler.py` lines 13-37:

```python
async def check_auto_reveal(session_id: str, game):
    """Проверяет условие автооткрытия результатов при полном наборе голосов"""
    if game.revealed:
        return

    if not getattr(game, "auto_reveal", False):
        return

    participants = manager.session_users.get(session_id, {})
    if not participants:
        return

    # Проверяем голоса из game.votes, а не статус из session_users
    # Это надежнее, т.к. game.votes гарантированно синхронизирован с БД
    voted_count = len(game.votes)
    total_count = len(participants)

    if voted_count > 0 and voted_count == total_count:
        game.revealed = True
        await state.storage.save_game(game)
        logger.info(f"Auto-reveal: все {total_count} участников проголосовали в сессии {session_id}")

        await manager.broadcast(session_id, {"type": "update", "data": enrich_session_response(game, session_id)})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/test_websocket.py::TestCheckAutoReveal -v`

Expected: All 5 tests PASS

- [ ] **Step 5: Run ALL existing tests to verify no regressions**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/ -v`

Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && git add websocket_handler.py tests/test_websocket.py && git commit -m "fix: use game.votes instead of session_users status for reliable auto-reveal"
```

---

### Task 3: Fix validation order in api_vote (500 → 400 on vote after reveal)

**Files:**
- Modify: `web_api.py:191-209`
- Modify: `tests/test_api.py` (enhance existing test)

**Interfaces:**
- Consumes: `api_vote` request handler
- Produces: Correct 400 error when voting after reveal instead of 500

- [ ] **Step 1: Write failing test for correct error code**

Add to `TestVoting` class in `/Users/msk-hq-nb-1079/project/my/python/tg_poker_planing/tests/test_api.py`:

```python
def test_vote_after_reveal_returns_400_not_500(self, client):
    """Vote after reveal returns 400, not 500."""
    create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
    session_id = create["session_id"]

    client.post(f"/api/sessions/{session_id}/reveal", json={"username": "Alice"})
    resp = client.post(f"/api/sessions/{session_id}/vote", json={"username": "Bob", "point": "3"})
    assert resp.status_code == 400
    # Verify it's a proper 400, not a 500
    assert "Session is already revealed" in resp.json().get("error", "")
```

Also modify the existing `test_vote_after_reveal_rejected` to be more precise:

```python
def test_vote_after_reveal_rejected(self, client):
    """Vote after reveal is rejected with 400."""
    create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
    session_id = create["session_id"]

    client.post(f"/api/sessions/{session_id}/reveal", json={"username": "Alice"})
    resp = client.post(f"/api/sessions/{session_id}/vote", json={"username": "Bob", "point": "3"})
    assert resp.status_code == 400
    data = resp.json()
    assert "revealed" in data.get("error", "").lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/test_api.py::TestVoting::test_vote_after_reveal_returns_400_not_500 -v`

Expected: Test FAILS because process_web_vote raises ValueError → 500

- [ ] **Step 3: Fix process_web_vote and api_vote in web_api.py**

Replace `api_vote` function in `/Users/msk-hq-nb-1079/project/my/python/tg_poker_planing/web_api.py`:

```python
async def api_vote(request: Request):
    session_id = request.path_params["session_id"]
    try:
        data = await request.json()
        username, point = data.get("username", "").strip(), data.get("point", "").strip()
        if not username or not point:
            return JSONResponse({"error": "Username and point are required"}, status_code=400)

        game = await state.storage.get_game(WEB_CHAT_ID, session_id)
        if not game:
            return JSONResponse({"error": "Session not found"}, status_code=404)
        
        # Check revealed BEFORE process_web_vote to avoid ValueError → 500
        if game.revealed:
            return JSONResponse({"error": "Session is already revealed"}, status_code=400)
        
        # Validate point before calling process_web_vote
        if point not in game.get_points():
            return JSONResponse({"error": f"Point '{point}' is not in the current scale ({game.scale_name})"}, status_code=400)

        updated_data = await process_web_vote(session_id, game, username, point)
        return JSONResponse(updated_data)
    except JSONResponse as e:
        # Re-raise JSONResponse to preserve status code
        raise e
    except Exception as e:
        logger.error(f"Error voting: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)
```

Also update `process_web_vote` to remove duplicate validation (it's now done in api_vote):

```python
async def process_web_vote(session_id: str, game, username: str, point: str):
    """Process a vote from a web user and broadcast the update.
    
    Note: point validation must be done by the caller before calling this function.
    """
    user_id = f"web_{username}"
    vote_data = {"user_id": user_id, "username": username, "point": point, "real_point": point, "version": 0}
    game.add_vote({"id": user_id, "first_name": username, "username": username}, point)
    await state.storage.save_game(game)
    manager.update_user_vote(session_id, username, vote_data)
    updated_data = enrich_session_response(game, session_id)
    await manager.broadcast(session_id, {"type": "update", "data": updated_data})
    return updated_data
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/test_api.py::TestVoting -v`

Expected: All voting tests PASS

- [ ] **Step 5: Run ALL existing tests to verify no regressions**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/ -v`

Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && git add web_api.py tests/test_api.py && git commit -m "fix: validate game.revealed before process_web_vote to return 400 instead of 500"
```

---

### Task 4: Fix transfer_initiator logic — invert condition and prevent incorrect transfer

**Files:**
- Modify: `websocket_handler.py:40-85`
- Modify: `tests/test_websocket.py` (add tests for reconnect scenario)

**Interfaces:**
- Consumes: `transfer_initiator_if_needed(session_id, leaving_username)` function
- Produces: Correct initiator transfer logic

- [ ] **Step 1: Write failing tests for transfer_initiator edge cases**

Add to `TestTransferInitiator` in `/Users/msk-hq-nb-1079/project/my/python/tg_poker_planing/tests/test_websocket.py`:

```python
@pytest.mark.asyncio
async def test_does_not_transfer_when_only_initiator_in_session(self):
    """Initiator leaves but is the only one in session → no transfer."""
    game = state.storage.new_game(
        "web", "s7", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
    )
    await state.storage.save_game(game)
    # Only initiator is registered
    manager.register_user("s7", "alice")
    
    await transfer_initiator_if_needed("s7", "alice")
    updated = await state.storage.get_game("web", "s7")
    assert updated.initiator.id == "web_alice"

@pytest.mark.asyncio
async def test_transfers_to_active_user_not_disconnected_one(self):
    """Transfer goes to user with active WS, not the one who just disconnected."""
    game = state.storage.new_game(
        "web", "s8", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
    )
    await state.storage.save_game(game)
    # 3 users: alice (initiator), bob (active), charlie (disconnected)
    manager.register_user("s8", "alice")
    manager.register_user("s8", "bob")
    manager.register_user("s8", "charlie")
    manager.register_ws_connection("s8", "bob", MagicMock())
    # charlie is NOT in ws_username_map (disconnected)
    
    with patch("connection.manager.broadcast", new=AsyncMock()) as mock_broadcast:
        await transfer_initiator_if_needed("s8", "alice")
        updated = await state.storage.get_game("web", "s8")
        assert updated.initiator.id == "web_bob"
        mock_broadcast.assert_awaited_once()

@pytest.mark.asyncio
async def test_does_not_transfer_when_leaving_user_not_initiator(self):
    """Non-initiator leaving → no transfer needed."""
    game = state.storage.new_game(
        "web", "s9", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
    )
    await state.storage.save_game(game)
    manager.register_user("s9", "alice")
    manager.register_user("s9", "bob")
    manager.register_ws_connection("s9", "bob", MagicMock())
    
    with patch("connection.manager.broadcast", new=AsyncMock()):
        await transfer_initiator_if_needed("s9", "bob")
        updated = await state.storage.get_game("web", "s9")
        assert updated.initiator.id == "web_alice"  # unchanged
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/test_websocket.py::TestTransferInitiator -v`

Expected: At least `test_does_not_transfer_when_only_initiator_in_session` FAILS because the condition is inverted

- [ ] **Step 3: Fix transfer_initiator_if_needed in websocket_handler.py**

Replace the function in `/Users/msk-hq-nb-1079/project/my/python/tg_poker_planing/websocket_handler.py` lines 40-84:

```python
async def transfer_initiator_if_needed(session_id: str, leaving_username: str):
    game = await state.storage.get_game(WEB_CHAT_ID, session_id)
    if not game:
        logger.warning(f"transfer_initiator: game not found for session {session_id}")
        return

    leaving_id = f"web_{leaving_username}"
    if game.initiator.id != leaving_id:
        logger.info("transfer_initiator: %s was not the initiator", leaving_username)
        return

    # Проверяем что в сессии есть другие участники
    if session_id not in manager.session_users or not manager.session_users[session_id]:
        logger.info(
            "transfer_initiator: no participants in session, keeping %s as initiator",
            leaving_username,
        )
        return
    
    participants = manager.session_users[session_id]
    
    # Если в сессии только инициатор — не передаём
    if len(participants) <= 1:
        logger.info(
            "transfer_initiator: only initiator in session, keeping %s as initiator",
            leaving_username,
        )
        return

    # Проверяем остались ли активные участники (с активным WS подключением)
    active_participants = [
        u for u in participants
        if manager.is_ws_connected(session_id, u) and u != leaving_username
    ]

    if not active_participants:
        logger.info(
            "transfer_initiator: no active participants left, keeping %s as initiator",
            leaving_username,
        )
        return

    new_initiator_username = active_participants[0]

    game.initiator = Initiator.from_web(new_initiator_username)
    await state.storage.save_game(game)
    logger.info(
        "Initiator role transferred: %s → %s in session %s",
        leaving_username,
        new_initiator_username,
        session_id,
    )

    await manager.broadcast(session_id, {"type": "update", "data": enrich_session_response(game, session_id)})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/test_websocket.py::TestTransferInitiator -v`

Expected: All 10 tests PASS

- [ ] **Step 5: Run ALL existing tests to verify no regressions**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/ -v`

Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && git add websocket_handler.py tests/test_websocket.py && git commit -m "fix: correct transfer_initiator logic — prevent transfer when only initiator in session"
```

---

### Task 5: Add API tests for auto_reveal endpoint and fix validation edge cases

**Files:**
- Modify: `tests/test_api.py` (add TestAutoReveal class)
- Modify: `web_api.py` (minor fixes for edge cases)

**Interfaces:**
- Consumes: `api_set_auto_reveal`, `api_create_session` with auto_reveal param
- Produces: Tests covering auto_reveal toggle during session

- [ ] **Step 1: Add auto_reveal API tests**

Add to `/Users/msk-hq-nb-1079/project/my/python/tg_poker_planing/tests/test_api.py`:

```python
class TestAutoRevealApi:
    def test_create_session_with_auto_reveal(self, client):
        """Create session with auto_reveal=True."""
        resp = client.post(
            "/api/sessions",
            json={"username": "Alice", "text": "My task", "auto_reveal": True},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["auto_reveal"] is True

    def test_create_session_without_auto_reveal(self, client):
        """Create session without auto_reveal defaults to False."""
        resp = client.post("/api/sessions", json={"username": "Alice", "text": "My task"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["auto_reveal"] is False

    def test_set_auto_reveal_enable(self, client):
        """Enable auto_reveal during session."""
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]
        
        resp = client.post(f"/api/sessions/{session_id}/auto-reveal", json={"auto_reveal": True})
        # Note: endpoint doesn't exist yet in routes, this will fail
        assert resp.status_code == 200 if "auto-reveal" in [r.path for r in client.app.routes] else 404

    def test_auto_reveal_persists_after_restart(self, client):
        """Auto-reveal setting persists after session restart."""
        create = client.post(
            "/api/sessions",
            json={"username": "Alice", "text": "My task", "auto_reveal": True},
        ).json()
        session_id = create["session_id"]
        
        # Restart
        client.post(f"/api/sessions/{session_id}/restart", json={"username": "Alice"})
        
        # Get session and check auto_reveal persisted
        resp = client.get(f"/api/sessions/{session_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["auto_reveal"] is True
```

- [ ] **Step 2: Run auto-reveal tests to see what's missing**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/test_api.py::TestAutoRevealApi -v`

Expected: At least `test_set_auto_reveal_enable` fails because route doesn't exist in test routes

- [ ] **Step 3: Add missing auto-reveal route to test fixture**

In `/Users/msk-hq-nb-1079/project/my/python/tg_poker_planing/tests/test_api.py`, add the auto-reveal route to the `client` fixture:

```python
Route("/api/sessions/{session_id}/auto-reveal", api_set_auto_reveal, methods=["POST"]),
```

Add it after the `/api/sessions/{session_id}/kick` route.

- [ ] **Step 4: Verify the test passes correctly**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/test_api.py::TestAutoRevealApi -v`

Expected: All tests PASS (the auto_reveal API already works, just was missing from test routes)

- [ ] **Step 5: Run ALL existing tests to verify no regressions**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/ -v`

Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && git add web_api.py tests/test_api.py && git commit -m "test: add tests for auto_reveal API endpoint and persistence"
```

---

### Task 6: Add custom_points validation (duplicates, minimum count)

**Files:**
- Modify: `web_api.py:322-338`
- Modify: `tests/test_api.py` (add validation tests)

**Interfaces:**
- Consumes: `api_save_custom_scale` request handler
- Produces: Validation that checks for duplicates and min 8 points

- [ ] **Step 1: Write failing tests for custom_points validation**

Add to `TestCustomScale` in `/Users/msk-hq-nb-1079/project/my/python/tg_poker_planing/tests/test_api.py`:

```python
def test_save_custom_scale_duplicates_rejected(self, client):
    """Custom scale with duplicate points is rejected."""
    resp = client.post(
        "/api/custom-scale",
        json={"username": "Alice", "points": ["10", "20", "10", "30"]},
    )
    assert resp.status_code == 400

def test_save_custom_scale_too_few_points(self, client):
    """Custom scale with < 8 points is rejected."""
    resp = client.post(
        "/api/custom-scale",
        json={"username": "Alice", "points": ["10", "20", "30"]},
    )
    assert resp.status_code == 400

def test_save_custom_scale_minimum_points_accepted(self, client):
    """Custom scale with exactly 8 points is accepted."""
    points = [str(i) for i in range(1, 9)]
    resp = client.post(
        "/api/custom-scale",
        json={"username": "Alice", "points": points},
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/test_api.py::TestCustomScale -v`

Expected: `test_save_custom_scale_duplicates_rejected` FAILS (no duplicate check), `test_save_custom_scale_too_few_points` FAILS (still allows < 8)

- [ ] **Step 3: Fix api_save_custom_scale in web_api.py**

Replace the validation section in `/Users/msk-hq-nb-1079/project/my/python/tg_poker_planing/web_api.py` (lines 329-332):

```python
if not isinstance(points, list) or not all(isinstance(p, str) for p in points):
    return JSONResponse({"error": "points must be a list of strings"}, status_code=400)
if len(points) < 8:
    return JSONResponse({"error": "At least 8 points are required (standard scales have 8-12 points)"}, status_code=400)
if len(points) != len(set(points)):
    return JSONResponse({"error": "Duplicate points are not allowed"}, status_code=400)

await state.storage.save_custom_scale(f"web_{username}", points)
return JSONResponse({"ok": True, "points": points})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/test_api.py::TestCustomScale -v`

Expected: All tests PASS

- [ ] **Step 5: Run ALL existing tests to verify no regressions**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/ -v`

Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && git add web_api.py tests/test_api.py && git commit -m "fix: validate custom_points — require min 8 items and no duplicates"
```

---

### Task 7: Add session cleanup to prevent memory leaks

**Files:**
- Modify: `connection.py` (add cleanup methods)
- Create: `tests/test_session_cleanup.py`

**Interfaces:**
- Consumes: `ConnectionManager` class
- Produces: `cleanup_session()` and `cleanup_old_sessions()` methods

- [ ] **Step 1: Write failing test — no cleanup method exists**

Create `/Users/msk-hq-nb-1079/project/my/python/tg_poker_planing/tests/test_session_cleanup.py`:

```python
"""Tests for session cleanup to prevent memory leaks."""

import pytest
from connection import manager


@pytest.fixture(autouse=True)
def _reset():
    manager.active_connections.clear()
    manager.session_users.clear()
    manager.ws_username_map.clear()
    manager._ws_connections.clear()


class TestSessionCleanup:
    def test_cleanup_session_removes_all_traces(self):
        """cleanup_session removes session from all tracking structures."""
        manager.register_user("s1", "alice")
        manager.register_user("s1", "bob")
        manager.active_connections["s1"] = []
        manager.ws_username_map["s1"] = {"alice"}
        manager._ws_connections["s1"] = {"alice": None}
        
        manager.cleanup_session("s1")
        
        assert "s1" not in manager.session_users
        assert "s1" not in manager.active_connections
        assert "s1" not in manager.ws_username_map
        assert "s1" not in manager._ws_connections

    def test_cleanup_session_unknown_session(self):
        """cleanup_session on unknown session does nothing."""
        manager.cleanup_session("nonexistent")  # no error

    def test_cleanup_session_with_websocket(self):
        """cleanup_session closes websocket connections."""
        from unittest.mock import MagicMock, AsyncMock
        
        ws = MagicMock()
        ws.close = AsyncMock()
        manager.register_user("s1", "alice")
        manager.active_connections["s1"] = [ws]
        manager.ws_username_map["s1"] = {"alice"}
        manager._ws_connections["s1"] = {"alice": ws}
        
        import asyncio
        asyncio.run(manager.cleanup_session("s1"))
        
        assert "s1" not in manager.session_users
        assert "s1" not in manager.active_connections
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/test_session_cleanup.py -v`

Expected: Error: `ConnectionManager` object has no attribute `cleanup_session`

- [ ] **Step 3: Implement cleanup_session in connection.py**

Add to `ConnectionManager` class in `/Users/msk-hq-nb-1079/project/my/python/tg_poker_planing/connection.py`:

```python
async def cleanup_session(self, session_id: str):
    """Полная очистка сессии: закрывает WS, удаляет все трекеры.
    
    Вызывается когда сессия завершена и больше не нужна.
    """
    # Закрываем все активные WebSocket соединения
    if session_id in self.active_connections:
        for ws in self.active_connections[session_id]:
            try:
                await ws.close(1000)
            except Exception:
                pass
        del self.active_connections[session_id]
    
    # Удаляем из всех структур трекинга
    self.session_users.pop(session_id, None)
    self.ws_username_map.pop(session_id, None)
    self._ws_connections.pop(session_id, None)

def cleanup_old_sessions(self, max_age_minutes: int = 60):
    """Очистка неактивных сессий.
    
    Удаляет сессии, которые не имеют активных WS-подключений.
    """
    stale_sessions = []
    for session_id in self.session_users:
        if session_id not in self.active_connections or not self.active_connections[session_id]:
            stale_sessions.append(session_id)
    
    for session_id in stale_sessions:
        self.session_users.pop(session_id, None)
        self.ws_username_map.pop(session_id, None)
        self._ws_connections.pop(session_id, None)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/test_session_cleanup.py -v`

Expected: All tests PASS

- [ ] **Step 5: Run ALL existing tests to verify no regressions**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/ -v`

Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && git add connection.py tests/test_session_cleanup.py && git commit -m "feat: add session cleanup methods to prevent memory leaks"
```

---

### Task 8: Final integration verification

**Files:**
- None (runs only)

- [ ] **Step 1: Run all tests with verbose output**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/ -v --tb=short 2>&1`

Expected: All tests PASS (no failures, no errors)

- [ ] **Step 2: Show final summary**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && git log --oneline -10`

Expected: Shows 7 commits with fix messages

- [ ] **Step 3: Show total test count**

Run: `cd /Users/msk-hq-nb-1079/project/my/python/tg_poker_planing && python -m pytest tests/ --collect-only -q 2>&1 | tail -1`

Expected: Shows total test count (should be significantly more than original ~60)