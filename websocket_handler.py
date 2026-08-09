import json
from contextlib import suppress

from starlette.websockets import WebSocket, WebSocketDisconnect

import state
from config import WEB_CHAT_ID, logger
from connection import manager
from ppbot.game import SCALES, Initiator
from web_api import enrich_session_response, process_web_vote, validate_username


async def check_auto_reveal(session_id: str, game):
    """Проверяет условие автооткрытия результатов при полном наборе голосов"""
    if game.revealed:
        return

    # Проверяем включено ли автооткрытие
    if not getattr(game, "auto_reveal", False):
        return

    # Перепроверяем из БД — могло уже открыться в другом запросе
    fresh_game = await state.storage.get_game(WEB_CHAT_ID, session_id)
    if fresh_game is None or fresh_game.revealed:
        return
    game.revealed = fresh_game.revealed  # синхронизируем

    # Получаем участников сессии
    participants = manager.session_users.get(session_id, {})
    if not participants:
        return

    # Проверяем голоса из game.votes, а не статус из session_users
    # Это надежнее, т.к. game.votes гарантированно синхронизирован с БД
    voted_count = len(game.votes)
    total_count = len(participants)

    if voted_count > 0 and voted_count == total_count:
        game.revealed = True
        await state.storage.save_game(game)
        logger.info(f"Auto-reveal: все {total_count} участников проголосовали в сессии {session_id}")

        # Отправляем обновление всем
        await manager.broadcast(session_id, {"type": "update", "data": enrich_session_response(game, session_id)})


async def transfer_initiator_if_needed(session_id: str, leaving_username: str):
    game = await state.storage.get_game(WEB_CHAT_ID, session_id)
    if not game:
        logger.warning(f"transfer_initiator: game not found for session {session_id}")
        return

    leaving_id = f"web_{leaving_username}"
    if game.initiator.id != leaving_id:
        logger.info("transfer_initiator: %s was not the initiator", leaving_username)
        return

    # Проверяем что в сессии есть другие участники
    if session_id not in manager.session_users or not manager.session_users[session_id]:
        logger.info(
            "transfer_initiator: no participants in session, keeping %s as initiator",
            leaving_username,
        )
        return

    participants = manager.session_users[session_id]

    # Если в сессии только инициатор — не передаём
    if len(participants) == 1 and leaving_username in participants:
        logger.info(
            "transfer_initiator: only initiator in session, keeping %s as initiator",
            leaving_username,
        )
        return

    # Проверяем остались ли активные участники (с активным WS подключением)
    active_participants = [u for u in participants if manager.is_ws_connected(session_id, u) and u != leaving_username]

    if not active_participants:
        logger.info(
            "transfer_initiator: no active participants left, keeping %s as initiator",
            leaving_username,
        )
        return

    new_initiator_username = active_participants[0]

    game.initiator = Initiator.from_web(new_initiator_username)
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
                    msg_type = msg.get("type")
                    if msg_type == "join":
                        username = validate_username(msg.get("username", ""))
                        if not username:
                            await websocket.send_json(
                                {"type": "error", "message": "Недопустимое имя участника"}
                            )
                        else:
                            is_new = manager.register_user(session_id, username)
                            manager.register_ws_connection(session_id, username, websocket)
                            if game:
                                # При reconnect отправляем текущее состояние
                                current_data = enrich_session_response(game, session_id)

                                if is_new:
                                    await manager.broadcast(
                                        session_id,
                                        {
                                            "type": "user_joined",
                                            "username": username,
                                            "data": current_data,
                                        },
                                    )
                                else:
                                    # Пользователь переподключился - просто обновляем его состояние
                                    await websocket.send_json({"type": "reconnected", "data": current_data})
                                    await manager.broadcast(
                                        session_id,
                                        {"type": "update", "data": current_data},
                                    )
                    elif msg_type == "set_scale":
                        scale_name = msg.get("scale_name", "")
                        setter_username = msg.get("username", "")
                        if game and scale_name in SCALES:
                            # Только инициатор может менять шкалу
                            if f"web_{setter_username}" != game.initiator.id:
                                logger.warning(f"User {setter_username} is not initiator, cannot change scale")
                                await websocket.send_json(
                                    {"type": "error", "message": "Только инициатор может менять шкалу"}
                                )
                            else:
                                game.scale_name = scale_name
                                await state.storage.save_game(game)
                                await manager.broadcast(
                                    session_id,
                                    {"type": "update", "data": enrich_session_response(game, session_id)},
                                )
                    elif msg_type == "kick_user":
                        target_username = msg.get("target_username", "")
                        kicker_username = msg.get("username", "")
                        if game and target_username and kicker_username:
                            if f"web_{kicker_username}" != game.initiator.id:
                                await websocket.send_json(
                                    {"type": "error", "message": "Только инициатор может исключать участников"}
                                )
                            elif target_username == kicker_username:
                                await websocket.send_json({"type": "error", "message": "Нельзя исключить себя"})
                            else:
                                # Send "kicked" message to the kicked user
                                kicked_ws = manager.get_ws_by_username(session_id, target_username)
                                if kicked_ws:
                                    with suppress(Exception):
                                        await kicked_ws.send_json(
                                            {
                                                "type": "kicked",
                                                "message": f"Вы были исключены инициатором {kicker_username}",
                                            }
                                        )

                                # kick_user сам чистит все трекеры
                                if manager.kick_user(session_id, target_username):
                                    if kicked_ws:
                                        with suppress(Exception):
                                            await kicked_ws.close(1000)

                                    updated_data = enrich_session_response(game, session_id)
                                    await manager.broadcast(
                                        session_id,
                                        {
                                            "type": "user_kicked",
                                            "username": target_username,
                                            "data": updated_data,
                                        },
                                    )
                    elif msg_type == "vote":
                        point = msg.get("point")
                        vote_username = msg.get("username")
                        if game and vote_username and point:
                            if point not in game.get_points():
                                err_msg = f"Point '{point}' is not in the current scale" f" ({game.scale_name})"
                                await websocket.send_json({"type": "error", "message": err_msg})
                            else:
                                await process_web_vote(session_id, game, vote_username, point)
                                await check_auto_reveal(session_id, game)
                except Exception as e:
                    logger.error(f"Error processing message: {e}")
                    pass
    except WebSocketDisconnect:
        manager.disconnect(session_id, websocket, username, game)
        if username:
            manager.unregister_ws_connection(session_id, username)
            await transfer_initiator_if_needed(session_id, username)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        manager.disconnect(session_id, websocket, username, game)
        if username:
            manager.unregister_ws_connection(session_id, username)
            await transfer_initiator_if_needed(session_id, username)
