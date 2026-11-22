@echo off
setlocal
title KINGSROCK
cd /d "%~dp0"
echo.
echo  ==========================================
echo    KINGSROCK  -  starting...
echo  ==========================================
echo.

rem ---- 1. Node.js 22+ (Node 24 is installed automatically if needed) --------
:check_node
where node >nul 2>nul
if errorlevel 1 goto :node_install
node -e "process.exit(parseInt(process.versions.node)<22?1:0)"
if errorlevel 1 goto :node_install
goto :node_ok

:node_install
if defined KR_NODE_TRIED goto :node_fail
set KR_NODE_TRIED=1
rem A usable Node may already be installed but hidden behind an older one on the PATH.
if not exist "%ProgramFiles%\nodejs\node.exe" goto :node_winget
"%ProgramFiles%\nodejs\node.exe" -e "process.exit(parseInt(process.versions.node)<22?1:0)"
if errorlevel 1 goto :node_winget
set "PATH=%ProgramFiles%\nodejs;%PATH%"
goto :check_node

:node_winget
where winget >nul 2>nul
if errorlevel 1 goto :node_fail
echo Node.js ^(version 22 or newer^) is needed. Installing Node.js 24 now...
echo If Windows asks "Do you want to allow this app to make changes?", click YES.
call winget install --id OpenJS.NodeJS.24 -e --silent --accept-source-agreements --accept-package-agreements
call :refresh_path
goto :check_node

:node_fail
echo.
echo [X] Node.js could not be installed automatically.
echo     Please install Node.js 24 yourself from https://nodejs.org ^(green LTS button^),
echo     then double-click start.bat again.
goto :end

:node_ok

rem ---- 2. FFmpeg (installed automatically if missing) -----------------------
where ffmpeg >nul 2>nul
if not errorlevel 1 goto :ffmpeg_ok
where winget >nul 2>nul
if errorlevel 1 goto :ffmpeg_manual
echo FFmpeg is missing. Installing it now ^(one time, about 1 minute^)...
call winget install --id Gyan.FFmpeg -e --silent --accept-source-agreements --accept-package-agreements
call :refresh_path
where ffmpeg >nul 2>nul
if not errorlevel 1 goto :ffmpeg_ok

:ffmpeg_manual
echo.
echo [X] FFmpeg could not be installed automatically.
echo     Open PowerShell and run:  winget install Gyan.FFmpeg
echo     Then double-click start.bat again.
goto :end

:ffmpeg_ok

rem ---- 3. Settings (asked once, saved in the file named .env) ---------------
if exist ".env" goto :env_ok
echo.
echo  FIRST-TIME SETUP  ^(only asked once^)
echo  -------------------------------------
echo  The bot owner gave you a secret "bot token". Never share it or post it publicly.
echo.
set KR_TRIES=0
:ask_token
set "KR_TOKEN="
set /p "KR_TOKEN=Paste the bot token here, then press Enter: "
if defined KR_TOKEN echo %KR_TOKEN%| findstr /r /c:"^[A-Za-z0-9_-][A-Za-z0-9_-]*\.[A-Za-z0-9_-][A-Za-z0-9_-]*\.[A-Za-z0-9_-][A-Za-z0-9_-]*$" >nul 2>nul
if not errorlevel 1 if defined KR_TOKEN goto :token_ok
set /a KR_TRIES+=1
if %KR_TRIES% GEQ 4 goto :token_fail
echo That does not look like a bot token. Paste only the token ^(3 parts separated by dots, no quotes or spaces^).
goto :ask_token

:token_fail
echo.
echo [X] No valid token was entered. Ask the bot owner for the token and start again.
goto :end

:token_ok
echo.
set "KR_YT="
set /p "KR_YT=Turn on YouTube support? Press Enter for Yes, or type N for No: "
set "KR_YTVAL=true"
if /i "%KR_YT%"=="N" set "KR_YTVAL=false"
> ".env" (
  echo NODE_ENV=production
  echo DISCORD_TOKEN=%KR_TOKEN%
  echo YOUTUBE_ENABLED=%KR_YTVAL%
)
set "KR_TOKEN="
echo Settings saved.
:env_ok

rem ---- 3b. yt-dlp, only if YouTube is turned on -----------------------------
findstr /b /i /c:"YOUTUBE_ENABLED=true" ".env" >nul 2>nul
if errorlevel 1 goto :yt_done
where yt-dlp >nul 2>nul
if not errorlevel 1 goto :yt_done
findstr /b /i /r /c:"YTDLP_PATH=..*[\\/]" ".env" >nul 2>nul
if not errorlevel 1 goto :yt_done
where winget >nul 2>nul
if errorlevel 1 goto :yt_manual
echo yt-dlp is missing ^(needed for YouTube^). Installing it now...
call winget install --id yt-dlp.yt-dlp -e --silent --accept-source-agreements --accept-package-agreements
call :refresh_path
where yt-dlp >nul 2>nul
if not errorlevel 1 goto :yt_done

:yt_manual
echo [!] yt-dlp could not be installed, so YouTube will not work. In PowerShell run:  winget install yt-dlp.yt-dlp
:yt_done

rem ---- 4. The bot's own packages (first run only) ---------------------------
if exist "node_modules" goto :deps_ok
echo Installing KINGSROCK packages ^(first run, about 1 minute^)...
call npm install --no-fund --no-audit
if errorlevel 1 (
  echo [X] Package install failed. Check your internet connection and try again.
  goto :end
)
:deps_ok

rem ---- 5. Run ---------------------------------------------------------------
echo.
echo  ------------------------------------------------------------------
echo   Make sure nobody else is running KINGSROCK right now ^(one at a time^).
echo   KEEP THIS WINDOW OPEN while you want the bot online.
echo   To stop the bot: press Ctrl+C, or just close this window.
echo  ------------------------------------------------------------------
echo.
call npm start
if errorlevel 1 (
  echo.
  echo  The bot stopped with an error. Read the red/ERROR lines above.
  echo  If the token was wrong, delete the file named ".env" in this folder and start again.
)

:end
echo.
echo  KINGSROCK has stopped.
pause
endlocal
exit /b 0

rem ---- helper: reload Windows' program list so just-installed tools are found
:refresh_path
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%p;%PATH%"
exit /b 0
