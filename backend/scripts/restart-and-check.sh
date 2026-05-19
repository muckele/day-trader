#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-4000}"
BASE_URL="${BASE_URL:-http://localhost:${PORT}}"
LOG_FILE="${LOG_FILE:-/tmp/daytrader-backend.log}"
STARTUP_WAIT_SECONDS="${STARTUP_WAIT_SECONDS:-3}"

echo "[backend] cleaning stale listeners on port ${PORT}..."
if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -ti -u "${USER}" -iTCP:${PORT} -sTCP:LISTEN || true)"
  if [ -n "${PIDS}" ]; then
    # shellcheck disable=SC2086
    if ! kill ${PIDS}; then
      echo "[backend] warning: could not kill one or more existing listeners on :${PORT} (permission denied or already gone)."
    fi
    sleep 1
  fi
fi

echo "[backend] starting server..."
nohup npm start >"${LOG_FILE}" 2>&1 &
NEW_PID="$!"
sleep "${STARTUP_WAIT_SECONDS}"

echo "[backend] checking ${BASE_URL}/health"
HEALTH_OK="false"
for _ in $(seq 1 15); do
  if curl -sS "${BASE_URL}/health" > /tmp/daytrader-health.json; then
    HEALTH_OK="true"
    break
  fi
  sleep 1
done

if [ "${HEALTH_OK}" != "true" ]; then
  echo "[backend] health check failed. Recent logs:"
  tail -n 120 "${LOG_FILE}" || true
  exit 1
fi

if ! grep -q '"services"' /tmp/daytrader-health.json; then
  echo "[backend] unexpected health payload (missing services). You may still be hitting an old process."
  cat /tmp/daytrader-health.json
  tail -n 120 "${LOG_FILE}" || true
  exit 1
fi

cat /tmp/daytrader-health.json
echo

for path in "/api/robo/run-once" "/api/robo/run_once" "/api/robo/runOnce"; do
  code="$(curl -s -o /tmp/daytrader-robo-check.out -w "%{http_code}" -X POST "${BASE_URL}${path}")"
  echo "[backend] POST ${path} -> ${code}"
  if [ "${code}" != "401" ] && [ "${code}" != "503" ]; then
    echo "[backend] unexpected status for ${path}. Body:"
    cat /tmp/daytrader-robo-check.out
    tail -n 120 "${LOG_FILE}" || true
    exit 1
  fi
done

echo "[backend] OK (pid ${NEW_PID}). Log: ${LOG_FILE}"
