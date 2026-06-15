import pytest

from ppbot.game import ALL_MARKS, AVAILABLE_POINTS, SCALES, Game, GameRegistry, Vote


class TestVote:
    def test_init(self):
        v = Vote()
        assert v.point == ""
        assert v.version == -1

    def test_set(self):
        v = Vote()
        v.set("5")
        assert v.point == "5"
        assert v.version == 0

    def test_set_increments_version(self):
        v = Vote()
        v.set("3")
        v.set("8")
        assert v.point == "8"
        assert v.version == 1

    def test_masked_cycles_through_marks(self):
        v = Vote()
        for i, mark in enumerate(ALL_MARKS):
            v.set(str(i))
            assert v.masked == mark

    def test_masked_repeats_after_four(self):
        v = Vote()
        for _ in range(4):
            v.set("1")
        # After 4 sets: version=3 → 3 % 4 = 3 → ♣
        assert v.masked == ALL_MARKS[3]
        v.set("2")
        # After 5 sets: version=4 → 4 % 4 = 0 → ♥
        assert v.masked == ALL_MARKS[0]

    def test_to_dict(self):
        v = Vote()
        v.set("13")
        d = v.to_dict()
        assert d == {"point": "13", "version": 0}

    def test_from_dict(self):
        d = {"point": "8", "version": 2}
        v = Vote.from_dict(d)
        assert v.point == "8"
        assert v.version == 2


class TestGame:
    def test_init(self, sample_initiator):
        game = Game(chat_id=-100, vote_id="abc", initiator=sample_initiator, text="my task")
        assert game.chat_id == -100
        assert game.vote_id == "abc"
        assert game.initiator == sample_initiator
        assert game.text == "my task"
        assert game.reply_message_id == 0
        assert game.revealed is False
        assert len(game.votes) == 0

    def test_add_vote_uses_id(self, sample_initiator, sample_game):
        sample_game.add_vote({"id": 999, "first_name": "Bob", "username": "bob"}, "5")
        assert "999" in sample_game.votes
        assert sample_game.votes["999"].point == "5"

    def test_add_vote_multiple_users(self, sample_game):
        sample_game.add_vote({"id": 1, "first_name": "A", "username": "a"}, "3")
        sample_game.add_vote({"id": 2, "first_name": "B", "username": "b"}, "5")
        assert len(sample_game.votes) == 3  # initiator + 2 new users

    def test_add_vote_overwrites(self, sample_game):
        sample_game.add_vote({"id": 1, "first_name": "A", "username": "a"}, "3")
        sample_game.add_vote({"id": 1, "first_name": "A", "username": "a"}, "8")
        assert len(sample_game.votes) == 2  # initiator + user 1
        assert sample_game.votes["1"].point == "8"
        assert sample_game.votes["1"].version == 1

    def test_default_scale_is_custom(self):
        game = Game(-100, "s1", {"id": 1}, "task")
        assert game.scale_name == "custom"
        assert game.get_points() == [
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

    def test_scale_fibonacci(self):
        game = Game(-100, "s1", {"id": 1}, "task", scale_name="fibonacci")
        assert game.scale_name == "fibonacci"
        assert "5" in game.get_points()
        assert "13" in game.get_points()
        assert "4" not in game.get_points()

    def test_scale_tshirt(self):
        game = Game(-100, "s1", {"id": 1}, "task", scale_name="tshirt")
        assert "XS" in game.get_points()
        assert "XXL" in game.get_points()

    def test_get_text_shows_scale(self):
        game = Game(-100, "s1", {"id": 1, "first_name": "A", "username": "a"}, "task", scale_name="fibonacci")
        text = game.get_text()
        assert "Scale: Fibonacci" in text

    def test_custom_points_returns_custom_list(self):
        game = Game(-100, "s1", {"id": 1}, "task", scale_name="custom", custom_points=["10", "20", "30", "❔", "☕"])
        assert game.get_points() == ["10", "20", "30", "❔", "☕"]

    def test_custom_points_empty_uses_default(self):
        game = Game(-100, "s1", {"id": 1}, "task", scale_name="custom", custom_points=[])
        assert game.get_points() == AVAILABLE_POINTS

    def test_custom_points_ignored_for_non_custom_scale(self):
        game = Game(-100, "s1", {"id": 1}, "task", scale_name="fibonacci", custom_points=["10", "20"])
        assert game.get_points() == SCALES["fibonacci"]

    def test_custom_points_in_to_dict(self, sample_initiator):
        game = Game(-100, "s1", sample_initiator, "task", scale_name="custom", custom_points=["X", "Y", "Z"])
        d = game.to_dict()
        assert d["custom_points"] == ["X", "Y", "Z"]

    def test_custom_points_restored_from_from_dict(self, sample_initiator):
        game = Game(-100, "s1", sample_initiator, "task", scale_name="custom", custom_points=["A", "B", "C"])
        d = game.to_dict()
        restored = Game.from_dict(-100, "s1", d)
        assert restored.custom_points == ["A", "B", "C"]
        assert restored.get_points() == ["A", "B", "C"]

    def test_scale_persists_in_to_dict(self, sample_initiator):
        game = Game(-100, "s1", sample_initiator, "task", scale_name="fibonacci")
        d = game.to_dict()
        assert d["scale_name"] == "fibonacci"

    def test_scale_restored_from_from_dict(self, sample_initiator):
        game = Game(-100, "s1", sample_initiator, "task", scale_name="powers_of_2")
        d = game.to_dict()
        restored = Game.from_dict(-100, "s1", d)
        assert restored.scale_name == "powers_of_2"

    def test_invalid_scale_falls_back_to_default(self):
        game = Game(-100, "s1", {"id": 1}, "task", scale_name="nonexistent")
        assert game.scale_name == "custom"

    def test_get_text_before_reveal(self, sample_game):
        text = sample_game.get_text()
        assert "Vote for:" in text
        assert "Test task description" in text
        assert "Alice" in text

    def test_get_text_after_reveal(self, sample_game):
        sample_game.add_vote({"id": 1, "first_name": "A", "username": "a"}, "5")
        sample_game.revealed = True
        text = sample_game.get_text()
        assert "Results for:" in text
        assert "5" in text  # revealed point visible

    def test_get_text_shows_masked_votes(self, sample_game):
        sample_game.add_vote({"id": 1, "first_name": "A", "username": "a"}, "5")
        text = sample_game.get_text()
        assert "Current votes:" in text
        assert ALL_MARKS[0] in text  # masked symbol

    def test_restart_clears_votes(self, sample_game):
        sample_game.add_vote({"id": 1, "first_name": "A", "username": "a"}, "5")
        sample_game.revealed = True
        sample_game.restart()
        assert len(sample_game.votes) == 0
        assert sample_game.revealed is False

    def test_to_dict_and_from_dict_roundtrip(self, sample_initiator):
        game = Game(chat_id=-100, vote_id="abc", initiator=sample_initiator, text="test")
        game.add_vote({"id": 1, "first_name": "A", "username": "a"}, "5")
        game.add_vote({"id": 2, "first_name": "B", "username": "b"}, "8")
        game.revealed = True
        game.reply_message_id = 42

        d = game.to_dict()
        restored = Game.from_dict(-100, "abc", d)

        assert restored.chat_id == -100
        assert restored.vote_id == "abc"
        assert restored.initiator == sample_initiator
        assert restored.text == "test"
        assert restored.revealed is True
        assert restored.reply_message_id == 42
        assert restored.votes["1"].point == "5"
        assert restored.votes["2"].point == "8"

    def test_average_calculation(self, sample_game):
        # sample_game has one vote of "3" from initiator
        sample_game.add_vote({"id": 1, "first_name": "A", "username": "a"}, "3")
        sample_game.add_vote({"id": 2, "first_name": "B", "username": "b"}, "5")
        sample_game.add_vote({"id": 3, "first_name": "C", "username": "c"}, "8")
        d = sample_game.to_dict()
        assert d["average"] == pytest.approx(4.75, rel=1e-3)  # (3+3+5+8) / 4

    def test_average_skips_non_numeric(self, sample_game):
        # sample_game has one vote of "3" from initiator
        sample_game.add_vote({"id": 1, "first_name": "A", "username": "a"}, "3")
        sample_game.add_vote({"id": 2, "first_name": "B", "username": "b"}, "☕")
        d = sample_game.to_dict()
        assert d["average"] == 3.0  # (3+3) / 2

    def test_average_all_non_numeric(self, sample_game):
        # sample_game has one vote of "3" from initiator - still numeric
        sample_game.add_vote({"id": 1, "first_name": "A", "username": "a"}, "❔")
        sample_game.add_vote({"id": 2, "first_name": "B", "username": "b"}, "☕")
        d = sample_game.to_dict()
        assert d["average"] == 3.0  # only initiator's "3" is numeric

    def test_get_markup_returns_inline_keyboard(self, sample_game):
        markup = sample_game.get_markup()
        from telegram import InlineKeyboardMarkup

        assert isinstance(markup, InlineKeyboardMarkup)

    def test_operations_constants(self):
        assert Game.OP_RESTART == "restart"
        assert Game.OP_RESTART_NEW == "restart-new"
        assert Game.OP_REVEAL == "reveal"
        assert Game.OP_REVEAL_NEW == "reveal-new"

    def test_add_vote_fallback_to_initiator_str(self, sample_game):
        sample_game.add_vote({"first_name": "Bob", "username": "bob"}, "5")
        expected_key = "@bob (Bob)"
        assert expected_key in sample_game.votes
        assert sample_game.votes[expected_key].point == "5"

    def test_add_vote_no_username_in_initiator_str(self, sample_game):
        sample_game.add_vote({"first_name": "Bob", "id": 999}, "5")
        assert "999" in sample_game.votes  # str(999), not @999 (Bob)

    def test_add_vote_fallback_no_id_no_username(self, sample_game):
        sample_game.add_vote({"first_name": "Bob", "user_id": 777}, "5")
        assert "777" in sample_game.votes

    def test_add_vote_unknown_user_fallback_str(self, sample_game):
        sample_game.add_vote({"first_name": "Bob"}, "5")
        expected_key = "@None (Bob)"
        assert expected_key in sample_game.votes

    def test_get_text_no_votes(self, sample_initiator):
        game = Game(chat_id=-100, vote_id="abc", initiator=sample_initiator, text="empty")
        text = game.get_text()
        assert "Vote for:" in text
        assert "Current votes:" not in text

    def test_get_text_empty_text(self, sample_initiator):
        game = Game(chat_id=-100, vote_id="abc", initiator=sample_initiator, text="")
        text = game.get_text()
        assert "Vote for:" in text

    def test_reply_message_id_default(self, sample_initiator):
        game = Game(chat_id=-100, vote_id="abc", initiator=sample_initiator, text="test")
        assert game.reply_message_id == 0

    def test_restart_without_votes(self, sample_game):
        sample_game.restart()
        assert len(sample_game.votes) == 0
        assert sample_game.revealed is False

    def test_average_empty_votes(self, sample_initiator):
        game = Game(chat_id=-100, vote_id="abc", initiator=sample_initiator, text="test")
        d = game.to_dict()
        assert d["average"] == 0

    def test_average_skips_unparseable_point(self, sample_game):
        sample_game.add_vote({"id": 1, "first_name": "A", "username": "a"}, "abc")
        d = sample_game.to_dict()
        assert d["average"] == 3.0  # only initiator's "3" is numeric

    def test_masked_property(self):
        v = Vote()
        expected = [ALL_MARKS[i % 4] for i in range(8)]
        actual = []
        for i in range(8):
            v.set(str(i))
            actual.append(v.masked)
        assert actual == expected


class TestGameRegistry:
    @pytest.fixture(autouse=True)
    async def _db_path(self, tmp_path):
        self.db_path = str(tmp_path / "test.db")
        self.registry = GameRegistry()
        yield
        await self.registry.close()

    @pytest.mark.asyncio
    async def test_new_game_creates_game(self, sample_initiator):
        await self.registry.init_db(self.db_path)
        game = self.registry.new_game(-100, "msg1", sample_initiator, "test task")
        assert isinstance(game, Game)
        assert game.chat_id == -100
        assert game.vote_id == "msg1"

    @pytest.mark.asyncio
    async def test_save_and_get_game(self, sample_initiator):
        await self.registry.init_db(self.db_path)
        game = self.registry.new_game(-100, "msg1", sample_initiator, "test task")
        game.add_vote({"id": 1, "first_name": "A", "username": "a"}, "5")
        await self.registry.save_game(game)

        loaded = await self.registry.get_game(-100, "msg1")
        assert loaded is not None
        assert loaded.chat_id == -100
        assert loaded.vote_id == "msg1"
        assert loaded.text == "test task"
        # JSON serialization converts int keys to strings
        assert loaded.votes["1"].point == "5"

    @pytest.mark.asyncio
    async def test_get_game_not_found(self):
        await self.registry.init_db(self.db_path)
        result = await self.registry.get_game(-100, "nonexistent")
        assert result is None

    @pytest.mark.asyncio
    async def test_save_overwrites(self, sample_initiator):
        await self.registry.init_db(self.db_path)
        game = self.registry.new_game(-100, "msg1", sample_initiator, "v1")
        await self.registry.save_game(game)

        game.text = "v2"
        await self.registry.save_game(game)

        loaded = await self.registry.get_game(-100, "msg1")
        assert loaded.text == "v2"

    @pytest.mark.asyncio
    async def test_multiple_games(self, sample_initiator):
        await self.registry.init_db(self.db_path)
        g1 = self.registry.new_game(-100, "msg1", sample_initiator, "task1")
        g2 = self.registry.new_game(-200, "msg2", sample_initiator, "task2")
        await self.registry.save_game(g1)
        await self.registry.save_game(g2)

        loaded1 = await self.registry.get_game(-100, "msg1")
        loaded2 = await self.registry.get_game(-200, "msg2")
        assert loaded1 is not None
        assert loaded2 is not None
        assert loaded1.text == "task1"
        assert loaded2.text == "task2"

    @pytest.mark.asyncio
    async def test_save_and_get_custom_scale(self):
        await self.registry.init_db(self.db_path)
        initiator_key = "web_Alice"
        points = ["10", "20", "30", "50", "100"]
        await self.registry.save_custom_scale(initiator_key, points)

        loaded = await self.registry.get_custom_scale(initiator_key)
        assert loaded == points

    @pytest.mark.asyncio
    async def test_get_custom_scale_missing(self):
        await self.registry.init_db(self.db_path)
        result = await self.registry.get_custom_scale("web_nobody")
        assert result is None

    @pytest.mark.asyncio
    async def test_save_custom_scale_overwrites(self):
        await self.registry.init_db(self.db_path)
        key = "web_Bob"
        await self.registry.save_custom_scale(key, ["1", "2"])
        await self.registry.save_custom_scale(key, ["3", "4", "5"])
        loaded = await self.registry.get_custom_scale(key)
        assert loaded == ["3", "4", "5"]
