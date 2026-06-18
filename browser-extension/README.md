# PP Jira Bridge — Browser Extension

Расширение для интеграции Planning Poker с Jira. Обходит CORS ограничения, позволяя отправлять оценки напрямую в Jira из браузера.

## 🆕 Что нового в версии 1.0.0

| Фича | Chrome | Firefox | Edge |
|------|--------|---------|------|
| Manifest V3 | ✅ | ❌ (V2) | ✅ |
| Кроссбраузерность | ✅ | ✅ | ✅ |
| Popup с настройками | ✅ | ✅ | ✅ |
| Автоопределение браузера | ✅ | ✅ | ✅ |
| Инструкции в браузере | ✅ | ✅ | ✅ |
| Windows автоустановка | ❌ | ❌ | ❌ |

### Новые возможности:

1. **Кроссбраузерная поддержка** — работает в Chrome, Firefox и Edge
2. **WebExtension Polyfill** — единая кодовая база для всех браузеров
3. **Popup UI** — удобная панель настроек прямо в расширении
4. **Автоопределение браузера** — показывает правильную инструкцию для каждого браузера
5. **Страницы установки** — красивые инструкции при скачивании
6. **Windows скрипт** — автоматическая установка для корпоративных пользователей

## 🌐 Поддерживаемые браузеры

| Браузер | Версия | Статус |
|---------|--------|--------|
| Chrome / Chromium | Manifest V3 | ✅ Полная поддержка |
| Firefox | 109+ | ✅ Полная поддержка |
| Edge | Manifest V3 | ✅ Полная поддержка |
| Safari | - | ⚠️ Требуется адаптация |

## 📦 Структура проекта

```
browser-extension/
├── manifest.json           # Manifest V3 для Chrome
├── manifest-firefox.json   # Manifest V2 для Firefox
├── browser-polyfill.min.js # Polyfill для кроссбраузерности
├── background.js           # Background script
├── content.js              # Content script
├── popup.html             # UI для настроек
├── popup.js               # Логика popup
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── README.md
```

## 🔧 Установка для разработки

### Chrome / Chromium

1. Откройте `chrome://extensions/`
2. Включите **Developer mode** (переключатель в правом верхнем углу)
3. Нажмите **Load unpacked**
4. Выберите папку `browser-extension/`

### Firefox (временно/для разработки)

⚠️ **Важно:** Firefox требует подписи расширений для установки. Для разработки есть обходной путь:

1. Откройте `about:debugging#/runtime/this-firefox`
2. Нажмите **Load Temporary Add-on...**
3. Выберите файл `manifest-firefox.json` из папки расширения
4. Расширение загрузится до перезапуска браузера

> Temporary add-ons исчезают после перезапуска Firefox. Для постоянной установки нужна подпись.

### Firefox (постоянная установка)

Для постоянной установки расширение должно быть подписано Mozilla:

1. Зарегистрируйтесь на [Firefox Add-ons Developer Hub](https://addons.mozilla.org/developers/)
2. Создайте учётную запись и подтвердите email
3. Нажмите **Submit a New Add-on**
4. Загрузите ZIP-архив с расширением
5. Пройдите процесс проверки (может занять от нескольких часов до нескольких дней)
6. После одобрения расширение появится в вашем аккаунте для установки

**Альтернатива для внутреннего использования:**

Вы можете создать **неподписанную версию** для внутреннего использования:

1. В `about:config` установите `xpinstall.signatures.required` в `false`
2. Перезапустите Firefox
3. Установите расширение как обычное (через `about:debugging`)

> ⚠️ Этот метод работает только в **Developer Edition** или **Nightly** версиях Firefox, либо требует отключения проверки подписей (не рекомендуется для продакшена).

## 🚀 Сборка для публикации

### Для Chrome

```bash
cd browser-extension
# Упакуйте в ZIP
zip -r pp-jira-bridge-chrome.zip . -x "*.git*"
```

### Для Firefox

```bash
cd browser-extension
# Копируем manifest-firefox.json на место manifest.json
cp manifest-firefox.json manifest.json
# Упакуйте в ZIP
zip -r pp-jira-bridge-firefox.zip . -x "*.git*"
# Восстанавливаем оригинальный manifest
cp manifest.json manifest-firefox.json
```

Или используйте скрипт сборки:

```bash
./build.sh
```

## 📝 Как использовать

1. Установите расширение
2. Кликните на иконку расширения
3. Введите URL вашей Jira (например, `https://your-company.atlassian.net`)
4. Создайте API Token в Jira: [id.atlassian.com/manage/api-tokens](https://id.atlassian.com/manage/api-tokens)
5. Введите Token в поле "API Token"
6. Нажмите **Проверить подключение**
7. Нажмите **Загрузить список полей** и выберите ID поля для Story Points
8. Нажмите **Сохранить настройки**

## 🔑 Получение API Token для Jira

1. Перейдите на [id.atlassian.com/manage/api-tokens](https://id.atlassian.com/manage/api-tokens)
2. Нажмите **Create token**
3. Дайте токену имя (например, "PP Jira Bridge")
4. Скопируйте токен и сохраните его в безопасном месте
5. Вставьте токен в настройки расширения

**Важно:** Token виден только один раз при создании!

## 🐛 Устранение проблем

### Firefox: "Extension is not signed"

- Используйте временную загрузку через `about:debugging`
- Или подпишите расширение через Mozilla Add-ons
- Для внутреннего использования: установите `xpinstall.signatures.required = false` в `about:config`

### Chrome: "Extension is corrupted"

- Переустановите расширение
- Проверьте, что все файлы на месте

### Подключение не работает

- Проверьте URL Jira (должен быть без слэша в конце)
- Проверьте, что Token действителен
- Проверьте консоль разработчика (`F12` → Console)

## 📚 Технические детали

### API Permissions

| Permission | Описание |
|------------|----------|
| `storage` | Сохранение настроек |
| `<all_urls>` | Работа на любых сайтах (Planning Poker, Jira) |

### Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Planning Poker │────▶│  Content Script │────▶│  Background     │
│  (Web Page)     │     │  (content.js)   │     │  (background.js)│
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │     Jira API    │
                                                └─────────────────┘
```

### Communication Flow

1. Страница Planning Poker отправляет кастомное событие `pp-jira-message`
2. Content script перехватывает событие и пересылает в background script
3. Background script делает запрос к Jira API
4. Ответ возвращается через content script обратно на страницу

## 🔄 Обновление

### Chrome

1. Перейдите на `chrome://extensions/`
2. Нажмите на иконку обновления (↻) у расширения
3. Или удалите и загрузите заново

### Firefox

Temporary add-ons автоматически обновляются при перезагрузке страницы `about:debugging`.

## 📄 License

MIT License

## 👥 Contact

Для вопросов и предложений создавайте issue в репозитории.
