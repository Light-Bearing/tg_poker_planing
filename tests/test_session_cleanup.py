"""Tests for session cleanup to prevent memory leaks."""

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

import state
from config import WEB_CHAT_ID
from connection import manager
from ppbot.game import GameRegistry, Initiator


def _fake_ws():
    """Заглушка WebSocket: connect() ждёт accept(), cleanup_session() — close()."""
    ws = MagicMock()
    ws.accept = AsyncMock()
    ws.close = AsyncMock()
    return ws


@pytest.fixture(autouse=True)
def _reset():
    manager.active_connections.clear()
    manager.session_users.clear()
    manager.ws_username_map.clear()
    manager._ws_connections.clear()
    manager._orphaned_at.clear()


class TestSessionCleanup:
    def test_cleanup_session_removes_all_traces(self):
        """cleanup_session removes session from all tracking structures."""
        import asyncio

        manager.register_user("s1", "alice")
        manager.register_user("s1", "bob")
        manager.active_connections["s1"] = []
        manager.ws_username_map["s1"] = {"alice"}
        manager._ws_connections["s1"] = {"alice": None}

        asyncio.run(manager.cleanup_session("s1"))

        assert "s1" not in manager.session_users
        assert "s1" not in manager.active_connections
        assert "s1" not in manager.ws_username_map
        assert "s1" not in manager._ws_connections

    def test_cleanup_session_unknown_session(self):
        """cleanup_session on unknown session does nothing."""
        import asyncio

        asyncio.run(manager.cleanup_session("nonexistent"))  # no error

    def test_cleanup_session_with_websocket(self):
        """cleanup_session closes websocket connections."""
        from unittest.mock import AsyncMock, MagicMock

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


class TestOrphanTracking:
    def test_метка_ставится_когда_ушёл_последний(self):
        ws = _fake_ws()
        asyncio.run(manager.connect("s1", ws))
        manager.disconnect("s1", ws)
        assert "s1" in manager._orphaned_at

    def test_метка_не_ставится_пока_кто_то_остаётся(self):
        a, b = _fake_ws(), _fake_ws()
        asyncio.run(manager.connect("s1", a))
        asyncio.run(manager.connect("s1", b))
        manager.disconnect("s1", a)
        assert "s1" not in manager._orphaned_at

    def test_новое_подключение_снимает_метку(self):
        ws = _fake_ws()
        asyncio.run(manager.connect("s1", ws))
        manager.disconnect("s1", ws)
        assert "s1" in manager._orphaned_at
        asyncio.run(manager.connect("s1", _fake_ws()))
        assert "s1" not in manager._orphaned_at

    def test_созревшая_метка_попадает_в_список(self):
        ws = _fake_ws()
        asyncio.run(manager.connect("s1", ws))
        manager.disconnect("s1", ws)
        manager._orphaned_at["s1"] = time.time() - 600
        assert manager.orphaned_web_sessions(300) == ["s1"]

    def test_свежая_метка_не_попадает(self):
        ws = _fake_ws()
        asyncio.run(manager.connect("s1", ws))
        manager.disconnect("s1", ws)
        assert manager.orphaned_web_sessions(300) == []

    def test_сессия_с_подключением_не_попадает(self):
        ws = _fake_ws()
        asyncio.run(manager.connect("s1", ws))
        manager._orphaned_at["s1"] = time.time() - 600
        assert manager.orphaned_web_sessions(300) == []

    def test_метка_переживает_cleanup_old_sessions(self):
        """Очистка памяти не должна стирать метку — иначе запись в БД останется навсегда."""
        ws = _fake_ws()
        asyncio.run(manager.connect("s1", ws))
        manager.register_user("s1", "alice")
        manager.disconnect("s1", ws)
        manager.cleanup_old_sessions()
        assert "s1" in manager._orphaned_at

    def test_cleanup_session_снимает_метку(self):
        ws = _fake_ws()
        asyncio.run(manager.connect("s1", ws))
        manager.disconnect("s1", ws)
        asyncio.run(manager.cleanup_session("s1"))
        assert "s1" not in manager._orphaned_at


class TestPurgeExpired:
    @pytest.fixture
    async def storage(self, tmp_path):
        """Поднимает GameRegistry на временной БД и подсовывает его в state.storage."""
        registry = GameRegistry()
        await registry.init_db(str(tmp_path / "purge.db"))
        previous, state.storage = state.storage, registry
        yield registry
        await registry.close()
        state.storage = previous

    @pytest.mark.asyncio
    async def test_созревшая_веб_сессия_удаляется(self, storage):
        from app import purge_expired_sessions

        await storage.save_game(storage.new_game(WEB_CHAT_ID, "s1", Initiator.from_web("alice"), "задача"))
        manager._orphaned_at["s1"] = time.time() - 600

        await purge_expired_sessions()

        assert await storage.get_game(WEB_CHAT_ID, "s1") is None

    @pytest.mark.asyncio
    async def test_свежая_осиротевшая_не_удаляется(self, storage):
        from app import purge_expired_sessions

        await storage.save_game(storage.new_game(WEB_CHAT_ID, "s1", Initiator.from_web("alice"), "задача"))
        manager._orphaned_at["s1"] = time.time()

        await purge_expired_sessions()

        assert await storage.get_game(WEB_CHAT_ID, "s1") is not None

    @pytest.mark.asyncio
    async def test_сессия_с_подключением_не_удаляется(self, storage):
        from app import purge_expired_sessions

        await storage.save_game(storage.new_game(WEB_CHAT_ID, "s1", Initiator.from_web("alice"), "задача"))
        manager._orphaned_at["s1"] = time.time() - 600
        manager.active_connections["s1"] = [_fake_ws()]

        await purge_expired_sessions()

        assert await storage.get_game(WEB_CHAT_ID, "s1") is not None

    @pytest.mark.asyncio
    async def test_телеграм_игра_не_удаляется(self, storage):
        """У игр из Telegram нет WebSocket вообще — правило «нет подключений» их не касается."""
        from app import purge_expired_sessions

        await storage.save_game(storage.new_game("-100500", "s1", Initiator.from_web("bob"), "telegram-задача"))
        manager._orphaned_at["s1"] = time.time() - 600

        await purge_expired_sessions()

        assert await storage.get_game("-100500", "s1") is not None

    @pytest.mark.asyncio
    async def test_память_о_сессии_очищается(self, storage):
        from app import purge_expired_sessions

        await storage.save_game(storage.new_game(WEB_CHAT_ID, "s1", Initiator.from_web("alice"), "задача"))
        manager.register_user("s1", "alice")
        manager._orphaned_at["s1"] = time.time() - 600

        await purge_expired_sessions()

        assert "s1" not in manager._orphaned_at
        assert "s1" not in manager.session_users


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

    def test_loop_survives_failing_tick(self):
        """Сбой в одном тике не должен останавливать цикл очистки навсегда."""
        import asyncio
        from unittest.mock import patch

        from app import session_cleanup_loop

        calls = []

        def flaky_cleanup():
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("boom")

        async def scenario():
            with patch.object(manager, "cleanup_old_sessions", side_effect=flaky_cleanup):
                task = asyncio.create_task(session_cleanup_loop(0.01))
                await asyncio.sleep(0.05)

                assert not task.done()
                assert len(calls) > 1

                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task

        asyncio.run(scenario())
