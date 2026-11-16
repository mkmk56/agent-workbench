@echo off
cd /d D:\Claude\agent-workbench
if not exist logs mkdir logs
D:\nodejs\node.exe scripts\sync-engine-token.mjs >> logs\token-sync.log 2>&1
D:\nodejs\node.exe --env-file-if-exists=workbench.env src\server.js >> logs\server.log 2>&1