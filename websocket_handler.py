import json

from starlette.websockets import WebSocket, WebSocketDisconnect

import state
from config import WEB_CHAT_ID, logger
from connection import manager
from web_api import enrich_session_response


async def transfer_initiator_if_needed(session_id: str, leaving_username: str):
    game = await state.storage.get_game(WEB_CHAT_ID, session_id)
    if not game:
        logger.warning(f"transfer_initiator: game not found for session {session_id}")
        return

    leaving_id = f"web_{leaving_username}"
    if game.initiator.get("id") != leaving_id:
        logger.info("transfer_initiator: %s was not the initiator", leaving_username)
        return

    if session_id not in manager.session_users or not manager.session_users[session_id]:
        logger.info(
            "transfer_initiator: no other participants, keeping %s as initiator in DB for session %s",
            leaving_username,
            session_id,
        )
        return

    new_initiator_username = next(iter(manager.session_users[session_id].keys()), None)
    if not new_initiator_username:
        return

    game.initiator = {
        "id": f"web_{new_initiator_username}",
        "first_name": new_initiator_username,
        "username": new_initiator_username,
    }
    await state.storage.save_game(game)
    logger.info(
        "Initiator role transferred: %s → %s in session %s",
        leaving_username,
        new_initiator_username,
        session_id,
    )

    await manager.broadcast(session_id, {"type": "update", "data": enrich_session_response(game, session_id)})


async def websocket_endpoint(websocket: WebSocket):
    session_id = websocket.path_params["session_id"]
    username = None
    await manager.connect(session_id, websocket)
    try:
        game = await state.storage.get_game(WEB_CHAT_ID, session_id)
        if game:
            await websocket.send_json({"type": "init", "data": enrich_session_response(game, session_id)})

        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
            else:
                try:
                    msg = json.loads(data)
                    if msg.get("type") == "join":
                        username = msg.get("username")
                        if username:
                            is_new = manager.register_user(session_id, username)
                            if game:
                                if is_new:
                                    await manager.broadcast(
                                        session_id,
                                        {
                                            "type": "user_joined",
                                            "username": username,
                                            "data": enrich_session_response(game, session_id),
                                        },
                                    )
                                else:
                                    await manager.broadcast(
                                        session_id,
                                        {"type": "update", "data": enrich_session_response(game, session_id)},
                                    )
                except Exception:
                    pass
    except WebSocketDisconnect:
        manager.disconnect(session_id, websocket, username, game)
        if username:
            await transfer_initiator_if_needed(session_id, username)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        manager.disconnect(session_id, websocket, username, game)
        if username:
            await transfer_initiator_if_needed(session_id, username)
