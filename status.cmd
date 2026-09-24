chcp 936 >nul 2>&1
@echo off
rem EdgeSSH 查看运行状态与最近日志（Windows）
setlocal
cd /d "%~dp0"
node server\cli.mjs log --lines 30 %*
pause
