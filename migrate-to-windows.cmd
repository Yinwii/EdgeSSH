@echo off
rem EdgeSSH 一键迁移：当前 Windows → 远程 Windows
rem 流程：停服 → 打备份 → 远程 git clone → 上传 deploy.cmd + 备份 → 远程 deploy
rem
rem 用法：
rem   migrate-to-windows.cmd user@hostname [--path C:\edgessh]
rem
rem 前置：Windows 10 1809+（自带 OpenSSH 客户端：scp / ssh / tar）
rem 默认远程路径 C:\edgessh
setlocal EnableDelayedExpansion

cd /d "%~dp0"

set "REMOTE="
set "REMOTE_PATH=C:\edgessh"
:parse
if "%~1"=="" goto :done
if /i "%~1"=="--path" ( set "REMOTE_PATH=%~2" & shift & shift & goto :parse )
if "!REMOTE!"=="" ( set "REMOTE=%~1" & shift & goto :parse )
echo [migrate] 未知参数：%~1 & pause & exit /b 1
:done
if "!REMOTE!"=="" (
    echo [migrate] 用法：migrate-to-windows.cmd user@hostname [--path C:\edgessh]
    pause
    exit /b 1
)
where scp >nul 2>nul || (echo [migrate] 找不到 scp & pause & exit /b 1)
where ssh >nul 2>nul || (echo [migrate] 找不到 ssh & pause & exit /b 1)
where tar >nul 2>nul || (echo [migrate] 找不到 tar & pause & exit /b 1)

echo [migrate] 远程 : !REMOTE!:!REMOTE_PATH!
echo.

echo [migrate] 1/5 停止本地服务 ...
call node server\cli.mjs stop || echo       跳过

echo [migrate] 2/5 打备份 ...
for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%i"
set "TARBALL=edgessh-migrate-!STAMP!.tar.gz"
tar -czf "!TARBALL!" .env server\data\ENCRYPTION_KEY server\data\state 2>nul
if not exist "!TARBALL!" ( echo [migrate] 打包失败 & pause & exit /b 1 )

echo [migrate] 3/5 远程 git clone ...
ssh "!REMOTE!" "if not exist !REMOTE_PATH!\.git ( git clone https://github.com/Yinwii/EdgeSSH.git !REMOTE_PATH! )"

echo [migrate] 4/5 上传 deploy.cmd 和备份 ...
scp deploy.cmd "!REMOTE!:/tmp/deploy.cmd"
scp "!TARBALL!" "!REMOTE!:/tmp/!TARBALL!"

echo [migrate] 5/5 远程 deploy ...
echo       （首次会装 Node.js，约 1-2 分钟）
ssh "!REMOTE!" "/tmp/deploy.cmd !REMOTE_PATH! /tmp/!TARBALL!"
set "REMOTE_RC=%errorlevel%"

del "!TARBALL!" 2>nul

if %REMOTE_RC% equ 0 (
    echo [migrate] 完成 ^!
    echo   状态：ssh !REMOTE! "cd /d !REMOTE_PATH! ^&^& call status.cmd"
) else (
    echo [migrate] 远程失败，备份在远程 /tmp/!TARBALL!
)
exit /b %REMOTE_RC%