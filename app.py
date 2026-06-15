import asyncio
import os
from contextlib import asynccontextmanager

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.routing import Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.templating import Jinja2Templates

import state
from config import logger
from connection import manager
from ppbot.game import GameRegistry
from telegram_bot import init_bot, telegram_webhook
from web_api import (
    api_create_session,
    api_get_session,
    api_list_sessions,
    api_restart,
    api_reveal,
    api_vote,
    health,
    info,
    web_index,
)
from websocket_handler import websocket_endpoint


async def shutdown_app(app: Starlette) -> None:
    """Graceful shutdown: broadcast, wait, stop telegram, close db."""
    logger.info("Shutting down server gracefully...")
    for session_id in list(manager.active_connections.keys()):
        await manager.broadcast(session_id, {"type": "shutdown", "message": "Server is shutting down"})
    logger.info("Waiting up to 5s for pending tasks...")
    await asyncio.sleep(5)
    if getattr(app.state, "telegram_app", None):
        await app.state.telegram_app.stop()
        await app.state.telegram_app.shutdown()
    if state.storage._db:
        await state.storage._db.close()
    logger.info("Shutdown complete")


async def build_app():
    state.storage = GameRegistry()
    state.templates = Jinja2Templates(directory="web/templates")

    await init_bot()

    routes = [
        Route("/", web_index, methods=["GET"]),
        Route("/web", web_index, methods=["GET"]),
        Route("/api/sessions", api_create_session, methods=["POST"]),
        Route("/api/sessions", api_list_sessions, methods=["GET"]),
        Route("/api/sessions/{session_id}", api_get_session, methods=["GET"]),
        Route("/api/sessions/{session_id}/vote", api_vote, methods=["POST"]),
        Route("/api/sessions/{session_id}/restart", api_restart, methods=["POST"]),
        Route("/api/sessions/{session_id}/reveal", api_reveal, methods=["POST"]),
        Route("/healthcheck", health, methods=["GET"]),
        Route("/info", info, methods=["GET"]),
        Route("/telegram", telegram_webhook, methods=["POST"]),
        WebSocketRoute("/ws/{session_id}", websocket_endpoint),
    ]

    @asynccontextmanager
    async def lifespan(app):
        yield
        await shutdown_app(app)

    starlette_app = Starlette(
        routes=routes,
        middleware=[Middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])],
        lifespan=lifespan,
    )

    if os.path.exists("web/static"):
        starlette_app.mount("/static", StaticFiles(directory="web/static"), name="static")

    return starlette_app
