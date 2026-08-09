# Planning Poker — Telegram Bot + Web Interface

**Planning Poker** — это инструмент для командной оценки задач по методике Planning Poker. Поддерживает Telegram бота и веб-интерфейс с реаль-time синхронизацией через WebSocket.

## Возможности

### Общие
- Создание сессий планирования покера
- Анонимное голосование до открытия карт
- Авто-открытие карт при голосе всех участников
- Перезапуск голосования и открытие результатов
- Поддержка многострочных описаний задач
- Сохранение состояния в SQLite базу данных
- Кастомные шкалы оценок
- **Горячие клавиши** (1-9 голосовать, R сброс, O открыть, N новая задача, J отправить в Jira)

### Telegram
- Создание сессий через команды `/poker` или `/покер`
- Push-уведомления через Telegram Long Polling / Webhook
- Поддержка прокси (HTTP/SOCKS5) для обхода ограничений

### Web Interface
- Современный UI с темной/светлой темой
- Real-time синхронизация через WebSocket
- Индикация онлайн-участников
- Визуализация распределения голосов (гистограмма)
- Звуковые уведомления
- История последних сессий (localStorage)

### Jira Integration (Browser Extension)
- Интеграция с Jira через браузерное расширение
- Загрузка задач из Jira по JQL-фильтру
- Автоматическое заполнение описания задачи
- Отображение имени эпика в дереве задач
- Показ связанных задач со статусами и сроками
- Отправка оценки (Story Points) обратно в Jira
- Редактирование результата перед отправкой
- Быстрая отправка — клавиша **J**
- Форматирование Jira wiki ссылок в описании

---

## Быстрый старт

### 1. Создание Telegram бота

1. Найдите в Telegram [@BotFather](https://t.me/BotFather)
2. Создайте нового бота командой `/newbot`
3. Сохраните полученный токен

### 2. Установка

```bash
# Клонируйте репозиторий
git clone <repository-url>
cd tg_poker_planing

# Создайте виртуальное окружение
python3 -m venv .venv
source .venv/bin/activate # Windows: .venv\Scripts\activate

# Установите зависимости
pip install -r requirements.txt
```

### 3. Настройка переменных окружения

Создайте файл `.env` в корне проекта:

⚠️ **Никогда не коммитьте `.env` и не вписывайте реальные токены в `.env.example`.** `.env` уже в `.gitignore`. В репозитории настроен hook `gitleaks` — установите его командой `pre-commit install`, чтобы коммит с секретом не прошёл. Если токен всё же попал в историю, его нужно отозвать: для бота — команда `/revoke` у [@BotFather](https://t.me/BotFather).

```bash
# Обязательные переменные
TELEGRAM_BOT_TOKEN=ваш_токен_бота_от_BotFather

# Опциональные переменные
PP_BOT_DB_PATH=/tmp/tg_pp_bot.db # Путь к базе данных
PROXY_URL=http://proxy:port # Прокси для Telegram (опционально)
WEBHOOK_URL=https://your-domain.com # Для webhook режима (опционально)
PORT=8000 # Port для веб-сервера (default: 8000)
```

**Примеры прокси:**
```bash
# HTTP прокси
PROXY_URL=http://127.0.0.1:8080

# SOCKS5 прокси
PROXY_URL=socks5://username:password@proxy.example.com:1080
```

### 4. Запуск

```bash
# Основной запуск (веб-сервер + Telegram бот)
python3 main.py
```

Бот запустится в режиме **Polling** (локальная разработка). Веб-интерфейс будет доступен по адресу: **http://localhost:8000**

---

## Запуск через Docker

### 1. Быстрый запуск

```bash
# Установите переменную окружения
export TELEGRAM_BOT_TOKEN="ваш_токен_бота"

# Запустите скрипт
chmod +x run.sh
./run.sh
```

### 2. Ручная сборка Docker

```bash
# Сборка образа
docker build -t planning_poker_bot .

# Запуск контейнера
docker run -d \
 --name planning_poker_bot \
 --restart=unless-stopped \
 -p 8000:8000 \
 -e TELEGRAM_BOT_TOKEN="ваш_токен_бота" \
 -e PP_BOT_DB_PATH="/db/tg_pp_bot.db" \
 -v ~/.ppbot/:/db/ \
 planning_poker_bot
```

### 3. Docker Compose (рекомендуется)

Создайте `docker-compose.yml`:

```yaml
version: '3.8'

services:
 planning-poker:
 build: .
 container_name: planning_poker_bot
 restart: unless-stopped
 ports:
 - "8000:8000"
 environment:
 - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
 - PP_BOT_DB_PATH=/db/tg_pp_bot.db
 - PROXY_URL=${PROXY_URL:-}
 volumes:
 - ./data:/db
```

Запуск:
```bash
# Создайте .env файл с переменными
cp .env.example .env
# Отредактируйте .env

# Запуск
docker-compose up -d
```

---

## Использование

### Telegram Бот

#### Команды

| Команда | Описание |
|---------|----------|
| `/start`, `/help` | Показать справку |
| `/poker [описание]` | Начать новую сессию |
| `/покер [описание]` | То же, что `/poker` (русский) |
| `/p [описание]` | Короткая версия |
| `/зщлук [описание]` | Русская версия (кириллица) |

#### Примеры

```bash
# Простая задача
/poker Разработка системы аутентификации

# Многострочное описание
/poker Реализовать JWT аутентификацию
- Создать endpoint для логина
- Реализовать refresh токены
- Добавить валидацию

# С выбором шкалы
/poker задача --scale fibonacci
/poker задача --scale powers_of_2
/poker задача --scale tshirt
```

#### Доступные оценки

**Стандартные шкалы:**

| Шкала | Значения |
|-------|----------|
| Fibonacci | 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, ❔, ☕ |
| Powers of 2 | 1, 2, 4, 8, 16, 32, 64, ❔, ☕ |
| T-shirt | XS, S, M, L, XL, XXL, ❔, ☕ |
| Custom | Настраиваемая пользователем |

**Специальные значения:**
- `❔` — Не уверен / Нужно обсудить
- `☕` — Нужен перерыв / Кофе-брейк

### Web Interface

1. Откройте **http://localhost:8000**
2. Введите имя и нажмите **"СОЗДАТЬ КОМНАТУ"**
3. Поделитесь ссылкой на комнату с командой
4. Голосуйте и открывайте карты

#### Возможности веб-интерфейса

- **Темы**: Переключение между светлой и темной темой
- **Звуки**: Включение/выключение звуковых уведомлений
- **Копирование**: Клик по ID комнаты для копирования
- **История**: Последние комнаты сохраняются в браузере
- **Гистограмма**: Визуализация распределения голосов
- **Авто-открытие**: Карты открываются автоматически через 1с после голоса всех участников
- **Смена шкалы на лету**: Инициатор может переключить шкалу прямо в сессии — панель «УПРАВЛЕНИЕ». Голоса при этом сбрасываются, потому что значения старой шкалы могут отсутствовать в новой.

#### ⌨ Горячие клавиши

| Клавиша | Действие | Кто может |
|---------|----------|-----------|
| `1`-`9` | Быстрое голосование | Все |
| `R` | Сброс голосования | Инициатор |
| `O` | Открыть карты | Инициатор |
| `N` | Новая задача | Инициатор |
| `J` | Отправить оценку в Jira | Инициатор |
| `Esc` | Закрыть модальное окно | Все |

> **Ввод/редактирование**: Если фокус на поле ввода или редактируемом результате — горячие клавиши не срабатывают.

---

## Архитектура

### Структура проекта

```
tg_poker_planing/
├── main.py # Точка входа, запуск сервера и бота
├── app.py # Создание Starlette приложения
├── config.py # Конфигурация и логгирование
├── state.py # Глобальное состояние (storage, templates)
│
├── telegram_bot.py # Обработчики Telegram бота
├── web_api.py # REST API для веб-интерфейса
├── websocket_handler.py # WebSocket обработчики
├── connection.py # Управление WebSocket подключениями
│
├── ppbot/
│ ├── __init__.py
│ └── game.py # Логика игры, Game, Vote, GameRegistry
│
├── web/
│ ├── templates/
│ │ └── index.html # HTML шаблон
│ └── static/
│ ├── script.js # Frontend логика
│ └── styles.css # Стили
│
├── browser-extension/ # Jira интеграция (Chrome Extension)
├── tests/ # Тесты
│ ├── test_game.py
│ ├── test_api.py
│ ├── test_telegram_bot.py
│ ├── test_websocket.py
│ └── test_app.py
│
├── requirements.txt # Python зависимости
├── Dockerfile # Docker образ
├── run.sh # Скрипт запуска
└── .env.example # Пример конфигурации
```

### Основные компоненты

| Компонент | Описание |
|-----------|----------|
| `main.py` | Запуск uvicorn сервера и Telegram бота в отдельном потоке |
| `telegram_bot.py` | Обработчики команд и callback'ов Telegram бота |
| `web_api.py` | REST API эндпоинты для веб-интерфейса |
| `websocket_handler.py` | WebSocket подключение и real-time обновления |
| `connection.py` | ConnectionManager для управления WebSocket сессиями |
| `ppbot/game.py` | Ядро: Game, Vote, GameRegistry (БД) |

### Технологический стек

| Категория | Технологии |
|-----------|------------|
| Backend | Python 3.10+, asyncio |
| Web Framework | Starlette, Uvicorn |
| Telegram Bot | python-telegram-bot 20.7 |
| Database | SQLite (aiosqlite) |
| Frontend | Vanilla JS, WebSocket |
| Templating | Jinja2 |
| Testing | pytest, pytest-asyncio |
| Code Style | Ruff |
| Containerization | Docker |

---

## Конфигурация

### Переменные окружения

| Переменная | Обязательная | По умолчанию | Описание |
|------------|--------------|--------------|----------|
| `TELEGRAM_BOT_TOKEN` | | - | Токен бота от BotFather |
| `PP_BOT_DB_PATH` | | `/tmp/tg_pp_bot.db` | Путь к файлу базы данных |
| `PROXY_URL` | | - | Прокси для Telegram (HTTP/SOCKS5) |
| `RENDER_EXTERNAL_URL` | | - | URL для webhook режима |
| `WEBHOOK_URL` | | - | Альтернативный URL для webhook |
| `PORT` | | `8000` | Порт веб-сервера |
| `SESSION_CLEANUP_INTERVAL` | | `600` | Период очистки неактивных сессий из памяти, секунды |

> **Известное ограничение**: очистка выбирает сессии по мгновенному снимку «нет живых WebSocket-подключений прямо сейчас», без окна ожидания. Если тик попадёт на момент, когда все участники отключены одновременно (общая перезагрузка страницы, свёрнутые вкладки на телефонах), список участников живой сессии будет сброшен. Голоса лежат в SQLite и не теряются — состояние восстанавливается по мере переподключения, но участники и их статусы «ожидает / проголосовал» обнуляются. Уменьшение `SESSION_CLEANUP_INTERVAL` расширяет это окно.

### Шкалы оценок

Шкалы оценок определяются в `ppbot/game.py`:

```python
SCALES = {
 "custom": ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
 "11", "12", "14", "16", "18", "20", "28", "40", "❔", "☕"],
 "fibonacci": ["1", "2", "3", "5", "8", "13", "21", "34", "55", "89", "❔", "☕"],
 "powers_of_2": ["1", "2", "4", "8", "16", "32", "64", "❔", "☕"],
 "tshirt": ["XS", "S", "M", "L", "XL", "XXL", "❔", "☕"],
}
```

### База данных

Используется SQLite с асинхронным доступом через aiosqlite.

**Схема:**

```sql
-- Активные сессии
CREATE TABLE IF NOT EXISTS games (
 chat_id TEXT,
 game_id TEXT,
 json_data TEXT,
 PRIMARY KEY (chat_id, game_id)
);

-- Пользовательские шкалы
CREATE TABLE IF NOT EXISTS custom_scales (
 initiator_key TEXT PRIMARY KEY,
 points TEXT NOT NULL
);
```

---

## Разработка

### Запуск в режиме разработки

```bash
# Установка зависимостей
pip install -r requirements.txt

# Запуск
python3 main.py
```

### Запуск тестов

```bash
# Все тесты
python3 -m pytest -v

# С покрытием
python3 -m pytest --cov=ppbot --cov=web_api --cov=telegram_bot

# Конкретный файл
python3 -m pytest tests/test_game.py -v

# Конкретный тест
python3 -m pytest tests/test_game.py::test_game_create -v

# Тесты JavaScript (парсеры описаний Jira), нужен Node.js
# кавычки обязательны: аргумент-каталог не работает
node --test 'tests/js/*.test.js'
```

### Pre-commit hooks

```bash
# Установка pre-commit
pre-commit install

# Запуск вручную
pre-commit run --all-files
```

### Linting

```bash
# Проверка кода
ruff check .

# Автофикс
ruff check --fix .
```

---

## Jira Integration

### Установка расширения

1. Скачайте расширение: [Скачать pp-jira-bridge.zip](http://localhost:8000/extension/download)
2. Распакуйте ZIP в отдельную папку
3. Откройте `chrome://extensions`
4. Включите **"Режим разработчика"**
5. Нажмите **"Загрузить распакованное расширение"**
6. Выберите папку с расширением
7. Обновите страницу Planning Poker

### Настройка

1. Откройте панель **⚡ JIRA** в правом верхнем углу
2. Введите URL вашей Jira
3. Введите API Token (Personal Access Token)
4. Настройте JQL-фильтр для загрузки задач
5. Нажмите **"СОХРАНИТЬ"**

### Использование

1. Создайте или откройте сессию
2. Нажмите **"⚡ JIRA"**
3. Нажмите **"ЗАГРУЗИТЬ ЗАДАЧИ"**
4. Выберите задачу из дерева
5. Нажмите **"▸ ПРИМЕНИТЬ К ЗАДАЧЕ"**

---

## API Documentation

### REST API

#### Создание сессии
```http
POST /api/sessions
Content-Type: application/json

{
 "username": "alice",
 "text": "Описание задачи",
 "scale_name": "fibonacci"
}
```

#### Голосование
```http
POST /api/sessions/{session_id}/vote
Content-Type: application/json

{
 "username": "alice",
 "point": "5"
}
```

#### Открытие карт
```http
POST /api/sessions/{session_id}/reveal
Content-Type: application/json

{
 "username": "alice"
}
```

#### Перезапуск сессии
```http
POST /api/sessions/{session_id}/restart
Content-Type: application/json

{
 "username": "alice",
 "new_text": "Новое описание"
}
```

#### Установка шкалы
```http
POST /api/sessions/{session_id}/scale
Content-Type: application/json

{
 "scale_name": "fibonacci"
}
```

### WebSocket Protocol

Подключение: `ws://localhost:8000/ws/{session_id}`

**Сообщения:**

```json
// Join to session
{
 "type": "join",
 "username": "alice"
}

// Set scale
{
 "type": "set_scale",
 "scale_name": "fibonacci"
}

// Ping/Pong
"ping"
```

**Ответы сервера:**

```json
// Initial data
{
 "type": "init",
 "data": { /* session data */ }
}

// Update
{
 "type": "update",
 "data": { /* updated session data */ }
}

// User events
{
 "type": "user_joined",
 "username": "alice",
 "data": { /* session data */ }
}

{
 "type": "user_left",
 "username": "alice",
 "data": { /* session data */ }
}
```

---

## Troubleshooting

### Бот не отвечает

1. Проверьте токен бота в переменной `TELEGRAM_BOT_TOKEN`
2. Убедитесь, что бот добавлен в чат и имеет права на отправку сообщений
3. Проверьте логи на наличие ошибок
4. Для webhook режима проверьте доступность URL извне

### Ошибка подключения к Telegram

```bash
# Проверьте прокси
export PROXY_URL=http://proxy:port

# Или используйте прямое соединение (если нет ограничений)
unset PROXY_URL
```

### Проблемы с базой данных

```bash
# Убедитесь, что путь к базе данных доступен
mkdir -p $(dirname $PP_BOT_DB_PATH)

# Проверьте права доступа
chmod 644 $PP_BOT_DB_PATH
```

### WebSocket не подключается

1. Проверьте, что сервер запущен на правильном порту
2. Убедитесь, что нет проблем с CORS (для production)
3. Проверьте браузерную консоль на наличие ошибок

---

## Тестирование

### Покрытие кода

```bash
python3 -m pytest --cov=ppbot --cov=web_api --cov=telegram_bot --cov-report=html

# Откройте coverage отчет
open htmlcov/index.html
```

### Типы тестов

- **Unit tests** — тестирование отдельных компонентов
- **Integration tests** — тестирование API и базы данных
- **Async tests** — тестирование асинхронного кода

---

## Лицензия

MIT License

---

## Вклад в проект

1. Форкните репозиторий
2. Создайте ветку для фичи (`git checkout -b feature/amazing-feature`)
3. Закоммитьте изменения (`git commit -m 'Add amazing feature'`)
4. Запушьте в ветку (`git push origin feature/amazing-feature`)
5. Создайте Pull Request

---

## Поддержка

При возникновении проблем:
1. Проверьте логи сервера
2. Убедитесь, что используете последнюю версию
3. Создайте issue в репозитории с описанием проблемы

---

## Changelog

### Версия 1.1.0 (текущая)

- Jira интеграция: выбор задач, эпики, связанные задачи
- Отправка оценки в Jira через браузерное расширение
- Jira wiki форматирование: [text|url], [PROJ-123], ссылки
- Редактируемый результат (contenteditable) с валидацией
- Авто-открытие карт при голосе всех участников
- Горячие клавиши: 1-9, R, O, N, J, Esc
- Epic Name в заголовке задачи
- Связанные задачи со статусами и датами
- Передача данных Jira всем участникам через JSON
- Улучшенный layout: результат наверх, анализ+гистограмма вместе

### Версия 1.0.0

- Web интерфейс с WebSocket
- Jira интеграция через browser extension
- Кастомные шкалы оценок
- Темная/светлая тема
- Звуковые уведомления
- Гистограмма распределения голосов
