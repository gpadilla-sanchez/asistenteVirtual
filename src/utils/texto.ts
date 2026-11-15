/** Minúsculas, sin acentos ni signos, espacios simples. */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nombre de columna normalizado: 'Fecha de Vencimiento' → 'fecha_de_vencimiento' */
export function normalizarEncabezado(texto: string): string {
  return normalizar(texto).replace(/ /g, '_');
}

export function parsearMonto(valor: unknown): number | null {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (valor === null || valor === undefined) return null;
  const limpio = String(valor).replace(/[^0-9.-]/g, '');
  if (limpio === '') return null;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

const formatoMxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

/** 1250 → '$1,250.00 MXN' */
export function formatearMonto(monto: number): string {
  return `${formatoMxn.format(monto)} MXN`;
}

export function primerNombre(nombreCompleto: string): string {
  const limpio = nombreCompleto.trim();
  return limpio.split(/\s+/)[0] || limpio;
}

/** Meta no acepta saltos de línea, tabuladores ni más de 4 espacios seguidos en variables. */
export function limpiarVariable(texto: string): string {
  return texto.replace(/[\n\r\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

export function esperar(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function valorSiNo(valor: unknown, porDefecto: boolean): boolean {
  if (valor === true) return true;
  if (valor === false) return false;
  if (valor === null || valor === undefined || String(valor).trim() === '') return porDefecto;
  const v = normalizar(String(valor));
  if (['si', 's', 'true', '1', 'x', 'yes', 'acepta', 'ok'].includes(v)) return true;
  return false;
}
