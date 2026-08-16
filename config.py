import logging
import os

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover
    pass

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN") or os.environ.get("PP_BOT_TOKEN")
URL = os.environ.get("RENDER_EXTERNAL_URL") or os.environ.get("WEBHOOK_URL")
PORT = int(os.getenv("PORT", 8000))
DB_PATH = os.getenv("PP_BOT_DB_PATH", "/tmp/tg_pp_bot.db")
PROXY_URL = os.environ.get("PROXY_URL")
WEB_CHAT_ID = "web"
# По умолчанию — никаких чужих источников. Страница ходит к своему же серверу,
# и CORS ей не нужен вовсе; звёздочка же разрешала любому сайту дёргать наш API
# из браузера человека, которому достаточно было знать номер комнаты.
CORS_ORIGINS = [o for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
SESSION_CLEANUP_INTERVAL = float(os.getenv("SESSION_CLEANUP_INTERVAL", 600))
# Сколько веб-сессия живёт после ухода последнего участника, секунды
SESSION_TTL_SECONDS = float(os.getenv("SESSION_TTL_SECONDS", 300))

GREETING = """\
Use /poker task url or description to start game.
Multiline is also supported:
/poker line1
line2

Available scales: Fibonacci, Powers of 2, T-shirt, Custom
Use --scale name to choose: /poker task --scale fibonacci
"""

if not TOKEN:
    raise ValueError(
        "\n"
        + "=" * 70
        + "\n❌ TELEGRAM BOT TOKEN NOT FOUND!\n"
        + "=" * 70
        + "\nPlease set PP_BOT_TOKEN environment variable.\n"
        + "=" * 70
    )

logging.basicConfig(format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO)

# httpx на уровне INFO пишет каждый запрос целиком, а у Telegram токен лежит прямо
# в пути: .../bot<TOKEN>/getUpdates. При опросе это раз в несколько секунд кладёт
# рабочий токен в логи контейнера, доступные любому, кто дотянулся до сервера.
logging.getLogger("httpx").setLevel(logging.WARNING)

logger = logging.getLogger(__name__)
