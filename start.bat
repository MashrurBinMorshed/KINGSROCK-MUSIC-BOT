@echo off
setlocal EnableExtensions
title KINGSROCK
cd /d "%~dp0"
echo.
echo  ==========================================
echo    KINGSROCK  -  starting...
echo  ==========================================
echo.

rem =========================================================================
rem  Everything the bot needs (Node.js, FFmpeg, yt-dlp) is downloaded into the
rem  "tools" folder next to this file if the PC does not already have it.
rem  No administrator rights, no winget and no manual installs are needed.
rem =========================================================================
set "KR_TOOLS=%~dp0tools"
set "KR_PS=powershell -NoProfile -ExecutionPolicy Bypass -Command"
set "KR_PSHEAD=$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; try{[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12}catch{};"

rem Tools downloaded by an earlier run are found first.
set "PATH=%KR_TOOLS%\node;%KR_TOOLS%\ffmpeg\bin;%KR_TOOLS%;%PATH%"

where powershell >nul 2>nul
if errorlevel 1 goto :no_powershell

rem ---- 1. Node.js 22 or newer ----------------------------------------------
:check_node
where node >nul 2>nul
if errorlevel 1 goto :node_install
node -e "process.exit(parseInt(process.versions.node)<22?1:0)" >nul 2>nul
if errorlevel 1 goto :node_install
goto :node_ok

:node_install
if defined KR_NODE_TRIED goto :node_fail
set "KR_NODE_TRIED=1"
rem A usable Node may be installed but hidden behind an older one on the PATH.
if not exist "%ProgramFiles%\nodejs\node.exe" goto :node_download
"%ProgramFiles%\nodejs\node.exe" -e "process.exit(parseInt(process.versions.node)<22?1:0)" >nul 2>nul
if errorlevel 1 goto :node_download
set "PATH=%ProgramFiles%\nodejs;%PATH%"
goto :check_node

:node_download
echo Node.js 22 or newer is needed. Downloading Node.js 24 ^(one time, about 1 minute^)...
if not exist "%KR_TOOLS%" mkdir "%KR_TOOLS%"
if exist "%KR_TOOLS%\node" rmdir /s /q "%KR_TOOLS%\node" >nul 2>nul
if exist "%KR_TOOLS%\node_tmp" rmdir /s /q "%KR_TOOLS%\node_tmp" >nul 2>nul
%KR_PS% "%KR_PSHEAD% $a='x64'; if($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64'){$a='arm64'}; $key='win-'+$a+'-zip'; $j=Invoke-RestMethod 'https://nodejs.org/dist/index.json'; $v=$null; foreach($r in $j){ if((-not $v) -and ($r.version -like 'v24.*') -and ($r.files -contains $key)){ $v=$r.version } }; if(-not $v){throw 'no Node 24 build found'}; $zip=Join-Path $env:TEMP 'kingsrock-node.zip'; Invoke-WebRequest ('https://nodejs.org/dist/'+$v+'/node-'+$v+'-win-'+$a+'.zip') -OutFile $zip -UseBasicParsing; Expand-Archive -LiteralPath $zip -DestinationPath '%KR_TOOLS%\node_tmp' -Force; Move-Item (Get-ChildItem '%KR_TOOLS%\node_tmp' -Directory | Select-Object -First 1).FullName '%KR_TOOLS%\node'; Remove-Item '%KR_TOOLS%\node_tmp' -Recurse -Force; Remove-Item $zip -Force"
if errorlevel 1 goto :node_fail
set "PATH=%KR_TOOLS%\node;%PATH%"
goto :check_node

:node_fail
echo.
echo [X] Node.js could not be set up automatically ^(no internet, or a firewall/antivirus blocked it^).
echo     Install Node.js 24 yourself from https://nodejs.org ^(green LTS button^),
echo     CLOSE this window, then double-click start.bat again.
goto :end

:node_ok

rem ---- 2. FFmpeg -------------------------------------------------------------
where ffmpeg >nul 2>nul
if not errorlevel 1 goto :ffmpeg_ok
echo FFmpeg is missing. Downloading it now ^(one time, about 1-2 minutes^)...
if not exist "%KR_TOOLS%" mkdir "%KR_TOOLS%"
if exist "%KR_TOOLS%\ffmpeg" rmdir /s /q "%KR_TOOLS%\ffmpeg" >nul 2>nul
if exist "%KR_TOOLS%\ffmpeg_tmp" rmdir /s /q "%KR_TOOLS%\ffmpeg_tmp" >nul 2>nul
%KR_PS% "%KR_PSHEAD% $zip=Join-Path $env:TEMP 'kingsrock-ffmpeg.zip'; $urls=@('https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip','https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'); $done=$false; foreach($u in $urls){ try{ Invoke-WebRequest $u -OutFile $zip -UseBasicParsing; $done=$true; break }catch{} }; if(-not $done){throw 'download failed'}; Expand-Archive -LiteralPath $zip -DestinationPath '%KR_TOOLS%\ffmpeg_tmp' -Force; $exe=Get-ChildItem '%KR_TOOLS%\ffmpeg_tmp' -Recurse -Filter ffmpeg.exe | Select-Object -First 1; if(-not $exe){throw 'ffmpeg.exe not found in archive'}; New-Item -ItemType Directory -Force '%KR_TOOLS%\ffmpeg\bin' | Out-Null; Copy-Item (Join-Path $exe.DirectoryName '*.exe') '%KR_TOOLS%\ffmpeg\bin' -Force; Remove-Item '%KR_TOOLS%\ffmpeg_tmp' -Recurse -Force; Remove-Item $zip -Force"
set "PATH=%KR_TOOLS%\ffmpeg\bin;%PATH%"
where ffmpeg >nul 2>nul
if not errorlevel 1 goto :ffmpeg_ok
echo.
echo [X] FFmpeg could not be downloaded automatically.
echo     Download "ffmpeg-release-essentials.zip" from https://www.gyan.dev/ffmpeg/builds/
echo     and put ffmpeg.exe into the folder:  %KR_TOOLS%\ffmpeg\bin
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
set "KR_CID="
set /p "KR_CID=Application ID of this bot ^(Developer Portal, General Information^). Press Enter to skip: "
set "KR_YT="
set /p "KR_YT=Turn on YouTube support? Press Enter for Yes, or type N for No: "
set "KR_YTVAL=true"
if /i "%KR_YT%"=="N" set "KR_YTVAL=false"
> ".env" (
  echo NODE_ENV=production
  echo DISCORD_TOKEN=%KR_TOKEN%
  echo YOUTUBE_ENABLED=%KR_YTVAL%
)
if defined KR_CID >> ".env" echo DISCORD_CLIENT_ID=%KR_CID%
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
echo yt-dlp is missing ^(needed for YouTube^). Downloading it now...
if not exist "%KR_TOOLS%" mkdir "%KR_TOOLS%"
%KR_PS% "%KR_PSHEAD% Invoke-WebRequest 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile '%KR_TOOLS%\yt-dlp.exe' -UseBasicParsing"
where yt-dlp >nul 2>nul
if not errorlevel 1 goto :yt_done
echo [!] yt-dlp could not be downloaded, so YouTube will not work. Download yt-dlp.exe from
echo     https://github.com/yt-dlp/yt-dlp/releases and put it in:  %KR_TOOLS%
:yt_done

rem ---- 4. The bot's own packages (first run only) ---------------------------
if exist "node_modules\discord.js" goto :deps_ok
echo Installing KINGSROCK packages ^(first run, about 1 minute^)...
call npm install --no-fund --no-audit
if errorlevel 1 (
  echo [X] Package install failed. Check your internet connection and try again.
  goto :end
)
:deps_ok

rem ---- 5. Register the slash commands (needs DISCORD_CLIENT_ID) -------------
findstr /b /i /r /c:"DISCORD_CLIENT_ID=[0-9][0-9]*" ".env" >nul 2>nul
if errorlevel 1 goto :register_skip
if exist "data\.registered" goto :register_skip
echo Registering slash commands for this bot...
call npm run register:global
if not errorlevel 1 (
  if not exist "data" mkdir "data"
  > "data\.registered" echo done
)
:register_skip

rem ---- 6. Run ---------------------------------------------------------------
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
goto :end

:no_powershell
echo [X] Windows PowerShell was not found, which this launcher needs to download tools.
echo     Install Node.js 24 ^(https://nodejs.org^) and FFmpeg manually, then run:  npm install  and  npm start

:end
echo.
echo  KINGSROCK has stopped.
pause
endlocal
exit /b 0
