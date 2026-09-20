@echo off
setlocal
cd /d "%~dp0"

set "PORT=7788"

rem ---- 找 node.exe ----
set "NODE="
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE set "NODE=%%I"
if not defined NODE if exist "C:\Develop\nodejs\node.exe" set "NODE=C:\Develop\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE (
  echo [错误] 找不到 node.exe，请先安装 Node.js
  pause
  exit /b 1
)

rem ---- 已经在跑就直接开页面 ----
netstat -ano | findstr /r /c:"127.0.0.1:%PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo Reader 已在运行，直接打开页面
  start "" "http://127.0.0.1:%PORT%/"
  exit /b 0
)

rem ---- 首次运行：装依赖 ----
if not exist "%~dp0node_modules" (
  echo 首次运行，正在安装依赖...
  pushd "%~dp0"
  call "%NODE%" -e "process.exit(0)"
  call npm install --no-audit --no-fund
  popd
)

rem ---- 后台起服务（窗口标题 ReaderServer） ----
start "ReaderServer" /min "%NODE%" "%~dp0server.mjs"

rem ---- 等端口就绪再开浏览器 ----
for /l %%i in (1,1,40) do (
  netstat -ano | findstr /r /c:"127.0.0.1:%PORT% .*LISTENING" >nul 2>nul
  if not errorlevel 1 goto ready
  timeout /t 1 /nobreak >nul
)
echo [错误] 服务 40 秒内没起来，检查端口 %PORT% 是否被占用
pause
exit /b 1

:ready
echo Reader 已启动: http://127.0.0.1:%PORT%/
start "" "http://127.0.0.1:%PORT%/"
exit /b 0
