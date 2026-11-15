import { sumarDias } from '../utils/fechas.js';

/** Recibo tal como lo guarda la aseguradora simulada. */
export interface ReciboSimulado {
  recibo: string;
  poliza: string;
  contratante: string;
  telefono: string; // como lo muestra el portal: "(55) 0001-0003"
  producto: string;
  prima: number;
  fechaLimite: string; // YYYY-MM-DD
  estado: 'Pendiente' | 'Pagado' | 'Cancelado';
}

/** Generador pseudoaleatorio con semilla: los mismos datos cada vez que se inicia. */
function aleatorio(semilla: string): () => number {
  let h = 1779033703;
  for (const c of semilla) h = Math.imul(h ^ c.charCodeAt(0), 3432918353) >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOMBRES = ['María', 'José', 'Guadalupe', 'Juan', 'Fernanda', 'Carlos', 'Sofía', 'Miguel', 'Valeria', 'Ricardo', 'Daniela', 'Alejandro', 'Paola', 'Jorge'];
const APELLIDOS = ['Hernández', 'García', 'Martínez', 'López', 'González', 'Rodríguez', 'Pérez', 'Sánchez', 'Ramírez', 'Torres', 'Flores', 'Rivera'];
const PRODUCTOS: [string, string, number, number][] = [
  ['Gastos Médicos Mayores', 'GMM', 2800, 9500],
  ['Vida', 'VID', 900, 4200],
  ['Auto', 'AUT', 1500, 6800],
  ['Hogar', 'HOG', 600, 2400],
];

/** Días respecto a "hoy" de cada recibo: hay vencidos, por vencer y algunos lejanos. */
const DESFASES = [-12, -5, -2, 0, 1, 2, 3, 4, 6, 9, 15, 24];

/**
 * Cartera ficticia de un agente. `indice` separa los teléfonos entre agentes.
 * Casos incluidos a propósito: un cliente con dos pólizas, un teléfono que WhatsApp no puede
 * entregar (termina en 9999) y algunos recibos ya pagados.
 */
export function generarCartera(usuario: string, indice: number, hoy: string): ReciboSimulado[] {
  const azar = aleatorio(usuario);
  const elegir = <T>(lista: T[]) => lista[Math.floor(azar() * lista.length)]!;
  const iniciales = usuario.split(/[.\-_]/).map((p) => p[0]?.toUpperCase() ?? 'X').join('');
  const recibos: ReciboSimulado[] = [];

  DESFASES.forEach((desfase, i) => {
    const [producto, clave, min, max] = elegir(PRODUCTOS);
    const n = i === 5 ? 4 : i; // el recibo 5 es del mismo cliente que el 4 (dos pólizas)
    const contratante = i === 5 ? recibos[4]!.contratante : `${elegir(NOMBRES)} ${elegir(APELLIDOS)} ${elegir(APELLIDOS)}`;
    const linea = i === 7 ? 9999 : 1 + n;
    const telefono = `(55) ${String(indice).padStart(4, '0')}-${String(linea).padStart(4, '0')}`;
    recibos.push({
      recibo: `R-${iniciales}-${String(1001 + i)}`,
      poliza: `${clave}-${String(Math.floor(100000 + azar() * 899999))}`,
      contratante,
      telefono,
      producto,
      prima: Math.round((min + azar() * (max - min)) * 100) / 100,
      fechaLimite: sumarDias(hoy, desfase),
      estado: desfase === -12 || i === 10 ? 'Pagado' : 'Pendiente',
    });
  });
  return recibos;
}

export function formatoPortalFecha(iso: string): string {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}

export function formatoPortalPrima(n: number): string {
  return `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
