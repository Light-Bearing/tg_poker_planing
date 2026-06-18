import collections
import json

import aiosqlite

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
DEFAULT_SCALE = "custom"


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
        self.initiator = initiator
        self.text = text
        self.reply_message_id = 0
        self.votes = collections.defaultdict(Vote)
        self.revealed = False
        self.scale_name = scale_name if scale_name in SCALES else DEFAULT_SCALE
        self.custom_points = custom_points or []
        self.auto_reveal = auto_reveal  # Автооткрытие при полном наборе голосов

    def add_vote(self, initiator, point):
        user_id = initiator.get("id") or initiator.get("user_id")
        if not user_id:
            user_id = self._initiator_str(initiator)
        self.votes[str(user_id)].set(point)

    def get_points(self):
        """Return the point scale used by this game."""
        if self.scale_name == "custom" and self.custom_points:
            return self.custom_points
        return SCALES.get(self.scale_name, AVAILABLE_POINTS)

    def get_text(self):
        result = "{} for:\n{}\nInitiator: {}\nScale: {}".format(
            "Vote" if not self.revealed else "Results",
            self.text,
            self._initiator_str(self.initiator),
            SCALE_NAMES.get(self.scale_name, self.scale_name),
        )
        if self.votes:
            votes_str = "\n".join(
                "{:3s} {}".format(vote.point if self.revealed else vote.masked, user_id)
                for user_id, vote in sorted(self.votes.items())
            )
            result += "\n\nCurrent votes:\n{}".format(votes_str)
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

    @staticmethod
    def _initiator_str(initiator: dict) -> str:
        return "@{} ({})".format(initiator.get("username") or initiator.get("id"), initiator["first_name"])

    def to_dict(self):
        data = {
            "initiator": self.initiator,
            "text": self.text,
            "reply_message_id": self.reply_message_id,
            "revealed": self.revealed,
            "scale_name": self.scale_name,
            "custom_points": self.custom_points,
            "votes": {user_id: vote.to_dict() for user_id, vote in self.votes.items()},
        }

        # Корректный расчет среднего
        numeric_votes = []
        for vote in self.votes.values():
            try:
                if vote.point not in ("❔", "☕"):
                    numeric_votes.append(float(vote.point))
            except ValueError:
                continue

        if numeric_votes:
            data["average"] = sum(numeric_votes) / len(numeric_votes)
        else:
            data["average"] = 0

        return data

    @classmethod
    def from_dict(cls, chat_id, vote_id, dct):
        res = cls(
            chat_id,
            vote_id,
            dct["initiator"],
            dct["text"],
            scale_name=dct.get("scale_name"),
            custom_points=dct.get("custom_points", []),
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

    async def get_game(self, chat_id, incoming_message_id: str) -> Game:
        query = "SELECT json_data FROM games WHERE chat_id = ? AND game_id = ?"
        async with self._db.execute(query, (chat_id, incoming_message_id)) as cursor:
            res = await cursor.fetchone()
            if not res:
                return None
            return Game.from_dict(chat_id, incoming_message_id, json.loads(res[0]))

    async def save_game(self, game: Game):
        await self._db.execute(
            "INSERT OR REPLACE INTO games VALUES (?, ?, ?)", (game.chat_id, game.vote_id, json.dumps(game.to_dict()))
        )
        await self._db.commit()

    async def save_custom_scale(self, initiator_key: str, points: list[str]):
        await self._db.execute(
            "INSERT OR REPLACE INTO custom_scales VALUES (?, ?)", (initiator_key, json.dumps(points))
        )
        await self._db.commit()

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
