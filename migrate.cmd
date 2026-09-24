chcp 936 >nul 2>&1
title EdgeSSH :: migrate
@echo off
rem EdgeSSH 一键迁移：当前 Windows → 远程 Linux
rem 流程：停服 → 打备份 → 一条 ssh 完成（传输 + 远程部署）
rem
rem 用法（双击运行，按提示输入；也可直接传参）：
rem   migrate.cmd [user@hostname] [--path /remote/path]
rem
rem 认证说明：整个迁移只有一条 ssh 连接，密码只输 1 次。
rem   注意：Windows 自带的 OpenSSH 不支持 ControlMaster 连接复用，
rem   旧版本因此报 "getsockname failed: Not a socket"，已移除该方案。
rem   想彻底免密：ssh-keygen 生成密钥后把公钥写入远程 ~/.ssh/authorized_keys。
setlocal EnableDelayedExpansion

cd /d "%~dp0"

rem ---- 解析参数 ----
set "REMOTE="
set "REMOTE_PATH=/opt/edgessh"
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
title EdgeSSH :: migrate -^> !REMOTE!

set /p "RP_INPUT=远程安装路径 [!REMOTE_PATH!]（回车跳过）："
if "!RP_INPUT!"==" " set "RP_INPUT="
if not "!RP_INPUT!"=="" set "REMOTE_PATH=!RP_INPUT!"

set "MIG_PORT="
set /p "MIG_PORT=服务端口 [沿用备份里的设置]（回车跳过）："
if "!MIG_PORT!"==" " set "MIG_PORT="
set "PORTENV="
if not "!MIG_PORT!"=="" set "PORTENV=PORT_OVERRIDE='!MIG_PORT!' "

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
rem deploy.sh + 备份打成一个包，经 ssh 标准输入送到远端解压，
rem 同一条连接里执行 deploy.sh：clone/pull + 还原备份 + 启动 + 打印访问地址。
set "BUNDLE=edgessh-upload-!STAMP!.tar.gz"
tar -czf "!BUNDLE!" deploy.sh "!TARBALL!"
ssh -o ConnectTimeout=30 "!REMOTE!" "set -e; rm -rf /tmp/edgessh-mig; mkdir -p /tmp/edgessh-mig; tar -C /tmp/edgessh-mig -xzf -; !PORTENV!bash /tmp/edgessh-mig/deploy.sh '!REMOTE_PATH!' /tmp/edgessh-mig/!TARBALL!" < "!BUNDLE!"
set "REMOTE_RC=!errorlevel!"

del "!BUNDLE!" "!TARBALL!" 2>nul

echo.
if !REMOTE_RC! equ 0 (
    echo [migrate] 完成
    echo   状态：ssh !REMOTE! "cd !REMOTE_PATH! ^&^& node server/cli.mjs status"
) else (
    echo [migrate] 远程部署失败（退出码 !REMOTE_RC!）
    echo   备份仍在远程 /tmp/edgessh-mig/
    echo   排查：ssh !REMOTE! "ls -la /tmp/edgessh-mig/ ^&^& cat !REMOTE_PATH!/server/data/edgessh.log 2^>^&1"
)
pause
exit /b !REMOTE_RC!
