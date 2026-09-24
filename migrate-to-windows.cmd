chcp 936 >nul 2>&1
title EdgeSSH :: migrate-to-windows
@echo off
rem EdgeSSH 一键迁移：当前 Windows → 远程 Windows
rem 流程：停服 → 打备份 → 远程 git clone → 上传 deploy.cmd + 备份 → 远程 deploy
rem
rem 用法：
rem   migrate-to-windows.cmd [user@hostname] [--path C:\remote\path]
rem
rem 前置：Windows 10 1809+ 自带 OpenSSH 客户端（scp / ssh / tar），远端默认 shell 为 cmd.exe。
rem 说明：所有 ssh/scp 走 SSH ControlMaster，密码只在第一次 ssh 时要求输入。
setlocal EnableDelayedExpansion

cd /d "%~dp0"

rem ---- 解析参数 ----
set "REMOTE="
set "REMOTE_PATH=C:\edgessh"
:parse
if "%~1"=="" goto :prompt
if /i "%~1"=="--path" ( set "REMOTE_PATH=%~2" & shift & shift & goto :parse )
if "!REMOTE!"=="" ( set "REMOTE=%~1" & shift & goto :parse )
echo [migrate] 未知参数：%~1 & pause & exit /b 1

:prompt
if "!REMOTE!"=="" (
    set /p "REMOTE=请输入远程主机 (user@hostname)："
    if "!REMOTE!"==" " set "REMOTE="
)
if "!REMOTE!"=="" ( echo [migrate] 未输入远程主机，退出。 & pause & exit /b 1 )

rem 拿到目标主机后更新窗口标题，方便多开时区分
title EdgeSSH :: migrate-to-windows -^> !REMOTE!

set /p "RP_INPUT=远程安装路径 [!REMOTE_PATH!]（回车跳过）："
if "!RP_INPUT!"==" " set "RP_INPUT="
if not "!RP_INPUT!"=="" set "REMOTE_PATH=!RP_INPUT!"

where scp >nul 2>&1 || (echo [migrate] 找不到 scp & pause & exit /b 1)
where ssh >nul 2>&1 || (echo [migrate] 找不到 ssh & pause & exit /b 1)
where tar >nul 2>&1 || (echo [migrate] 找不到 tar & pause & exit /b 1)

rem ---- SSH ControlMaster：一次密码, 所有 ssh/scp 共享同一认证会话 ----
rem 8.3 短路径避免 USERPROFILE 里的空格被 SSH 错误地截断 ControlPath 值。
if not exist "%USERPROFILE%\.ssh" mkdir "%USERPROFILE%\.ssh" >nul 2>&1
for %%i in ("%USERPROFILE%\.ssh") do set "CM_DIR_SHORT=%%~si"
set "CM_PATH=!CM_DIR_SHORT!\edgessh-cm-%%r@%%h-%%p"

echo.
echo [migrate] 远程 : !REMOTE!:!REMOTE_PATH!
echo [migrate] 首次 ssh 会要求输入密码；后续 ssh/scp 自动复用认证
echo.

echo [migrate] 1/5 停止本地服务 ...
call node server\cli.mjs stop 2>nul || echo       [跳过] 本地服务未运行

echo [migrate] 2/5 打备份 ...
for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%i"
set "TARBALL=edgessh-migrate-!STAMP!.tar.gz"
tar -czf "!TARBALL!" .env server\data\ENCRYPTION_KEY server\data\state 2>nul
if not exist "!TARBALL!" ( echo [migrate] 打包失败 & pause & exit /b 1 )
echo       备份：!TARBALL!

echo [migrate] 3/5 远程 git clone ...
rem 远端默认 shell 是 cmd.exe，用 cmd 语法（bash 没装差异）
call :ssh "!REMOTE!" 'if not exist "!REMOTE_PATH!\.git" ( git clone https://github.com/Yinwii/EdgeSSH.git "!REMOTE_PATH!" )'
if errorlevel 1 ( echo [migrate] 第 3 步失败：远程 git clone 未成功 & call :ssh_exit & pause & exit /b 1 )

echo [migrate] 4/5 上传 deploy.cmd 和备份 ...
call :scp deploy.cmd "!REMOTE!:/tmp/deploy.cmd"
if errorlevel 1 ( echo [migrate] 第 4 步失败：deploy.cmd 上传未成功 & call :ssh_exit & pause & exit /b 1 )
call :scp "!TARBALL!" "!REMOTE!:/tmp/!TARBALL!"
if errorlevel 1 ( echo [migrate] 第 4 步失败：备份上传未成功 & call :ssh_exit & pause & exit /b 1 )

echo [migrate] 5/5 远程 deploy （首次会装 Node.js，约 1-2 分钟）...
call :ssh "!REMOTE!" "/tmp/deploy.cmd !REMOTE_PATH! /tmp/!TARBALL!"
set "REMOTE_RC=%errorlevel%"

call :ssh_exit
del "!TARBALL!" 2>nul

echo.
if !REMOTE_RC! equ 0 (
    echo [migrate] 完成
    echo   状态：ssh !REMOTE! "cd /d !REMOTE_PATH! ^&^& call status.cmd"
) else (
    echo [migrate] 远程 deploy 失败
    echo   备份仍在远程 /tmp/!TARBALL!
)
pause
exit /b !REMOTE_RC!

rem ========== 子程序 ==========

:ssh  args...
ssh -o ConnectTimeout=30 -o ControlMaster=auto -o "ControlPath=!CM_PATH!" -o ControlPersist=600 %*
exit /b %errorlevel%

:scp args...
scp -o ConnectTimeout=30 -o ControlMaster=auto -o "ControlPath=!CM_PATH!" -o ControlPersist=600 %*
exit /b %errorlevel%

:ssh_exit
ssh -o "ControlPath=!CM_PATH!" -O exit "!REMOTE!" 2>nul
exit /b 0
