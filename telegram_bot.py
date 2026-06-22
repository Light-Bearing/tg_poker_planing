from starlette.requests import Request
from starlette.responses import Response
from telegram import Update
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, ContextTypes, MessageHandler, filters

import state
from config import DB_PATH, GREETING, PROXY_URL, TOKEN, logger
from ppbot.game import DEFAULT_SCALE, SCALES, Game, Initiator


async def init_bot():
    await state.storage.init_db(DB_PATH)


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(GREETING)


def _parse_scale_from_args(args: list[str]) -> tuple[str, list[str]]:
    """Extract --scale NAME from args, return (scale_name, remaining_args)."""
    remaining = list(args)
    scale_name = DEFAULT_SCALE
    for i, arg in enumerate(remaining):
        if arg.startswith("--scale="):
            scale_name = arg.split("=", 1)[1]
            remaining.pop(i)
            break
        elif arg == "--scale" and i + 1 < len(remaining):
            scale_name = remaining[i + 1]
            remaining.pop(i)  # --scale
            remaining.pop(i)  # value
            break
    if scale_name not in SCALES:
        scale_name = DEFAULT_SCALE
    return scale_name, remaining


async def poker_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        chat_id = update.effective_chat.id
        message_id = str(update.message.message_id)
        initiator = Initiator.from_telegram_user(update.effective_user)
        raw_args = list(context.args or [])
        scale_name, text_args = _parse_scale_from_args(raw_args)
        text = " ".join(text_args) if text_args else "No description provided"
        if not text.strip():
            text = update.message.text.split("\n", 1)[1] if "\n" in update.message.text else "No description provided"

        game = state.storage.new_game(chat_id, message_id, initiator, text, scale_name=scale_name)
        message = await update.message.reply_text(game.get_text(), reply_markup=game.get_markup())
        game.reply_message_id = message.message_id
        await state.storage.save_game(game)
    except Exception as e:
        logger.error(f"Error in poker_command: {e}")
        await update.message.reply_text("Error creating game.")


async def russian_poker_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    return await poker_command(update, context)


async def handle_scale_click(query, data, chat_id):
    """Cycle the game's scale to the next preset."""
    vote_id = data.split("-", 2)[2] if data.count("-") >= 2 else data.removeprefix("scale-cycle-")
    game = await state.storage.get_game(chat_id, vote_id)
    if not game:
        return await query.answer("Game not found", show_alert=True)

    # Только инициатор может менять шкалу
    if str(query.from_user.id) != str(game.initiator.id):
        return await query.answer("Only initiator can change scale", show_alert=True)

    # Advance to the next scale in the list
    scale_keys = list(SCALES.keys())
    current_idx = scale_keys.index(game.scale_name) if game.scale_name in scale_keys else -1
    next_idx = (current_idx + 1) % len(scale_keys)
    game.scale_name = scale_keys[next_idx]

    # If switching to custom scale, load saved custom points
    if game.scale_name == "custom":
        initiator_key = game.initiator.id
        if initiator_key:
            saved_points = await state.storage.get_custom_scale(initiator_key)
            if saved_points:
                game.custom_points = saved_points
            else:
                game.custom_points = []

    try:
        await query.edit_message_text(game.get_text(), reply_markup=game.get_markup())
        await state.storage.save_game(game)
    except Exception as e:
        if "message is not modified" in str(e).lower():
            await query.answer("No changes to apply")
        else:
            raise e


async def callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    try:
        data = query.data
        chat_id = query.message.chat_id
        if data.startswith("vote-click-"):
            await handle_vote_click(query, data, chat_id)
        elif data.startswith("scale-cycle-"):
            await handle_scale_click(query, data, chat_id)
        elif any(
            data.startswith(op + "-click-")
            for op in [Game.OP_REVEAL, Game.OP_RESTART, Game.OP_RESTART_NEW, Game.OP_REVEAL_NEW]
        ):
            await handle_operation_click(query, data, chat_id)
    except Exception as e:
        logger.error(f"Error in callback_handler: {e}")
        await query.answer("Error processing request", show_alert=True)


async def handle_vote_click(query, data, chat_id):
    parts = data.split("-")
    vote_id, point = parts[2], parts[3]
    game = await state.storage.get_game(chat_id, vote_id)
    if not game:
        return await query.edit_message_text("Game not found or expired")
    if game.revealed:
        return await query.answer("Can't change vote after cards are opened", show_alert=True)

    voter = {"id": query.from_user.id, "first_name": query.from_user.first_name, "username": query.from_user.username}
    game.add_vote(voter, point)
    await state.storage.save_game(game)
    try:
        await query.edit_message_text(game.get_text(), reply_markup=game.get_markup())
    except Exception as e:
        if "message is not modified" not in str(e).lower():
            raise e


async def handle_operation_click(query, data, chat_id):
    parts = data.rsplit("-", 2)
    if len(parts) != 3 or parts[1] != "click":
        return
    operation, _, vote_id = parts
    game = await state.storage.get_game(chat_id, vote_id)
    if not game:
        return await query.answer("Game not found", show_alert=True)
    if str(query.from_user.id) != str(game.initiator.id):
        return await query.answer(f"{operation} is available only for initiator", show_alert=True)

    if operation in (Game.OP_RESTART, Game.OP_RESTART_NEW):
        game.restart()
    else:
        game.revealed = True

    try:
        if operation in (Game.OP_RESTART, Game.OP_REVEAL):
            await query.edit_message_text(game.get_text(), reply_markup=game.get_markup())
        else:
            await query.edit_message_text(game.get_text())
            new_message = await query.message.reply_text(game.get_text(), reply_markup=game.get_markup())
            game.reply_message_id = new_message.message_id
        await state.storage.save_game(game)
    except Exception as e:
        if "message is not modified" in str(e).lower():
            await query.answer("No changes to apply")
        else:
            raise e


def create_telegram_app(use_proxy: bool):
    if use_proxy and PROXY_URL:
        from telegram.request import HTTPXRequest

        app = (
            Application.builder()
            .token(TOKEN)
            .request(HTTPXRequest(proxy=PROXY_URL))
            .get_updates_request(HTTPXRequest(proxy=PROXY_URL))
            .updater(None)
            .build()
        )
    else:
        app = Application.builder().token(TOKEN).updater(None).build()
    app.add_handler(CommandHandler(["start", "help"], start_command))
    app.add_handler(CommandHandler(["poker", "p"], poker_command))
    app.add_handler(MessageHandler(filters.Regex(r"^(/покер|/п|/зщлук|/з)"), russian_poker_command))
    app.add_handler(CallbackQueryHandler(callback_handler))
    return app


async def telegram_webhook(request: Request):
    try:
        data = await request.json()
        app = request.app.state.telegram_app
        if app is None:
            return Response(status_code=503)
        await app.process_update(Update.de_json(data, app.bot))
        return Response()
    except Exception as e:
        logger.error(f"Error processing update: {e}")
        return Response(status_code=500)
