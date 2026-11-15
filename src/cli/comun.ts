import { cargarConfiguracion, rutasDesdeEntorno } from '../plataforma/configuracion.js';
import { Boveda } from '../seguridad/boveda.js';

export const rutas = rutasDesdeEntorno();

export function abrirBoveda(): Boveda {
  return Boveda.abrir(rutas.secretos, rutas.claveMaestra);
}

export function configuracion() {
  return cargarConfiguracion(rutas.config);
}

/** Ejecuta un comando mostrando errores de forma amigable. */
export async function ejecutar(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`\n✘ ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
