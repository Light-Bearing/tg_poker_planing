from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from starlette.templating import Jinja2Templates

    from ppbot.game import GameRegistry

# Инициализируется в build_app() — mypy: не смотри на None
storage: "GameRegistry" = None  # type: ignore[assignment]
templates: "Jinja2Templates" = None  # type: ignore[assignment]
