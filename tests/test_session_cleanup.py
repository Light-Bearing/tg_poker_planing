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
