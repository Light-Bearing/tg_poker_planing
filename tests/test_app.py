from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestBuildApp:
    @pytest.mark.asyncio
    async def test_build_app_returns_starlette_app(self):
        with (
            patch("app.init_bot", new=AsyncMock()),
            patch("app.GameRegistry"),
            patch("app.Jinja2Templates"),
            patch("os.path.exists", return_value=False),
        ):
            from app import build_app

            app = await build_app()
            assert app is not None
            routes = [r.path for r in app.routes]
            assert "/" in routes
            assert "/api/sessions" in routes
            assert "/ws/{session_id}" in routes
            assert "/telegram" in routes
            assert "/healthcheck" in routes

    @pytest.mark.asyncio
    async def test_build_app_calls_init_bot(self):
        init_bot_mock = AsyncMock()
        with (
            patch("app.init_bot", new=init_bot_mock),
            patch("app.GameRegistry"),
            patch("app.Jinja2Templates"),
            patch("os.path.exists", return_value=False),
        ):
            from app import build_app

            await build_app()
            init_bot_mock.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_build_app_sets_state(self):
        with (
            patch("app.init_bot", new=AsyncMock()),
            patch("app.GameRegistry") as mock_registry_cls,
            patch("app.Jinja2Templates") as mock_templates_cls,
            patch("os.path.exists", return_value=False),
        ):
            mock_registry = MagicMock()
            mock_registry_cls.return_value = mock_registry
            mock_templates = MagicMock()
            mock_templates_cls.return_value = mock_templates

            import app as app_module
            from app import build_app

            await build_app()
            assert app_module.state.storage is mock_registry
            assert app_module.state.templates is mock_templates


class TestShutdownEvent:
    @pytest.mark.asyncio
    async def test_broadcasts_shutdown(self):
        with (
            patch("app.manager.active_connections", new={"s1": []}),
            patch("app.manager.broadcast", new=AsyncMock()) as mock_broadcast,
        ):
            from app import shutdown_app

            mock_app = MagicMock()
            mock_app.state.telegram_app = MagicMock()
            mock_app.state.telegram_app.stop = AsyncMock()
            mock_app.state.telegram_app.shutdown = AsyncMock()
            with patch("app.state.storage._db", new=MagicMock()) as mock_db:
                mock_db.close = AsyncMock()
                with patch("asyncio.sleep", new=AsyncMock()):
                    await shutdown_app(mock_app)
                    mock_broadcast.assert_awaited_once_with(
                        "s1",
                        {
                            "type": "shutdown",
                            "message": "Server is shutting down",
                        },
                    )

    @pytest.mark.asyncio
    async def test_shutdown_no_telegram_app(self):
        from app import shutdown_app

        mock_app = MagicMock()
        mock_app.state.telegram_app = None
        with patch("app.state.storage._db", new=None):
            with patch("asyncio.sleep", new=AsyncMock()):
                await shutdown_app(mock_app)


class TestMainFunctions:
    @pytest.mark.asyncio
    async def test_check_proxy_connection_success(self):
        from main import check_proxy_connection

        with patch("asyncio.open_connection", new=AsyncMock()) as mock_conn:
            mock_writer = MagicMock()
            mock_writer.close = MagicMock()
            mock_writer.wait_closed = AsyncMock()
            mock_conn.return_value = (MagicMock(), mock_writer)
            result = await check_proxy_connection("socks5://user:pass@proxy.example.com:1080")
            assert result is True

    @pytest.mark.asyncio
    async def test_check_proxy_connection_failure(self):
        from main import check_proxy_connection

        with patch("asyncio.open_connection", side_effect=OSError("connection failed")):
            result = await check_proxy_connection("socks5://proxy.example.com:1080")
            assert result is False

    @pytest.mark.asyncio
    async def test_check_proxy_connection_invalid_url(self):
        from main import check_proxy_connection

        with patch("asyncio.open_connection", side_effect=ValueError("invalid")):
            result = await check_proxy_connection("not-a-url")
            assert result is False

    @pytest.mark.asyncio
    async def test_check_telegram_direct_success(self):
        from main import check_telegram_direct

        with patch("asyncio.open_connection", new=AsyncMock()) as mock_conn:
            mock_writer = MagicMock()
            mock_writer.close = MagicMock()
            mock_writer.wait_closed = AsyncMock()
            mock_conn.return_value = (MagicMock(), mock_writer)
            result = await check_telegram_direct()
            assert result is True
            mock_conn.assert_awaited_with("api.telegram.org", 443)

    @pytest.mark.asyncio
    async def test_check_telegram_direct_failure(self):
        from main import check_telegram_direct

        with patch("asyncio.open_connection", side_effect=OSError("timeout")):
            result = await check_telegram_direct()
            assert result is False


class TestRunTelegramBotThread:
    def test_run_polling_called(self):
        from main import run_telegram_bot_thread

        mock_app = MagicMock()
        run_telegram_bot_thread(mock_app)
        mock_app.run_polling.assert_called_once()


class TestMain:
    @pytest.mark.asyncio
    async def test_main_exits_when_no_proxy_and_no_direct(self):
        with (
            patch("main.check_telegram_direct", return_value=False),
            patch("main.PROXY_URL", "socks5://proxy:1080"),
            patch("main.check_proxy_connection", return_value=False),
        ):
            with patch("main.print"):
                from main import main

                result = await main()
                assert result is None


class TestGameToWebResponse:
    def test_game_to_web_response(self):
        from ppbot.game import Game
        from web_api import game_to_web_response

        game = Game(-100, "s1", {"id": "web_alice", "first_name": "A", "username": "a"}, "task")
        result = game_to_web_response(game, "s1")
        assert result["session_id"] == "s1"
        assert result["text"] == "task"
        assert result["initiator"] == "a"
        assert result["revealed"] is False
        assert result["vote_count"] == 0
        assert "available_points" in result

    def test_game_to_web_response_with_votes(self):
        from ppbot.game import Game
        from web_api import game_to_web_response

        game = Game(-100, "s1", {"id": "web_alice", "first_name": "A", "username": "a"}, "task")
        game.add_vote({"id": "web_alice", "first_name": "A", "username": "a"}, "5")
        result = game_to_web_response(game, "s1")
        assert result["vote_count"] == 1
        assert result["votes"][0]["point"] == "♥"  # masked, not revealed
        assert result["votes"][0]["real_point"] == "5"

    def test_game_to_web_response_revealed(self):
        from ppbot.game import Game
        from web_api import game_to_web_response

        game = Game(-100, "s1", {"id": "web_alice", "first_name": "A", "username": "a"}, "task")
        game.add_vote({"id": "web_alice", "first_name": "A", "username": "a"}, "5")
        game.revealed = True
        result = game_to_web_response(game, "s1")
        assert result["votes"][0]["point"] == "5"

    def test_game_to_web_response_initiator_fallback(self):
        from ppbot.game import Game
        from web_api import game_to_web_response

        game = Game(-100, "s1", {"id": 123, "first_name": "A"}, "task")
        result = game_to_web_response(game, "s1")
        assert result["initiator"] == "123"


class TestEnrichSessionResponse:
    def test_enrich_with_no_participants(self):
        from ppbot.game import Game
        from web_api import enrich_session_response

        game = Game(-100, "s1", {"id": "web_alice", "first_name": "A", "username": "a"}, "task")
        result = enrich_session_response(game, "s1")
        assert "participants" in result

    def test_enrich_with_online_user(self):
        from connection import manager
        from ppbot.game import Game
        from web_api import enrich_session_response

        manager.register_user("s1", "alice")
        game = Game("web", "s1", {"id": "web_alice", "first_name": "A", "username": "alice"}, "task")
        game.add_vote({"id": "web_alice", "first_name": "A", "username": "alice"}, "3")
        result = enrich_session_response(game, "s1")
        participants = {p["username"]: p for p in result["participants"]}
        assert "alice" in participants
        assert participants["alice"]["online"] is True


class TestAPIErrorHandling:
    def test_malformed_json_on_create(self, tmp_path):
        import asyncio

        import state
        from ppbot.game import GameRegistry

        state.storage = GameRegistry()
        asyncio.run(state.storage.init_db(str(tmp_path / "test_err.db")))

        from starlette.applications import Starlette
        from starlette.middleware import Middleware
        from starlette.middleware.cors import CORSMiddleware
        from starlette.routing import Route
        from starlette.testclient import TestClient

        from web_api import api_create_session

        app = Starlette(
            routes=[Route("/api/sessions", api_create_session, methods=["POST"])],
            middleware=[Middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])],
        )
        tc = TestClient(app)
        resp = tc.post("/api/sessions", content=b"not-json", headers={"Content-Type": "application/json"})
        assert resp.status_code == 500

        asyncio.run(state.storage.close())

    def test_malformed_json_on_vote(self, tmp_path):
        import asyncio

        import state
        from ppbot.game import GameRegistry

        state.storage = GameRegistry()
        asyncio.run(state.storage.init_db(str(tmp_path / "test_err2.db")))

        from starlette.applications import Starlette
        from starlette.middleware import Middleware
        from starlette.middleware.cors import CORSMiddleware
        from starlette.routing import Route
        from starlette.testclient import TestClient

        from web_api import api_vote

        app = Starlette(
            routes=[Route("/api/sessions/{session_id}/vote", api_vote, methods=["POST"])],
            middleware=[Middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])],
        )
        tc = TestClient(app)
        resp = tc.post("/api/sessions/test/vote", content=b"not-json", headers={"Content-Type": "application/json"})
        assert resp.status_code == 500

        asyncio.run(state.storage.close())
