@echo off
rem Encuentra Node sin suponer donde esta y corre el buscador. Uso: buscar.cmd ^<comando^>
setlocal
rem Acentos y enies en las busquedas: la consola pasa a UTF-8
chcp 65001 >nul
set "AQUI=%~dp0"
set "NODO="
if exist "%USERPROFILE%\.local\node\node.exe" set "NODO=%USERPROFILE%\.local\node\node.exe"
if not defined NODO for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODO set "NODO=%%i"
if not defined NODO if exist "%ProgramFiles%\nodejs\node.exe" set "NODO=%ProgramFiles%\nodejs\node.exe"
if not defined NODO if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODO=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODO if exist "%APPDATA%\nvm\current\node.exe" set "NODO=%APPDATA%\nvm\current\node.exe"
if not defined NODO if exist "%LOCALAPPDATA%\Volta\bin\node.exe" set "NODO=%LOCALAPPDATA%\Volta\bin\node.exe"
if not defined NODO (
  echo No encontre Node. Instala la version LTS desde https://nodejs.org y proba de nuevo. 1>&2
  exit /b 127
)
"%NODO%" "%AQUI%buscar.cjs" %*
exit /b %ERRORLEVEL%
