"""Tests for config.py."""

import importlib.util
import os
import subprocess
import sys
from unittest.mock import patch


def test_missing_token_raises_value_error():
    """When TELEGRAM_BOT_TOKEN and PP_BOT_TOKEN are not set, raise ValueError."""
    # Save old module to restore later
    old_config = sys.modules.pop("config", None)
    try:
        with patch.dict(os.environ, {"PP_BOT_TOKEN": "", "TELEGRAM_BOT_TOKEN": ""}):
            spec = importlib.util.spec_from_file_location("config", "config.py")
            mod = importlib.util.module_from_spec(spec)
            import pytest

            with pytest.raises(ValueError, match="TELEGRAM BOT TOKEN NOT FOUND"):
                spec.loader.exec_module(mod)
    finally:
        if old_config:
            sys.modules["config"] = old_config


def test_missing_token_via_subprocess():
    """Also verify with subprocess that import fails without token."""
    env = {k: v for k, v in os.environ.items() if k not in ("PP_BOT_TOKEN", "TELEGRAM_BOT_TOKEN")}
    env["PP_BOT_TOKEN"] = ""
    env["TELEGRAM_BOT_TOKEN"] = ""

    result = subprocess.run(
        [sys.executable, "-c", "import config"],
        capture_output=True,
        text=True,
        timeout=5,
        env=env,
    )
    assert result.returncode != 0
    assert "TELEGRAM BOT TOKEN NOT FOUND" in result.stderr
