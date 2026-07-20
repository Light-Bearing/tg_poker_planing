import collections
import json
from dataclasses import dataclass
from typing import Any, Final, Optional

import aiosqlite


@dataclass
class Initiator:
    """Represents a user who created a poker session (initiator).

    Stored as a dict in SQLite for backward compatibility.
    """

    id: str
    first_name: str
    username: str = ""

    @classmethod
    def from_telegram_user(cls, user: Any) -> "Initiator":
        return cls(id=str(user.id), first_name=user.first_name, username=getattr(user, "username", "") or "")

    @classmethod
    def from_web(cls, username: str) -> "Initiator":
        return cls(id=f"web_{username}", first_name=username, username=username)

    def to_dict(self) -> dict:
        return {"id": self.id, "first_name": self.first_name, "username": self.username}

    @classmethod
    def from_dict(cls, data: dict) -> "Initiator":
        return cls(id=str(data["id"]), first_name=data.get("first_name", ""), username=data.get("username", ""))


AVAILABLE_POINTS = [
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "11",
    "12",
    "14",
    "16",
    "18",
    "20",
    "28",
    "40",
    "❔",
    "☕",
]
HALF_POINTS = len(AVAILABLE_POINTS) // 2
ALL_MARKS = "♥♦♠♣"

# Standard scale presets
SCALES = {
    "custom": AVAILABLE_POINTS,
    "fibonacci": ["1", "2", "3", "5", "8", "13", "21", "34", "55", "89", "❔", "☕"],
    "powers_of_2": ["1", "2", "4", "8", "16", "32", "64", "❔", "☕"],
    "tshirt": ["XS", "S", "M", "L", "XL", "XXL", "❔", "☕"],
}
SCALE_NAMES = {
    "custom": "Custom",
    "fibonacci": "Fibonacci",
    "powers_of_2": "Powers of 2",
    "tshirt": "T-shirt",
}
DEFAULT_SCALE: Final = "custom"


class Vote:
    def __init__(self):
        self.point = ""
        self.version = -1

    def set(self, point):
        self.point = point
        self.version += 1

    @property
    def masked(self):
        return ALL_MARKS[self.version % len(ALL_MARKS)]

    def to_dict(self):
        return {
            "point": self.point,
            "version": self.version,
        }

    @classmethod
    def from_dict(cls, dct):
        res = cls()
        res.point = dct["point"]
        res.version = dct["version"]
        return res


class Game:
    OP_RESTART = "restart"
    OP_RESTART_NEW = "restart-new"
    OP_REVEAL = "reveal"
    OP_REVEAL_NEW = "reveal-new"

    def __init__(self, chat_id, vote_id, initiator, text, scale_name=None, custom_points=None, auto_reveal=False):
        self.chat_id = chat_id
        self.vote_id = vote_id
        # Normalize initiator to Initiator dataclass (accepts dict for backward compat)
        self.initiator = initiator if isinstance(initiator, Initiator) else Initiator.from_dict(initiator)
        self.text = text
        self.reply_message_id = 0
        self.votes = collections.defaultdict(Vote)
        self.revealed = False
        self.scale_name = scale_name if scale_name in SCALES else DEFAULT_SCALE
        self.custom_points = custom_points or []
        self.auto_reveal = auto_reveal  # Автооткрытие при полном наборе голосов
        # Внутренний кэш для среднего значения (пересчитывается при to_dict)
        self._average_cache = None

    def add_vote(self, initiator: dict, point: str):
        user_id = str(initiator.get("id") or initiator.get("user_id") or "")
        if not user_id:
            user_id = self._initiator_str(initiator)
        self.votes[user_id].set(point)
        self._invalidate_cache()

    def _invalidate_cache(self):
        """Сброс кэша среднего значения при изменении голосов."""
        self._average_cache = None

    def get_points(self):
        """Return the point scale used by this game."""
        if self.scale_name == "custom" and self.custom_points:
            return self.custom_points
        return SCALES.get(self.scale_name, AVAILABLE_POINTS)

    @staticmethod
    def _sort_key(user_id: str) -> tuple:
        """Ключ сортировки: числовые ключи сортируются как числа, остальные — строки."""
        try:
            return (0, int(user_id))
        except ValueError:
            return (1, user_id.lower())

    def get_text(self):
        result = "{} for:\n{}\nInitiator: {}\nScale: {}".format(
            "Vote" if not self.revealed else "Results",
            self.text,
            f"@{self.initiator.username} ({self.initiator.first_name})",
            SCALE_NAMES.get(self.scale_name, self.scale_name),
        )
        if self.votes:
            votes_str = "\n".join(
                f"{vote.point if self.revealed else vote.masked:3s} {user_id}"
                for user_id, vote in sorted(self.votes.items(), key=lambda x: self._sort_key(x[0]))
            )
            result += f"\n\nCurrent votes:\n{votes_str}"
        return result

    def get_markup(self):
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup

        points = self.get_points()
        half = len(points) // 2

        # Создаем кнопки для оценок
        points_keys = []
        for point in points:
            points_keys.append(InlineKeyboardButton(text=point, callback_data=f"vote-click-{self.vote_id}-{point}"))

        # Создаем кнопки управления
        scale_name = SCALE_NAMES.get(self.scale_name, self.scale_name)
        control_buttons = [
            [
                InlineKeyboardButton(text=f"📐 {scale_name}", callback_data=f"scale-cycle-{self.vote_id}"),
            ],
            [
                InlineKeyboardButton(text="Restart", callback_data=f"{self.OP_RESTART}-click-{self.vote_id}"),
                InlineKeyboardButton(text="Restart 🆕", callback_data=f"{self.OP_RESTART_NEW}-click-{self.vote_id}"),
            ],
            [
                InlineKeyboardButton(text="Open Cards", callback_data=f"{self.OP_REVEAL}-click-{self.vote_id}"),
                InlineKeyboardButton(text="Open Cards 🆕", callback_data=f"{self.OP_REVEAL_NEW}-click-{self.vote_id}"),
            ],
        ]

        # Разделяем кнопки оценок на две строки (или одну, если мало)
        point_rows = [points_keys[i : i + half] for i in range(0, len(points), half)]
        keyboard = [*point_rows, *control_buttons]

        return InlineKeyboardMarkup(keyboard)

    def restart(self):
        self.votes.clear()
        self.revealed = False
        self._invalidate_cache()

    @staticmethod
    def _initiator_str(initiator: "Initiator | dict") -> str:
        """Format a user (Initiator or dict) as a readable string."""
        if isinstance(initiator, Initiator):
            return f"@{initiator.username or initiator.id} ({initiator.first_name})"
        return "@{} ({})".format(initiator.get("username") or initiator.get("id"), initiator.get("first_name", ""))

    def _calc_average(self) -> float:
        """Расчёт среднего арифметического числовых голосов с кэшированием."""
        if self._average_cache is not None:
            return self._average_cache

        numeric_votes = []
        for vote in self.votes.values():
            try:
                if vote.point not in ("❔", "☕"):
                    numeric_votes.append(float(vote.point))
            except ValueError:
                continue

        self._average_cache = sum(numeric_votes) / len(numeric_votes) if numeric_votes else 0.0
        return self._average_cache

    def to_dict(self):
        data = {
            "initiator": self.initiator.to_dict(),
            "text": self.text,
            "reply_message_id": self.reply_message_id,
            "revealed": self.revealed,
            "scale_name": self.scale_name,
            "custom_points": self.custom_points,
            "auto_reveal": self.auto_reveal,
            "votes": {user_id: vote.to_dict() for user_id, vote in self.votes.items()},
            "average": self._calc_average(),
        }

        return data

    @classmethod
    def from_dict(cls, chat_id, vote_id, dct):
        res = cls(
            chat_id,
            vote_id,
            Initiator.from_dict(dct["initiator"]),
            dct["text"],
            scale_name=dct.get("scale_name"),
            custom_points=dct.get("custom_points", []),
            auto_reveal=dct.get("auto_reveal", False),
        )
        for user_id, vote in dct["votes"].items():
            res.votes[user_id] = Vote.from_dict(vote)
        res.revealed = dct["revealed"]
        res.reply_message_id = dct["reply_message_id"]
        return res


class GameRegistry:
    def __init__(self):
        self._db = None

    async def init_db(self, db_path):
        self._db = await aiosqlite.connect(db_path)
        # Enable WAL mode for concurrent read/write performance
        await self._db.execute("PRAGMA journal_mode=WAL")
        await self._db.execute("PRAGMA busy_timeout=5000")
        await self._db.execute("""
            CREATE TABLE IF NOT EXISTS games (
                chat_id, game_id,
                json_data,
                PRIMARY KEY (chat_id, game_id)
            )
        """)
        await self._db.execute("""
            CREATE TABLE IF NOT EXISTS custom_scales (
                initiator_key TEXT PRIMARY KEY,
                points TEXT NOT NULL
            )
        """)
        await self._db.commit()

    def new_game(self, chat_id, incoming_message_id, initiator, text, scale_name=None, custom_points=None):
        return Game(chat_id, incoming_message_id, initiator, text, scale_name=scale_name, custom_points=custom_points)

    async def get_game(self, chat_id, incoming_message_id: str) -> Optional["Game"]:
        query = "SELECT json_data FROM games WHERE chat_id = ? AND game_id = ?"
        async with self._db.execute(query, (chat_id, incoming_message_id)) as cursor:
            res = await cursor.fetchone()
            if not res:
                return None
            return Game.from_dict(chat_id, incoming_message_id, json.loads(res[0]))

    async def save_game(self, game: Game):
        """Сохраняет игру. WAL + busy_timeout=5000 защищают от race condition."""
        await self._db.execute(
            "INSERT OR REPLACE INTO games VALUES (?, ?, ?)",
            (game.chat_id, game.vote_id, json.dumps(game.to_dict())),
        )
        await self._db.commit()

    async def save_custom_scale(self, initiator_key: str, points: list[str]):
        await self._db.execute(
            "INSERT OR REPLACE INTO custom_scales VALUES (?, ?)", (initiator_key, json.dumps(points))
        )
        await self._db.commit()

    async def list_all_sessions(self, chat_id: str, limit: int = 50, offset: int = 0) -> list[tuple[str, Game]]:
        """Возвращает список (game_id, Game) для указанного chat_id с пагинацией."""
        async with self._db.execute(
            "SELECT game_id, json_data FROM games WHERE chat_id = ? ORDER BY rowid DESC LIMIT ? OFFSET ?",
            (chat_id, limit, offset),
        ) as cursor:
            rows = await cursor.fetchall()
            return [(row[0], Game.from_dict(chat_id, row[0], json.loads(row[1]))) for row in rows]

    async def count_sessions(self, chat_id: str) -> int:
        """Возвращает количество сессий для указанного chat_id."""
        async with self._db.execute("SELECT COUNT(*) FROM games WHERE chat_id = ?", (chat_id,)) as cursor:
            row = await cursor.fetchone()
            return row[0] if row else 0

    async def get_custom_scale(self, initiator_key: str) -> list[str] | None:
        async with self._db.execute(
            "SELECT points FROM custom_scales WHERE initiator_key = ?", (initiator_key,)
        ) as cursor:
            row = await cursor.fetchone()
            if row:
                return json.loads(row[0])
            return None

    async def close(self):
        if self._db is not None:
            await self._db.close()
            self._db = None
