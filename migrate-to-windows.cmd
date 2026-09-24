chcp 936 >nul 2>&1
title EdgeSSH :: migrate-to-windows
@echo off
rem EdgeSSH 一键迁移：当前 Windows → 远程 Windows
rem 流程：停服 → 打备份 → 一条 ssh 完成（传输 + 远程部署）
rem
rem 用法：
rem   migrate-to-windows.cmd [user@hostname] [--path C:\remote\path]
rem
rem 认证说明：整个迁移只有一条 ssh 连接，密码只输 1 次。
rem   （Windows 自带 OpenSSH 不支持 ControlMaster，旧版本因此报
rem    "getsockname failed: Not a socket"，已移除该方案。）
rem 前置：远端 Windows 10 1809+（OpenSSH 服务 + tar），远端默认 shell 为 cmd.exe。
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

set "MIG_PORT="
set /p "MIG_PORT=服务端口 [沿用备份里的设置]（回车跳过）："
if "!MIG_PORT!"==" " set "MIG_PORT="

rem 远程命令经一层 ssh + 一层 cmd 传递，路径含 & 等特殊字符会断链，直接拒绝
if not "!REMOTE_PATH:&=!"=="!REMOTE_PATH!" (
    echo [migrate] 远程路径含 ^& 字符，无法安全传递，请更换路径。 & pause & exit /b 1
)

where ssh >nul 2>&1 || (echo [migrate] 找不到 ssh & pause & exit /b 1)
where tar >nul 2>&1 || (echo [migrate] 找不到 tar & pause & exit /b 1)

echo.
echo [migrate] 远程 : !REMOTE!:!REMOTE_PATH!
echo [migrate] 整个迁移只建一条 ssh 连接，密码只输 1 次
echo.

echo [migrate] 1/3 停止本地服务 ...
node server\cli.mjs stop 2>nul || echo       [跳过] 本地服务未运行

echo [migrate] 2/3 打备份 ...
for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%i"
set "TARBALL=edgessh-migrate-!STAMP!.tar.gz"
tar -czf "!TARBALL!" .env server\data\ENCRYPTION_KEY server\data\state 2>nul
if not exist "!TARBALL!" ( echo [migrate] 打包失败 & pause & exit /b 1 )
echo       备份：!TARBALL!

echo [migrate] 3/3 传输 + 远程部署（首次会装 Node.js，约 1-2 分钟）...
rem deploy.cmd + 备份打成一个包，经 ssh 标准输入送到远端 C:\edgessh-mig 解压，
rem 参数用环境变量传（MIG_TARGET/MIG_BACKUP），避免跨 shell 的引号转义问题。
set "BUNDLE=edgessh-upload-!STAMP!.tar.gz"
tar -czf "!BUNDLE!" deploy.cmd "!TARBALL!"
set "PORTSET="
if not "!MIG_PORT!"=="" set "PORTSET=PORT_OVERRIDE=!MIG_PORT!& "
ssh -o ConnectTimeout=30 "!REMOTE!" "rd /s /q C:\edgessh-mig 2>nul & md C:\edgessh-mig && tar -xzf - -C C:\edgessh-mig && set DEPLOY_BATCH=1& set MIG_TARGET=!REMOTE_PATH!& set MIG_BACKUP=C:\edgessh-mig\!TARBALL!& !PORTSET!call C:\edgessh-mig\deploy.cmd" < "!BUNDLE!"
set "REMOTE_RC=!errorlevel!"

del "!BUNDLE!" "!TARBALL!" 2>nul

echo.
if !REMOTE_RC! equ 0 (
    echo [migrate] 完成
    echo   状态：ssh !REMOTE! "cd /d !REMOTE_PATH! ^&^& call status.cmd"
) else (
    echo [migrate] 远程部署失败（退出码 !REMOTE_RC!）
    echo   备份仍在远程 C:\edgessh-mig\
)
pause
exit /b !REMOTE_RC!
