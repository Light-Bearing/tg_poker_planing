# PP Jira Bridge — Автоматическая установка для Windows

Этот скрипт автоматически установит расширение PP Jira Bridge в браузеры Chrome и Firefox.

## 🚀 Быстрая установка

### Вариант 1: Двойной клик

1. Распакуйте архив с расширением
2. Дважды кликните на `install-windows.ps1`
3. Следуйте инструкциям в окне PowerShell

### Вариант 2: Через PowerShell

1. Откройте PowerShell в папке с расширением
2. Выполните:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\install-windows.ps1
```

---

## 📋 Что делает скрипт

### Для Chrome:
- Находит профиль Chrome
- Копирует расширение в папку `Extensions`
- Создаёт файл `ExtensionsConfig` (требуется групповая политика)
- Автоматически загружает расширение

### Для Firefox:
- Находит профиль Firefox
- Копирует расширение в папку `extensions`
- Создаёт `distribution/policies.json` для автоматической установки
- Расширение установится после перезапуска браузера

---

## ⚙️ Требования

- Windows 10/11
- PowerShell 5.1 или выше
- Chrome или Firefox должны быть установлены
- Права администратора (опционально, для системной установки)

---

## 🐛 Устранение проблем

### "Script blocked by execution policy"

Выполните в PowerShell:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

### "Chrome не найден"

Убедитесь, что Chrome установлен. Скрипт ищет в стандартных расположениях:
- `C:\Program Files\Google\Chrome\Application`
- `C:\Program Files (x86)\Google\Chrome\Application`

### "Firefox не найден"

Скрипт ищет Firefox в:
- `C:\Program Files\Mozilla Firefox`
- `C:\Program Files (x86)\Mozilla Firefox`

### "Расширение не появилось"

1. Перезапустите браузер
2. Откройте `chrome://extensions/` или `about:addons`
3. Проверьте, включено ли расширение

---

## 📞 Поддержка

Если скрипт не работает:
1. Запустите PowerShell от имени администратора
2. Выполните скрипт вручную с флагом `-Verbose`
3. Проверьте логи в папке `logs/`
