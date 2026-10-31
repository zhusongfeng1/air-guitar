@echo off
rem ---------------------------------------------------------------------------
rem  IMPORTANT: keep this file ASCII-only.
rem  cmd.exe parses .bat using the ANSI codepage (GBK on a zh-CN system) no matter
rem  what "chcp" says, so UTF-8 Chinese text here gets mis-decoded and can even eat
rem  the line endings, producing "xxx is not recognized as a command".
rem  All Chinese messages live in tools\open_when_ready.mjs / tools\serve.js,
rem  which print UTF-8 and display correctly under "chcp 65001".
rem ---------------------------------------------------------------------------
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
set "PORT=8765"
title air-guitar  -  hand 21 keypoints  -  http://127.0.0.1:%PORT%/

echo ============================================
echo   air-guitar  -  hand keypoints guitar
echo ============================================
echo.

set "NODE="
where node >nul 2>nul
if %errorlevel%==0 set "NODE=node"
if defined NODE goto :serve_node
if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-next-primary-runtime\dependencies\node\bin\node.exe" set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-next-primary-runtime\dependencies\node\bin\node.exe"
if defined NODE goto :serve_node

where python >nul 2>nul
if %errorlevel%==0 goto :serve_python

echo [!] Neither "node" nor "python" was found on PATH.
echo     Install one of them, or open web\index.html via VS Code Live Server.
pause
goto :eof

:serve_node
echo [1/2] starting static server ... http://127.0.0.1:%PORT%/
echo [2/2] browser opens by itself as soon as the page really answers.
echo.
echo       Keep this window open - closing it stops the server.
echo.
start "" /b "%NODE%" "%ROOT%tools\open_when_ready.mjs" %PORT%
"%NODE%" "%ROOT%tools\serve.js" %PORT%
goto :eof

:serve_python
echo [1/2] no node found, falling back to python http.server ... http://127.0.0.1:%PORT%/
echo [2/2] browser opens by itself as soon as the page really answers.
echo.
echo       Keep this window open - closing it stops the server.
echo.
start "" /b python "%ROOT%tools\open_when_ready.py" %PORT%
pushd "%ROOT%web"
python -m http.server %PORT% --bind 127.0.0.1
popd
goto :eof
