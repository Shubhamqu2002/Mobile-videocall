@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (echo Install Node.js 22.12 or newer first. & exit /b 1)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a<22||(a===22&&b<12)?1:0)"
if errorlevel 1 (echo Node.js 22.12 or newer is required. & exit /b 1)
if not exist "server-web\.env" copy "server-web\.env.example" "server-web\.env" >nul
cd server-web
call npm ci
if errorlevel 1 exit /b 1
call npm run build
if errorlevel 1 exit /b 1
cd ..\mobile
call npm ci
if errorlevel 1 exit /b 1
echo.
echo Dependencies installed. Follow docs\WINDOWS_SETUP.md for Android SDK and device setup.
echo Start the server with StartServer.cmd. Start Metro in mobile with npm start.
endlocal
