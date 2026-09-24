chcp 936 >nul 2>&1
@echo off
rem EdgeSSH 一键迁移：当前 Windows → 远程 Linux
rem 流程：停服 → 打备份 → 远程 git clone → 上传 deploy.sh + 备份 → 远程 deploy
rem
rem 用法（双击或直接运行即可）：
rem   migrate.cmd
rem
rem 启动后按提示输入：远程主机 (user@hostname) 和（可选）远程安装路径
rem 默认远程路径 /opt/edgessh
rem 前置：Windows 10 1809+（自带 OpenSSH 客户端：scp / ssh / tar）
setlocal EnableDelayedExpansion

cd /d "%~dp0"

set "REMOTE="
set "REMOTE_PATH=/opt/edgessh"

rem ---- 解析参数（支持 --path 覆盖）----
:parse
if "%~1"=="" goto :prompt
if /i "%~1"=="--path" ( set "REMOTE_PATH=%~2" & shift & shift & goto :parse )
if "!REMOTE!"=="" ( set "REMOTE=%~1" & shift & goto :parse )
echo [migrate] 未知参数：%~1 & pause & exit /b 1

rem ---- 交互式补全：未传位置参数则询问远程主机 ----
rem 注意：set /p 在空输入时会写入单个空格，需手动清掉。
:prompt
if "!REMOTE!"=="" (
    set /p "REMOTE=请输入远程主机 (user@hostname)："
    if "!REMOTE!"==" " set "REMOTE="
)
if "!REMOTE!"=="" (
    echo [migrate] 未输入远程主机，退出。
    pause & exit /b 1
)

set /p "RP_INPUT=远程安装路径 [!REMOTE_PATH!]（回车跳过）："
if "!RP_INPUT!"==" " set "RP_INPUT="
if not "!RP_INPUT!"=="" set "REMOTE_PATH=!RP_INPUT!"

where scp >nul 2>nul || (echo [migrate] 找不到 scp & pause & exit /b 1)
where ssh >nul 2>nul || (echo [migrate] 找不到 ssh & pause & exit /b 1)
where tar >nul 2>nul || (echo [migrate] 找不到 tar & pause & exit /b 1)

echo.
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
ssh "!REMOTE!" "test -d '!REMOTE_PATH!/.git' || git clone https://github.com/Yinwii/EdgeSSH.git '!REMOTE_PATH!'"

echo [migrate] 4/5 上传 deploy.sh 和备份 ...
scp deploy.sh "!REMOTE!:/tmp/deploy.sh"
scp "!TARBALL!" "!REMOTE!:/tmp/!TARBALL!"

echo [migrate] 5/5 远程 deploy ...
echo       （首次会装 Node.js，约 1-2 分钟）
ssh -tt "!REMOTE!" "/tmp/deploy.sh '!REMOTE_PATH!' /tmp/!TARBALL!"
set "REMOTE_RC=%errorlevel%"

del "!TARBALL!" 2>nul

if %REMOTE_RC% equ 0 (
    echo [migrate] 完成 ^!
    echo   状态：ssh !REMOTE! "cd !REMOTE_PATH! ^&^& node server/cli.mjs status"
) else (
    echo [migrate] 远程失败，备份在远程 /tmp/!TARBALL!
)
exit /b %REMOTE_RC%
