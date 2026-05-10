@echo off
chcp 65001 >nul
title 无忧音乐播放器

echo.
echo  ╔══════════════════════════════════════╗
echo  ║       ♪ 无忧音乐播放器 v1.0          ║
echo  ╠══════════════════════════════════════╣
echo  ║                                      ║
echo  ║   [1] 启动服务 (默认端口 8080)       ║
echo  ║   [2] 设置端口                       ║
echo  ║   [3] 停止服务                       ║
echo  ║   [4] 打开播放器                     ║
echo  ║   [0] 退出                           ║
echo  ║                                      ║
echo  ╚══════════════════════════════════════╝
echo.

set PORT=8080
set SERVER_PID=

:menu
echo.
set /p choice="请选择操作 (0-4): "

if "%choice%"=="1" goto start
if "%choice%"=="2" goto setport
if "%choice%"=="3" goto stop
if "%choice%"=="4" goto open
if "%choice%"=="0" goto exit
echo 无效选择，请重试
goto menu

:start
echo.
echo 正在启动服务...
start "无忧音乐服务" cmd /c "node server.js %PORT%"
timeout /t 2 >nul
echo 服务已启动，端口: %PORT%
echo 播放器地址: http://localhost:%PORT%
echo 管理面板: http://localhost:%PORT%/admin
start http://localhost:%PORT%
goto menu

:setport
echo.
set /p PORT="请输入端口号 (1-65535): "
echo 端口已设置为: %PORT%
goto menu

:stop
echo.
echo 正在停止服务...
taskkill /fi "WINDOWTITLE eq 无忧音乐服务*" /f >nul 2>&1
echo 服务已停止
goto menu

:open
echo.
start http://localhost:%PORT%
goto menu

:exit
echo.
echo 正在退出...
taskkill /fi "WINDOWTITLE eq 无忧音乐服务*" /f >nul 2>&1
echo 已退出
timeout /t 1 >nul
