chcp 936 >nul 2>&1
@echo off
rem EdgeSSH 一键重启（Windows）：双击运行即可，可加 --rebuild 强制重建
setlocal
cd /d "%~dp0"
node server\cli.mjs restart %*
pause
