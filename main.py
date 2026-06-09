import asyncio
import os
import logging
import uuid
import json
import uvicorn
import threading

try:
    from dotenv import load_dotenv
    load_dotenv()
    print("✅ Loaded environment variables from .env file")
except ImportError:
    print("⚠️  python-dotenv not installed")

from starlette.applications import Starlette
from starlette.responses import Response, PlainTextResponse, JSONResponse, HTMLResponse
from starlette.requests import Request
from starlette.routing import Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.templating import Jinja2Templates
from starlette.websockets import WebSocket, WebSocketDisconnect
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from telegram import Update
from telegram.ext import Application, ContextTypes, CommandHandler, CallbackQueryHandler, MessageHandler, filters

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN") or os.environ.get("PP_BOT_TOKEN")
URL = os.environ.get("RENDER_EXTERNAL_URL") or os.environ.get("WEBHOOK_URL")
PORT = int(os.getenv("PORT", 8000))
DB_PATH = os.getenv("PP_BOT_DB_PATH", "/tmp/tg_pp_bot.db")
PROXY_URL = os.environ.get("PROXY_URL")

if not TOKEN:
    raise ValueError("\n" + "="*70 + "\n❌ TELEGRAM BOT TOKEN NOT FOUND!\n" + "="*70 + "\nPlease set PP_BOT_TOKEN environment variable.\n" + "="*70)

print(f"✅ Bot token loaded: {TOKEN[:10]}...{TOKEN[-5:]}")
print(f"📁 Database path: {DB_PATH}")
print(f"🌐 Web server port: {PORT}")
if PROXY_URL: print(f"🔒 Proxy configured: {PROXY_URL}")
else: print("⚠️  No proxy configured")

logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)
logger = logging.getLogger(__name__)

from ppbot.game import GameRegistry, Game, AVAILABLE_POINTS

storage = GameRegistry()
GREETING = """
Use /poker task url or description to start game.
Multiline is also supported:
/poker line1
line2
Available scales: 1,2,3,5,8,13,20,40,❔,☕
"""

class ConnectionManager:
    def __init__(self):
        self.active_connections: dict[str, list[WebSocket]] = {}
        self.session_users: dict[str, dict[str, dict]] = {}

    async def connect(self, session_id: str, websocket: WebSocket):
        await websocket.accept()
        if session_id not in self.active_connections:
            self.active_connections[session_id] = []
            self.session_users[session_id] = {}
        self.active_connections[session_id].append(websocket)

    def disconnect(self, session_id: str, websocket: WebSocket, username: str = None):
        if session_id in self.active_connections:
            if websocket in self.active_connections[session_id]:
                self.active_connections[session_id].remove(websocket)
            if not self.active_connections[session_id]:
                del self.active_connections[session_id]
                if session_id in self.session_users: del self.session_users[session_id]
            elif username and session_id in self.session_users:
                if username in self.session_users[session_id]:
                    del self.session_users[session_id][username]
                    asyncio.create_task(self.broadcast(session_id, {"type": "update", "data": self._get_enriched_data(session_id)}))

    async def broadcast(self, session_id: str, message: dict):
        if session_id in self.active_connections:
            disconnected = []
            for connection in self.active_connections[session_id]:
                try: await connection.send_json(message)
                except Exception: disconnected.append(connection)
            for conn in disconnected: self.disconnect(session_id, conn)

    def register_user(self, session_id: str, username: str):
        if session_id not in self.session_users: self.session_users[session_id] = {}
        if username not in self.session_users[session_id]:
            self.session_users[session_id][username] = {'status': 'pending', 'vote': None}

    def update_user_vote(self, session_id: str, username: str, vote_data: dict):
        if session_id in self.session_users and username in self.session_users[session_id]:
            self.session_users[session_id][username]['status'] = 'voted'
            self.session_users[session_id][username]['vote'] = vote_data

    def reset_session_users(self, session_id: str):
        if session_id in self.session_users:
            for username in self.session_users[session_id]:
                self.session_users[session_id][username] = {'status': 'pending', 'vote': None}

    def _get_enriched_data(self, session_id: str):
        pass

manager = ConnectionManager()
templates = Jinja2Templates(directory="web/templates")
WEB_CHAT_ID = "web"

# ==================== TELEGRAM HANDLERS ====================
async def init_bot(): await storage.init_db(DB_PATH)

async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(GREETING)

async def poker_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        chat_id = update.effective_chat.id
        message_id = str(update.message.message_id)
        initiator = {"id": update.effective_user.id, "first_name": update.effective_user.first_name, "username": update.effective_user.username}
        text = " ".join(context.args) if context.args else "No description provided"
        if not text.strip(): text = update.message.text.split('\n', 1)[1] if '\n' in update.message.text else "No description provided"
        
        game = storage.new_game(chat_id, message_id, initiator, text)
        message = await update.message.reply_text(game.get_text(), reply_markup=game.get_markup())
        game.reply_message_id = message.message_id
        await storage.save_game(game)
    except Exception as e:
        logger.error(f"Error in poker_command: {e}")
        await update.message.reply_text("Error creating game.")

async def russian_poker_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    return await poker_command(update, context)

async def callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    try:
        data = query.data
        chat_id = query.message.chat_id
        if data.startswith("vote-click-"):
            await handle_vote_click(query, data, chat_id)
        elif any(data.startswith(op + "-click-") for op in [Game.OP_REVEAL, Game.OP_RESTART, Game.OP_RESTART_NEW, Game.OP_REVEAL_NEW]):
            await handle_operation_click(query, data, chat_id)
    except Exception as e:
        logger.error(f"Error in callback_handler: {e}")
        await query.answer("Error processing request", show_alert=True)

async def handle_vote_click(query, data, chat_id):
    parts = data.split("-")
    vote_id, point = parts[2], parts[3]
    game = await storage.get_game(chat_id, vote_id)
    if not game: return await query.edit_message_text("Game not found or expired")
    if game.revealed: return await query.answer("Can't change vote after cards are opened", show_alert=True)
    
    voter = {"id": query.from_user.id, "first_name": query.from_user.first_name, "username": query.from_user.username}
    game.add_vote(voter, point)
    await storage.save_game(game)
    try:
        await query.edit_message_text(game.get_text(), reply_markup=game.get_markup())
    except Exception as e:
        if "message is not modified" not in str(e).lower(): raise e

async def handle_operation_click(query, data, chat_id):
    parts = data.split("-")
    operation, vote_id = parts[0], parts[2]
    game = await storage.get_game(chat_id, vote_id)
    if not game: return await query.answer("Game not found", show_alert=True)
    if query.from_user.id != game.initiator["id"]: return await query.answer(f"{operation} is available only for initiator", show_alert=True)
    
    if operation in (Game.OP_RESTART, Game.OP_RESTART_NEW): game.restart()
    else: game.revealed = True
    
    try:
        if operation in (Game.OP_RESTART, Game.OP_REVEAL):
            await query.edit_message_text(game.get_text(), reply_markup=game.get_markup())
        else:
            await query.edit_message_text(game.get_text())
            new_message = await query.message.reply_text(game.get_text(), reply_markup=game.get_markup())
            game.reply_message_id = new_message.message_id
        await storage.save_game(game)
    except Exception as e:
        if "message is not modified" in str(e).lower(): await query.answer("No changes to apply")
        else: raise e

# ==================== WEB HELPERS ====================
def game_to_web_response(game: Game, session_id: str) -> dict:
    votes = []
    for user_id, vote in game.votes.items():
        votes.append({
            "user_id": user_id,
            "username": user_id.replace("web_", "") if user_id.startswith("web_") else user_id,
            "point": vote.point if game.revealed else vote.masked,
            "real_point": vote.point,
            "version": vote.version
        })
    return {
        "session_id": session_id, "text": game.text,
        "initiator": game.initiator.get("username") or str(game.initiator.get("id")),
        "initiator_name": game.initiator.get("first_name", "Unknown"),
        "initiator_id": game.initiator.get("id"),  # ✅ НОВОЕ: id для динамического определения
        "revealed": game.revealed, "votes": votes, "vote_count": len(game.votes),
        "average": game.to_dict().get("average", 0), "available_points": AVAILABLE_POINTS
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
                "vote": canonical_votes.get(user_id)
            }

    for user_id, vote in canonical_votes.items():
        if user_id not in participants_dict:
            participants_dict[user_id] = {
                "user_id": user_id,
                "username": vote["username"],
                "online": False,
                "vote": vote
            }

    data['participants'] = list(participants_dict.values())
    return data

# ==================== INITIATOR TRANSFER ====================
async def transfer_initiator_if_needed(session_id: str, leaving_username: str):
    """Передаёт роль инициатора следующему участнику, если ушедший был инициатором"""
    game = await storage.get_game(WEB_CHAT_ID, session_id)
    if not game:
        return
    
    leaving_id = f"web_{leaving_username}"
    if game.initiator.get("id") != leaving_id:
        return  # Ушёл не инициатор
    
    # Ищем следующего онлайн-участника
    if session_id not in manager.session_users or not manager.session_users[session_id]:
        logger.info(f"No other participants in session {session_id}, initiator role lost")
        return
    
    # Берём первого доступного (в реальности - старшего по времени подключения)
    new_initiator_username = next(iter(manager.session_users[session_id].keys()), None)
    if not new_initiator_username:
        return
    
    # Назначаем нового инициатора
    game.initiator = {
        "id": f"web_{new_initiator_username}",
        "first_name": new_initiator_username,
        "username": new_initiator_username
    }
    await storage.save_game(game)
    logger.info(f"👑 Initiator role transferred from {leaving_username} to {new_initiator_username} in session {session_id}")
    
    # Рассылаем обновления всем, чтобы новый инициатор увидел кнопки управления
    await manager.broadcast(session_id, {"type": "update", "data": enrich_session_response(game, session_id)})

# ==================== WEB API HANDLERS ====================
async def web_index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request, "available_points": AVAILABLE_POINTS})

async def api_create_session(request: Request):
    try:
        data = await request.json()
        username, text = data.get("username", "").strip(), data.get("text", "").strip()
        if not username: return JSONResponse({"error": "Username is required"}, status_code=400)
        if not text: return JSONResponse({"error": "Task description is required"}, status_code=400)
        
        session_id = str(uuid.uuid4())[:8]
        initiator = {"id": f"web_{username}", "first_name": username, "username": username}
        game = storage.new_game(WEB_CHAT_ID, session_id, initiator, text)
        await storage.save_game(game)
        
        manager.register_user(session_id, username)
        return JSONResponse({"session_id": session_id, **enrich_session_response(game, session_id)})
    except Exception as e:
        logger.error(f"Error creating session: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)

async def api_get_session(request: Request):
    game = await storage.get_game(WEB_CHAT_ID, request.path_params["session_id"])
    if not game: return JSONResponse({"error": "Session not found"}, status_code=404)
    return JSONResponse(enrich_session_response(game, request.path_params["session_id"]))

async def api_vote(request: Request):
    session_id = request.path_params["session_id"]
    try:
        data = await request.json()
        username, point = data.get("username", "").strip(), data.get("point", "").strip()
        if not username or not point: return JSONResponse({"error": "Username and point are required"}, status_code=400)
        
        game = await storage.get_game(WEB_CHAT_ID, session_id)
        if not game: return JSONResponse({"error": "Session not found"}, status_code=404)
        if game.revealed: return JSONResponse({"error": "Session is already revealed"}, status_code=400)
        
        user_id = f"web_{username}"
        vote_data = {"user_id": user_id, "username": username, "point": point, "real_point": point, "version": 0}
        game.add_vote({"id": user_id, "first_name": username, "username": username}, point)
        await storage.save_game(game)
        
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
        game = await storage.get_game(WEB_CHAT_ID, session_id)
        if not game: return JSONResponse({"error": "Session not found"}, status_code=404)
        # ✅ ИЗМЕНЕНО: Проверяем актуального инициатора из БД, а не предполагаем
        if f"web_{username}" != game.initiator["id"]: 
            return JSONResponse({"error": "Only initiator can restart"}, status_code=403)
        
        if new_text: game.text = new_text
        game.restart()
        await storage.save_game(game)
        
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
        game = await storage.get_game(WEB_CHAT_ID, session_id)
        if not game: return JSONResponse({"error": "Session not found"}, status_code=404)
        # ✅ ИЗМЕНЕНО: Проверяем актуального инициатора из БД
        if f"web_{username}" != game.initiator["id"]: 
            return JSONResponse({"error": "Only initiator can reveal cards"}, status_code=403)
        
        game.revealed = True
        await storage.save_game(game)
        await manager.broadcast(session_id, {"type": "update", "data": enrich_session_response(game, session_id)})
        return JSONResponse(enrich_session_response(game, session_id))
    except Exception as e:
        logger.error(f"Error revealing: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)

async def api_list_sessions(request: Request):
    try:
        async with storage._db.execute("SELECT game_id, json_data FROM games WHERE chat_id = ?", (WEB_CHAT_ID,)) as cursor:
            rows = await cursor.fetchall()
            sessions = [enrich_session_response(Game.from_dict(WEB_CHAT_ID, row[0], json.loads(row[1])), row[0]) for row in rows]
            return JSONResponse({"sessions": sessions})
    except Exception as e:
        logger.error(f"Error listing sessions: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)

async def websocket_endpoint(websocket: WebSocket):
    session_id = websocket.path_params["session_id"]
    username = None
    await manager.connect(session_id, websocket)
    try:
        game = await storage.get_game(WEB_CHAT_ID, session_id)
        if game: await websocket.send_json({"type": "init", "data": enrich_session_response(game, session_id)})
        
        while True:
            data = await websocket.receive_text()
            if data == "ping": await websocket.send_text("pong")
            else:
                try:
                    msg = json.loads(data)
                    if msg.get("type") == "join":
                        username = msg.get("username")
                        if username:
                            manager.register_user(session_id, username)
                            if game: await manager.broadcast(session_id, {"type": "update", "data": enrich_session_response(game, session_id)})
                except: pass
    except WebSocketDisconnect:
        manager.disconnect(session_id, websocket, username)
        # ✅ НОВОЕ: Передаём роль инициатора, если ушёл инициатор
        if username:
            await transfer_initiator_if_needed(session_id, username)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        manager.disconnect(session_id, websocket, username)
        if username:
            await transfer_initiator_if_needed(session_id, username)

async def health(_): return PlainTextResponse("OK")
async def info(_): return JSONResponse({"status": "running", "service": "planning-poker-bot", "features": ["telegram", "web", "websocket"]})

async def telegram_webhook(request: Request):
    try:
        data = await request.json()
        app = request.app.state.telegram_app
        if app is None: return Response(status_code=503)
        await app.process_update(Update.de_json(data, app.bot))
        return Response()
    except Exception as e:
        logger.error(f"Error processing update: {e}")
        return Response(status_code=500)

# ==================== NETWORK & MAIN ====================
async def check_proxy_connection(proxy_url: str) -> bool:
    try:
        protocol, rest = (proxy_url.split("://", 1) if "://" in proxy_url else ("socks5", proxy_url))
        host_port = rest.split("@", 1)[1] if "@" in rest else rest
        host, port = (host_port.rsplit(":", 1) if ":" in host_port else (host_port, 1080 if protocol == "socks5" else 8080))
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, int(port)), timeout=5.0)
        writer.close(); await writer.wait_closed()
        return True
    except Exception: return False

async def check_telegram_direct() -> bool:
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection("api.telegram.org", 443), timeout=5.0)
        writer.close(); await writer.wait_closed()
        return True
    except Exception: return False

def create_telegram_app(use_proxy: bool):
    if use_proxy and PROXY_URL:
        from telegram.request import HTTPXRequest
        app = Application.builder().token(TOKEN).request(HTTPXRequest(proxy=PROXY_URL)).get_updates_request(HTTPXRequest(proxy=PROXY_URL)).updater(None).build()
    else:
        app = Application.builder().token(TOKEN).updater(None).build()
    app.add_handler(CommandHandler(["start", "help"], start_command))
    app.add_handler(CommandHandler(["poker", "p"], poker_command))
    app.add_handler(MessageHandler(filters.Regex(r"^(/покер|/п|/зщлук|/з)"), russian_poker_command))
    app.add_handler(CallbackQueryHandler(callback_handler))
    return app

def run_telegram_bot_thread(use_proxy: bool):
    try:
        app = create_telegram_app(use_proxy)
        print("🤖 Starting Telegram bot polling in separate thread...")
        app.run_polling(allowed_updates=Update.ALL_TYPES, drop_pending_updates=True, close_loop=True)
    except Exception as e: print(f"❌ Telegram bot thread error: {e}")

async def main():
    print("\n" + "="*70 + "\nNETWORK DIAGNOSTICS\n" + "="*70)
    direct_available = await check_telegram_direct()
    use_proxy = False
    if PROXY_URL:
        if await check_proxy_connection(PROXY_URL): use_proxy = True
        elif direct_available: print("✅ Will use direct connection")
        else: print("❌ Neither proxy nor direct connection available!"); return
    print("="*70 + "\n")
    
    await init_bot()
    routes = [
        Route("/", web_index, methods=["GET"]), Route("/web", web_index, methods=["GET"]),
        Route("/api/sessions", api_create_session, methods=["POST"]), Route("/api/sessions", api_list_sessions, methods=["GET"]),
        Route("/api/sessions/{session_id}", api_get_session, methods=["GET"]), Route("/api/sessions/{session_id}/vote", api_vote, methods=["POST"]),
        Route("/api/sessions/{session_id}/restart", api_restart, methods=["POST"]), Route("/api/sessions/{session_id}/reveal", api_reveal, methods=["POST"]),
        Route("/healthcheck", health, methods=["GET"]), Route("/info", info, methods=["GET"]),
        Route("/telegram", telegram_webhook, methods=["POST"]), WebSocketRoute("/ws/{session_id}", websocket_endpoint),
    ]
    starlette_app = Starlette(routes=routes, middleware=[Middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])])
    
    is_webhook_mode = URL and URL != "https://your-domain.com"
    if is_webhook_mode:
        print("🌐 Starting in WEBHOOK mode...")
        telegram_app = create_telegram_app(use_proxy)
        await telegram_app.initialize(); await telegram_app.start()
        await telegram_app.bot.set_webhook(f"{URL}/telegram", allowed_updates=Update.ALL_TYPES, drop_pending_updates=True)
        starlette_app.state.telegram_app = telegram_app
    else:
        print("🔄 Starting in POLLING mode (local development)...")
        starlette_app.state.telegram_app = None
        threading.Thread(target=run_telegram_bot_thread, args=(use_proxy,), daemon=True, name="TelegramBotThread").start()
        print("✅ Telegram bot thread started")
    
    if os.path.exists("web/static"): starlette_app.mount("/static", StaticFiles(directory="web/static"), name="static")
    
    config = uvicorn.Config(app=starlette_app, port=PORT, host="0.0.0.0", use_colors=False, log_level="info")
    server = uvicorn.Server(config)
    print("\n" + "="*70 + f"\n🚀 WEB SERVER STARTING ON http://0.0.0.0:{PORT}\n📱 Open in browser: http://localhost:{PORT}\n" + "="*70 + "\n")
    
    try: await server.serve()
    finally:
        if is_webhook_mode and starlette_app.state.telegram_app:
            await starlette_app.state.telegram_app.stop(); await starlette_app.state.telegram_app.shutdown()
        print("👋 Server stopped")

if __name__ == "__main__":
    asyncio.run(main())