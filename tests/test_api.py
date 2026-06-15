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
    api_get_custom_scale,
    api_get_session,
    api_list_sessions,
    api_restart,
    api_reveal,
    api_save_custom_scale,
    api_set_scale,
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
        Route("/api/sessions/{session_id}/scale", api_set_scale, methods=["POST"]),
        Route("/api/custom-scale", api_get_custom_scale, methods=["GET"]),
        Route("/api/custom-scale", api_save_custom_scale, methods=["POST"]),
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


class TestScale:
    def test_create_session_with_scale(self, client):
        resp = client.post("/api/sessions", json={"username": "Alice", "text": "My task", "scale_name": "fibonacci"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["scale_name"] == "fibonacci"
        assert "8" in data["available_points"]
        assert "4" not in data["available_points"]

    def test_create_session_default_scale(self, client):
        resp = client.post("/api/sessions", json={"username": "Alice", "text": "My task"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["scale_name"] == "custom"

    def test_set_scale(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]
        assert create["scale_name"] == "custom"

        resp = client.post(f"/api/sessions/{session_id}/scale", json={"scale_name": "tshirt"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["scale_name"] == "tshirt"
        assert "XXL" in data["available_points"]

    def test_set_scale_missing_name(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]

        resp = client.post(f"/api/sessions/{session_id}/scale", json={})
        assert resp.status_code == 400

    def test_set_scale_session_not_found(self, client):
        resp = client.post("/api/sessions/nonexistent/scale", json={"scale_name": "fibonacci"})
        assert resp.status_code == 404

    def test_set_scale_invalid_falls_back_to_default(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]

        resp = client.post(f"/api/sessions/{session_id}/scale", json={"scale_name": "bogus"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["scale_name"] == "custom"


class TestCustomScale:
    def test_get_custom_scale_empty(self, client):
        resp = client.get("/api/custom-scale", params={"username": "Alice"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["points"] == []

    def test_get_custom_scale_missing_username(self, client):
        resp = client.get("/api/custom-scale")
        assert resp.status_code == 400

    def test_save_custom_scale(self, client):
        resp = client.post(
            "/api/custom-scale",
            json={"username": "Alice", "points": ["10", "20", "30", "50", "100"]},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["points"] == ["10", "20", "30", "50", "100"]

        # Verify it's saved
        get_resp = client.get("/api/custom-scale", params={"username": "Alice"})
        assert get_resp.json()["points"] == ["10", "20", "30", "50", "100"]

    def test_save_custom_scale_missing_username(self, client):
        resp = client.post("/api/custom-scale", json={"points": ["1", "2"]})
        assert resp.status_code == 400

    def test_save_custom_scale_invalid_points(self, client):
        resp = client.post(
            "/api/custom-scale",
            json={"username": "Alice", "points": "not a list"},
        )
        assert resp.status_code == 400

    def test_save_custom_scale_too_few_points(self, client):
        resp = client.post(
            "/api/custom-scale",
            json={"username": "Alice", "points": ["1"]},
        )
        assert resp.status_code == 400

    def test_create_session_with_custom_scale_uses_saved_points(self, client):
        # Save custom scale first
        client.post(
            "/api/custom-scale",
            json={"username": "Alice", "points": ["10", "20", "30", "❔", "☕"]},
        )

        # Create session with custom scale
        resp = client.post(
            "/api/sessions",
            json={"username": "Alice", "text": "My task", "scale_name": "custom"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["scale_name"] == "custom"
        # Should include saved custom points
        assert "10" in data["available_points"]
        assert "20" in data["available_points"]
        assert "30" in data["available_points"]
        # The default AVAILABLE_POINTS also includes "4", "6", etc.
        # But custom points should override the defaults
        assert data["available_points"] == ["10", "20", "30", "❔", "☕"]
