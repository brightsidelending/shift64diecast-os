@echo off
REM ===== Shift64Diecast one-click deploy =====
REM Double-click this file whenever Claude has finished editing.
REM It clears any stuck lock, commits every change, and pushes to GitHub Pages.

cd /d "%~dp0"

if exist ".git\index.lock" del /f /q ".git\index.lock"

git add -A
git commit -m "Update site %date% %time%"
git push

echo.
echo ============================================
echo   Done. If you see "Everything up-to-date"
echo   or "nothing to commit", there was nothing
echo   new to deploy.
echo ============================================
echo.
pause
