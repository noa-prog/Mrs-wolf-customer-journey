@echo off
title Mrs. Wolf ICP Tool

cd /d "C:\Users\noa\קלוד קוד\דניאל ונועה\Mrs Wolf\icp-tool"

if not exist node_modules (
  echo Installing dependencies...
  npm install
)

if not exist .env (
  echo ERROR: .env file not found.
  pause
  exit /b 1
)

echo Starting server at http://localhost:3030
start "" http://localhost:3030
node server.js
pause
