"""Tests for Game persistence with auto_reveal setting."""

import pytest

from ppbot.game import Game


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

    def test_save_and_load_auto_reveal(self):
        """auto_reveal survives save -> load from DB"""
        pytest.skip("Requires DB -- tested in integration")
