import asyncio
import os
import logging
import uvicorn
from starlette.applications import Starlette
from starlette.responses import Response, PlainTextResponse, JSONResponse
from starlette.requests import Request
from starlette.routing import Route
from telegram import Update
from telegram.ext import Application, ContextTypes, CommandHandler, CallbackQueryHandler
from telegram import InlineKeyboardButton, InlineKeyboardMarkup

# Конфигурация
TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
URL = os.environ.get("RENDER_EXTERNAL_URL") or os.environ.get("WEBHOOK_URL")
PORT = int(os.getenv("PORT", 8000))
DB_PATH = os.getenv("PP_BOT_DB_PATH", "/tmp/tg_pp_bot.db")

# Настройка логирования
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# Импорт нашей логики
from ppbot.game import GameRegistry, Game, AVAILABLE_POINTS

# Глобальные переменные
storage = GameRegistry()
GREETING = """
Use /poker task url or description to start game.

Multiline is also supported:
/poker line1
line2

Available scales: 1, 2, 3, 5, 8, 13, 20, 40, ❔, ☕
"""

async def init_bot():
    """Инициализация бота и базы данных"""
    await storage.init_db(DB_PATH)

async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик команды /start и /help"""
    await update.message.reply_text(GREETING)

async def poker_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик команды /poker"""
    try:
        chat_id = update.effective_chat.id
        message_id = str(update.message.message_id)
        initiator = {
            "id": update.effective_user.id,
            "first_name": update.effective_user.first_name,
            "username": update.effective_user.username
        }
        
        # Получаем текст задачи (может быть многострочным)
        text = " ".join(context.args) if context.args else "No description provided"
        if not text.strip():
            text = update.message.text.split('\n', 1)[1] if '\n' in update.message.text else "No description provided"
        
        # Создаем новую игру
        game = storage.new_game(chat_id, message_id, initiator, text)
        
        # Отправляем сообщение с кнопками
        message = await update.message.reply_text(
            game.get_text(),
            reply_markup=game.get_markup()
        )
        
        game.reply_message_id = message.message_id
        await storage.save_game(game)
        
    except Exception as e:
        logger.error(f"Error in poker_command: {e}")
        await update.message.reply_text("Error creating game. Please try again.")

async def callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    
    try:
        data = query.data
        chat_id = query.message.chat_id
        
        # Обработка голосования
        if data.startswith("vote-click-"):
            await handle_vote_click(query, data, chat_id)
            
        # Обработка операций
        elif any(data.startswith(op + "-click-") for op in [Game.OP_REVEAL, Game.OP_RESTART, Game.OP_RESTART_NEW, Game.OP_REVEAL_NEW]):
            await handle_operation_click(query, data, chat_id)
            
    except Exception as e:
        logger.error(f"Error in callback_handler: {e}")
        await query.answer("Error processing request", show_alert=True)

async def handle_vote_click(query, data, chat_id):
    """Обработчик кликов по кнопкам голосования"""
    parts = data.split("-")
    vote_id = parts[2]
    point = parts[3]
    
    game = await storage.get_game(chat_id, vote_id)
    if not game:
        await query.edit_message_text("Game not found or expired")
        return
        
    if game.revealed:
        await query.answer("Can't change vote after cards are opened", show_alert=True)
        return
    
    # Добавляем голос
    voter = {
        "id": query.from_user.id,
        "first_name": query.from_user.first_name,
        "username": query.from_user.username
    }
    game.add_vote(voter, point)
    await storage.save_game(game)
    
    # Обновляем сообщение с обработкой ошибки "не изменилось"
    try:
        await query.edit_message_text(
            game.get_text(),
            reply_markup=game.get_markup()
        )
    except Exception as e:
        if "message is not modified" in str(e).lower():
            # Игнорируем эту ошибку - это нормально
            pass
        else:
            raise e

async def handle_operation_click(query, data, chat_id):
    """Обработчик кликов по операциям (reveal/restart)"""
    parts = data.split("-")
    operation = parts[0]
    vote_id = parts[2]
    
    game = await storage.get_game(chat_id, vote_id)
    if not game:
        await query.answer("Game not found", show_alert=True)
        return
    
    # Проверяем права инициатора
    if query.from_user.id != game.initiator["id"]:
        await query.answer(f"{operation} is available only for initiator", show_alert=True)
        return
    
    # Выполняем операцию
    if operation in (Game.OP_RESTART, Game.OP_RESTART_NEW):
        game.restart()
    else:
        game.revealed = True
    
    # Обновляем сообщение с обработкой ошибки "не изменилось"
    try:
        if operation in (Game.OP_RESTART, Game.OP_REVEAL):
            await query.edit_message_text(
                game.get_text(),
                reply_markup=game.get_markup()
            )
        else:
            await query.edit_message_text(game.get_text())
            new_message = await query.message.reply_text(
                game.get_text(),
                reply_markup=game.get_markup()
            )
            game.reply_message_id = new_message.message_id
        
        await storage.save_game(game)
        
    except Exception as e:
        if "message is not modified" in str(e).lower():
            # Игнорируем ошибку "не изменилось"
            await query.answer("No changes to apply")
        else:
            raise e

from telegram.ext import MessageHandler, filters

# Добавьте после CommandHandler
async def russian_poker_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    return await poker_command(update, context)



async def main():
    """Основная функция инициализации"""
    # Инициализация бота
    app = Application.builder().token(TOKEN).updater(None).build()
    
    # Добавляем обработчики
    app.add_handler(CommandHandler(["start", "help"], start_command))
    app.add_handler(CommandHandler(["poker", "p"], poker_command))
    app.add_handler(MessageHandler(filters.Regex(r"^(/покер|/п)"), russian_poker_command))
    app.add_handler(CallbackQueryHandler(callback_handler))
    
    # Инициализируем базу данных
    await init_bot()
    
    # Устанавливаем вебхук
    if URL:
        webhook_url = f"{URL}/telegram"
        await app.bot.set_webhook(
            webhook_url,
            allowed_updates=Update.ALL_TYPES,
            drop_pending_updates=True
        )
        logger.info(f"Webhook set to: {webhook_url}")
    else:
        logger.warning("URL not set, webhook cannot be configured")
    
    # Обработчик для обновлений от Telegram
    async def telegram(request: Request):
        try:
            data = await request.json()
            update = Update.de_json(data, app.bot)
            await app.process_update(update)
            return Response()
        except Exception as e:
            logger.error(f"Error processing update: {e}")
            return Response(status_code=500)
    
    # Health check endpoint
    async def health(_):
        return PlainTextResponse("OK")
    
    # Info endpoint
    async def info(_):
        return JSONResponse({
            "status": "running",
            "service": "planning-poker-bot"
        })
    
    # Настройка веб-сервера
    starlette_app = Starlette(routes=[
        Route("/telegram", telegram, methods=["POST"]),
        Route("/healthcheck", health, methods=["GET"]),
        Route("/", info, methods=["GET"]),
    ])
    
    # Запуск сервера
    config = uvicorn.Config(
        app=starlette_app,
        port=PORT,
        host="0.0.0.0",
        use_colors=False,
        log_level="info"
    )
    
    server = uvicorn.Server(config)
    
    # Запускаем приложение
    await app.initialize()
    await app.start()
    await server.serve()
    await app.stop()
    await app.shutdown()

if __name__ == "__main__":
    asyncio.run(main())