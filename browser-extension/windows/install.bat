@echo off
REM PP Jira Bridge — Quick Installer for Windows
REM Double-click this file to install

echo.
echo ================================================
echo   PP Jira Bridge — Windows Installer
echo ================================================
echo.

REM Check if running as admin
net session >nul 2>&1
if %errorLevel% == 0 (
    echo Running with administrator privileges...
    powershell -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
) else (
    echo Running without administrator privileges.
    echo Some features may not work.
    echo.
    powershell -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
)

echo.
echo Press any key to exit...
pause >nul
