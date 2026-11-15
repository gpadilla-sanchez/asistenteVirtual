/**
 * Valores de la DEMOSTRACIÓN. Solo sirven para el modo simulación:
 * `npm run inicializar -- --simulacion` los guarda (cifrados) en la bóveda y el simulador los usa.
 * En producción cada valor real se captura con `npm run secretos` y nunca se escribe en archivos de texto.
 */
export const DEMO = {
  appSecret: 'secreto-app-SIMULADO-no-usar-en-produccion',
  verifyToken: 'verify-token-SIMULADO',
  metaToken: 'token-meta-SIMULADO',
  tokenSimulacion: 'token-control-SIMULACION',
  plantillas: { recordatorio: 'recordatorio_poliza_v1', seguimiento: 'seguimiento_poliza_v1', idioma: 'es_MX' },
  /** Usuarios del portal de la aseguradora simulada, por agente. */
  portal: {
    'ana-lopez': { usuario: 'ana.lopez', contrasena: 'Demo-Ana-2026' },
    'luis-martinez': { usuario: 'luis.martinez', contrasena: 'Demo-Luis-2026' },
  } as Record<string, { usuario: string; contrasena: string }>,
  /** Contraseñas del panel en la demostración. */
  panel: {
    admin: 'Admin-Demo-2026',
    'ana-lopez': 'Ana-Panel-2026',
    'luis-martinez': 'Luis-Panel-2026',
  } as Record<string, string>,
};
