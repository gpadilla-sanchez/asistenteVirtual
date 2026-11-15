import type { Campo, PerfilPortal } from '../plataforma/configuracion.js';
import { parsearFecha, type FormatoFecha } from '../utils/fechas.js';
import { normalizarTelefono } from '../utils/telefono.js';
import { normalizar, parsearMonto, valorSiNo } from '../utils/texto.js';
import type { EstadoFuente, Pago } from './tipos.js';

/** Nombres alternativos que se reconocen si el perfil no indica la columna exacta. */
const ALIAS: Record<Campo, string[]> = {
  id: ['recibo', 'no recibo', 'numero de recibo', 'id pago', 'id', 'folio'],
  poliza: ['poliza', 'no poliza', 'numero de poliza'],
  cliente: ['contratante', 'asegurado', 'cliente', 'nombre'],
  telefono: ['telefono', 'celular', 'whatsapp', 'telefono celular', 'movil'],
  producto: ['producto', 'ramo', 'plan', 'tipo de seguro'],
  monto: ['prima', 'importe', 'monto', 'prima total', 'total'],
  fecha_vencimiento: ['fecha limite', 'fecha limite de pago', 'vencimiento', 'fecha de vencimiento', 'fecha vencimiento', 'limite de pago'],
  estado: ['estado', 'estatus', 'status', 'situacion'],
  acepta_whatsapp: ['acepta whatsapp', 'consentimiento'],
};

const OBLIGATORIOS: Campo[] = ['id', 'cliente', 'telefono', 'fecha_vencimiento'];

export type MapaColumnas = Partial<Record<Campo, number>>;

/** Ubica cada campo en los encabezados. Usa los nombres del perfil y, si faltan, los alias. */
export function mapearEncabezados(encabezados: unknown[], columnas?: PerfilPortal['columnas']): MapaColumnas {
  const normalizados = encabezados.map((e) => normalizar(String(e ?? '')));
  const mapa: MapaColumnas = {};
  for (const campo of Object.keys(ALIAS) as Campo[]) {
    const exacto = columnas?.[campo];
    const candidatos = exacto ? [normalizar(exacto)] : ALIAS[campo];
    const indice = normalizados.findIndex((n) => candidatos.includes(n));
    if (indice >= 0) mapa[campo] = indice;
  }
  const faltantes = OBLIGATORIOS.filter((c) => mapa[c] === undefined);
  if (faltantes.length > 0) {
    const nombres = faltantes.map((c) => columnas?.[c] ?? c).join(', ');
    throw new Error(`No se encontraron las columnas: ${nombres}. Encabezados encontrados: ${encabezados.join(' | ')}`);
  }
  return mapa;
}

export function interpretarEstado(valor: unknown, estados?: PerfilPortal['estados']): EstadoFuente {
  const v = normalizar(String(valor ?? ''));
  if (estados) {
    for (const tipo of ['pendiente', 'pagado', 'cancelado'] as const) {
      if (estados[tipo].some((e) => normalizar(e) === v)) return tipo;
    }
  }
  if (v === '' || ['pendiente', 'por pagar', 'no pagado', 'vencido', 'adeudo', 'emitido'].includes(v)) return 'pendiente';
  if (['pagado', 'pagada', 'aplicado', 'cobrado', 'liquidado'].includes(v)) return 'pagado';
  if (['cancelado', 'cancelada', 'anulado', 'rehabilitado'].includes(v)) return 'cancelado';
  return 'desconocido';
}

function texto(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  return String(valor).replace(/\s+/g, ' ').trim();
}

export interface OpcionesFila {
  formatoFecha: FormatoFecha;
  estados?: PerfilPortal['estados'];
  aceptaPorDefecto: boolean;
}

/** Convierte un renglón en Pago. Devuelve null si el renglón está vacío. */
export function interpretarFila(fila: unknown[], mapa: MapaColumnas, op: OpcionesFila): Pago | null {
  const celda = (c: Campo) => (mapa[c] === undefined ? undefined : fila[mapa[c]!]);
  const id = texto(celda('id'));
  const cliente = texto(celda('cliente'));
  if (!id && !cliente) return null;
  const telefonoOriginal = texto(celda('telefono'));
  return {
    id: id || `sin-id-${cliente}`,
    poliza: texto(celda('poliza')),
    cliente,
    telefono: normalizarTelefono(telefonoOriginal),
    telefonoOriginal,
    producto: texto(celda('producto')),
    monto: parsearMonto(celda('monto')),
    fechaVencimiento: parsearFecha(celda('fecha_vencimiento'), op.formatoFecha),
    estado: interpretarEstado(celda('estado'), op.estados),
    estadoOriginal: texto(celda('estado')),
    aceptaWhatsapp: mapa.acepta_whatsapp === undefined ? op.aceptaPorDefecto : valorSiNo(celda('acepta_whatsapp'), op.aceptaPorDefecto),
  };
}

/** Convierte una tabla completa (primer renglón = encabezados). Ignora IDs repetidos. */
export function interpretarTabla(filas: unknown[][], perfil: PerfilPortal | undefined, aceptaPorDefecto: boolean): Pago[] {
  if (filas.length === 0) return [];
  const mapa = mapearEncabezados(filas[0]!, perfil?.columnas);
  const op: OpcionesFila = { formatoFecha: perfil?.formato_fecha ?? 'dd/mm/aaaa', estados: perfil?.estados, aceptaPorDefecto };
  const vistos = new Set<string>();
  const pagos: Pago[] = [];
  for (const fila of filas.slice(1)) {
    const pago = interpretarFila(fila ?? [], mapa, op);
    if (!pago || vistos.has(pago.id)) continue;
    vistos.add(pago.id);
    pagos.push(pago);
  }
  return pagos;
}
