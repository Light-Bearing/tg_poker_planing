# 📝 Руководство по подписи расширения для Firefox

## Почему нужно подписывать?

Firefox требует подписи всех расширений для защиты пользователей от вредоносного ПО. Без подписи расширение можно установить только временно (до перезапуска браузера).

---

## 🚀 Быстрая подпись (Self-distribution)

### Шаг 1: Зарегистрируйтесь на Mozilla Add-ons

1. Перейдите на [addons.mozilla.org](https://addons.mozilla.org/)
2. Нажмите **Sign In / Register**
3. Создайте учётную запись (можно через Google, GitHub, Apple)

### Шаг 2: Перейдите в Developer Hub

1. Откройте [Firefox Add-ons Developer Hub](https://addons.mozilla.org/developers/)
2. Войдите в учётную запись

### Шаг 3: Загрузите расширение

1. Нажмите **Submit a New Add-on**
2. Выберите файл `pp-jira-bridge-firefox.zip`
3. Выберите **Complete Review** (полная проверка) или **Self-review** (для внутренних расширений)

### Шаг 4: Заполните информацию

- **Name**: PP Jira Bridge
- **Description**: Прокси для отправки оценок из Planning Poker в Jira
- **Upload a new upload**: (если обновляете)
- **Tags**: jira, planning-poker, productivity
- **Homepage**: (опционально, ссылка на репозиторий)

### Шаг 5: Дождитесь проверки

- **Self-review**: Обычно 1-2 дня
- **Complete review**: 3-7 дней (может занять больше времени)

### Шаг 6: Получите подписанный ZIP

После одобрения:
1. Перейдите в **Your submissions**
2. Нажмите на расширение
3. В разделе **Versions** найдите версию
4. Скачайте подписанный ZIP файл

### Шаг 7: Распространение

Теперь вы можете:
- Разместить ZIP на внутреннем сервере
- Установить через политику предприятия (policies.json)
- Предоставить пользователям прямую ссылку

---

## 🔧 Автоматическая подпись через CLI (для продвинутых)

### Установите web-ext

```bash
npm install -g web-ext
```

### Авторизуйтесь

```bash
web-ext sign --api-key YOUR_API_KEY --api-secret YOUR_API_SECRET
```

API ключи можно получить в [Developer Hub → API Keys](https://addons.mozilla.org/developers/addon/api/key/)

### Подпишите расширение

```bash
cd browser-extension
web-ext sign --source-dir . --channel unlisted
```

Это создаст подписанный ZIP в папке `web-ext-artifacts/`

---

## 🏢 Внутреннее распространение (Enterprise)

### Вариант 1: policies.json

Создайте файл `distribution/policies.json` в папке установки Firefox:

```json
{
  "policies": {
    "ExtensionSettings": {
      "pp-jira-bridge@planningpoker.com": {
        "installation_mode": "force_installed",
        "install_url": "https://internal-server.local/pp-jira-bridge.xpi"
      }
    }
  }
}
```

### Вариант 2: Mozilla Add-ons для организаций

Если у вас есть организация, можно зарегистрировать расширение как **Organization Add-on** и распространять через внутренний портал.

---

## ⚠️ Важные ограничения

1. **ID расширения**: В `manifest-firefox.json` указан `pp-jira-bridge@planningpoker.com`. При подписании Mozilla может изменить ID. Зафиксируйте его в Developer Hub.

2. **Версии**: После подписания нельзя менять файлы расширения. Только повторная загрузка новой версии.

3. **Обновления**: Пользователи получат уведомление об обновлении, когда вы загрузите новую версию.

4. **Отзыв**: Mozilla может отозвать подпись, если расширение нарушает правила.

---

## 📞 Полезные ссылки

- [Firefox Add-ons Documentation](https://extensionworkshop.com/)
- [WebExtensions API](https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions)
- [Review Policy](https://extensions.mozilla.org/content/about/review-queue)
- [Signboarding Guide](https://extensionworkshop.com/documentation/develop/submitting-an-add-on/)

---

## ❓ FAQ

**Q: Можно ли избежать подписи?**  
A: Только для временной установки через `about:debugging` или в Firefox Developer Edition/Nightly с отключённой проверкой.

**Q: Сколько стоит подпись?**  
A: Бесплатно. Платные расширения доступны, но требуют дополнительного рассмотрения.

**Q: Можно ли публиковать как приватное?**  
A: Да, при загрузке выберите **Unlisted** или **Private**. Такие расширения не видны в публичном каталоге.

**Q: Что если проверка отклонена?**  
A: Вы получите комментарий от ревьюера. Исправьте проблемы и загрузите новую версию.
