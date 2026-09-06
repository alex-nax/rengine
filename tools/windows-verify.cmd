@echo off
rem Windows verification stages for the native desktop (docs/runbooks/windows-verification.md).
rem Usage: windows-verify.cmd setup|build|render|suite <backend>|ctest|smoke   (run from a scheduled task in the console session)
setlocal EnableDelayedExpansion
set "STAGE=%~1"
if "%STAGE%"=="" set "STAGE=render"
set "ROOT=C:\Users\pr0fe\rengine"
set "LOGDIR=C:\Users\pr0fe\rengine-logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "LOGNAME=%STAGE%"
if not "%~2"=="" set "LOGNAME=%STAGE%-%~2"
rem One log per run: a leftover process from a failed run can hold the previous file open.
set "STAMP=%DATE:~-4%%DATE:~4,2%%DATE:~7,2%-%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%"
set "STAMP=%STAMP: =0%"
set "LOG=%LOGDIR%\%LOGNAME%-%STAMP%.log"
> "%LOGDIR%\%LOGNAME%.latest" echo %LOG%
call :main %* > "%LOG%" 2>&1
exit /b %ERRORLEVEL%

:main
echo === %STAGE% %2 %DATE% %TIME%
call "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat" -arch=x64 >nul 2>&1
set "PATH=C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;%PATH%"
set "SDL2_DIR=C:\Users\pr0fe\rengine-deps\SDL2-2.32.10\cmake"
set "VULKAN_SDK=C:\VulkanSDK\1.4.357.0"
set "VK_LAYER_PATH=%VULKAN_SDK%\Bin"
cd /d "%ROOT%"
git rev-parse --short HEAD
if "%STAGE%"=="setup" goto :setup
if "%STAGE%"=="build" goto :build
if "%STAGE%"=="render" goto :render
if "%STAGE%"=="suite" goto :suite
if "%STAGE%"=="ctest" goto :ctest
if "%STAGE%"=="smoke" goto :smoke
echo unknown stage %STAGE%
set "CODE=2"
goto :done
:setup
call npm ci
set "CODE=%ERRORLEVEL%"
goto :done
:build
call npm run build
set "CODE=%ERRORLEVEL%"
goto :done
:render
call npm run build
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" goto :done
call node --test --test-reporter=tap --test-force-exit orchestrator\tests\native-render.spec.mjs
set "CODE=%ERRORLEVEL%"
goto :done
:suite
set "RENGINE_RENDERER=%~2"
call npm run test:desktop
set "CODE=%ERRORLEVEL%"
goto :done
:ctest
ctest --test-dir .cache\desktop -C Release --output-on-failure
set "CODE=%ERRORLEVEL%"
goto :done
:smoke
set "CODE=0"
for %%r in (sdl opengl vulkan) do (
  .cache\desktop\bin\Release\rengine.exe --renderer %%r --smoke-test --snapshot "%LOGDIR%\smoke-%%r.bmp"
  echo smoke %%r exit=!ERRORLEVEL!
  if not "!ERRORLEVEL!"=="0" set "CODE=1"
)
.cache\desktop\bin\Release\rengine.exe --smoke-test --snapshot "%LOGDIR%\smoke-default.bmp"
echo smoke default exit=!ERRORLEVEL!
.cache\desktop\bin\Release\rengine.exe --renderer nope --smoke-test --snapshot "%LOGDIR%\smoke-nope.bmp"
echo smoke nope exit=!ERRORLEVEL!
certutil -hashfile "%LOGDIR%\smoke-sdl.bmp" SHA1 | findstr /v "hash"
certutil -hashfile "%LOGDIR%\smoke-opengl.bmp" SHA1 | findstr /v "hash"
certutil -hashfile "%LOGDIR%\smoke-vulkan.bmp" SHA1 | findstr /v "hash"
certutil -hashfile "%LOGDIR%\smoke-default.bmp" SHA1 | findstr /v "hash"
goto :done
:done
echo STAGE-EXIT=%CODE%
exit /b %CODE%
