"""Tests for Game persistence with auto_reveal setting."""

import pytest

from ppbot.game import Game, GameRegistry, Initiator


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


class TestDeleteGame:
    @pytest.mark.asyncio
    async def test_delete_game_удаляет_запись(self, tmp_path):
        reg = GameRegistry()
        await reg.init_db(str(tmp_path / "t.db"))
        game = reg.new_game("web", "s1", Initiator.from_web("alice"), "task")
        await reg.save_game(game)
        assert await reg.get_game("web", "s1") is not None
        await reg.delete_game("web", "s1")
        assert await reg.get_game("web", "s1") is None
        await reg.close()

    @pytest.mark.asyncio
    async def test_delete_game_не_трогает_чужие(self, tmp_path):
        """game_id у разных чатов может совпадать — удаление различает их по chat_id."""
        reg = GameRegistry()
        await reg.init_db(str(tmp_path / "t.db"))
        web = reg.new_game("web", "s1", Initiator.from_web("alice"), "web-задача")
        tg = reg.new_game("-100500", "s1", Initiator.from_web("bob"), "telegram-задача")
        await reg.save_game(web)
        await reg.save_game(tg)
        await reg.delete_game("web", "s1")
        assert await reg.get_game("web", "s1") is None
        assert await reg.get_game("-100500", "s1") is not None
        await reg.close()
