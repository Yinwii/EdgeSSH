chcp 936 >nul 2>&1
@echo off
rem EdgeSSH 一键升级脚本（Windows）
rem 流程：git pull → npm ci → npm run build:server → 重启服务
rem 任意一步失败立即停止，不影响现有服务的运行状态。
setlocal

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

node server\cli.mjs update
if errorlevel 1 (
    echo.
    echo [update.cmd] 升级失败，服务保持升级前的状态未变。
    exit /b 1
)

endlocal
