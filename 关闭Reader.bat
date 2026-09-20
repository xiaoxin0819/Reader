@echo off
setlocal
set "PORT=7788"

rem Try graceful shutdown first so pending config writes can flush.
curl --max-time 2 -s -X POST http://127.0.0.1:%PORT%/api/shutdown >nul 2>nul

rem Wait up to 5 seconds for the listener to stop.
for /l %%i in (1,1,5) do (
  netstat -ano | findstr /C:":%PORT% " | findstr /C:"LISTENING" >nul 2>nul
  if errorlevel 1 goto done
  ping -n 2 127.0.0.1 >nul
)

rem Fallback: force kill only if graceful shutdown failed.
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":%PORT% " ^| findstr /C:"LISTENING"') do (
  taskkill /f /pid %%P >nul 2>nul
)

:done
echo Reader closed.
ping -n 2 127.0.0.1 >nul
exit /b 0

