from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from telegram import Update
from telegram.ext import ContextTypes

import state
from ppbot.game import GameRegistry
from telegram_bot import (
    callback_handler,
    create_telegram_app,
    handle_operation_click,
    handle_scale_click,
    handle_vote_click,
    init_bot,
    poker_command,
    russian_poker_command,
    start_command,
    telegram_webhook,
)


@pytest.fixture(autouse=True)
def _setup_state(tmp_path):
    state.storage = GameRegistry()

    async def _init():
        await state.storage.init_db(str(tmp_path / "test.db"))

    import asyncio

    asyncio.run(_init())
    yield

    async def _close():
        await state.storage.close()

    asyncio.run(_close())


@pytest.fixture
def sent_message():
    msg = MagicMock()
    msg.message_id = 99
    return msg


@pytest.fixture
def update(sent_message):
    u = MagicMock(spec=Update)
    u.effective_chat.id = -100
    u.effective_user.id = 12345
    u.effective_user.first_name = "TestUser"
    u.effective_user.username = "testuser"
    u.message.message_id = 42
    u.message.reply_text = AsyncMock(return_value=sent_message)
    u.callback_query = None
    return u


@pytest.fixture
def context():
    return MagicMock(spec=ContextTypes.DEFAULT_TYPE)


class TestInitBot:
    @pytest.mark.asyncio
    async def test_init_bot_calls_init_db(self, tmp_path):
        state.storage = GameRegistry()
        state.storage.init_db = AsyncMock()
        await init_bot()
        state.storage.init_db.assert_awaited_once()


class TestStartCommand:
    @pytest.mark.asyncio
    async def test_replies_with_greeting(self, update, context):
        await start_command(update, context)
        update.message.reply_text.assert_awaited_once()
        text = update.message.reply_text.await_args[0][0]
        assert "Use /poker" in text
        assert "Available scales" in text


class TestPokerCommand:
    @pytest.mark.asyncio
    async def test_creates_game_with_args(self, update, context):
        context.args = ["test", "task"]
        await poker_command(update, context)
        update.message.reply_text.assert_awaited_once()
        text = update.message.reply_text.await_args[0][0]
        assert "test task" in text

    @pytest.mark.asyncio
    async def test_creates_game_without_args(self, update, context):
        context.args = []
        update.message.text = "/poker"
        await poker_command(update, context)
        update.message.reply_text.assert_awaited_once()
        text = update.message.reply_text.await_args[0][0]
        assert "No description provided" in text

    @pytest.mark.asyncio
    async def test_creates_game_with_multiline_args(self, update, context):
        context.args = ["task", "description"]
        update.message.text = "/poker task description"
        await poker_command(update, context)
        update.message.reply_text.assert_awaited_once()
        text = update.message.reply_text.await_args[0][0]
        assert "task description" in text

    @pytest.mark.asyncio
    async def test_saves_reply_message_id(self, update, context, sent_message):
        context.args = ["task"]
        await poker_command(update, context)
        game = await state.storage.get_game(-100, "42")
        assert game is not None
        assert game.reply_message_id == 99

    @pytest.mark.asyncio
    async def test_error_replies_with_error_text(self, update, context, sent_message):
        context.args = ["task"]
        sent_message.message_id = 99
        update.message.reply_text = AsyncMock(return_value=sent_message)

        real_save = state.storage.save_game
        state.storage.save_game = AsyncMock(side_effect=Exception("save failed"))

        await poker_command(update, context)
        update.message.reply_text.assert_awaited_with("Error creating game.")
        state.storage.save_game = real_save

    @pytest.mark.asyncio
    async def test_uses_chat_id_and_message_id(self, update, context):
        context.args = ["task"]
        await poker_command(update, context)
        game = await state.storage.get_game(-100, "42")
        assert game is not None
        assert game.chat_id == -100
        assert game.vote_id == "42"

    @pytest.mark.asyncio
    async def test_empty_args_with_only_slash(self, update, context):
        context.args = []
        update.message.text = "/poker "
        await poker_command(update, context)
        text = update.message.reply_text.await_args[0][0]
        assert "No description provided" in text

    @pytest.mark.asyncio
    async def test_multiline_fallback_no_args(self, update, context):
        """When context.args has whitespace-only tokens, falls back to multiline message text."""
        context.args = ["", ""]
        update.message.text = "/poker\nmy multiline task"
        await poker_command(update, context)
        text = update.message.reply_text.await_args[0][0]
        assert "my multiline task" in text


class TestRussianPokerCommand:
    @pytest.mark.asyncio
    async def test_delegates_to_poker_command(self, update, context):
        context.args = ["задача"]
        with patch("telegram_bot.poker_command", new=AsyncMock()) as mock_poker:
            await russian_poker_command(update, context)
            mock_poker.assert_awaited_once_with(update, context)


class TestHandleVoteClick:
    @pytest.mark.asyncio
    async def test_successful_vote(self):
        game = state.storage.new_game(-100, "session1", {"id": 1, "first_name": "A", "username": "a"}, "task")
        await state.storage.save_game(game)
        query = AsyncMock()
        query.data = "vote-click-session1-5"
        query.message.chat_id = -100
        query.from_user.id = 999
        query.from_user.first_name = "Voter"
        query.from_user.username = "voter"
        await handle_vote_click(query, query.data, -100)
        query.edit_message_text.assert_awaited_once()
        query.answer.assert_not_called()

    @pytest.mark.asyncio
    async def test_game_not_found(self):
        query = AsyncMock()
        query.data = "vote-click-nonexistent-5"
        query.message.chat_id = -100
        await handle_vote_click(query, query.data, -100)
        query.edit_message_text.assert_awaited_once_with("Game not found or expired")

    @pytest.mark.asyncio
    async def test_vote_on_revealed_game(self):
        game = state.storage.new_game(-100, "session2", {"id": 1, "first_name": "A", "username": "a"}, "task")
        game.revealed = True
        await state.storage.save_game(game)
        query = AsyncMock()
        query.data = "vote-click-session2-3"
        query.message.chat_id = -100
        query.from_user.id = 999
        query.from_user.first_name = "Voter"
        query.from_user.username = "voter"
        await handle_vote_click(query, query.data, -100)
        query.answer.assert_awaited_once()
        query.edit_message_text.assert_not_called()

    @pytest.mark.asyncio
    async def test_suppresses_message_not_modified(self):
        game = state.storage.new_game(-100, "session3", {"id": 1, "first_name": "A", "username": "a"}, "task")
        game.add_vote({"id": 1, "first_name": "A", "username": "a"}, "3")
        await state.storage.save_game(game)
        query = AsyncMock()
        query.data = "vote-click-session3-3"
        query.message.chat_id = -100
        query.from_user.id = 1
        query.from_user.first_name = "A"
        query.from_user.username = "a"
        query.edit_message_text = AsyncMock(side_effect=Exception("Message is not modified"))
        await handle_vote_click(query, query.data, -100)
        query.edit_message_text.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_raises_non_modification_error(self):
        game = state.storage.new_game(-100, "session4", {"id": 1, "first_name": "A", "username": "a"}, "task")
        game.add_vote({"id": 1, "first_name": "A", "username": "a"}, "5")
        await state.storage.save_game(game)
        query = AsyncMock()
        query.data = "vote-click-session4-5"
        query.message.chat_id = -100
        query.from_user.id = 1
        query.from_user.first_name = "A"
        query.from_user.username = "a"
        query.edit_message_text = AsyncMock(side_effect=Exception("Some other error"))
        with pytest.raises(Exception, match="Some other error"):
            await handle_vote_click(query, query.data, -100)


class TestHandleOperationClick:
    @pytest.fixture(autouse=True)
    async def _game(self):
        self.game = state.storage.new_game(-100, "op1", {"id": 1, "first_name": "A", "username": "a"}, "task")
        self.game.add_vote({"id": 2, "first_name": "B", "username": "b"}, "5")
        await state.storage.save_game(self.game)
        self.query = AsyncMock()
        self.query.message.chat_id = -100
        self.query.from_user.id = 1
        self.query.message.reply_text = AsyncMock()

    @pytest.mark.asyncio
    async def test_restart(self):
        self.query.data = "restart-click-op1"
        await handle_operation_click(self.query, self.query.data, -100)
        self.query.edit_message_text.assert_awaited_once()
        game = await state.storage.get_game(-100, "op1")
        assert game.revealed is False
        assert len(game.votes) == 0

    @pytest.mark.asyncio
    async def test_restart_new(self):
        self.query.data = "restart-new-click-op1"
        self.query.message.reply_text = AsyncMock(return_value=MagicMock(message_id=200))
        await handle_operation_click(self.query, self.query.data, -100)
        self.query.edit_message_text.assert_awaited_once()
        self.query.message.reply_text.assert_awaited_once()
        game = await state.storage.get_game(-100, "op1")
        assert game.reply_message_id == 200

    @pytest.mark.asyncio
    async def test_reveal(self):
        self.query.data = "reveal-click-op1"
        await handle_operation_click(self.query, self.query.data, -100)
        self.query.edit_message_text.assert_awaited_once()
        game = await state.storage.get_game(-100, "op1")
        assert game.revealed is True

    @pytest.mark.asyncio
    async def test_reveal_new(self):
        self.query.data = "reveal-new-click-op1"
        self.query.message.reply_text = AsyncMock(return_value=MagicMock(message_id=201))
        await handle_operation_click(self.query, self.query.data, -100)
        self.query.edit_message_text.assert_awaited_once()
        self.query.message.reply_text.assert_awaited_once()
        game = await state.storage.get_game(-100, "op1")
        assert game.reply_message_id == 201

    @pytest.mark.asyncio
    async def test_non_initiator_rejected(self):
        self.query.from_user.id = 999
        self.query.data = "reveal-click-op1"
        await handle_operation_click(self.query, self.query.data, -100)
        self.query.answer.assert_awaited_once()
        self.query.edit_message_text.assert_not_called()

    @pytest.mark.asyncio
    async def test_game_not_found(self):
        self.query.data = "reveal-click-nonexistent"
        await handle_operation_click(self.query, self.query.data, -100)
        self.query.answer.assert_awaited_once()
        self.query.edit_message_text.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_changes_to_apply(self):
        self.query.data = "reveal-click-op1"
        # Reveal when already revealed
        game = await state.storage.get_game(-100, "op1")
        game.revealed = True
        await state.storage.save_game(game)
        self.query.edit_message_text = AsyncMock(side_effect=Exception("message is not modified"))
        await handle_operation_click(self.query, self.query.data, -100)
        self.query.answer.assert_awaited_once_with("No changes to apply")

    @pytest.mark.asyncio
    async def test_raises_unrelated_error(self):
        self.query.data = "reveal-click-op1"
        self.query.edit_message_text = AsyncMock(side_effect=Exception("database error"))
        with pytest.raises(Exception, match="database error"):
            await handle_operation_click(self.query, self.query.data, -100)

    @pytest.mark.asyncio
    async def test_invalid_data_format_returns_early(self):
        """Data that doesn't match 'op-click-id' format should return without action."""
        self.query.data = "invalid-format"
        await handle_operation_click(self.query, self.query.data, -100)
        self.query.edit_message_text.assert_not_called()
        self.query.answer.assert_not_called()


class TestCallbackHandler:
    @pytest.mark.asyncio
    async def test_calls_query_answer(self):
        update = MagicMock(spec=Update)
        query = AsyncMock()
        query.data = "vote-click-nonexistent-3"
        query.message.chat_id = -100
        update.callback_query = query
        await callback_handler(update, MagicMock())
        query.answer.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_handles_exception_with_alert(self):
        update = MagicMock(spec=Update)
        query = AsyncMock()
        query.data = "invalid-format"
        query.message.chat_id = -100
        update.callback_query = query
        await callback_handler(update, MagicMock())
        query.answer.assert_awaited()

    @pytest.mark.asyncio
    async def test_callback_exception_in_handler(self):
        """Exception inside handle_vote_click bubbles up to callback_handler's except."""
        update = MagicMock(spec=Update)
        query = AsyncMock()
        query.data = "vote-click-"  # too few parts → IndexError
        query.message.chat_id = -100
        query.answer = AsyncMock()
        update.callback_query = query
        await callback_handler(update, MagicMock())
        query.answer.assert_awaited_with("Error processing request", show_alert=True)

    @pytest.mark.asyncio
    async def test_operation_click_through_callback_handler(self):
        """callback_handler dispatches operation clicks to handle_operation_click."""
        game = state.storage.new_game(-100, "cb_op1", {"id": 1, "first_name": "A", "username": "a"}, "task")
        await state.storage.save_game(game)

        update = MagicMock(spec=Update)
        query = AsyncMock()
        query.data = "restart-click-cb_op1"
        query.message.chat_id = -100
        query.from_user.id = 1
        query.answer = AsyncMock()
        query.edit_message_text = AsyncMock()
        update.callback_query = query
        await callback_handler(update, MagicMock())
        query.edit_message_text.assert_awaited_once()


class TestCreateTelegramApp:
    def test_creates_app_without_proxy(self):
        with patch("telegram_bot.TOKEN", "fake_token"):
            app = create_telegram_app(use_proxy=False)
            assert app is not None

    def test_creates_app_with_proxy(self):
        with patch("telegram_bot.TOKEN", "fake_token"), patch("telegram_bot.PROXY_URL", "http://proxy:8080"):
            app = create_telegram_app(use_proxy=True)
            assert app is not None

    def test_app_has_handlers(self):
        with patch("telegram_bot.TOKEN", "fake_token"), patch("telegram_bot.PROXY_URL", None):
            app = create_telegram_app(use_proxy=False)
            handler_names = [type(h).__name__ for h in app.handlers.get(0, [])]
            assert "CommandHandler" in handler_names
            assert "CallbackQueryHandler" in handler_names
            assert "MessageHandler" in handler_names


class TestTelegramWebhook:
    @pytest.mark.asyncio
    async def test_returns_503_when_app_missing(self):
        request = AsyncMock()
        request.json.return_value = {"update_id": 1}
        request.app.state.telegram_app = None
        resp = await telegram_webhook(request)
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_returns_500_on_exception(self):
        request = AsyncMock()
        request.json.side_effect = ValueError("parse error")
        resp = await telegram_webhook(request)
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_successful_webhook(self):
        from telegram import Update as TGUpdate

        mock_bot = MagicMock()
        mock_bot.name = "test_bot"
        mock_app = MagicMock()
        mock_app.process_update = AsyncMock()
        mock_app.bot = mock_bot

        request = AsyncMock()
        request.json.return_value = {"update_id": 1, "message": {"text": "test"}}
        request.app.state.telegram_app = mock_app

        with patch("telegram_bot.Update.de_json", return_value=MagicMock(spec=TGUpdate)):
            resp = await telegram_webhook(request)
            assert resp.status_code == 200
            mock_app.process_update.assert_awaited_once()


class TestParseScaleFromArgs:
    def test_default_when_no_scale_arg(self):
        from telegram_bot import _parse_scale_from_args

        scale, rest = _parse_scale_from_args(["task", "description"])
        assert scale == "custom"
        assert rest == ["task", "description"]

    def test_scale_with_equals(self):
        from telegram_bot import _parse_scale_from_args

        scale, rest = _parse_scale_from_args(["task", "--scale=fibonacci"])
        assert scale == "fibonacci"
        assert rest == ["task"]

    def test_scale_with_separate_value(self):
        from telegram_bot import _parse_scale_from_args

        scale, rest = _parse_scale_from_args(["--scale", "tshirt", "task"])
        assert scale == "tshirt"
        assert rest == ["task"]

    def test_invalid_scale_falls_back(self):
        from telegram_bot import _parse_scale_from_args

        scale, rest = _parse_scale_from_args(["--scale", "bogus"])
        assert scale == "custom"


class TestHandleScaleClick:
    @pytest.mark.asyncio
    async def test_cycles_to_next_scale(self):
        """handle_scale_click advances to the next scale preset."""
        game = state.storage.new_game(-100, "scale1", {"id": 1, "first_name": "A", "username": "a"}, "task")
        await state.storage.save_game(game)

        query = AsyncMock()
        query.data = "scale-cycle-scale1"
        query.message.chat_id = -100
        query.answer = AsyncMock()
        query.edit_message_text = AsyncMock()

        await handle_scale_click(query, query.data, -100)
        query.edit_message_text.assert_awaited_once()

        # Scale should have changed from "custom" to "fibonacci" (first next entry)
        updated = await state.storage.get_game(-100, "scale1")
        assert updated.scale_name != "custom"

    @pytest.mark.asyncio
    async def test_game_not_found(self):
        from telegram_bot import handle_scale_click

        query = AsyncMock()
        query.data = "scale-cycle-nonexistent"
        query.message.chat_id = -100
        query.answer = AsyncMock()

        await handle_scale_click(query, query.data, -100)
        query.answer.assert_awaited_with("Game not found", show_alert=True)
