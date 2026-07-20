import pytest

from ppbot.game import Initiator


@pytest.fixture
def sample_initiator():
    return Initiator(id="42", first_name="Alice", username="alice")


@pytest.fixture
def sample_game(sample_initiator):
    from ppbot.game import Game

    game = Game(chat_id=-100, vote_id="msg1", initiator=sample_initiator, text="Test task description")
    game.add_vote({"id": 42, "first_name": "Alice", "username": "alice"}, "3")
    return game
