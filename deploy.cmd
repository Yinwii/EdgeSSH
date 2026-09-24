@echo off
rem EdgeSSH 一键部署（Windows）：装 Node 22（如缺）→ 克隆/拉取最新代码 → 还原备份（如指定）→ 启动
rem
rem 用法：
rem   deploy.cmd                                              部署到脚本所在目录
rem   deploy.cmd C:\opt\edgessh                               部署到指定目录
rem   deploy.cmd C:\opt\edgessh C:\backup\edgessh.tar.gz      部署 + 还原旧数据
rem
rem 前置：Windows 10 1809+（自带 OpenSSH 客户端 + winget）
setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "INSTALL_DIR=%~1"
set "BACKUP=%~2"
if "!INSTALL_DIR!"=="" set "INSTALL_DIR=!SCRIPT_DIR!"

rem ---- Node.js（如缺则用 winget 装 Node LTS）----
where node >nul 2>nul && goto :node_ready
echo [deploy] 未检测到 Node.js，尝试通过 winget 安装 Node 22 LTS ...
where winget >nul 2>nul && (
    winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    if errorlevel 1 (
        echo [deploy] winget 安装失败，请手动安装 Node.js 22+ 后重试：https://nodejs.org/
        pause
        exit /b 1
    )
) || (
    echo [deploy] 找不到 winget，请手动安装 Node.js 22+ 后重试：https://nodejs.org/
    pause
    exit /b 1
)
rem winget 装完通常需要刷新 PATH
set "PATH=%ProgramFiles%\nodejs;%PATH%"

:node_ready
where node >nul 2>nul || (
    echo [deploy] 仍未找到 node，请重启 cmd 后重试。
    pause
    exit /b 1
)

rem ---- 克隆或拉取 ----
if exist "!INSTALL_DIR!\.git" goto :do_pull

dir /b "!INSTALL_DIR!\*.*" 2>nul | findstr . >nul && (
    echo [deploy] !INSTALL_DIR! 已有非 git 内容，终止。请使用空目录。
    pause
    exit /b 1
)
git clone https://github.com/Yinwii/EdgeSSH.git "!INSTALL_DIR!" || (
    echo [deploy] git clone 失败。
    pause
    exit /b 1
)
goto :after_git

:do_pull
git -C "!INSTALL_DIR!" pull --ff-only || (
    echo [deploy] git pull 失败。
    pause
    exit /b 1
)

:after_git

rem ---- 还原备份（如指定）----
if "!BACKUP!"=="" goto :do_start
if not exist "!BACKUP!" (
    echo [deploy] 备份不存在: !BACKUP!
    pause
    exit /b 1
)
tar -xzf "!BACKUP!" -C "!INSTALL_DIR!" || (
    echo [deploy] 还原备份失败。
    pause
    exit /b 1
)

rem ---- 启动 ----
:do_start
cd /d "!INSTALL_DIR!"
call start.cmd