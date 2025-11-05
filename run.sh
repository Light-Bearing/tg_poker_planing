#!/bin/bash -ex

NAME=wmsout_planing_poker_bot
DB_LOCATION=/db/
DB_NAME=tg_pp_bot.db
PP_BOT_TOKEN=8209778838:AAHqPK_3Q8oXtmK3wcEuknVZSpabB6px2lg
# 8009682691:AAF-kaC8ivVrTb3IQZs_FSOdwt-Sr8qcoLo

docker build -t ${NAME} .
docker rm -f ${NAME} || true
docker run --name ${NAME} -d --restart=unless-stopped -e PP_BOT_TOKEN=${PP_BOT_TOKEN} -e PP_BOT_DB_PATH=${DB_LOCATION}/${DB_NAME} -v ~/.ppbot/:${DB_LOCATION} ${NAME}
docker logs -f ${NAME}
