import re
import time
import uuid
from contextlib import suppress

from starlette.requests import Request
from starlette.responses import JSONResponse

import state
from config import WEB_CHAT_ID, logger
from connection import manager
from ppbot.game import AVAILABLE_POINTS, DEFAULT_SCALE, SCALE_NAMES, SCALES, Game, Initiator

# ========== SIMPLE RATE LIMITER ==========
_rate_limit_store: dict[str, list[float]] = {}


def reset_rate_limits() -> None:
    """Сброс rate limit store (для тестов)."""
    _rate_limit_store.clear()


def _check_rate_limit(key: str, max_requests: int = 30, window: float = 60.0) -> bool:
    """Проверяет rate limit: не более max_requests запросов за window секунд.
    Возвращает True, если запрос разрешён."""
    now = time.time()
    timestamps = [t for t in _rate_limit_store.get(key, []) if now - t < window]
    if len(timestamps) >= max_requests:
        _rate_limit_store[key] = timestamps
        return False
    timestamps.append(now)
    _rate_limit_store[key] = timestamps
    return True


def evict_stale_rate_limits(window: float = 60.0) -> None:
    """Убирает ключи, по которым за окно не было ни одного запроса.

    Без этого словарь хранит по записи на каждый когда-либо виденный IP.
    """
    now = time.time()
    for key in [k for k, ts in _rate_limit_store.items() if all(now - t >= window for t in ts)]:
        del _rate_limit_store[key]


# ========== USERNAME VALIDATION ==========
# \w покрывает буквы любого алфавита и цифры; дополнительно разрешены пробел,
# дефис и точка. Всё остальное (< > " ' & перевод строки) отсекается, потому что
# имя попадает в HTML и в JS-контекст на фронте.
USERNAME_RE = re.compile(r"[\w \-.]{1,32}", re.UNICODE)
USERNAME_ERROR = "Username must be 1-32 characters: letters, digits, spaces, - . _"


def validate_username(raw: str) -> str | None:
    """Нормализует имя участника. Возвращает None, если имя недопустимо."""
    name = (raw or "").strip()
    if not USERNAME_RE.fullmatch(name):
        return None
    return name


# ========== SCALE POINT VALIDATION ==========
# Значение точки шкалы — короткая метка (1, 13, XS, ❔, ☕), и она попадает
# в HTML на фронте. Разрешаем буквы любого алфавита, цифры и пунктуацию из
# существующих шкал; < > " ' & ` и пустые значения отсекаются.
SCALE_POINT_RE = re.compile(r"[\w.,:;!?+\-*/½∞❔☕ ]{1,8}", re.UNICODE)
SCALE_POINT_ERROR = "Each point must be 1-8 characters: letters, digits, and . , : ; ! ? + - * / ½ ∞ ❔ ☕"


def validate_scale_point(raw: str) -> str | None:
    """Нормализует значение точки шкалы. Возвращает None, если оно недопустимо."""
    point = (raw or "").strip()
    if not point or not SCALE_POINT_RE.fullmatch(point):
        return None
    return point


def game_to_web_response(game: Game, session_id: str) -> dict:
    votes = []
    for user_id, vote in game.votes.items():
        payload = {
            "user_id": user_id,
            "username": user_id.replace("web_", "") if user_id.startswith("web_") else user_id,
            "point": vote.point if game.revealed else vote.masked,
            "version": vote.version,
        }
        # Реальное значение голоса отдаём только после вскрытия карт —
        # иначе анонимность ломается через DevTools.
        if game.revealed:
            payload["real_point"] = vote.point
        votes.append(payload)
    response = {
        "session_id": session_id,
        "text": game.text,
        "initiator": game.initiator.username or game.initiator.id,
        "initiator_name": game.initiator.first_name or "Unknown",
        "initiator_id": game.initiator.id,
        "revealed": game.revealed,
        "votes": votes,
        "vote_count": len(game.votes),
        "available_points": game.get_points(),
        "scale_name": game.scale_name,
        "scale_names": SCALE_NAMES,
        "auto_reveal": getattr(game, "auto_reveal", False),
    }
    # Среднее значение отдаём только после вскрытия карт,
    # чтобы не утекали данные через агрегат до вскрытия.
    if game.revealed:
        response["average"] = game._calc_average()
    return response


def enrich_session_response(game: Game, session_id: str) -> dict:
    data = game_to_web_response(game, session_id)

    canonical_votes = {v["user_id"]: v for v in data["votes"]}
    participants_dict = {}

    if session_id in manager.session_users:
        for username, user_data in manager.session_users[session_id].items():
            user_id = f"web_{username}"
            participants_dict[user_id] = {
                "user_id": user_id,
                "username": username,
                "online": True,
                "vote": canonical_votes.get(user_id),
            }

    for user_id, vote in canonical_votes.items():
        if user_id not in participants_dict:
            participants_dict[user_id] = {
                "user_id": user_id,
                "username": vote["username"],
                "online": False,
                "vote": vote,
            }

    data["participants"] = list(participants_dict.values())
    return data


async def web_index(request: Request):
    return state.templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "available_points": AVAILABLE_POINTS,
            "scale_names": SCALE_NAMES,
            "scales": SCALES,
        },
    )


async def api_create_session(request: Request):
    try:
        data = await request.json()
        username = validate_username(data.get("username", ""))
        text = data.get("text", "").strip()
        if not username:
            return JSONResponse({"error": USERNAME_ERROR}, status_code=400)
        if not text:
            return JSONResponse({"error": "Task description is required"}, status_code=400)

        # Rate limit
        client_ip = request.client.host if request.client else "unknown"
        if not _check_rate_limit(f"create_session:{client_ip}", max_requests=20, window=60):
            return JSONResponse({"error": "Too many requests. Please slow down."}, status_code=429)

        session_id = str(uuid.uuid4())[:8]
        initiator = Initiator.from_web(username)
        scale_name = data.get("scale_name", "").strip() or None
        auto_reveal = data.get("auto_reveal", False)  # Новая настройка

        # Load initiator's saved custom scale if available
        custom_points = None
        if scale_name == "custom":
            custom_points = await state.storage.get_custom_scale(f"web_{username}")

        game = state.storage.new_game(
            WEB_CHAT_ID, session_id, initiator, text, scale_name=scale_name, custom_points=custom_points
        )
        game.auto_reveal = auto_reveal
        await state.storage.save_game(game)

        manager.register_user(session_id, username)
        return JSONResponse({"session_id": session_id, **enrich_session_response(game, session_id)})
    except Exception as e:
        logger.error(f"Error creating session: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


async def api_set_scale(request: Request):
    session_id = request.path_params["session_id"]
    try:
        data = await request.json()
        scale_name = data.get("scale_name", "").strip()
        username = data.get("username", "").strip()
        if not scale_name:
            return JSONResponse({"error": "scale_name is required"}, status_code=400)
        if not username:
            return JSONResponse({"error": "username is required"}, status_code=400)

        game = await state.storage.get_game(WEB_CHAT_ID, session_id)
        if not game:
            return JSONResponse({"error": "Session not found"}, status_code=404)

        # Только инициатор может менять шкалу
        if f"web_{username}" != game.initiator.id:
            return JSONResponse({"error": "Only initiator can change scale"}, status_code=403)

        game.scale_name = scale_name if scale_name in SCALES else DEFAULT_SCALE
        # Голоса по старой шкале в новой могут отсутствовать — сбрасываем,
        # иначе среднее считается по значениям, которые нельзя переголосовать.
        game.restart()
        await state.storage.save_game(game)
        manager.reset_session_users(session_id)
        await manager.broadcast(session_id, {"type": "update", "data": enrich_session_response(game, session_id)})
        return JSONResponse(enrich_session_response(game, session_id))
    except Exception as e:
        logger.error(f"Error setting scale: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


async def api_set_auto_reveal(request: Request):
    """API для включения/выключения автооткрытия во время сессии"""
    session_id = request.path_params["session_id"]
    try:
        data = await request.json()
        auto_reveal = data.get("auto_reveal", False)
        username = data.get("username", "").strip()

        if not username:
            return JSONResponse({"error": "username is required"}, status_code=400)

        game = await state.storage.get_game(WEB_CHAT_ID, session_id)
        if not game:
            return JSONResponse({"error": "Session not found"}, status_code=404)

        # Только инициатор может менять auto-reveal
        if f"web_{username}" != game.initiator.id:
            return JSONResponse({"error": "Only initiator can change auto-reveal"}, status_code=403)

        game.auto_reveal = bool(auto_reveal)
        await state.storage.save_game(game)

        logger.info(f"Auto-reveal {'enabled' if auto_reveal else 'disabled'} for session {session_id}")

        await manager.broadcast(session_id, {"type": "update", "data": enrich_session_response(game, session_id)})
        return JSONResponse({"ok": True, "auto_reveal": auto_reveal})
    except Exception as e:
        logger.error(f"Error setting auto-reveal: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


async def api_get_session(request: Request):
    game = await state.storage.get_game(WEB_CHAT_ID, request.path_params["session_id"])
    if not game:
        return JSONResponse({"error": "Session not found"}, status_code=404)
    return JSONResponse(enrich_session_response(game, request.path_params["session_id"]))


async def process_web_vote(session_id: str, game, username: str, point: str):
    """Process a vote from a web user and broadcast the update.

    Note: point validation must be done by the caller before calling this function.
    """
    user_id = f"web_{username}"
    vote_data = {"user_id": user_id, "username": username, "point": point, "version": 0}
    game.add_vote({"id": user_id, "first_name": username, "username": username}, point)
    await state.storage.save_game(game)
    manager.update_user_vote(session_id, username, vote_data)
    updated_data = enrich_session_response(game, session_id)
    await manager.broadcast(session_id, {"type": "update", "data": updated_data})
    # Проверяем условие автооткрытия (если все проголосовали и auto_reveal включён)
    from websocket_handler import check_auto_reveal

    await check_auto_reveal(session_id, game)
    return updated_data


async def api_vote(request: Request):
    session_id = request.path_params["session_id"]
    try:
        data = await request.json()
        username = validate_username(data.get("username", ""))
        point = data.get("point", "").strip()
        if not username:
            return JSONResponse({"error": USERNAME_ERROR}, status_code=400)
        if not point:
            return JSONResponse({"error": "Username and point are required"}, status_code=400)

        # Rate limit
        client_ip = request.client.host if request.client else "unknown"
        if not _check_rate_limit(f"vote:{client_ip}", max_requests=30, window=60):
            return JSONResponse({"error": "Too many requests. Please slow down."}, status_code=429)

        game = await state.storage.get_game(WEB_CHAT_ID, session_id)
        if not game:
            return JSONResponse({"error": "Session not found"}, status_code=404)

        if game.revealed:
            return JSONResponse({"error": "Session is already revealed"}, status_code=400)

        if point not in game.get_points():
            return JSONResponse(
                {"error": f"Point '{point}' is not in the current scale ({game.scale_name})"}, status_code=400
            )

        updated_data = await process_web_vote(session_id, game, username, point)
        return JSONResponse(updated_data)
    except Exception as e:
        logger.error(f"Error voting: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


async def api_restart(request: Request):
    session_id = request.path_params["session_id"]
    try:
        data = await request.json()
        username = validate_username(data.get("username", ""))
        new_text = data.get("new_text", "").strip()
        if not username:
            return JSONResponse({"error": USERNAME_ERROR}, status_code=400)
        game = await state.storage.get_game(WEB_CHAT_ID, session_id)
        if not game:
            return JSONResponse({"error": "Session not found"}, status_code=404)
        if f"web_{username}" != game.initiator.id:
            return JSONResponse({"error": "Only initiator can restart"}, status_code=403)

        if new_text:
            game.text = new_text
        game.restart()
        await state.storage.save_game(game)

        manager.reset_session_users(session_id)
        await manager.broadcast(session_id, {"type": "update", "data": enrich_session_response(game, session_id)})
        return JSONResponse(enrich_session_response(game, session_id))
    except Exception as e:
        logger.error(f"Error restarting: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


async def api_reveal(request: Request):
    session_id = request.path_params["session_id"]
    try:
        data = await request.json()
        username = validate_username(data.get("username", ""))
        if not username:
            return JSONResponse({"error": USERNAME_ERROR}, status_code=400)
        game = await state.storage.get_game(WEB_CHAT_ID, session_id)
        if not game:
            return JSONResponse({"error": "Session not found"}, status_code=404)
        if f"web_{username}" != game.initiator.id:
            return JSONResponse({"error": "Only initiator can reveal cards"}, status_code=403)

        game.revealed = True
        await state.storage.save_game(game)
        await manager.broadcast(session_id, {"type": "update", "data": enrich_session_response(game, session_id)})
        return JSONResponse(enrich_session_response(game, session_id))
    except Exception as e:
        logger.error(f"Error revealing: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


async def api_kick_user(request: Request):
    session_id = request.path_params["session_id"]
    try:
        data = await request.json()
        username = validate_username(data.get("username", ""))
        target_username = validate_username(data.get("target_username", ""))
        if not username or not target_username:
            return JSONResponse({"error": USERNAME_ERROR}, status_code=400)

        game = await state.storage.get_game(WEB_CHAT_ID, session_id)
        if not game:
            return JSONResponse({"error": "Session not found"}, status_code=404)

        if f"web_{username}" != game.initiator.id:
            return JSONResponse({"error": "Only initiator can kick users"}, status_code=403)

        if target_username == username:
            return JSONResponse({"error": "Cannot kick yourself"}, status_code=400)

        # Send "kicked" message if they have active WS
        kicked_ws = manager.get_ws_by_username(session_id, target_username)
        if kicked_ws:
            with suppress(Exception):
                await kicked_ws.send_json({"type": "kicked", "message": f"Вы были исключены инициатором {username}"})

        if not manager.kick_user(session_id, target_username):
            return JSONResponse({"error": "User not found in session"}, status_code=404)

        # Close the kicked user's WebSocket
        if kicked_ws:
            with suppress(Exception):
                await kicked_ws.close(1000)
        # Also remove from active_connections
        if session_id in manager.active_connections and kicked_ws in manager.active_connections[session_id]:
            manager.active_connections[session_id].remove(kicked_ws)
            if not manager.active_connections[session_id]:
                del manager.active_connections[session_id]

        await manager.broadcast(
            session_id,
            {
                "type": "user_kicked",
                "username": target_username,
                "data": enrich_session_response(game, session_id),
            },
        )

        logger.info(f"User {target_username} kicked from session {session_id} by {username}")
        return JSONResponse({"ok": True})
    except Exception as e:
        logger.error(f"Error kicking user: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


async def api_get_custom_scale(request: Request):
    username = request.query_params.get("username", "").strip()
    if not username:
        return JSONResponse({"error": "username is required"}, status_code=400)
    points = await state.storage.get_custom_scale(f"web_{username}")
    return JSONResponse({"points": points or []})


async def api_save_custom_scale(request: Request):
    try:
        data = await request.json()
        username = data.get("username", "").strip()
        points = data.get("points", [])
        if not username:
            return JSONResponse({"error": "username is required"}, status_code=400)
        if not isinstance(points, list) or not all(isinstance(p, str) for p in points):
            return JSONResponse({"error": "points must be a list of strings"}, status_code=400)

        # Точка шкалы становится допустимым голосом и рендерится в HTML у всех
        # участников, поэтому содержимое ограничиваем белым списком.
        cleaned = []
        for raw_point in points:
            point = validate_scale_point(raw_point)
            if point is None:
                return JSONResponse({"error": SCALE_POINT_ERROR}, status_code=400)
            cleaned.append(point)

        if len(cleaned) < 8:
            return JSONResponse(
                {"error": "At least 8 points are required (standard scales have 8-12 points)"}, status_code=400
            )
        if len(cleaned) != len(set(cleaned)):
            return JSONResponse({"error": "Duplicate points are not allowed"}, status_code=400)

        await state.storage.save_custom_scale(f"web_{username}", cleaned)
        return JSONResponse({"ok": True, "points": cleaned})
    except Exception as e:
        logger.error(f"Error saving custom scale: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


async def api_list_sessions(request: Request):
    try:
        # Пагинация: ?limit=20&offset=0
        try:
            limit = min(int(request.query_params.get("limit", 20)), 100)
            offset = max(int(request.query_params.get("offset", 0)), 0)
        except (ValueError, TypeError):
            limit, offset = 20, 0

        sessions_raw = await state.storage.list_all_sessions(WEB_CHAT_ID, limit=limit, offset=offset)
        total = await state.storage.count_sessions(WEB_CHAT_ID)
        sessions = [enrich_session_response(game, game_id) for game_id, game in sessions_raw]
        return JSONResponse({"sessions": sessions, "total": total, "limit": limit, "offset": offset})
    except Exception as e:
        logger.error(f"Error listing sessions: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


async def health(_):
    from starlette.responses import PlainTextResponse

    # Проверяем что БД жива
    try:
        await state.storage.count_sessions(WEB_CHAT_ID)
    except Exception as e:
        logger.error(f"Healthcheck failed: {e}")
        return PlainTextResponse("DB ERROR", status_code=503)

    return PlainTextResponse("OK")


async def info(_):
    return JSONResponse(
        {"status": "running", "service": "planning-poker-bot", "features": ["telegram", "web", "websocket"]}
    )


async def download_extension(request: Request):
    from starlette.responses import FileResponse, HTMLResponse

    # Проверяем параметр ?download=html — показать страницу с инструкциями
    download_param = request.query_params.get("download", "")

    # Если ?download=html — показываем страницу с инструкциями для браузера
    if download_param == "html":
        user_agent = request.headers.get("user-agent", "").lower()

        is_firefox = "firefox" in user_agent
        is_edge = "edg" in user_agent

        # Показываем страницу с инструкцией для конкретного браузера
        if is_firefox:
            instruction_file = "browser-extension/firefox-instruction.html"
        elif is_edge:
            instruction_file = "browser-extension/edge-instruction.html"
        else:  # Chrome или другой Chromium
            instruction_file = "browser-extension/chrome-instruction.html"

        try:
            with open(instruction_file, encoding="utf-8") as f:
                content = f.read()
            return HTMLResponse(content)
        except FileNotFoundError:
            return HTMLResponse("<h1>Файл инструкции не найден</h1>")

    # Прямая загрузка ZIP — детект браузера по User-Agent
    user_agent = request.headers.get("user-agent", "").lower()

    if "firefox" in user_agent:
        zip_path = "browser-extension/pp-jira-bridge-firefox.zip"
    elif "edg" in user_agent:
        zip_path = "browser-extension/pp-jira-bridge-chrome.zip"
    else:
        # Chrome, Chromium, Safari, Opera, etc.
        zip_path = "browser-extension/pp-jira-bridge-chrome.zip"

    return FileResponse(zip_path, media_type="application/zip", filename="pp-jira-bridge.zip")
