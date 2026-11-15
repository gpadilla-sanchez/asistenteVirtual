#!/usr/bin/env bash
# Atajos para manejar la plataforma en la Raspberry. Uso: ./asistente.sh <comando> [argumentos]
set -euo pipefail
cd "$(dirname "$0")"

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
IP=${IP:-localhost}
PROD=(docker compose --profile produccion)
SIM=(docker compose --profile simulacion)

# Los comandos de administración corren dentro del contenedor (con TTY para escribir contraseñas sin mostrarlas)
cli() { "${PROD[@]}" run --rm --no-deps asistente node "dist/cli/$1.js" "${@:2}"; }

preparar_carpetas() {
  mkdir -p "$@"
  chmod 700 secretos secretos-simulacion 2>/dev/null || true
}

case "${1:-ayuda}" in
  simulacion)
    preparar_carpetas data-simulacion secretos-simulacion
    "${SIM[@]}" up -d --build
    echo
    echo "Simulación en marcha:"
    echo "  WhatsApp simulado ........ http://$IP:4000   (botón ▶ Simular día completo)"
    echo "  Portal de aseguradora .... http://$IP:4100   (ana.lopez / Demo-Ana-2026)"
    echo "  Panel del asistente ...... http://$IP:3000/panel"
    echo "     admin / Admin-Demo-2026 · ana / Ana-Panel-2026 · luis / Luis-Panel-2026"
    ;;
  detener-simulacion) "${SIM[@]}" down ;;
  reiniciar-simulacion)
    "${SIM[@]}" down
    rm -rf data-simulacion/agentes
    "${SIM[@]}" up -d
    echo "Simulación reiniciada desde cero (se conservaron los secretos de demostración)."
    ;;
  produccion) preparar_carpetas data secretos entrada; "${PROD[@]}" up -d --build ;;
  detener) "${PROD[@]}" down ;;
  reiniciar) "${PROD[@]}" restart asistente ;;
  logs) docker compose logs -f --tail 200 "${2:-asistente}" ;;
  inicializar|secretos|agente|validar|probar-portal|revision|crear-plantillas|respaldo)
    preparar_carpetas data secretos entrada
    cli "$@"
    ;;
  *)
    cat <<'AYUDA'
Uso: ./asistente.sh <comando>

  SIMULACIÓN (probar todo sin cuentas reales)
    simulacion               arranca asistente + WhatsApp simulado + aseguradora ficticia
    reiniciar-simulacion     borra el historial de la simulación y vuelve a empezar
    detener-simulacion

  PRODUCCIÓN
    inicializar              crea la clave maestra y pide los datos de Meta y del administrador
    agente nuevo             da de alta un agente (config + credenciales cifradas)
    agente listar
    secretos portal <id>     cambia usuario/contraseña del portal de un agente
    secretos panel <id|admin>
    secretos ver             qué secretos existen (sin mostrar valores)
    validar                  revisa configuración y secretos
    probar-portal <id> [--capturas]   prueba la lectura del portal sin enviar nada
    crear-plantillas         envía las plantillas a Meta para aprobación
    produccion               arranca asistente + HTTPS (Caddy)
    reiniciar                aplica cambios en config/ (reinicia el asistente)
    revision todos --sincronizar      ejecuta lectura y envío a mano
    respaldo
    logs [servicio]
    detener
AYUDA
    ;;
esac
