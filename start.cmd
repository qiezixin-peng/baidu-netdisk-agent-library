@echo off
cd /d "%~dp0"
node src\cli.mjs init
start "" http://127.0.0.1:3210
node src\cli.mjs serve
