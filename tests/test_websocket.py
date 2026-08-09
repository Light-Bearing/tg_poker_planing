import json
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
    manager.ws_username_map.clear()
    manager._ws_connections.clear()


@pytest.fixture(autouse=True)
async def _game_storage(tmp_path):
    registry = GameRegistry()
    state.storage = registry
    await registry.init_db(str(tmp_path / "test.db"))
    yield
    await registry.close()


@pytest.fixture
def ws():
    w = MagicMock(spec=WebSocket)
    w.accept = AsyncMock()
    w.send_json = AsyncMock()
    w.send_text = AsyncMock()
    w.receive_text = AsyncMock()
    w.path_params = {"session_id": "test-session"}
    return w


class SimpleMockWs:
    """Minimal WebSocket mock for kick testing."""

    async def send_json(self, data):
        pass

    async def close(self, code=1000):
        pass


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
        assert updated.initiator.id == "web_alice"

    @pytest.mark.asyncio
    async def test_transfers_to_next_user(self):
        game = state.storage.new_game(
            "web", "s1", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
        )
        await state.storage.save_game(game)
        manager.register_user("s1", "bob")
        manager.register_ws_connection("s1", "bob", MagicMock())
        with patch("connection.manager.broadcast", new=AsyncMock()) as mock_broadcast:
            await transfer_initiator_if_needed("s1", "alice")
            updated = await state.storage.get_game("web", "s1")
            assert updated.initiator.id == "web_bob"
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
        assert updated.initiator.id == "web_alice"

    @pytest.mark.asyncio
    async def test_does_not_transfer_when_no_other_users(self):
        game = state.storage.new_game(
            "web", "s3", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
        )
        await state.storage.save_game(game)
        manager.register_user("s3", "alice")
        await transfer_initiator_if_needed("s3", "alice")
        updated = await state.storage.get_game("web", "s3")
        assert updated.initiator.id == "web_alice"

    @pytest.mark.asyncio
    async def test_no_game_found(self):
        await transfer_initiator_if_needed("nonexistent", "alice")

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
            assert updated.initiator.id == "web_bob"
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
            assert updated.initiator.id == "web_alice"  # unchanged

    @pytest.mark.asyncio
    async def test_does_not_transfer_when_only_initiator_in_session(self):
        """Initiator leaves but is the only one in session → no transfer."""
        game = state.storage.new_game(
            "web", "s7", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
        )
        await state.storage.save_game(game)
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
        manager.register_user("s8", "alice")
        manager.register_user("s8", "bob")
        manager.register_user("s8", "charlie")
        manager.register_ws_connection("s8", "bob", MagicMock())

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
        manager.register_user("s1", "alice")
        manager.register_user("s1", "bob")
        manager.register_ws_connection("s1", "alice", MagicMock())
        manager.register_ws_connection("s1", "bob", MagicMock())
        manager.kick_user("s1", "alice")
        manager.kick_user("s1", "bob")
        assert "s1" not in manager.ws_username_map


class TestWebSocketKick:
    @pytest.mark.asyncio
    async def test_kick_user_by_initiator(self, ws):
        game = state.storage.new_game(
            "web", "test-session", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
        )
        await state.storage.save_game(game)
        manager.register_user("test-session", "alice")
        manager.register_user("test-session", "bob")
        manager.register_ws_connection("test-session", "alice", SimpleMockWs())
        manager.register_ws_connection("test-session", "bob", SimpleMockWs())

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
        manager.register_ws_connection("test-session", "bob", SimpleMockWs())

        ws.receive_text.side_effect = [
            '{"type": "join", "username": "bob"}',
            '{"type": "kick_user", "username": "bob", "target_username": "alice"}',
            WebSocketDisconnect(),
        ]
        await websocket_endpoint(ws)
        assert "alice" in manager.session_users.get("test-session", {})


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
        manager.register_ws_connection("test-session", "bob", bob_ws)

        # alice connects and triggers exception
        await websocket_endpoint(alice_ws)

        updated = await state.storage.get_game("web", "test-session")
        assert updated.initiator.id == "web_bob"

    @pytest.mark.asyncio
    async def test_join_rejects_invalid_username(self, ws):
        """WebSocket join with an invalid/dangerous username is rejected and never registered."""
        bad_name = "<img src=x onerror=alert(1)>"
        ws.receive_text.side_effect = [
            json.dumps({"type": "join", "username": bad_name}),
            WebSocketDisconnect(),
        ]
        await websocket_endpoint(ws)

        error_calls = [call for call in ws.send_json.await_args_list if call.args[0].get("type") == "error"]
        assert len(error_calls) >= 1
        assert error_calls[0].args[0]["message"] == "Недопустимое имя участника"

        assert manager.session_users.get("test-session", {}) == {}


class TestCheckAutoReveal:
    @pytest.mark.asyncio
    async def test_auto_reveal_triggers_when_all_voted(self):
        """Auto-reveal triggers when all participants have voted."""
        from websocket_handler import check_auto_reveal

        game = state.storage.new_game(
            "web",
            "test-session",
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
            "web",
            "test-session",
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
            "web",
            "test-session",
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
            "web",
            "test-session",
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
            "web",
            "test-session",
            {"id": "web_alice", "first_name": "Alice", "username": "alice"},
            "task",
        )
        game.auto_reveal = True
        await state.storage.save_game(game)

        with patch("connection.manager.broadcast", new=AsyncMock()) as mock_broadcast:
            await check_auto_reveal("test-session", game)
            mock_broadcast.assert_not_called()


class TestWebSocketVoteValidation:
    @pytest.mark.asyncio
    async def test_websocket_rejects_invalid_point(self, ws):
        """WebSocket vote with point not in scale returns error."""
        game = state.storage.new_game(
            "web", "test-session",
            {"id": "web_alice", "first_name": "Alice", "username": "alice"},
            "task",
            scale_name="fibonacci",
        )
        await state.storage.save_game(game)

        ws.receive_text.side_effect = [
            '{"type": "join", "username": "alice"}',
            '{"type": "vote", "username": "alice", "point": "99"}',
            WebSocketDisconnect(),
        ]
        ws.send_json.reset_mock()
        await websocket_endpoint(ws)

        error_calls = [
            call for call in ws.send_json.await_args_list
            if call[0][0].get("type") == "error"
        ]
        assert len(error_calls) >= 1
        message = error_calls[0].args[0].get("message", "")
        assert "99" in message
        assert "fibonacci" in message

    @pytest.mark.asyncio
    async def test_websocket_vote_rejects_invalid_username(self, ws):
        """WebSocket vote with an invalid/dangerous username is rejected and never stored."""
        game = state.storage.new_game(
            "web", "test-session", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
        )
        await state.storage.save_game(game)

        bad_name = "<img src=x onerror=alert(1)>"
        ws.receive_text.side_effect = [
            json.dumps({"type": "vote", "username": bad_name, "point": "5"}),
            WebSocketDisconnect(),
        ]
        ws.send_json.reset_mock()
        await websocket_endpoint(ws)

        error_calls = [call for call in ws.send_json.await_args_list if call.args[0].get("type") == "error"]
        assert len(error_calls) >= 1
        assert error_calls[0].args[0]["message"] == "Недопустимое имя участника"

        stored_game = await state.storage.get_game("web", "test-session")
        assert stored_game.votes == {}


class TestWebSocketFreshGame:
    @pytest.mark.asyncio
    async def test_vote_does_not_wipe_votes_cast_after_connect(self, ws):
        """Алиса подключилась, Боб проголосовал «снаружи», Алиса голосует по WS.
        Голос Боба должен уцелеть — значит обработчик читал игру заново."""
        game = state.storage.new_game(
            "web", "test-session", {"id": "web_alice", "first_name": "Alice", "username": "alice"}, "task"
        )
        await state.storage.save_game(game)
        manager.register_user("test-session", "alice")

        messages = iter(
            [
                '{"type": "join", "username": "alice"}',
                "__external_vote__",
                '{"type": "vote", "username": "alice", "point": "3"}',
            ]
        )

        async def receive_text():
            try:
                nxt = next(messages)
            except StopIteration:
                raise WebSocketDisconnect() from None
            if nxt == "__external_vote__":
                # Эмулируем голос Боба через REST: отдельное чтение и запись игры
                fresh = await state.storage.get_game("web", "test-session")
                fresh.add_vote({"id": "web_bob", "first_name": "bob", "username": "bob"}, "5")
                await state.storage.save_game(fresh)
                return "ping"
            return nxt

        ws.receive_text.side_effect = receive_text

        await websocket_endpoint(ws)

        saved = await state.storage.get_game("web", "test-session")
        assert "web_bob" in saved.votes, "голос Боба затёрт устаревшим объектом игры"
        assert "web_alice" in saved.votes
        assert saved.votes["web_bob"].point == "5"
