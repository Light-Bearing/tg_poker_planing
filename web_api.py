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

        # Load initiator's saved custom scale if available
        custom_points = None
        if scale_name == "custom":
            custom_points = await state.storage.get_custom_scale(f"web_{username}")

        game = state.storage.new_game(
            WEB_CHAT_ID, session_id, initiator, text, scale_name=scale_name, custom_points=custom_points
        )
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
        if not scale_name:
            return JSONResponse({"error": "scale_name is required"}, status_code=400)

        game = await state.storage.get_game(WEB_CHAT_ID, session_id)
        if not game:
            return JSONResponse({"error": "Session not found"}, status_code=404)

        game.scale_name = scale_name if scale_name in SCALES else DEFAULT_SCALE
        await state.storage.save_game(game)
        await manager.broadcast(session_id, {"type": "update", "data": enrich_session_response(game, session_id)})
        return JSONResponse(enrich_session_response(game, session_id))
    except Exception as e:
        logger.error(f"Error setting scale: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


async def api_get_session(request: Request):
    game = await state.storage.get_game(WEB_CHAT_ID, request.path_params["session_id"])
    if not game:
        return JSONResponse({"error": "Session not found"}, status_code=404)
    return JSONResponse(enrich_session_response(game, request.path_params["session_id"]))


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

        user_id = f"web_{username}"
        vote_data = {"user_id": user_id, "username": username, "point": point, "real_point": point, "version": 0}
        game.add_vote({"id": user_id, "first_name": username, "username": username}, point)
        await state.storage.save_game(game)

        manager.update_user_vote(session_id, username, vote_data)
        await manager.broadcast(session_id, {"type": "update", "data": enrich_session_response(game, session_id)})

        return JSONResponse(enrich_session_response(game, session_id))
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


async def download_extension(_):
    from starlette.responses import FileResponse

    zip_path = "browser-extension/pp-jira-bridge.zip"
    return FileResponse(zip_path, media_type="application/zip", filename="pp-jira-bridge.zip")
