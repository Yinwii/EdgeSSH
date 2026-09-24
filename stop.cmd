@echo off
rem EdgeSSH 一键停止（Windows）：双击运行即可，核心逻辑见 server\cli.mjs
setlocal
cd /d "%~dp0"
node server\cli.mjs stop %*
pause
