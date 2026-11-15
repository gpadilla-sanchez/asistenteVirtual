import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Contraseñas del panel: se guardan como hash scrypt (no se pueden recuperar,
 * solo verificar). Formato: scrypt$N$r$p$sal$hash
 */
const N = 16384;
const R = 8;
const P = 1;

export function hashContrasena(contrasena: string): string {
  const sal = randomBytes(16);
  const hash = scryptSync(contrasena, sal, 32, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${sal.toString('base64')}$${hash.toString('base64')}`;
}

export function verificarContrasena(contrasena: string, guardado: string | undefined): boolean {
  if (!guardado) return false;
  const [tipo, n, r, p, sal, hash] = guardado.split('$');
  if (tipo !== 'scrypt' || !sal || !hash) return false;
  const esperado = Buffer.from(hash, 'base64');
  const calculado = scryptSync(contrasena, Buffer.from(sal, 'base64'), esperado.length, {
    N: Number(n), r: Number(r), p: Number(p),
  });
  return calculado.length === esperado.length && timingSafeEqual(calculado, esperado);
}

export function validarFortaleza(contrasena: string): string | null {
  if (contrasena.length < 10) return 'Debe tener al menos 10 caracteres';
  if (!/[a-zA-Z]/.test(contrasena) || !/\d/.test(contrasena)) return 'Debe combinar letras y números';
  return null;
}

/** Contraseña aleatoria legible (sin caracteres confusos). */
export function generarContrasena(largo = 16): string {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(largo);
  let r = '';
  for (const b of bytes) r += alfabeto[b % alfabeto.length];
  return /\d/.test(r) ? r : `${r.slice(0, -1)}7`;
}
