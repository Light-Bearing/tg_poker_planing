import asyncio

from starlette.websockets import WebSocket

from ppbot.game import Game


class ConnectionManager:
    def __init__(self):
        self.active_connections: dict[str, list[WebSocket]] = {}
        self.session_users: dict[str, dict[str, dict]] = {}

    async def connect(self, session_id: str, websocket: WebSocket):
        await websocket.accept()
        if session_id not in self.active_connections:
            self.active_connections[session_id] = []
        if session_id not in self.session_users:
            self.session_users[session_id] = {}
        self.active_connections[session_id].append(websocket)

    def disconnect(self, session_id: str, websocket: WebSocket, username: str = None, game: Game = None):
        if session_id in self.active_connections:
            if websocket in self.active_connections[session_id]:
                self.active_connections[session_id].remove(websocket)
            if not self.active_connections[session_id]:
                del self.active_connections[session_id]
        if username and session_id in self.session_users:
            if username in self.session_users[session_id]:
                del self.session_users[session_id][username]
                asyncio.create_task(
                    self.broadcast(
                        session_id,
                        {
                            "type": "user_left",
                            "username": username,
                            "data": self._get_enriched_data(session_id, game),
                        },
                    )
                )

    async def broadcast(self, session_id: str, message: dict):
        if session_id in self.active_connections:
            disconnected = []
            for connection in self.active_connections[session_id]:
                try:
                    await connection.send_json(message)
                except Exception:
                    disconnected.append(connection)
            for conn in disconnected:
                self.disconnect(session_id, conn)

    def register_user(self, session_id: str, username: str):
        if session_id not in self.session_users:
            self.session_users[session_id] = {}
        is_new = username not in self.session_users[session_id]
        if is_new:
            self.session_users[session_id][username] = {"status": "pending", "vote": None}
        return is_new

    def update_user_vote(self, session_id: str, username: str, vote_data: dict):
        if session_id in self.session_users and username in self.session_users[session_id]:
            self.session_users[session_id][username]["status"] = "voted"
            self.session_users[session_id][username]["vote"] = vote_data

    def reset_session_users(self, session_id: str):
        if session_id in self.session_users:
            for username in self.session_users[session_id]:
                self.session_users[session_id][username] = {"status": "pending", "vote": None}

    def _get_enriched_data(self, session_id: str, game: Game = None):
        if game is None:
            return {"session_id": session_id, "participants": []}
        from web_api import enrich_session_response

        return enrich_session_response(game, session_id)


manager = ConnectionManager()
