@echo off
# Определение переменных
set NAME=wmsout_planing_poker_bot
set DB_LOCATION=C:\db
set DB_NAME=tg_pp_bot.db
set PP_BOT_TOKEN="PP_BOT_TOKEN_REMOVED"

# Построение образа Docker
docker build -t %NAME% .
# Удаление запущенного контейнера (если он существует)
docker rm -f %NAME% 2>nul
# Запуск нового контейнера
docker run --name %NAME% -d --restart unless-stopped ^
  -p 8000:8000 ^
  -e "PP_BOT_TOKEN=%PP_BOT_TOKEN%" ^
  -e "PP_BOT_DB_PATH=%DB_LOCATION%\%DB_NAME%" ^
  -v "%USERPROFILE%\.ppbot\:%DB_LOCATION%" ^
  %NAME%
# Просмотр логов контейнера
docker logs -f %NAME%