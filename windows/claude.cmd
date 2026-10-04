@echo off
rem Stands in front of claude.exe on PATH so every Claude Code session gets real picture previews
rem in Windows Terminal. Outside a terminal (scripts, pipes) it runs claude.exe untouched.
node "%USERPROFILE%\.claude\tools\claude-pictures\index.cjs" %*
