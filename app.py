import asyncio
import os
from contextlib import asynccontextmanager, suppress

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.routing import Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.templating import Jinja2Templates

import state
from config import CORS_ORIGINS, SESSION_CLEANUP_INTERVAL, logger
from connection import manager
from ppbot.game import GameRegistry
from telegram_bot import init_bot, telegram_webhook
from web_api import (
    api_create_session,
    api_get_custom_scale,
    api_get_session,
    api_kick_user,
    api_list_sessions,
    api_restart,
    api_reveal,
    api_save_custom_scale,
    api_set_auto_reveal,
    api_set_scale,
    api_vote,
    download_extension,
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
    await state.storage.close()
    logger.info("Shutdown complete")


async def session_cleanup_loop(interval: float) -> None:
    """Периодически убирает из памяти сессии без активных подключений
    и протухшие записи rate-limiter'а."""
    from web_api import evict_stale_rate_limits

    while True:
        await asyncio.sleep(interval)
        try:
            manager.cleanup_old_sessions()
            evict_stale_rate_limits()
        except Exception:
            # Один сбойный тик не должен останавливать уборку навсегда.
            logger.exception("Session cleanup tick failed")


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
        Route("/api/sessions/{session_id}/scale", api_set_scale, methods=["POST"]),
        Route("/api/sessions/{session_id}/auto-reveal", api_set_auto_reveal, methods=["POST"]),
        Route("/api/sessions/{session_id}/kick", api_kick_user, methods=["POST"]),
        Route("/custom-scale", api_get_custom_scale, methods=["GET"]),
        Route("/custom-scale", api_save_custom_scale, methods=["POST"]),
        Route("/healthcheck", health, methods=["GET"]),
        Route("/info", info, methods=["GET"]),
        Route("/extension/download", download_extension, methods=["GET"]),
        Route("/telegram", telegram_webhook, methods=["POST"]),
        WebSocketRoute("/ws/{session_id}", websocket_endpoint),
    ]

    @asynccontextmanager
    async def lifespan(app):
        cleanup_task = asyncio.create_task(session_cleanup_loop(SESSION_CLEANUP_INTERVAL))
        try:
            yield
        finally:
            cleanup_task.cancel()
            with suppress(asyncio.CancelledError):
                await cleanup_task
            await shutdown_app(app)

    starlette_app = Starlette(
        routes=routes,
        middleware=[Middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"])],
        lifespan=lifespan,
    )

    if os.path.exists("web/static"):
        starlette_app.mount("/static", StaticFiles(directory="web/static"), name="static")

    return starlette_app
