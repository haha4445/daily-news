@echo off
setlocal
cd /d "%~dp0"
rem 双击即可生成当日新闻汇总；输出默认落在脚本同目录的 digest\ 文件夹。
rem 想换输出目录，把下面这行换成： node "%~dp0news-digest.mjs" --out "D:\news" %*
node "%~dp0news-digest.mjs" %*
set "code=%ERRORLEVEL%"
echo.
if "%code%"=="0" goto ok
if "%code%"=="2" goto skipped
echo [失败] 退出码 %code%，请查看上方日志。
goto done
:ok
echo [完成] 运行结束，日报位置见上方日志（默认 digest\news-latest.md）。
goto done
:skipped
echo [跳过] 今天是周末或法定节假日，按配置不生成日报。
echo        如需强制生成： node news-digest.mjs --force
goto done
:done
pause
endlocal