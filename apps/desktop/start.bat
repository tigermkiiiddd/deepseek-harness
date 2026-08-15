@echo off
rem Double-click entry: packages the exe if sources changed, then launches it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
pause
