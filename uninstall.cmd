chcp 936 >nul 2>&1
@echo off
rem EdgeSSH 一键卸载脚本（Windows）
rem
rem 用法（双击或命令行）：
rem   uninstall.cmd             彻底卸载（停止服务 + 删除运行时数据 + 删除整个项目目录）
rem   uninstall.cmd --keep-code 仅清理运行时数据，保留源码
rem
rem 默认会把整个项目目录一并删掉。如果只想清理数据但保留源码以便再次部署，请加 --keep-code。
setlocal EnableDelayedExpansion

set "KEEP_CODE=false"
:parse
if "%~1"=="" goto :prompt_done
if /i "%~1"=="--keep-code" ( set "KEEP_CODE=true" & shift & goto :parse )
if /i "%~1"=="-h" goto :help
if /i "%~1"=="--help" goto :help
echo [uninstall] 未知参数：%~1 (支持 --keep-code / -h / --help)
pause & exit /b 2

:help
echo.
echo EdgeSSH 一键卸载脚本（Windows）
echo.
echo   uninstall.cmd             彻底卸载（删除整个项目目录）
echo   uninstall.cmd --keep-code 仅清理运行时数据，保留源码
echo.
pause
exit /b 0

:prompt_done
rem SCRIPT_DIR 含尾部 \，去掉
set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=!SCRIPT_DIR:~0,-1!"

echo [uninstall] 目标项目目录：!PROJECT_DIR!

rem ---- 1) 停止服务（如还在运行）----
echo [uninstall] 1/4 停止服务 ...
if exist "!PROJECT_DIR!\server\cli.mjs" (
    pushd "!PROJECT_DIR!"
    call node server\cli.mjs stop
    popd
) else (
    echo       [跳过] 找不到 server\cli.mjs（可能已部分卸载）
)

rem ---- 2) 兜底杀残留进程 ----
echo [uninstall] 2/4 兜底清理残留进程 ...
rem 杀 workerd 子进程（EdgeSSH 通过 workerd 跑 Worker），不影响其他 node 进程
taskkill /im workerd.exe /f 2>nul
rem 注：node.exe 可能是其他程序使用，故不杀；上面的 cli.mjs stop 已经优雅停过主进程。

rem ---- 3) 删除运行时数据 ----
echo [uninstall] 3/4 删除运行时数据 ...
if exist "!PROJECT_DIR!\server\data" rmdir /s /q "!PROJECT_DIR!\server\data"
if exist "!PROJECT_DIR!\.env" del /f /q "!PROJECT_DIR!\.env"

rem ---- 4) 全部卸载 / 保留源码 ----
if "!KEEP_CODE!"=="false" (
    echo [uninstall] 4/4 删除整个项目目录 ...
    rmdir /s /q "!PROJECT_DIR!"
    echo [uninstall] 完成。EdgeSSH 已从本机完全移除。
) else (
    echo [uninstall] 4/4 保留源码 ...
    echo [uninstall] 完成。源码保留在 !PROJECT_DIR!（运行时数据已清理）。
    echo   重新部署：deploy.cmd
)

pause
exit /b 0
