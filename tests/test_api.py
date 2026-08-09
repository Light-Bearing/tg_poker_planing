import pytest
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.routing import Route, WebSocketRoute
from starlette.testclient import TestClient

import state
from connection import manager
from ppbot.game import SCALES, GameRegistry
from web_api import (
    api_create_session,
    api_get_custom_scale,
    api_get_session,
    api_kick_user,
    api_restart,
    api_reveal,
    api_save_custom_scale,
    api_set_auto_reveal,
    api_set_scale,
    api_vote,
    health,
    info,
    reset_rate_limits,
    web_index,
)
from websocket_handler import websocket_endpoint


@pytest.fixture(autouse=True)
def _setup_state(tmp_path):
    registry = GameRegistry()
    state.storage = registry
    db_path = str(tmp_path / "test.db")

    async def _init():
        await registry.init_db(db_path)

    import asyncio

    asyncio.run(_init())
    manager.session_users.clear()
    manager.active_connections.clear()
    reset_rate_limits()

    yield

    async def _close():
        await registry.close()

    asyncio.run(_close())


@pytest.fixture
def client():
    routes = [
        Route("/", web_index, methods=["GET"]),
        Route("/api/sessions", api_create_session, methods=["POST"]),
        Route("/api/sessions/{session_id}", api_get_session, methods=["GET"]),
        Route("/api/sessions/{session_id}/vote", api_vote, methods=["POST"]),
        Route("/api/sessions/{session_id}/restart", api_restart, methods=["POST"]),
        Route("/api/sessions/{session_id}/reveal", api_reveal, methods=["POST"]),
        Route("/api/sessions/{session_id}/scale", api_set_scale, methods=["POST"]),
        Route("/api/sessions/{session_id}/kick", api_kick_user, methods=["POST"]),
        Route("/api/sessions/{session_id}/auto-reveal", api_set_auto_reveal, methods=["POST"]),
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

    def test_vote_after_reveal_returns_400_not_500(self, client):
        """Vote after reveal returns 400, not 500."""
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]

        client.post(f"/api/sessions/{session_id}/reveal", json={"username": "Alice"})
        resp = client.post(f"/api/sessions/{session_id}/vote", json={"username": "Bob", "point": "3"})
        assert resp.status_code == 400
        assert "Session is already revealed" in resp.json().get("error", "")

    def test_vote_after_reveal_rejected(self, client):
        """Vote after reveal is rejected with 400."""
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]

        client.post(f"/api/sessions/{session_id}/reveal", json={"username": "Alice"})
        resp = client.post(f"/api/sessions/{session_id}/vote", json={"username": "Bob", "point": "3"})
        assert resp.status_code == 400
        data = resp.json()
        assert "revealed" in data.get("error", "").lower()


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

        resp = client.post(f"/api/sessions/{session_id}/scale", json={"username": "Alice", "scale_name": "tshirt"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["scale_name"] == "tshirt"
        assert "XXL" in data["available_points"]

    def test_set_scale_missing_name(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]

        resp = client.post(f"/api/sessions/{session_id}/scale", json={"username": "Alice"})
        assert resp.status_code == 400

    def test_set_scale_session_not_found(self, client):
        resp = client.post("/api/sessions/nonexistent/scale", json={"username": "Alice", "scale_name": "fibonacci"})
        assert resp.status_code == 404

    def test_set_scale_unknown_name_rejected(self, client):
        """Опечатка в scale_name должна быть ошибкой, а не молчаливым сбросом голосов."""
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]
        client.post(f"/api/sessions/{session_id}/vote", json={"username": "Alice", "point": "5"})

        resp = client.post(f"/api/sessions/{session_id}/scale", json={"username": "Alice", "scale_name": "bogus"})
        assert resp.status_code == 400
        assert "bogus" in resp.json()["error"]

        after = client.get(f"/api/sessions/{session_id}").json()
        assert after["scale_name"] == "custom", "шкала не должна меняться"
        assert after["vote_count"] == 1, "голоса не должны сбрасываться при опечатке"


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
        points = [str(i * 10) for i in range(1, 9)]
        resp = client.post(
            "/api/custom-scale",
            json={"username": "Alice", "points": points},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["points"] == points

        # Verify it's saved
        get_resp = client.get("/api/custom-scale", params={"username": "Alice"})
        assert get_resp.json()["points"] == points

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
        """Custom scale with < 8 points is rejected."""
        resp = client.post(
            "/api/custom-scale",
            json={"username": "Alice", "points": ["10", "20", "30"]},
        )
        assert resp.status_code == 400

    def test_save_custom_scale_duplicates_rejected(self, client):
        """Custom scale with duplicate points is rejected."""
        resp = client.post(
            "/api/custom-scale",
            json={"username": "Alice", "points": ["10", "20", "10", "30", "40", "50", "60", "70"]},
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

    def test_create_session_with_custom_scale_uses_saved_points(self, client):
        # Save custom scale first
        points = [str(i * 10) for i in range(1, 9)]
        client.post(
            "/api/custom-scale",
            json={"username": "Alice", "points": points},
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
        assert data["available_points"] == points


SCALE_POINT_ERROR = "Each point must be 1-8 characters: letters, digits, and . , : ; ! ? + - * / ½ ∞ ❔ ☕"


class TestCustomScalePointValidation:
    """Значение точки шкалы попадает в innerHTML на фронте — валидируем на входе."""

    def _points_with(self, bad: str) -> list[str]:
        return ["1", "2", "3", "4", "5", "6", "7", bad]

    def test_rejects_html_payload(self, client):
        resp = client.post(
            "/api/custom-scale",
            json={"username": "Alice", "points": self._points_with('<img src=x onerror="alert(1)">')},
        )
        assert resp.status_code == 400
        assert resp.json()["error"] == SCALE_POINT_ERROR

    def test_rejects_quotes_and_ampersand(self, client):
        for bad in ['"', "'", "&", "`", "<b>", "a>b"]:
            resp = client.post("/api/custom-scale", json={"username": "Alice", "points": self._points_with(bad)})
            assert resp.status_code == 400, f"{bad!r} должен быть отклонён"

    def test_rejects_too_long_point(self, client):
        resp = client.post("/api/custom-scale", json={"username": "Alice", "points": self._points_with("123456789")})
        assert resp.status_code == 400

    def test_rejects_blank_point(self, client):
        resp = client.post("/api/custom-scale", json={"username": "Alice", "points": self._points_with("   ")})
        assert resp.status_code == 400

    def test_accepts_builtin_scale_values(self, client):
        """Значения встроенных шкал должны проходить валидацию."""
        for scale_name, points in SCALES.items():
            padded = points if len(points) >= 8 else points + [f"x{i}" for i in range(8 - len(points))]
            resp = client.post("/api/custom-scale", json={"username": "Alice", "points": padded})
            assert resp.status_code == 200, f"шкала {scale_name} отклонена: {resp.json()}"

    def test_accepts_plain_labels(self, client):
        points = ["1", "2.5", "13", "XS", "XXL", "½", "❔", "☕", "Оценка"]
        resp = client.post("/api/custom-scale", json={"username": "Alice", "points": points})
        assert resp.status_code == 200
        assert resp.json()["points"] == points

    def test_poisoned_point_never_becomes_votable(self, client):
        """Сквозная проверка: отравленную точку нельзя ни сохранить, ни за неё проголосовать."""
        payload = '<img src=x onerror="alert(1)">'
        save = client.post("/api/custom-scale", json={"username": "Alice", "points": self._points_with(payload)})
        assert save.status_code == 400

        created = client.post(
            "/api/sessions", json={"username": "Alice", "text": "task", "scale_name": "custom"}
        ).json()
        assert payload not in created["available_points"]

        vote = client.post(
            f"/api/sessions/{created['session_id']}/vote", json={"username": "Alice", "point": payload}
        )
        assert vote.status_code == 400


class TestKick:
    def test_kick_user(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]

        # Register Bob as a participant
        from connection import manager

        manager.register_user(session_id, "bob")

        resp = client.post(f"/api/sessions/{session_id}/kick", json={"username": "Alice", "target_username": "bob"})
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("ok") is True

    def test_kick_user_non_initiator_forbidden(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]

        manager.register_user(session_id, "bob")
        manager.register_user(session_id, "charlie")

        resp = client.post(f"/api/sessions/{session_id}/kick", json={"username": "bob", "target_username": "charlie"})
        assert resp.status_code == 403

    def test_kick_user_not_found(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]

        resp = client.post(
            f"/api/sessions/{session_id}/kick", json={"username": "Alice", "target_username": "nonexistent"}
        )
        assert resp.status_code == 404


class TestAutoRevealApi:
    def test_create_session_with_auto_reveal(self, client):
        resp = client.post(
            "/api/sessions",
            json={"username": "Alice", "text": "My task", "auto_reveal": True},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["auto_reveal"] is True

    def test_create_session_without_auto_reveal(self, client):
        resp = client.post("/api/sessions", json={"username": "Alice", "text": "My task"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["auto_reveal"] is False

    def test_set_auto_reveal_enable(self, client):
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]

        resp = client.post(f"/api/sessions/{session_id}/auto-reveal", json={"username": "Alice", "auto_reveal": True})
        assert resp.status_code == 200
        data = resp.json()
        assert data["auto_reveal"] is True

        resp = client.get(f"/api/sessions/{session_id}")
        assert resp.json()["auto_reveal"] is True

    def test_auto_reveal_rejects_non_initiator(self, client):
        """Non-initiator cannot change auto-reveal."""
        create = client.post("/api/sessions", json={"username": "Alice", "text": "My task"}).json()
        session_id = create["session_id"]

        resp = client.post(f"/api/sessions/{session_id}/auto-reveal", json={"username": "Bob", "auto_reveal": True})
        assert resp.status_code == 403

    def test_auto_reveal_persists_after_restart(self, client):
        create = client.post(
            "/api/sessions",
            json={"username": "Alice", "text": "My task", "auto_reveal": True},
        ).json()
        session_id = create["session_id"]

        restart_resp = client.post(f"/api/sessions/{session_id}/restart", json={"username": "Alice"})
        assert restart_resp.status_code == 200

        resp = client.get(f"/api/sessions/{session_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["auto_reveal"] is True


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

    def test_restart_rejects_bad_username(self, client):
        created = client.post("/api/sessions", json={"username": "alice", "text": "task"}).json()
        r = client.post(f"/api/sessions/{created['session_id']}/restart", json={"username": BAD_NAME})
        assert r.status_code == 400
        assert r.json()["error"] == NAME_ERROR

    def test_reveal_rejects_bad_username(self, client):
        created = client.post("/api/sessions", json={"username": "alice", "text": "task"}).json()
        r = client.post(f"/api/sessions/{created['session_id']}/reveal", json={"username": BAD_NAME})
        assert r.status_code == 400
        assert r.json()["error"] == NAME_ERROR
        assert client.get(f"/api/sessions/{created['session_id']}").json()["revealed"] is False

    def test_kick_rejects_bad_target_username(self, client):
        created = client.post("/api/sessions", json={"username": "alice", "text": "task"}).json()
        r = client.post(
            f"/api/sessions/{created['session_id']}/kick",
            json={"username": "alice", "target_username": BAD_NAME},
        )
        assert r.status_code == 400
        assert r.json()["error"] == NAME_ERROR


class TestVoteSecrecy:
    def test_real_point_hidden_until_reveal(self, client):
        created = client.post("/api/sessions", json={"username": "alice", "text": "task"}).json()
        sid = created["session_id"]
        client.post(f"/api/sessions/{sid}/vote", json={"username": "alice", "point": "5"})

        before = client.get(f"/api/sessions/{sid}").json()
        assert before["votes"], "голос должен быть записан"
        assert all("real_point" not in v for v in before["votes"]), "real_point must be hidden before reveal"
        assert "average" not in before, "average must be hidden before reveal"

        client.post(f"/api/sessions/{sid}/reveal", json={"username": "alice"})

        after = client.get(f"/api/sessions/{sid}").json()
        assert after["votes"][0]["real_point"] == "5", "real_point must be present after reveal"
        assert "average" in after, "average must be present after reveal"
        assert after["average"] == 5.0, "average must equal the single vote"


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
