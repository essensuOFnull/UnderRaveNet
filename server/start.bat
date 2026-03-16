@echo off
chcp 65001 > nul
echo Запуск сервера...
cd /d "%~dp0"
go run main.go
echo Сервер остановлен.
pause