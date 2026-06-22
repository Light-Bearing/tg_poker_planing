"""Tests for Game persistence with auto_reveal setting."""

import pytest

from ppbot.game import Game, GameRegistry


class TestAutoRevealPersistence:
    def test_auto_reveal_in_from_dict(self, sample_initiator):
        """auto_reveal=True survives Game -> dict -> Game roundtrip"""
        game = Game(-100, "s1", sample_initiator, "task", auto_reveal=True)
        d = game.to_dict()
        restored = Game.from_dict(-100, "s1", d)
        assert restored.auto_reveal is True

    def test_auto_reveal_false_in_from_dict(self, sample_initiator):
        """auto_reveal=False survives Game -> dict -> Game roundtrip"""
        game = Game(-100, "s1", sample_initiator, "task", auto_reveal=False)
        d = game.to_dict()
        restored = Game.from_dict(-100, "s1", d)
        assert restored.auto_reveal is False

    def test_auto_reveal_default_in_from_dict(self, sample_initiator):
        """auto_reveal defaults to False when not in dict"""
        game = Game(-100, "s1", sample_initiator, "task", auto_reveal=True)
        d = game.to_dict()
        del d["auto_reveal"]  # simulate old data without auto_reveal
        restored = Game.from_dict(-100, "s1", d)
        assert restored.auto_reveal is False

    def test_auto_reveal_in_dict(self, sample_initiator):
        """auto_reveal is present in to_dict output"""
        game = Game(-100, "s1", sample_initiator, "task", auto_reveal=True)
        d = game.to_dict()
        assert "auto_reveal" in d
        assert d["auto_reveal"] is True


class TestAutoRevealDBPersistence:
    @pytest.fixture(autouse=True)
    async def _setup(self, tmp_path):
        self.registry = GameRegistry()
        await self.registry.init_db(str(tmp_path / "test.db"))
        yield
        await self.registry.close()

    @pytest.mark.asyncio
    async def test_save_and_load_auto_reveal(self, sample_initiator):
        """auto_reveal survives save -> load from DB"""
        game = self.registry.new_game(-100, "s1", sample_initiator, "task")
        game.auto_reveal = True
        await self.registry.save_game(game)

        loaded = await self.registry.get_game(-100, "s1")
        assert loaded is not None
        assert loaded.auto_reveal is True

    @pytest.mark.asyncio
    async def test_save_and_load_auto_reveal_false(self, sample_initiator):
        """auto_reveal=False survives save -> load from DB"""
        game = self.registry.new_game(-100, "s2", sample_initiator, "task")
        game.auto_reveal = False
        await self.registry.save_game(game)

        loaded = await self.registry.get_game(-100, "s2")
        assert loaded is not None
        assert loaded.auto_reveal is False
