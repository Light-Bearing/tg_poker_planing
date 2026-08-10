"""Проверки того, что по /extension/download отдаётся именно та сборка, что лежит в исходниках.

Дважды подряд владелец ставил расширение и не находил в нём новых кнопок. Причина —
не код расширения, а доставка: архивы собираются скриптом и коммитятся руками, поэтому
забытая пересборка не видна ни тестам, ни глазу. Здесь она видна.
"""

import io
import json
import zipfile
from pathlib import Path

import pytest
from starlette.applications import Starlette
from starlette.routing import Route
from starlette.testclient import TestClient

from web_api import download_extension

EXT = Path(__file__).resolve().parent.parent / "browser-extension"

FIREFOX_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"
CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"

# Файлы, которые обязаны совпадать с исходниками. Манифест исключён: в архивах он
# переименован из manifest-firefox.json, его проверяем отдельно.
MIRRORED = ["background.js", "content.js", "popup.js", "popup.html"]


@pytest.fixture
def client():
    app = Starlette(routes=[Route("/extension/download", download_extension, methods=["GET"])])
    return TestClient(app)


def _archive(client, user_agent):
    response = client.get("/extension/download?download=true", headers={"user-agent": user_agent})
    assert response.status_code == 200
    return response, zipfile.ZipFile(io.BytesIO(response.content))


class TestServedArchive:
    @pytest.mark.parametrize("user_agent", [FIREFOX_UA, CHROME_UA])
    def test_содержимое_совпадает_с_исходниками(self, client, user_agent):
        _, archive = _archive(client, user_agent)
        for name in MIRRORED:
            assert archive.read(name) == (EXT / name).read_bytes(), (
                f"{name} в архиве отличается от исходника — забыта пересборка build.sh"
            )

    def test_firefox_получает_манифест_второй_версии(self, client):
        _, archive = _archive(client, FIREFOX_UA)
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["manifest_version"] == 2
        assert manifest == json.loads((EXT / "manifest-firefox.json").read_text(encoding="utf-8"))

    def test_chrome_получает_манифест_третьей_версии(self, client):
        _, archive = _archive(client, CHROME_UA)
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["manifest_version"] == 3
        assert manifest == json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))

    def test_версии_манифестов_совпадают(self):
        chrome = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))
        firefox = json.loads((EXT / "manifest-firefox.json").read_text(encoding="utf-8"))
        assert chrome["version"] == firefox["version"]


class TestDelivery:
    def test_архив_не_кешируется(self, client):
        response, _ = _archive(client, FIREFOX_UA)
        assert "no-store" in response.headers["cache-control"]

    def test_имя_файла_содержит_версию_и_браузер(self, client):
        version = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))["version"]
        response, _ = _archive(client, FIREFOX_UA)
        assert f"pp-jira-bridge-firefox-{version}.zip" in response.headers["content-disposition"]

    def test_инструкция_не_кешируется(self, client):
        response = client.get("/extension/download?download=html", headers={"user-agent": FIREFOX_UA})
        assert response.status_code == 200
        assert "no-store" in response.headers["cache-control"]
