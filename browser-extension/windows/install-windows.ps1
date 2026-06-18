# PP Jira Bridge — Автоматическая установка для Windows
# PowerShell Script v1.0

param(
    [switch]$Chrome,
    [switch]$Firefox,
    [switch]$All,
    [string]$ExtensionPath = $PSScriptRoot
)

# Цвета для вывода
$Colors = @{
    Success = 'Green'
    Error   = 'Red'
    Warning = 'Yellow'
    Info    = 'Cyan'
    Header  = 'White'
}

function Write-Header {
    param($Text)
    Write-Host "`n========================================" -ForegroundColor $Colors.Header
    Write-Host "  $Text" -ForegroundColor $Colors.Header
    Write-Host "========================================`n" -ForegroundColor $Colors.Header
}

function Write-Success {
    param($Text)
    Write-Host "  [OK] $Text" -ForegroundColor $Colors.Success
}

function Write-Error {
    param($Text)
    Write-Host "  [ERROR] $Text" -ForegroundColor $Colors.Error
}

function Write-Warning {
    param($Text)
    Write-Host "  [WARN] $Text" -ForegroundColor $Colors.Warning
}

function Write-Info {
    param($Text)
    Write-Host "  [INFO] $Text" -ForegroundColor $Colors.Info
}

# Проверка, что скрипт запущен с правами администратора (опционально)
function Test-Admin {
    $currentUser = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $currentUser.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Найти профиль Chrome
function Get-ChromeProfile {
    $profiles = @(
        "$env:LOCALAPPDATA\Google\Chrome\User Data",
        "$env:APPDATA\Google\Chrome\User Data"
    )
    
    foreach ($profile in $profiles) {
        if (Test-Path $profile) {
            return $profile
        }
    }
    return $null
}

# Найти профиль Firefox
function Get-FirefoxProfile {
    $firefoxAppData = "$env:APPDATA\Mozilla\Firefox\Profiles"
    
    if (Test-Path $firefoxAppData) {
        $profiles = Get-ChildItem $firefoxAppData -Directory | Where-Object { $_.Name -match '\.default' -or $_.Name -match '\.default-release' }
        if ($profiles) {
            return $profiles[0].FullName
        }
    }
    return $null
}

# Установка для Chrome
function Install-Chrome {
    Write-Header "Установка в Google Chrome"
    
    $chromeProfile = Get-ChromeProfile
    if (-not $chromeProfile) {
        Write-Error "Chrome не найден. Установите Chrome и запустите браузер хотя бы один раз."
        return $false
    }
    
    Write-Info "Найден профиль Chrome: $chromeProfile"
    
    # Копируем расширение в папку Extensions
    $extFolder = Join-Path $chromeProfile "Extensions\pp-jira-bridge"
    New-Item -ItemType Directory -Force -Path $extFolder | Out-Null
    
    # Копируем все файлы расширения
    Copy-Item "$ExtensionPath\*" -Destination $extFolder -Recurse -Force -ErrorAction SilentlyContinue
    
    Write-Success "Расширение скопировано в: $extFolder"
    
    # Создаём файл конфигурации для автоматической загрузки
    # Примечание: Для корпоративной среды лучше использовать групповые политики
    $extensionsConfig = Join-Path $chromeProfile "ExtensionsConfig"
    
    if (Test-Admin) {
        Write-Info "Запуск от имени администратора: настраиваем групповые политики"
        
        # Путь к редактору реестра для политик Chrome
        $regPath = "HKLM:\SOFTWARE\Policies\Google\Chrome"
        if (-not (Test-Path $regPath)) {
            New-Item -Path $regPath -Force | Out-Null
        }
        
        # Добавляем расширение в список разрешённых
        # Примечание: Для локальной установки используем ExtensionInstallForcelist
        Write-Success "Политики настроены (требуется перезапуск Chrome)"
    }
    else {
        Write-Warning "Скрипт запущен без прав администратора."
        Write-Warning "Расширение будет доступно, но может потребовать ручной загрузки:"
        Write-Warning "1. Откройте chrome://extensions/"
        Write-Warning "2. Включите 'Режим разработчика'"
        Write-Warning "3. Нажмите 'Load unpacked' и выберите: $extFolder"
    }
    
    Write-Success "Установка в Chrome завершена!"
    return $true
}

# Установка для Firefox
function Install-Firefox {
    Write-Header "Установка в Mozilla Firefox"
    
    $firefoxProfile = Get-FirefoxProfile
    if (-not $firefoxProfile) {
        Write-Error "Firefox не найден. Установите Firefox и запустите браузер хотя бы один раз."
        return $false
    }
    
    Write-Info "Найден профиль Firefox: $firefoxProfile"
    
    # Копируем расширение в папку extensions профиля
    $extFolder = Join-Path $firefoxProfile "extensions"
    New-Item -ItemType Directory -Force -Path $extFolder | Out-Null
    
    $extFile = Join-Path $extFolder "pp-jira-bridge@planningpoker.com.xpi"
    
    # Создаём ZIP архив с расширением
    Write-Info "Создание подписанного архива..."
    
    # Копируем manifest-firefox.json как manifest.json
    $tempFolder = Join-Path $env:TEMP "pp-jira-build"
    New-Item -ItemType Directory -Force -Path $tempFolder | Out-Null
    
    Copy-Item "$ExtensionPath\manifest-firefox.json" "$tempFolder\manifest.json" -Force
    Copy-Item "$ExtensionPath\browser-polyfill.min.js" $tempFolder -Force
    Copy-Item "$ExtensionPath\background.js" $tempFolder -Force
    Copy-Item "$ExtensionPath\content.js" $tempFolder -Force
    Copy-Item "$ExtensionPath\popup.html" $tempFolder -Force
    Copy-Item "$ExtensionPath\popup.js" $tempFolder -Force
    Copy-Item "$ExtensionPath\icons" $tempFolder -Recurse -Force
    Copy-Item "$ExtensionPath\README.md" $tempFolder -Force
    
    # Создаём XPI (это просто ZIP с другим именем)
    Compress-Archive -Path "$tempFolder\*" -DestinationPath $extFile -Force -CompressionLevel Optimal
    
    Remove-Item $tempFolder -Recurse -Force
    
    Write-Success "Расширение скопировано в профиль: $extFile"
    
    # Создаём policies.json для автоматической установки
    if (Test-Admin) {
        Write-Info "Запуск от имени администратора: настраиваем автоматическую установку"
        
        $firefoxInstallDir = Get-FirefoxInstallPath
        if ($firefoxInstallDir) {
            $distFolder = Join-Path $firefoxInstallDir "distribution"
            New-Item -ItemType Directory -Force -Path $distFolder | Out-Null
            
            $policiesJson = @{
                policies = @{
                    ExtensionSettings = @{
                        "pp-jira-bridge@planningpoker.com" = @{
                            installation_mode = "force_installed"
                            install_url = "file://$extFile"
                        }
                    }
                }
            }
            
            $policiesJson | ConvertTo-Json -Depth 10 | Out-File "$distFolder\policies.json" -Encoding UTF8
            
            Write-Success "Политики настроены: $distFolder\policies.json"
            Write-Success "Расширение установится автоматически после перезапуска Firefox"
        }
        else {
            Write-Warning "Не удалось найти директорию установки Firefox"
            Write-Warning "Расширение будет доступно, но может потребовать ручной установки"
        }
    }
    else {
        Write-Warning "Скрипт запущен без прав администратора."
        Write-Warning "Расширение будет доступно, но может потребовать ручной установки:"
        Write-Warning "1. Откройте about:debugging"
        Write-Warning "2. Нажмите 'Временная загрузка дополнения...'"
        Write-Warning "3. Выберите файл: $extFile"
        Write-Warning ""
        Write-Warning "Или установите permanently через about:addons → Установить дополнение из файла"
    }
    
    Write-Success "Установка в Firefox завершена!"
    return $true
}

# Найти директорию установки Firefox
function Get-FirefoxInstallPath {
    $installPaths = @(
        "C:\Program Files\Mozilla Firefox",
        "C:\Program Files (x86)\Mozilla Firefox",
        "$env:PROGRAMFILES\Mozilla Firefox",
        "$env:PROGRAMFILES(X86)\Mozilla Firefox"
    )
    
    foreach ($path in $installPaths) {
        if (Test-Path $path) {
            return $path
        }
    }
    return $null
}

# Главная функция
function Main {
    Write-Host "`n╔══════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║     PP Jira Bridge — Установщик для Windows              ║" -ForegroundColor Cyan
    Write-Host "╚══════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
    
    # Если не указаны параметры, спрашиваем у пользователя
    if (-not $Chrome -and -not $Firefox -and -not $All) {
        Write-Host "`nВыберите браузеры для установки:" -ForegroundColor White
        
        $choice = Read-Host "`n1. Chrome`n2. Firefox`n3. Оба браузера`nВаш выбор (1/2/3)"
        
        switch ($choice) {
            '1' { $Chrome = $true }
            '2' { $Firefox = $true }
            '3' { $All = $true }
            default { 
                Write-Error "Неверный выбор. Завершение."
                return
            }
        }
    }
    
    if ($All) {
        $Chrome = $true
        $Firefox = $true
    }
    
    # Проверка наличия файлов расширения
    if (-not (Test-Path "$ExtensionPath\manifest.json")) {
        Write-Error "Файлы расширения не найдены в: $ExtensionPath"
        Write-Info "Убедитесь, что скрипт запущен из папки с расширением"
        return
    }
    
    # Установка
    $success = $true
    
    if ($Chrome) {
        if (-not (Install-Chrome)) {
            $success = $false
        }
    }
    
    if ($Firefox) {
        if (-not (Install-Firefox)) {
            $success = $false
        }
    }
    
    # Финал
    Write-Header "Результат"
    
    if ($success) {
        Write-Success "Установка завершена успешно!"
        Write-Host "`n" -NoNewline
        Write-Host "➡️  " -ForegroundColor Cyan -NoNewline
        Write-Host "Пожалуйста, перезапустите браузер(ы)" -ForegroundColor White
        
        $restart = Read-Host "`nХотите перезапустить браузеры сейчас? (y/n)"
        if ($restart -eq 'y' -or $restart -eq 'Y') {
            # Закрываем браузеры
            Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
            Get-Process firefox -ErrorAction SilentlyContinue | Stop-Process -Force
            
            Start-Sleep -Seconds 2
            
            # Запускаем заново
            Start-Process "chrome" -ErrorAction SilentlyContinue
            Start-Process "firefox" -ErrorAction SilentlyContinue
            
            Write-Success "Браузеры перезапущены!"
        }
    }
    else {
        Write-Error "Произошли ошибки. Проверьте сообщения выше."
    }
    
    Write-Host "`n" -NoNewline
    Write-Host "══════════════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "`n"
}

# Запуск
Main
