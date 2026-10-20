@echo off
chcp 65001 >nul
rem Start NapCat through its own launcher and keep the boot log next to this script.
rem If NapCat lives somewhere else, set NAPCAT_DIR before running this file.
set "NAPCAT_DIR=%~dp0..\napcat"
if not "%NAPCAT_DIR_OVERRIDE%"=="" set "NAPCAT_DIR=%NAPCAT_DIR_OVERRIDE%"
cd /d "%NAPCAT_DIR%"
call "%NAPCAT_DIR%\launcher-win10.bat" > "%~dp0napcat-boot.log" 2>&1
echo exit=%ERRORLEVEL% >> "%~dp0napcat-boot.log"
