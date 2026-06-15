from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from starlette.websockets import WebSocket, WebSocketDisconnect

import state
from connection import manager
from ppbot.game import GameRegistry
from websocket_handler import transfer_initiator_if_needed, websocket_endpoint


@pytest.fixture(autouse=True)
def _reset_manager():
    manager.active_connections.clear()
    manager.session_users.clear()


@pytest.fixture(autouse=True)
async def _game_storage(tmp_path):
    state.storage = GameRegistry()
    await state.storage.init_db(str(tmp_path / "test.db"))
    yield
    await state.storage.close()


@pytest.fixture
def ws():
    w = MagicMock(spec=WebSocket)
    w.accept = AsyncMock()
    w.send_json = AsyncMock()
    w.send_text = AsyncMock()
    w.receive_text = AsyncMock()
    w.path_params = {"session_id": "test-session"}
    return w


class TestConnectionManager:
    def test_connect_adds_websocket_to_session(self):
        ws1 = MagicMock(spec=WebSocket)
        ws2 = MagicMock(spec=WebSocket)
        ws1.accept = AsyncMock()
        ws2.accept = AsyncMock()

        async def test():
            await manager.connect("s1", ws1)
            await manager.connect("s1", ws2)
            assert len(manager.active_connections["s1"]) == 2
            assert "s1" in manager.session_users

        import asyncio

        asyncio.run(test())

    def test_connect_accepts_websocket(self):
        ws = MagicMock(spec=WebSocket)
        ws.accept = AsyncMock()

        async def test():
            await manager.connect("s1", ws)
            ws.accept.assert_awaited_once()

        import asyncio

        asyncio.run(test())

    def test_disconnect_removes_websocket(self):
        ws = MagicMock(spec=WebSocket)
        ws.accept = AsyncMock()

        async def test():
            await manager.connect("s1", ws)
            assert len(manager.active_connections["s1"]) == 1
            manager.disconnect("s1", ws)
            assert "s1" not in manager.active_connections
            # session_users persist after last ws disconnects (for reconnects / transfer)
            assert "s1" in manager.session_users

        import asyncio

        asyncio.run(test())

    def test_disconnect_removes_empty_session(self):
        ws1 = MagicMock(spec=WebSocket)
        ws2 = MagicMock(spec=WebSocket)
        ws1.accept = AsyncMock()
        ws2.accept = AsyncMock()

        async def test():
            await manager.connect("s1", ws1)
            await manager.connect("s1", ws2)
            manager.disconnect("s1", ws1)
            assert "s1" in manager.active_connections
            assert len(manager.active_connections["s1"]) == 1
            manager.disconnect("s1", ws2)
            assert "s1" not in manager.active_connections

        import asyncio

        asyncio.run(test())

    def test_disconnect_broadcasts_user_left(self):
        ws1 = MagicMock(spec=WebSocket)
        ws2 = MagicMock(spec=WebSocket)
        ws1.send_json = AsyncMock()
        ws2.send_json = AsyncMock()
        ws1.accept = AsyncMock()
        ws2.accept = AsyncMock()

        async def test():
            await manager.connect("s1", ws1)
            await manager.connect("s1", ws2)
            manager.register_user("s1", "alice")
            manager.register_user("s1", "bob")
            manager.disconnect("s1", ws1, "alice")
            await asyncio.sleep(0)  # let create_task run
            assert ws2.send_json.await_count >= 1
            calls = [c[0][0] for c in ws2.send_json.await_args_list]
            user_left = [c for c in calls if c.get("type") == "user_left"]
            assert len(user_left) == 1
            assert user_left[0]["username"] == "alice"

        import asyncio

        asyncio.run(test())

    def test_disconnect_does_not_broadcast_without_username(self):
        ws = MagicMock(spec=WebSocket)
        ws.send_json = AsyncMock()
        ws.accept = AsyncMock()

        async def test():
            await manager.connect("s1", ws)
            manager.disconnect("s1", ws)
            ws.send_json.assert_not_called()

        import asyncio

        asyncio.run(test())

    def test_broadcast_sends_to_all(self):
        ws1 = MagicMock(spec=WebSocket)
        ws2 = MagicMock(spec=WebSocket)
        ws1.accept = AsyncMock()
        ws2.accept = AsyncMock()
        ws1.send_json = AsyncMock()
        ws2.send_json = AsyncMock()

        async def test():
            await manager.connect("s1", ws1)
            await manager.connect("s1", ws2)
            await manager.broadcast("s1", {"type": "test", "data": {}})
            ws1.send_json.assert_awaited_once()
            ws2.send_json.assert_awaited_once()

        import asyncio

        asyncio.run(test())

    def test_broadcast_handles_disconnected_client(self):
        ws = MagicMock(spec=WebSocket)
        ws.send_json = AsyncMock(side_effect=[Exception("gone"), None])
        ws.accept = AsyncMock()

        async def test():
            await manager.connect("s1", ws)
            await manager.broadcast("s1", {"type": "test"})
            assert "s1" not in manager.active_connections

        import asyncio

        asyncio.run(test())

    def test_register_user_adds_new_user(self):
        is_new = manager.register_user("s1", "alice")
        assert is_new is True
        assert manager.session_users["s1"]["alice"] == {"status": "pending", "vote": None}

    def test_register_user_returns_false_for_existing(self):
        manager.register_user("s1", "alice")
        is_new = manager.register_user("s1", "alice")
        assert is_new is False

    def test_update_user_vote(self):
        manager.register_user("s1", "bob")
        manager.update_user_vote("s1", "bob", {"point": "5"})
        assert manager.session_users["s1"]["bob"]["status"] == "voted"
        assert manager.session_users["s1"]["bob"]["vote"] == {"point": "5"}

    def test_update_user_vote_unknown_user_does_nothing(self):
        manager.update_user_vote("s1", "unknown", {"point": "5"})
        assert "unknown" not in manager.session_users.get("s1", {})

    def test_reset_session_users(self):
        manager.register_user("s1", "alice")
        manager.register_user("s1", "bob")
        manager.update_user_vote("s1", "alice", {"point": "3"})
        manager.update_user_vote("s1", "bob", {"point": "5"})
        manager.reset_session_users("s1")
        for username in ["alice", "bob"]:
            assert manager.session_users["s1"][username] == {"status": "pending", "vote": None}

    def test_reset_session_users_empty_session(self):
        manager.reset_session_users("nonexistent")

    def test_get_enriched_data_without_game(self):
        result = manager._get_enriched_data("s1")
        assert result == {"session_id": "s1", "participants": []}

    def test_get_enriched_data_with_game(self):
        manager.register_user("s1", "alice")

        async def test():
            game = state.storage.new_game(
                "web", "s1", {"id": "web_alice", "first_name": "alice", "username": "alice"}, "task"
            )
            result = manager._get_enriched_data("s1", game)
            assert result["session_id"] == "s1"
            assert len(result["participants"]) >= 1
            assert result["participants"][0]["online"] is True
            assert result["participants"][0]["username"] == "alice"

        import asyncio

        asyncio.run(test())


class TestTransferInitiator:
    @pytest.mark.asyncio
    async def test_no_other_participants(self):
        """Initiator leaves but no other users registered → log and return."""
        game = state.storage.new_game(
            "web", "s4", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
        )
        await state.storage.save_game(game)
        # Don't register any session users → session_id not in manager.session_users
        await transfer_initiator_if_needed("s4", "alice")
        # Initiator should remain unchanged
        updated = await state.storage.get_game("web", "s4")
        assert updated.initiator["id"] == "web_alice"

    @pytest.mark.asyncio
    async def test_transfers_to_next_user(self):
        game = state.storage.new_game(
            "web", "s1", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
        )
        await state.storage.save_game(game)
        manager.register_user("s1", "bob")
        # alice is the initiator, but never registered as a ws user;
        # only bob is in session_users — transfer should go to bob
        with patch("connection.manager.broadcast", new=AsyncMock()) as mock_broadcast:
            await transfer_initiator_if_needed("s1", "alice")
            updated = await state.storage.get_game("web", "s1")
            assert updated.initiator["id"] == "web_bob"
            mock_broadcast.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_does_not_transfer_when_not_initiator(self):
        game = state.storage.new_game(
            "web", "s2", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
        )
        await state.storage.save_game(game)
        manager.register_user("s2", "bob")
        await transfer_initiator_if_needed("s2", "bob")
        updated = await state.storage.get_game("web", "s2")
        assert updated.initiator["id"] == "web_alice"

    @pytest.mark.asyncio
    async def test_does_not_transfer_when_no_other_users(self):
        game = state.storage.new_game(
            "web", "s3", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
        )
        await state.storage.save_game(game)
        manager.register_user("s3", "alice")
        await transfer_initiator_if_needed("s3", "alice")
        updated = await state.storage.get_game("web", "s3")
        assert updated.initiator["id"] == "web_alice"

    @pytest.mark.asyncio
    async def test_no_game_found(self):
        await transfer_initiator_if_needed("nonexistent", "alice")


class TestWebSocketEndpoint:
    @pytest.mark.asyncio
    async def test_sends_init_message_when_game_exists(self, ws):
        game = state.storage.new_game(
            "web", "test-session", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
        )
        await state.storage.save_game(game)
        ws.receive_text.side_effect = WebSocketDisconnect()
        await websocket_endpoint(ws)
        init_calls = [c for c in ws.send_json.await_args_list if c[0][0].get("type") == "init"]
        assert len(init_calls) >= 1

    @pytest.mark.asyncio
    async def test_no_init_when_no_game(self, ws):
        ws.receive_text.side_effect = WebSocketDisconnect()
        await websocket_endpoint(ws)
        init_calls = [c for c in ws.send_json.await_args_list if c[0][0].get("type") == "init"]
        assert len(init_calls) == 0

    @pytest.mark.asyncio
    async def test_handles_ping(self, ws):
        ws.receive_text.side_effect = ["ping", WebSocketDisconnect()]
        await websocket_endpoint(ws)
        ws.send_text.assert_any_await("pong")

    @pytest.mark.asyncio
    async def test_handles_join_new_user(self, ws):
        ws.receive_text.side_effect = [
            '{"type": "join", "username": "alice"}',
            WebSocketDisconnect(),
        ]
        with patch("connection.manager.register_user", wraps=manager.register_user) as spy:
            await websocket_endpoint(ws)
            spy.assert_called_with("test-session", "alice")

    @pytest.mark.asyncio
    async def test_ignores_invalid_json(self, ws):
        ws.receive_text.side_effect = ["not-json", WebSocketDisconnect()]
        await websocket_endpoint(ws)

    @pytest.mark.asyncio
    async def test_disconnect_cleanup(self, ws):
        ws.receive_text.side_effect = WebSocketDisconnect()
        await websocket_endpoint(ws)
        assert "test-session" not in manager.active_connections

    @pytest.mark.asyncio
    async def test_error_handling(self, ws):
        ws.receive_text.side_effect = Exception("unexpected error")
        await websocket_endpoint(ws)
        assert "test-session" not in manager.active_connections

    @pytest.mark.asyncio
    async def test_join_broadcasts_user_joined(self, ws):
        """When game exists and a new user joins → broadcasts user_joined."""
        game = state.storage.new_game(
            "web", "test-session", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
        )
        await state.storage.save_game(game)
        ws.receive_text.side_effect = [
            '{"type": "join", "username": "bob"}',
            WebSocketDisconnect(),
        ]
        await websocket_endpoint(ws)
        user_joined_calls = [call for call in ws.send_json.await_args_list if call.args[0].get("type") == "user_joined"]
        assert len(user_joined_calls) >= 1
        assert user_joined_calls[0].args[0]["username"] == "bob"

    @pytest.mark.asyncio
    async def test_join_broadcasts_update_on_rejoin(self, ws):
        """When game exists and an existing user rejoins → broadcasts update."""
        game = state.storage.new_game(
            "web", "test-session", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
        )
        await state.storage.save_game(game)
        # Register bob first, then connect — connect no longer resets session_users
        manager.register_user("test-session", "bob")
        ws.receive_text.side_effect = [
            '{"type": "join", "username": "bob"}',
            WebSocketDisconnect(),
        ]
        await websocket_endpoint(ws)
        update_calls = [call for call in ws.send_json.await_args_list if call.args[0].get("type") == "update"]
        assert len(update_calls) >= 1

    @pytest.mark.asyncio
    async def test_exception_with_username_triggers_transfer(self, ws):
        """Generic exception after username is set → transfer_initiator called."""
        # We need two WebSocket connections: one for alice (initiator), one for bob
        # bob connects first, then alice connects and triggers the exception
        alice_ws = MagicMock()
        alice_ws.accept = AsyncMock()
        alice_ws.send_json = AsyncMock()
        alice_ws.send_text = AsyncMock()
        alice_ws.receive_text = AsyncMock()
        alice_ws.path_params = {"session_id": "test-session"}
        alice_ws.receive_text.side_effect = [
            '{"type": "join", "username": "alice"}',
            Exception("unexpected after join"),
        ]

        bob_ws = MagicMock()
        bob_ws.accept = AsyncMock()
        bob_ws.send_json = AsyncMock()
        bob_ws.send_text = AsyncMock()
        bob_ws.receive_text = AsyncMock()
        bob_ws.path_params = {"session_id": "test-session"}
        bob_ws.receive_text.side_effect = [WebSocketDisconnect()]

        game = state.storage.new_game(
            "web", "test-session", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
        )
        await state.storage.save_game(game)

        # bob connects first
        await websocket_endpoint(bob_ws)
        manager.register_user("test-session", "bob")

        # alice connects and triggers exception
        await websocket_endpoint(alice_ws)

        updated = await state.storage.get_game("web", "test-session")
        assert updated.initiator["id"] == "web_bob"
