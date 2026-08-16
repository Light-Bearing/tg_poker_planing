import asyncio
import secrets
import time
from contextlib import suppress
from typing import TYPE_CHECKING, Optional

from starlette.websockets import WebSocket

if TYPE_CHECKING:
    from ppbot.game import Game


# Сколько человек ещё считается участником комнаты после закрытия последней вкладки.
# Столько же ждёт перенос роли ведущего (INITIATOR_GRACE_SECONDS): перезагрузка
# страницы не должна ни отнимать комнату, ни выбрасывать из состава.
PRESENCE_GRACE_SECONDS = 30.0


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
        # Когда человек закрыл последнюю вкладку комнаты ((session_id, username) -> time.time())
        self._left_at: dict[tuple[str, str], float] = {}
        # Пропуска участников: session_id -> токен -> имя.
        #
        # До них личностью служило имя, присланное в самом же запросе, — то есть
        # никакой личности не было. Любой участник мог проголосовать за соседа, а
        # зная имя ведущего (оно написано на экране), исключить кого угодно,
        # вскрыть карты и подменить задачу. Пропуск выдаётся при входе в комнату
        # и живёт только в памяти сервера.
        self._tokens: dict[str, dict[str, str]] = {}

    def issue_token(self, session_id: str, username: str) -> str:
        """Выдаёт участнику пропуск в комнату."""
        token = secrets.token_urlsafe(24)
        self._tokens.setdefault(session_id, {})[token] = username
        return token

    def username_by_token(self, session_id: str, token: str | None) -> str | None:
        """Чей это пропуск. None — если пропуска нет или он не от этой комнаты."""
        if not token:
            return None
        return self._tokens.get(session_id, {}).get(token)

    def revoke_tokens(self, session_id: str, username: str) -> None:
        """Отзывает все пропуска человека: исключённый не должен ими пользоваться."""
        выданные = self._tokens.get(session_id)
        if not выданные:
            return
        for token in [t for t, имя in выданные.items() if имя == username]:
            del выданные[token]
        if not выданные:
            del self._tokens[session_id]

    def _rename_tokens(self, session_id: str, old_username: str, new_username: str) -> None:
        выданные = self._tokens.get(session_id, {})
        for token, имя in выданные.items():
            if имя == old_username:
                выданные[token] = new_username

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
        if username:
            # Не стираем человека, пока у него открыта хотя бы одна вкладка этой комнаты
            self.unregister_ws_connection(session_id, username, websocket)

        # Notify remaining participants that this user left (с данными сессии)
        if username and session_id in self.active_connections:
            enriched = self._get_enriched_data(session_id, game) if game else {"session_id": session_id}
            asyncio.create_task(
                self.broadcast(session_id, {"type": "user_left", "username": username, "data": enriched})
            )

        # Ушёл последний — засекаем время, с которого сессия считается осиротевшей.
        if not self.active_connections.get(session_id):
            self._orphaned_at[session_id] = time.time()

    def mark_orphaned_if_idle(self, session_id: str) -> None:
        """Помечает сессию осиротевшей, если у неё нет подключений и метки.

        Нужно для записей, которые не проходили цикл «подключился-отключился»
        в текущем процессе: они пережили перезапуск или их сокет не открылся.
        """
        if self.active_connections.get(session_id):
            return
        self._orphaned_at.setdefault(session_id, time.time())

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
        self._ws_connections[session_id].setdefault(username, set()).add(websocket)
        self._left_at.pop((session_id, username), None)

    def unregister_ws_connection(self, session_id: str, username: str, websocket: WebSocket | None = None):
        """Убирает сокет человека из учёта активных подключений.

        У одного человека может быть несколько вкладок одной комнаты. Раньше закрытие
        любой из них стирало его целиком, и в оставшейся, живой вкладке он числился
        ушедшим: счётчик показывал больше голосов, чем участников. Поэтому имя
        снимается только когда закрылся его последний сокет.

        websocket=None снимает человека целиком — так поступают при исключении из
        комнаты, когда закрываются все его вкладки разом.
        """
        sockets = self._ws_connections.get(session_id, {}).get(username)
        if sockets is not None and websocket is not None:
            sockets.discard(websocket)
            if sockets:
                return

        if session_id in self.ws_username_map:
            self.ws_username_map[session_id].discard(username)
            self._ws_connections[session_id].pop(username, None)
            self._left_at[(session_id, username)] = time.time()
            if not self.ws_username_map[session_id]:
                del self.ws_username_map[session_id]
                del self._ws_connections[session_id]

    def is_ws_connected(self, session_id: str, username: str) -> bool:
        return username in self.ws_username_map.get(session_id, set())

    def is_present(self, session_id: str, username: str, grace: float | None = None) -> bool:
        """На связи — или только что был.

        Перезагрузка страницы для сервера неотличима от ухода: сокет закрылся. Без
        отсрочки участник на секунду выпадал из состава комнаты, и автовскрытие могло
        открыть карты у него за спиной. Ушедший насовсем, наоборот, не должен держать
        комнату: после отсрочки он перестаёт считаться.
        """
        if grace is None:
            grace = PRESENCE_GRACE_SECONDS
        if self.is_ws_connected(session_id, username):
            return True
        left = self._left_at.get((session_id, username))
        if left is None:
            # Вошёл по HTTP, сокет ещё не открыл — считаем участником, иначе карты
            # успевали открыться в промежутке между входом и подключением
            return True
        return (time.time() - left) < grace

    def get_active_ws_usernames(self, session_id: str) -> set[str]:
        return self.ws_username_map.get(session_id, set()).copy()

    def get_ws_by_username(self, session_id: str, username: str) -> WebSocket | None:
        """Любой из сокетов человека. Для рассылки по всем вкладкам — get_all_ws_by_username."""
        sockets = self._ws_connections.get(session_id, {}).get(username)
        return next(iter(sockets), None) if sockets else None

    def get_all_ws_by_username(self, session_id: str, username: str) -> list[WebSocket]:
        """Все вкладки человека. Исключение из комнаты обязано закрыть каждую."""
        return list(self._ws_connections.get(session_id, {}).get(username, ()))

    async def notify_and_close(self, session_id: str, username: str, message: dict) -> None:
        """Сообщает человеку и закрывает все его вкладки этой комнаты.

        Закрыть одну мало: исключённый остался бы в комнате в другой вкладке, а его
        сокет — в active_connections, куда продолжала бы идти рассылка.
        """
        for websocket in self.get_all_ws_by_username(session_id, username):
            with suppress(Exception):
                await websocket.send_json(message)
            with suppress(Exception):
                await websocket.close(1000)
            connections = self.active_connections.get(session_id)
            if connections and websocket in connections:
                connections.remove(websocket)
        if session_id in self.active_connections and not self.active_connections[session_id]:
            del self.active_connections[session_id]

    def rename_user(self, session_id: str, old_username: str, new_username: str) -> bool:
        """Переносит человека под новое имя. False — если нельзя.

        Имя служит ключом сразу в трёх учётах, поэтому переносить надо всё разом:
        иначе участник раздваивается — под старым именем висит его голос, под новым
        сидит он сам. Сокеты переезжают вместе с ним, чтобы не потерять вкладки.
        """
        участники = self.session_users.get(session_id)
        if not участники or old_username not in участники:
            return False
        if new_username != old_username and new_username in участники:
            return False
        if new_username == old_username:
            return True

        участники[new_username] = участники.pop(old_username)

        if session_id in self.ws_username_map and old_username in self.ws_username_map[session_id]:
            self.ws_username_map[session_id].discard(old_username)
            self.ws_username_map[session_id].add(new_username)
        sockets = self._ws_connections.get(session_id, {}).pop(old_username, None)
        if sockets:
            self._ws_connections[session_id][new_username] = sockets
        ушёл = self._left_at.pop((session_id, old_username), None)
        if ушёл is not None:
            self._left_at[(session_id, new_username)] = ушёл
        self._rename_tokens(session_id, old_username, new_username)
        return True

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
        # Исключённый не должен доживать отсрочку присутствия: его удалили насовсем
        self._left_at.pop((session_id, target_username), None)
        self.revoke_tokens(session_id, target_username)
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
