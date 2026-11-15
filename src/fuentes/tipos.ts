/** Estado del recibo según la aseguradora (portal o archivo). */
export type EstadoFuente = 'pendiente' | 'pagado' | 'cancelado' | 'desconocido';

/** Estado del seguimiento que lleva el asistente. */
export type EstadoSeguimiento = 'pendiente' | 'reportado' | 'pagado' | 'escalado' | 'cancelado';

/** Un recibo por cobrar tal como viene de la aseguradora. */
export interface Pago {
  /** Identificador único del recibo (número de recibo). */
  id: string;
  poliza: string;
  cliente: string;
  /** Teléfono normalizado (solo dígitos con lada de país) o null si no es válido. */
  telefono: string | null;
  telefonoOriginal: string;
  producto: string;
  monto: number | null;
  /** 'YYYY-MM-DD' */
  fechaVencimiento: string | null;
  estado: EstadoFuente;
  estadoOriginal: string;
  aceptaWhatsapp: boolean;
}

/** Cualquier origen de recibos: portal de la aseguradora, archivo exportado, etc. Solo lectura. */
export interface FuenteDatos {
  readonly nombre: string;
  leerPagos(): Promise<Pago[]>;
}
