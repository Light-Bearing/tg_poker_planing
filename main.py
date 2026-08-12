import asyncio
import threading

import uvicorn
from telegram import Update

from config import DB_PATH, PORT, PROXY_URL, TOKEN, URL
from telegram_bot import create_telegram_app


async def check_proxy_connection(proxy_url: str) -> bool:
    try:
        protocol, rest = proxy_url.split("://", 1) if "://" in proxy_url else ("socks5", proxy_url)
        host_port = rest.split("@", 1)[1] if "@" in rest else rest
        if ":" in host_port:
            host, port_str = host_port.rsplit(":", 1)
        else:
            host = host_port
            port_str = "1080" if protocol == "socks5" else "8080"
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, int(port_str)), timeout=5.0)
        writer.close()
        await writer.wait_closed()
        return True
    except Exception:
        return False


async def check_telegram_direct() -> bool:
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection("api.telegram.org", 443), timeout=5.0)
        writer.close()
        await writer.wait_closed()
        return True
    except Exception:
        return False


def run_telegram_bot_thread(app):
    try:
        print("🤖 Starting Telegram bot polling in separate thread...")
        # stop_signals=None обязателен: по умолчанию run_polling вешает обработчики
        # сигналов, а это умеет только главный поток — иначе ValueError и бот молча
        # не поднимается, пока веб-часть выглядит здоровой.
        app.run_polling(
            allowed_updates=Update.ALL_TYPES,
            drop_pending_updates=True,
            close_loop=True,
            stop_signals=None,
        )
    except Exception as e:
        print(f"❌ Telegram bot thread error: {e}")


async def main():
    # Куски токена в лог не печатаем: логи контейнера читает кто угодно с доступом
    # к серверу, а по началу видно ещё и идентификатор бота.
    print("✅ Bot token loaded")
    print(f"📁 Database path: {DB_PATH}")
    print(f"🌐 Web server port: {PORT}")
    if PROXY_URL:
        print(f"🔒 Proxy configured: {PROXY_URL}")
    else:
        print("⚠️  No proxy configured")

    print("\n" + "=" * 70 + "\nNETWORK DIAGNOSTICS\n" + "=" * 70)
    direct_available = await check_telegram_direct()
    use_proxy = False
    if PROXY_URL:
        if await check_proxy_connection(PROXY_URL):
            use_proxy = True
        elif direct_available:
            print("✅ Will use direct connection")
        else:
            print("❌ Neither proxy nor direct connection available!")
            return
    print("=" * 70 + "\n")

    from app import build_app

    starlette_app = await build_app()

    is_webhook_mode = URL and URL != "https://your-domain.com"
    if is_webhook_mode:
        print("🌐 Starting in WEBHOOK mode...")
        telegram_app = create_telegram_app(use_proxy, with_updater=False)
        await telegram_app.initialize()
        await telegram_app.start()
        await telegram_app.bot.set_webhook(
            f"{URL}/telegram", allowed_updates=Update.ALL_TYPES, drop_pending_updates=True
        )
        starlette_app.state.telegram_app = telegram_app
    else:
        print("🔄 Starting in POLLING mode...")
        telegram_app = create_telegram_app(use_proxy, with_updater=True)
        starlette_app.state.telegram_app = telegram_app
        threading.Thread(
            target=run_telegram_bot_thread, args=(telegram_app,), daemon=True, name="TelegramBotThread"
        ).start()
        print("✅ Telegram bot thread started")

    config = uvicorn.Config(app=starlette_app, port=PORT, host="0.0.0.0", use_colors=False, log_level="info")
    server = uvicorn.Server(config)
    print(
        "\n"
        + "=" * 70
        + f"\n🚀 WEB SERVER STARTING ON http://0.0.0.0:{PORT}\n📱 Open in browser: http://localhost:{PORT}\n"
        + "=" * 70
        + "\n"
    )

    try:
        await server.serve()
    finally:
        if starlette_app.state.telegram_app:
            await starlette_app.state.telegram_app.stop()
            await starlette_app.state.telegram_app.shutdown()
        print("👋 Server stopped")


if __name__ == "__main__":  # pragma: no cover
    asyncio.run(main())
