@echo off
cd /d D:\Claude\agent-workbench
D:\nodejs\node.exe --env-file-if-exists=workbench.env src\server.js >> logs\server.log 2>&1