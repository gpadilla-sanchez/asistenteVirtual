/**
 * Normaliza un teléfono al formato que usa la API de WhatsApp (solo dígitos, con lada de país).
 *
 * México: los números pueden llegar como 10 dígitos (3312345678), con 52 (523312345678)
 * o con el antiguo prefijo móvil 521 (5213312345678). Todos se guardan como 52 + 10 dígitos,
 * así un mensaje entrante (que WhatsApp puede reportar con 521) se relaciona con el cliente correcto.
 */
export function normalizarTelefono(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  const digitos = String(valor).replace(/\D/g, '');
  if (digitos.length === 10) return `52${digitos}`;
  if (digitos.length === 13 && digitos.startsWith('521')) return `52${digitos.slice(3)}`;
  if (digitos.length === 12 && digitos.startsWith('52')) return digitos;
  if (digitos.length >= 11 && digitos.length <= 15 && !digitos.startsWith('52')) return digitos;
  return null;
}

/** Oculta parte del número para logs: 523312345678 → 52******5678 */
export function enmascarar(telefono: string): string {
  if (telefono.length < 6) return '***';
  return `${telefono.slice(0, 2)}${'*'.repeat(telefono.length - 6)}${telefono.slice(-4)}`;
}
