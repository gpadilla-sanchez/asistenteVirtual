#!/usr/bin/env bash
# Respaldo diario. Prográmalo con:  crontab -e
#   15 3 * * * /home/pi/plataforma-asistente-seguros/deploy/respaldo-cron.sh >> /home/pi/plataforma-asistente-seguros/data/respaldo.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose --profile produccion exec -T asistente node dist/cli/respaldo.js
