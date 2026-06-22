import json
import uuid

from starlette.requests import Request
from starlette.responses import JSONResponse

import state
from config import WEB_CHAT_ID, logger
from connection import manager
from ppbot.game import AVAILABLE_POINTS, DEFAULT_SCALE, SCALE_NAMES, SCALES, Game


def game_to_web_response(game: Game, session_id: str) -> dict:
    votes = []
    for user_id, vote in game.votes.items():
        votes.append(
            {
                "user_id": user_id,
                "username": user_id.replace("web_", "") if user_id.startswith("web_") else user_id,
                "point": vote.point if game.revealed else vote.masked,
                "real_point": vote.point,
                "version": vote.version,
            }
        )
    return {
        "session_id": session_id,
        "text": game.text,
        "initiator": game.initiator.get("username") or str(game.initiator.get("id")),
        "initiator_name": game.initiator.get("first_name", "Unknown"),
        "initiator_id": game.initiator.get("id"),
        "revealed": game.revealed,
        "votes": votes,
        "vote_count": len(game.votes),
        "average": game.to_dict().get("average", 0),
        "available_points": game.get_points(),
        "scale_name": game.scale_name,
        "scale_names": SCALE_NAMES,
        "auto_reveal": getattr(game, "auto_reveal", False),
    }


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
        username, text = data.get("username", "").strip(), data.get("text", "").strip()
        if not username:
            return JSONResponse({"error": "Username is required"}, status_code=400)
        if not text:
            return JSONResponse({"error": "Task description is required"}, status_code=400)

        session_id = str(uuid.uuid4())[:8]
        initiator = {"id": f"web_{username}", "first_name": username, "username": username}
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
        if f"web_{username}" != game.initiator.get("id"):
            return JSONResponse({"error": "Only initiator can change scale"}, status_code=403)

        game.scale_name = scale_name if scale_name in SCALES else DEFAULT_SCALE
        await state.storage.save_game(game)
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

        game = await state.storage.get_game(WEB_CHAT_ID, session_id)
        if not game:
            return JSONResponse({"error": "Session not found"}, status_code=404)

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

    Returns the enriched session data dict.
    """
    user_id = f"web_{username}"
    vote_data = {"user_id": user_id, "username": username, "point": point, "real_point": point, "version": 0}
    game.add_vote({"id": user_id, "first_name": username, "username": username}, point)
    await state.storage.save_game(game)
    manager.update_user_vote(session_id, username, vote_data)
    updated_data = enrich_session_response(game, session_id)
    await manager.broadcast(session_id, {"type": "update", "data": updated_data})
    return updated_data


async def api_vote(request: Request):
    session_id = request.path_params["session_id"]
    try:
        data = await request.json()
        username, point = data.get("username", "").strip(), data.get("point", "").strip()
        if not username or not point:
            return JSONResponse({"error": "Username and point are required"}, status_code=400)

        game = await state.storage.get_game(WEB_CHAT_ID, session_id)
        if not game:
            return JSONResponse({"error": "Session not found"}, status_code=404)
        if game.revealed:
            return JSONResponse({"error": "Session is already revealed"}, status_code=400)

        updated_data = await process_web_vote(session_id, game, username, point)
        return JSONResponse(updated_data)
    except Exception as e:
        logger.error(f"Error voting: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


async def api_restart(request: Request):
    session_id = request.path_params["session_id"]
    try:
        data = await request.json()
        username, new_text = data.get("username", "").strip(), data.get("new_text", "").strip()
        game = await state.storage.get_game(WEB_CHAT_ID, session_id)
        if not game:
            return JSONResponse({"error": "Session not found"}, status_code=404)
        if f"web_{username}" != game.initiator["id"]:
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
        username = data.get("username", "").strip()
        game = await state.storage.get_game(WEB_CHAT_ID, session_id)
        if not game:
            return JSONResponse({"error": "Session not found"}, status_code=404)
        if f"web_{username}" != game.initiator["id"]:
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
        username = data.get("username", "").strip()
        target_username = data.get("target_username", "").strip()
        if not username or not target_username:
            return JSONResponse({"error": "username and target_username are required"}, status_code=400)

        game = await state.storage.get_game(WEB_CHAT_ID, session_id)
        if not game:
            return JSONResponse({"error": "Session not found"}, status_code=404)

        if f"web_{username}" != game.initiator.get("id"):
            return JSONResponse({"error": "Only initiator can kick users"}, status_code=403)

        if target_username == username:
            return JSONResponse({"error": "Cannot kick yourself"}, status_code=400)

        # Send "kicked" message if they have active WS
        kicked_ws = manager.get_ws_by_username(session_id, target_username)
        if kicked_ws:
            try:
                await kicked_ws.send_json({"type": "kicked", "message": f"Вы были исключены инициатором {username}"})
            except Exception:
                pass

        if not manager.kick_user(session_id, target_username):
            return JSONResponse({"error": "User not found in session"}, status_code=404)

        # Close the kicked user's WebSocket
        if kicked_ws:
            try:
                await kicked_ws.close(1000)
            except Exception:
                pass
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
        if len(points) < 2:
            return JSONResponse({"error": "At least 2 points are required"}, status_code=400)

        await state.storage.save_custom_scale(f"web_{username}", points)
        return JSONResponse({"ok": True, "points": points})
    except Exception as e:
        logger.error(f"Error saving custom scale: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


async def api_list_sessions(request: Request):
    try:
        async with state.storage._db.execute(
            "SELECT game_id, json_data FROM games WHERE chat_id = ?", (WEB_CHAT_ID,)
        ) as cursor:
            rows = await cursor.fetchall()
            sessions = [
                enrich_session_response(Game.from_dict(WEB_CHAT_ID, row[0], json.loads(row[1])), row[0]) for row in rows
            ]
            return JSONResponse({"sessions": sessions})
    except Exception as e:
        logger.error(f"Error listing sessions: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


async def health(_):
    from starlette.responses import PlainTextResponse

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
        from starlette.responses import HTMLResponse

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
            with open(instruction_file, "r", encoding="utf-8") as f:
                content = f.read()
            return HTMLResponse(content)
        except FileNotFoundError:
            return HTMLResponse("<h1>Файл инструкции не найден</h1>")

    # Если ?download=true или просто клик с атрибутом download — прямая загрузка ZIP
    # Скачиваем универсальный архив со всеми файлами и инструкциями
    zip_path = "browser-extension/pp-jira-bridge-all.zip"
    return FileResponse(zip_path, media_type="application/zip", filename="pp-jira-bridge.zip")
