/**
 * Utilidades de fechas. Internamente las fechas de calendario se manejan como
 * texto 'YYYY-MM-DD' para evitar errores de zona horaria.
 */

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function partes(fecha: Date, zona: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zona,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const r: Record<string, string> = {};
  for (const p of fmt.formatToParts(fecha)) r[p.type] = p.value;
  return r;
}

/** Fecha de calendario 'YYYY-MM-DD' en la zona indicada. */
export function fechaEnZona(fecha: Date, zona: string): string {
  const p = partes(fecha, zona);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Hora 'HH:MM' (24 h) en la zona indicada. */
export function horaEnZona(fecha: Date, zona: string): string {
  const p = partes(fecha, zona);
  return `${p.hour}:${p.minute}`;
}

/** 'YYYY-MM-DD HH:MM' en la zona indicada, para mostrar o guardar en la hoja. */
export function fechaHoraEnZona(fecha: Date, zona: string): string {
  return `${fechaEnZona(fecha, zona)} ${horaEnZona(fecha, zona)}`;
}

export const DIAS_SEMANA = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'] as const;
export type DiaSemana = (typeof DIAS_SEMANA)[number];
const DIA_INGLES: Record<string, DiaSemana> = {
  Mon: 'lun', Tue: 'mar', Wed: 'mie', Thu: 'jue', Fri: 'vie', Sat: 'sab', Sun: 'dom',
};

/** Día de la semana en la zona indicada: 'lun', 'mar', ... */
export function diaSemana(fecha: Date, zona: string): DiaSemana {
  return DIA_INGLES[partes(fecha, zona).weekday!]!;
}

export function esFinDeSemana(fecha: Date, zona: string): boolean {
  const dia = diaSemana(fecha, zona);
  return dia === 'sab' || dia === 'dom';
}

function aUtc(iso: string): number {
  const [a, m, d] = iso.split('-').map(Number);
  return Date.UTC(a!, m! - 1, d!);
}

export function sumarDias(iso: string, dias: number): string {
  return new Date(aUtc(iso) + dias * 86_400_000).toISOString().slice(0, 10);
}

/** Días de `desde` a `hasta` (positivo si `hasta` es posterior). */
export function diasEntre(desde: string, hasta: string): number {
  return Math.round((aUtc(hasta) - aUtc(desde)) / 86_400_000);
}

function valida(a: number, m: number, d: number): string | null {
  if (!a || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const fecha = new Date(Date.UTC(a, m - 1, d));
  if (fecha.getUTCMonth() !== m - 1) return null;
  return fecha.toISOString().slice(0, 10);
}

/**
 * Convierte lo que venga de Excel o Google Sheets a 'YYYY-MM-DD'.
 * Acepta: Date, número de serie de hoja de cálculo, 'YYYY-MM-DD', 'DD/MM/YYYY', 'DD-MM-YYYY'.
 */
export type FormatoFecha = 'dd/mm/aaaa' | 'mm/dd/aaaa' | 'aaaa-mm-dd';

export function parsearFecha(valor: unknown, formato: FormatoFecha = 'dd/mm/aaaa'): string | null {
  if (valor === null || valor === undefined || valor === '') return null;
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return null;
    return valida(valor.getUTCFullYear(), valor.getUTCMonth() + 1, valor.getUTCDate());
  }
  if (typeof valor === 'number') {
    // Número de serie: días desde 1899-12-30 (Excel y Google Sheets)
    const ms = Date.UTC(1899, 11, 30) + Math.floor(valor) * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const texto = String(valor).trim();
  let m = texto.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valida(Number(m[1]), Number(m[2]), Number(m[3]));
  m = texto.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const anio = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    return formato === 'mm/dd/aaaa' ? valida(anio, Number(m[1]), Number(m[2])) : valida(anio, Number(m[2]), Number(m[1]));
  }
  if (/^\d+(\.\d+)?$/.test(texto)) return parsearFecha(Number(texto));
  return null;
}

/** '2026-11-15' → '15 de noviembre' */
export function fechaLegible(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} de ${MESES[m! - 1]}`;
}
