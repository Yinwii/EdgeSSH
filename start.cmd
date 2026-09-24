chcp 936 >nul 2>&1
title EdgeSSH :: start
@echo off
rem EdgeSSH 一键启动（Windows）：双击运行即可，核心逻辑见 server\cli.mjs
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo [EdgeSSH] 未找到 node，请先安装 Node.js 22.12+ https://nodejs.org/ & pause & exit /b 1)
node server\cli.mjs start %*
pause
