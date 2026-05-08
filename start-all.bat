@echo off
echo Starting Citizenwatch MVP Infrastructure...
echo ==============================================

echo [0] Releasing busy service ports (3000, 3001, 3600) if needed...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ports = 3000,3001,3600; foreach ($p in $ports) { " ^
  "  $lines = netstat -ano | Select-String (':'+$p+'\\s+.*LISTENING'); " ^
  "  foreach ($line in $lines) { " ^
  "    $parts = ($line.ToString().Trim() -split '\s+'); " ^
  "    $pid = $parts[$parts.Length-1]; " ^
  "    if ($pid -match '^\d+$') { " ^
  "      Write-Host ('   Port ' + $p + ' busy with PID ' + $pid + ' - terminating process...'); " ^
  "      Stop-Process -Id ([int]$pid) -Force -ErrorAction SilentlyContinue; " ^
  "    } " ^
  "  } " ^
  "}"

echo [1] Starting Docker containers (PostgreSQL ^& Redis)...
start "Docker Compose" cmd /k "docker-compose up -d && echo. && echo Docker containers started! You can close this window if you want or keep it to check status with 'docker ps'."

echo [2] Waiting 5 seconds for databases to initialize...
timeout /t 5 /nobreak >nul

echo [3] Starting Python CCTV Pipeline (Port 3600)...
start "CCTV Python Pipeline" cmd /k "cd apps\cctv-pipeline && .\venv\Scripts\activate && python server.py"

echo [4] Starting Node.js API Server (Port 3001)...
start "Node.js API Server" cmd /k "cd apps\api && npm run dev"

echo [5] Starting Next.js Frontend (Port 3000)...
start "Next.js Frontend" cmd /k "cd web && npm run dev"

echo ==============================================
echo All services have been launched in separate windows!
echo It may take a few moments for the Next.js frontend to finish compiling.
echo Access the application at: http://localhost:3000
echo ==============================================
pause
