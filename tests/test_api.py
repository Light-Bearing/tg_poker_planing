import pytest
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.routing import Route, WebSocketRoute
from starlette.testclient import TestClient

import state
from connection import manager
from ppbot.game import GameRegistry
from web_api import (
    api_create_session,
    api_get_session,
    api_list_sessions,
    api_restart,
    api_reveal,
    api_vote,
    health,
    info,
    web_index,
)
from websocket_handler import websocket_endpoint


@pytest.fixture(autouse=True)
def _setup_state(tmp_path):
    state.storage = GameRegistry()
    db_path = str(tmp_path / "test.db")

    async def _init():
        await state.storage.init_db(db_path)

    import asyncio

    asyncio.run(_init())
    manager.session_users.clear()
    manager.active_connections.clear()

    yield

    async def _close():
        if state.storage._db:
            await state.storage._db.close()

    asyncio.run(_close())


@pytest.fixture
def client():
    routes = [
        Route("/", web_index, methods=["GET"]),
        Route("/api/sessions", api_create_session, methods=["POST"]),
        Route("/api/sessions", api_list_sessions, methods=["GET"]),
        Route("/api/sessions/{session_id}", api_get_session, methods=["GET"]),
        Route("/api/sessions/{session_id}/vote", api_vote, methods=["POST"]),
        Route("/api/sessions/{session_id}/restart", api_restart, methods=["POST"]),
        Route("/api/sessions/{session_id}/reveal", api_reveal, methods=["POST"]),
        Route("/healthcheck", health, methods=["GET"]),
        Route("/info", info, methods=["GET"]),
        WebSocketRoute("/ws/{session_id}", websocket_endpoint),
    ]
    app = Starlette(
        routes=routes,
        middleware=[Middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])],
    )
    return TestClient(app)


class TestHealth:
    def test_healthcheck(self, client):
        resp = client.get("/healthcheck")
        assert resp.status_code == 200
        assert resp.text == "OK"

    def test_info(self, client):
        resp = client.get("/info")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "running"
        assert "telegram" in data["features"]


class TestSessions:
    def test_create_session(self, client):
        resp = client.post("/api/sessions", json={"username": "Alice", "text": "My task"})
        assert resp.status_code == 200
        data = resp.json()
        assert "session_id" in data
        assert data["text"] == "My task"
        assert data["initiator"] == "Alice"
        assert data["vote_count"] == 0

    def test_create_session_missing_username(self, client):
        resp = client.post("/api/sessions", json={"text": "task"})
        assert resp.status_code == 400

    def test_create_session_missing_text(self, client):
        resp = client.post("/api/sessions", json={"username": "Alice"})
        assert resp.status_code == 400

    def test_get_session(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]

        resp = client.get(f"/api/sessions/{session_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["session_id"] == session_id
        assert data["text"] == "My task"

    def test_get_session_not_found(self, client):
        resp = client.get("/api/sessions/nonexistent")
        assert resp.status_code == 404

    def test_list_sessions_empty(self, client):
        resp = client.get("/api/sessions")
        assert resp.status_code == 200
        assert resp.json()["sessions"] == []

    def test_list_sessions(self, client):
        client.post("/api/sessions", json={"username": "Alice", "text": "Task 1"})
        client.post("/api/sessions", json={"username": "Bob", "text": "Task 2"})

        resp = client.get("/api/sessions")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["sessions"]) == 2


class TestVoting:
    def test_vote(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]

        resp = client.post(f"/api/sessions/{session_id}/vote", json={"username": "Alice", "point": "5"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["vote_count"] == 1

    def test_vote_missing_fields(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]

        resp = client.post(f"/api/sessions/{session_id}/vote", json={"username": "Alice"})
        assert resp.status_code == 400

        resp = client.post(f"/api/sessions/{session_id}/vote", json={"point": "5"})
        assert resp.status_code == 400

    def test_vote_session_not_found(self, client):
        resp = client.post("/api/sessions/nonexistent/vote", json={"username": "Alice", "point": "5"})
        assert resp.status_code == 404

    def test_vote_after_reveal_rejected(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]

        client.post(f"/api/sessions/{session_id}/reveal", json={"username": "Alice"})
        resp = client.post(f"/api/sessions/{session_id}/vote", json={"username": "Bob", "point": "3"})
        assert resp.status_code == 400


class TestReveal:
    def test_reveal_by_initiator(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]
        client.post(f"/api/sessions/{session_id}/vote", json={"username": "Alice", "point": "5"})

        resp = client.post(f"/api/sessions/{session_id}/reveal", json={"username": "Alice"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["revealed"] is True
        assert len(data["votes"]) == 1

    def test_reveal_by_non_initiator_forbidden(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]

        resp = client.post(f"/api/sessions/{session_id}/reveal", json={"username": "Bob"})
        assert resp.status_code == 403

    def test_reveal_session_not_found(self, client):
        resp = client.post("/api/sessions/nonexistent/reveal", json={"username": "Alice"})
        assert resp.status_code == 404


class TestRestart:
    def test_restart_by_initiator(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]
        client.post(f"/api/sessions/{session_id}/vote", json={"username": "Alice", "point": "5"})

        resp = client.post(f"/api/sessions/{session_id}/restart", json={"username": "Alice"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["vote_count"] == 0
        assert data["revealed"] is False

    def test_restart_with_new_text(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "Old task"}).json()
        session_id = create["session_id"]

        resp = client.post(f"/api/sessions/{session_id}/restart", json={"username": "Alice", "new_text": "New task"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["text"] == "New task"

    def test_restart_by_non_initiator_forbidden(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]

        resp = client.post(f"/api/sessions/{session_id}/restart", json={"username": "Bob"})
        assert resp.status_code == 403

    def test_restart_session_not_found(self, client):
        resp = client.post("/api/sessions/nonexistent/restart", json={"username": "Alice"})
        assert resp.status_code == 404
