import { pino, type Logger } from 'pino';

export type { Logger };

/** Bitácora en JSON. Nunca registra contraseñas ni tokens (se ocultan automáticamente). */
export function crearLogger(nivel: string = 'info'): Logger {
  return pino({
    level: nivel,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['token', 'contrasena', 'password', 'authorization', '*.token', '*.contrasena', '*.password', '*.authorization', 'headers.authorization'],
      censor: '[oculto]',
    },
  });
}
