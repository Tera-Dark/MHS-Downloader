@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PYTHON="

rem Optional custom paths: MHS_PYTHON for Python; MHS_DATA for an existing data directory.
if defined MHS_PYTHON call :tryPython "%MHS_PYTHON%"
rem ARCHIVE_PYTHON remains a compatible alias.
if defined ARCHIVE_PYTHON call :tryPython "%ARCHIVE_PYTHON%"
if defined PYTHON goto python_ready

rem Preserve a working virtual environment when updating the application.
call :tryPython "%CD%\.venv\Scripts\python.exe"
if defined PYTHON goto python_ready

rem Standard python.org per-user paths; Python312 matches the reported setup.
for %%V in (312 313 314 311) do call :tryPython "%LOCALAPPDATA%\Programs\Python\Python%%V\python.exe"
if defined PYTHON goto python_ready
for %%V in (312 313 314 311) do call :tryPython "%ProgramFiles%\Python%%V\python.exe"
if defined PYTHON goto python_ready

rem The Python Launcher is optional, not required.
for /f "delims=" %%P in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do call :tryPython "%%P"
if defined PYTHON goto python_ready
for /f "delims=" %%P in ('where python 2^>nul') do call :tryPython "%%P"
if defined PYTHON goto python_ready

echo [ERROR] 未找到可运行的 Python 3.11 或更高版本。
echo 请安装 Python，或将MHS_PYTHON 环境变量 指向 python.exe。
echo 也可在当前终端先运行：set "MHS_PYTHON=你的完整Python路径"
echo 不需要额外安装 Python Launcher。
goto fail

:python_ready
echo 使用 Python："%PYTHON%"
"%PYTHON%" --version
if exist ".venv\Scripts\python.exe" goto check_venv
echo 正在创建虚拟环境...
"%PYTHON%" -m venv .venv
if errorlevel 1 goto fail

:check_venv
".venv\Scripts\python.exe" -c "import sys; assert sys.version_info >= (3,11)" >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 旧 .venv 已失效，可能是原 Python 被移动或卸载。
  echo 请关闭窗口，仅将 .venv 文件夹改名后再启动；不要删除 data。
  goto fail
)
".venv\Scripts\python.exe" -c "import requests, PIL; assert tuple(map(int,requests.__version__.split('.')[:3])) >= (2,32,3); assert tuple(map(int,PIL.__version__.split('.')[:2])) >= (11,1)" >nul 2>nul
if errorlevel 1 (
  echo 安装或更新运行依赖，需要网络连接...
  ".venv\Scripts\python.exe" -m pip install -r native\requirements.txt
  if errorlevel 1 goto fail
)
echo.
echo 启动 MHS-Downloader 0.8.0。请保持此窗口运行，不要同时启动旧版本。
echo 若提示端口占用，请先关闭旧 Python 窗口，再重新运行。
if defined MHS_DATA (
  ".venv\Scripts\python.exe" native\server.py --data "%MHS_DATA%"
) else (
  ".venv\Scripts\python.exe" native\server.py
)
if errorlevel 1 goto fail
echo 本机程序已退出。进度已保留，重新启动后请在浮动面板点击继续。
pause
exit /b 0

:tryPython
if defined PYTHON exit /b 0
if not exist "%~1" exit /b 0
rem Avoid the Microsoft Store app execution alias.
if /I "%~dp1"=="%LOCALAPPDATA%\Microsoft\WindowsApps\" exit /b 0
"%~1" -c "import sys; assert sys.version_info >= (3,11)" >nul 2>nul
if errorlevel 1 exit /b 0
set "PYTHON=%~1"
exit /b 0

:fail
echo.
echo 启动失败。请保留上方错误信息；不要删除 data 数据目录。
pause
exit /b 1
