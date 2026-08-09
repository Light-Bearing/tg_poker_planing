import asyncio
import time
from contextlib import suppress
from typing import TYPE_CHECKING, Optional

from starlette.websockets import WebSocket

if TYPE_CHECKING:
    from ppbot.game import Game


class ConnectionManager:
    """Manages WebSocket connections, user registration, and session state.

    Tracks three levels of state per session:
    - active_connections: raw WebSocket objects for broadcasting
    - session_users: all users who joined (persists across reconnects, used for auto-reveal)
    - ws_username_map + _ws_connections: users with currently active WS (for initiator transfer)
    """

    def __init__(self):
        self.active_connections: dict[str, list[WebSocket]] = {}
        self.session_users: dict[str, dict[str, dict]] = {}
        self.ws_username_map: dict[str, set[str]] = {}
        self._ws_connections: dict[str, dict[str, WebSocket]] = {}
        # Момент, когда сессия осталась без активных подключений (session_id -> time.time())
        self._orphaned_at: dict[str, float] = {}

    async def connect(self, session_id: str, websocket: WebSocket):
        """Accept and register a new WebSocket connection for a session."""
        await websocket.accept()
        if session_id not in self.active_connections:
            self.active_connections[session_id] = []
        if session_id not in self.session_users:
            self.session_users[session_id] = {}
        self.active_connections[session_id].append(websocket)
        # Кто-то вернулся — сессия больше не осиротевшая.
        self._orphaned_at.pop(session_id, None)

    def disconnect(
        self,
        session_id: str,
        websocket: WebSocket,
        username: str | None = None,
        game: Optional["Game"] = None,
    ):
        """Remove a WebSocket from the session.

        Does NOT remove the user from session_users — that persists for reconnection
        and auto-reveal counting. Use kick_user() for permanent removal.
        """
        if session_id in self.active_connections:
            if websocket in self.active_connections[session_id]:
                self.active_connections[session_id].remove(websocket)
            if not self.active_connections[session_id]:
                del self.active_connections[session_id]
        if session_id in self.ws_username_map and username:
            self.ws_username_map[session_id].discard(username)

        # Notify remaining participants that this user left (с данными сессии)
        if username and session_id in self.active_connections:
            enriched = self._get_enriched_data(session_id, game) if game else {"session_id": session_id}
            asyncio.create_task(
                self.broadcast(session_id, {"type": "user_left", "username": username, "data": enriched})
            )

        # Ушёл последний — засекаем время, с которого сессия считается осиротевшей.
        if not self.active_connections.get(session_id):
            self._orphaned_at[session_id] = time.time()

    def orphaned_web_sessions(self, ttl: float) -> list[str]:
        """Сессии без активных подключений, осиротевшие дольше ttl секунд."""
        now = time.time()
        return [
            sid
            for sid, since in self._orphaned_at.items()
            if not self.active_connections.get(sid) and now - since >= ttl
        ]

    async def broadcast(self, session_id: str, message: dict):
        """Send a JSON message to all WebSocket clients in a session."""
        if session_id in self.active_connections:
            disconnected = []
            for connection in self.active_connections[session_id]:
                try:
                    await connection.send_json(message)
                except Exception:
                    disconnected.append(connection)
            for conn in disconnected:
                self.disconnect(session_id, conn)

    def register_user(self, session_id: str, username: str) -> bool:
        """Register a user in the session. Returns True if user is new (first join)."""
        if session_id not in self.session_users:
            self.session_users[session_id] = {}
        is_new = username not in self.session_users[session_id]
        if is_new:
            self.session_users[session_id][username] = {"status": "pending", "vote": None}
        return is_new

    def register_ws_connection(self, session_id: str, username: str, websocket: WebSocket):
        """Track a user's active WebSocket connection (called on join/reconnect)."""
        if session_id not in self.ws_username_map:
            self.ws_username_map[session_id] = set()
            self._ws_connections[session_id] = {}
        self.ws_username_map[session_id].add(username)
        self._ws_connections[session_id][username] = websocket

    def unregister_ws_connection(self, session_id: str, username: str):
        """Remove user from active WS tracking (called on disconnect)."""
        if session_id in self.ws_username_map:
            self.ws_username_map[session_id].discard(username)
            self._ws_connections[session_id].pop(username, None)
            if not self.ws_username_map[session_id]:
                del self.ws_username_map[session_id]
                del self._ws_connections[session_id]

    def is_ws_connected(self, session_id: str, username: str) -> bool:
        return username in self.ws_username_map.get(session_id, set())

    def get_active_ws_usernames(self, session_id: str) -> set[str]:
        return self.ws_username_map.get(session_id, set()).copy()

    def get_ws_by_username(self, session_id: str, username: str) -> WebSocket | None:
        return self._ws_connections.get(session_id, {}).get(username)

    def kick_user(self, session_id: str, target_username: str) -> bool:
        """Remove a user from the session. Returns True if user was found and removed."""
        if session_id not in self.session_users:
            return False
        if target_username not in self.session_users[session_id]:
            return False
        del self.session_users[session_id][target_username]
        if not self.session_users[session_id]:
            del self.session_users[session_id]
        # Clean up active_connections
        if session_id in self.active_connections:
            ws = self._ws_connections.get(session_id, {}).get(target_username)
            if ws and ws in self.active_connections[session_id]:
                self.active_connections[session_id].remove(ws)
                if not self.active_connections[session_id]:
                    del self.active_connections[session_id]

        # Clean up WS tracking
        if session_id in self.ws_username_map:
            self.ws_username_map[session_id].discard(target_username)
        if session_id in self._ws_connections:
            self._ws_connections[session_id].pop(target_username, None)
        # Clean up empty session WS tracking
        if session_id in self.ws_username_map and not self.ws_username_map[session_id]:
            del self.ws_username_map[session_id]
        if session_id in self._ws_connections and not self._ws_connections[session_id]:
            del self._ws_connections[session_id]
        return True

    def update_user_vote(self, session_id: str, username: str, vote_data: dict):
        if session_id in self.session_users and username in self.session_users[session_id]:
            self.session_users[session_id][username]["status"] = "voted"
            self.session_users[session_id][username]["vote"] = vote_data

    def reset_session_users(self, session_id: str):
        if session_id in self.session_users:
            for username in self.session_users[session_id]:
                self.session_users[session_id][username] = {"status": "pending", "vote": None}

    async def cleanup_session(self, session_id: str):
        """Полная очистка сессии: закрывает WS, удаляет все трекеры.

        Вызывается когда сессия завершена и больше не нужна.
        """
        if session_id in self.active_connections:
            for ws in self.active_connections[session_id]:
                with suppress(Exception):
                    await ws.close(1000)
            del self.active_connections[session_id]

        self.session_users.pop(session_id, None)
        self.ws_username_map.pop(session_id, None)
        self._ws_connections.pop(session_id, None)
        self._orphaned_at.pop(session_id, None)

    def cleanup_old_sessions(self):
        """Очистка неактивных сессий.

        Удаляет сессии, которые не имеют активных WS-подключений.
        Метку `_orphaned_at` не трогает: она должна пережить очистку памяти,
        иначе запись в БД останется навсегда.
        """
        stale_sessions = [
            sid for sid in self.session_users if sid not in self.active_connections or not self.active_connections[sid]
        ]

        for sid in stale_sessions:
            self.session_users.pop(sid, None)
            self.ws_username_map.pop(sid, None)
            self._ws_connections.pop(sid, None)
            self.active_connections.pop(sid, None)

    @staticmethod
    def _get_enriched_data(session_id: str, game: Optional["Game"] = None) -> dict:
        """Возвращает обогащённые данные сессии для broadcast.
        Если game=None — возвращает минимальный ответ."""
        if game is None:
            return {"session_id": session_id, "participants": []}
        from web_api import enrich_session_response

        return enrich_session_response(game, session_id)


manager = ConnectionManager()
