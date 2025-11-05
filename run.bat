# Определение переменных
$NAME = "wmsout_planing_poker_bot"
$DB_LOCATION = "C:\db" @REM определи положение БД
$DB_NAME = "tg_pp_bot.db"
$PP_BOT_TOKEN = "8009682691:AAF-kaC8ivVrTb3IQZs_FSOdwt-Sr8qcoLo"

# Построение образа Docker
docker build -t $NAME .

# Удаление запущенного контейнера (если он существует)
docker rm -f $NAME -ErrorAction SilentlyContinue

# Запуск нового контейнера
docker run --name $NAME -d --restart unless-stopped `
  -e "PP_BOT_TOKEN=$PP_BOT_TOKEN" `
  -e "PP_BOT_DB_PATH=$DB_LOCATION\$DB_NAME" `
  -v "$HOME\.ppbot\$($DB_LOCATION)" `
  $NAME

# Просмотр логов контейнера
docker logs -f $NAME
