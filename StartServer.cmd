@echo off
cd /d "%~dp0server-web"
if not exist ".env" copy ".env.example" ".env" >nul
call npm start
