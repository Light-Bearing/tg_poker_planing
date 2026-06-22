# Phase B — Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Refactor 5 areas: clean connection.py, extract vote logic, type initiator, deduplicate Jira trees, modularize script.js

**Architecture:** Backend changes in `connection.py`, `web_api.py`, `websocket_handler.py`, `ppbot/game.py`, `telegram_bot.py`. Frontend in `script.js` only.

**Tech Stack:** Python 3.10+, asyncio, Starlette, Vanilla JS

## Global Constraints
- All existing tests must pass after each task
- Python code must pass `ruff check .` and `ruff format .`
- Use async/await for all I/O
- pytest, pytest-asyncio

---

### Task B5: Clean up connection.py

**Files:** `connection.py`

**Changes:**
1. Remove the commented-out code block in `disconnect()` (lines 25-40 area — the `if username and session_id in self.session_users` block)
2. Add docstrings to all methods
3. Remove any dead code

**Tests:** `tests/test_websocket.py` — all existing tests should still pass (run `pytest tests/test_websocket.py -q`)

---

### Task B2: Extract vote logic from REST/WS

**Files:** `web_api.py`, `websocket_handler.py`, `ppbot/game.py` (or `connection.py`)

**Changes:**
1. Create shared `async def process_web_vote(...)` in `web_api.py` (or a new module `vote_service.py`)
2. Replace duplicate vote logic in `api_vote` and `websocket_handler vote` handler with the shared function
3. Include `check_auto_reveal` call inside the shared function

**Risk:** Medium — need to ensure both callers pass correct params. Tests cover both paths.

**Tests:** `tests/test_api.py`, `tests/test_websocket.py` — run all passing tests

---

### Task B3: Typed Initiator dataclass

**Files:** `ppbot/game.py`, `web_api.py`, `telegram_bot.py`, `tests/conftest.py`, `tests/test_game.py`, `tests/test_telegram_bot.py`, `tests/test_websocket.py`, `tests/test_app.py`

**Changes:**
1. Add `Initiator` dataclass in `ppbot/game.py` with `from_telegram_user()` and `from_web()` classmethods
2. Update `Game.__init__` to accept `Initiator` instead of `dict`
3. Update `Game.to_dict()` and `from_dict()` to serialize/deserialize `Initiator`
4. Update all callers: `web_api.py` (create_session, enrich), `telegram_bot.py` (poker_command)
5. Update all test fixtures and test code

**Risk:** High — touches many files. Must ensure JSON serialization is backward-compatible (Initiator → dict for stored data).

---

### Task B1: Deduplicate Jira trees (script.js)

**Files:** `web/static/script.js`

**Changes:**
1. Extract common `renderJiraTree(container, options)` function
2. Replace `renderJiraJoinTree`, `renderJiraIssueTree`, `renderJiraTreeInContainer` with calls to the shared function

**Risk:** Medium — JS, no tests. Manual verification needed.

---

### Task B4: Modularize script.js

**Files:** `web/static/script.js`

**Changes:**
1. Add clear section headers/comments: Game Core, UI Components, Jira Integration, Scales
2. Group related functions together
3. No behavioral changes

**Risk:** Low — comments only, no code changes.