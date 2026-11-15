import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EstadoFuente, EstadoSeguimiento, Pago } from '../fuentes/tipos.js';

/**
 * Base local de UN agente (data/agentes/<id>/asistente.db).
 * Cada agente tiene su propio archivo: los datos quedan separados, se respaldan o mueven
 * por agente, y la plataforma puede repartirse en varios equipos sin cambios.
 */

export type Respuesta = 'si' | 'no' | 'sin_respuesta' | 'otro';
export type OrigenEstado = 'sistema' | 'cliente' | 'fuente' | 'panel' | 'ausente_en_fuente';

export interface Seguimiento {
  pagoId: string;
  estado: EstadoSeguimiento;
  origenEstado: OrigenEstado;
  intentos: number;
  ultimoEnvio: string | null;
  /** 'YYYY-MM-DD' local del último recordatorio */
  ultimoEnvioDia: string | null;
  /** 'YYYY-MM-DD' a partir del cual se puede volver a enviar */
  proximoEnvio: string | null;
  ultimaRespuesta: Respuesta | null;
  fechaRespuesta: string | null;
  noReconocidas: number;
  ultimoError: string | null;
}

export interface PagoGuardado extends Pago {
  vistoEn: string;
}

export interface FilaPanel {
  id: string;
  poliza: string;
  cliente: string;
  telefono: string | null;
  producto: string;
  monto: number | null;
  fechaVencimiento: string | null;
  estadoFuente: EstadoFuente | 'ausente';
  estado: EstadoSeguimiento;
  origenEstado: OrigenEstado;
  intentos: number;
  ultimoEnvio: string | null;
  proximoEnvio: string | null;
  ultimaRespuesta: string | null;
  ultimoError: string | null;
}

export interface Evento {
  fecha: string;
  pagoId: string | null;
  tipo: string;
  detalle: string;
}

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS pagos (
  id TEXT PRIMARY KEY,
  poliza TEXT, cliente TEXT NOT NULL, telefono TEXT, telefono_original TEXT, producto TEXT,
  monto REAL, fecha_vencimiento TEXT, acepta_whatsapp INTEGER NOT NULL,
  estado_fuente TEXT NOT NULL, estado_original TEXT,
  visto_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pagos_tel ON pagos(telefono);

CREATE TABLE IF NOT EXISTS seguimientos (
  pago_id TEXT PRIMARY KEY,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  origen_estado TEXT NOT NULL DEFAULT 'sistema',
  intentos INTEGER NOT NULL DEFAULT 0,
  ultimo_envio TEXT, ultimo_envio_dia TEXT, proximo_envio TEXT,
  ultima_respuesta TEXT, fecha_respuesta TEXT,
  no_reconocidas INTEGER NOT NULL DEFAULT 0,
  ultimo_error TEXT
);

CREATE TABLE IF NOT EXISTS mensajes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wamid TEXT NOT NULL UNIQUE,
  pago_id TEXT, telefono TEXT NOT NULL, direccion TEXT NOT NULL, tipo TEXT NOT NULL,
  contenido TEXT, estado_entrega TEXT, error TEXT, creado_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mensajes_tel ON mensajes(telefono, creado_en);

CREATE TABLE IF NOT EXISTS bajas (telefono TEXT PRIMARY KEY, creado_en TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL, pago_id TEXT, tipo TEXT NOT NULL, detalle TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eventos_pago ON eventos(pago_id);

CREATE TABLE IF NOT EXISTS kv (clave TEXT PRIMARY KEY, valor TEXT NOT NULL);
`;

interface FilaSeguimiento {
  pago_id: string; estado: EstadoSeguimiento; origen_estado: OrigenEstado; intentos: number;
  ultimo_envio: string | null; ultimo_envio_dia: string | null; proximo_envio: string | null;
  ultima_respuesta: Respuesta | null; fecha_respuesta: string | null; no_reconocidas: number; ultimo_error: string | null;
}

interface FilaPago {
  id: string; poliza: string | null; cliente: string; telefono: string | null; telefono_original: string | null;
  producto: string | null; monto: number | null; fecha_vencimiento: string | null; acepta_whatsapp: number;
  estado_fuente: EstadoFuente; estado_original: string | null; visto_en: string;
}

const aSeguimiento = (f: FilaSeguimiento): Seguimiento => ({
  pagoId: f.pago_id, estado: f.estado, origenEstado: f.origen_estado, intentos: f.intentos,
  ultimoEnvio: f.ultimo_envio, ultimoEnvioDia: f.ultimo_envio_dia, proximoEnvio: f.proximo_envio,
  ultimaRespuesta: f.ultima_respuesta, fechaRespuesta: f.fecha_respuesta, noReconocidas: f.no_reconocidas, ultimoError: f.ultimo_error,
});

const aPago = (f: FilaPago): PagoGuardado => ({
  id: f.id, poliza: f.poliza ?? '', cliente: f.cliente, telefono: f.telefono, telefonoOriginal: f.telefono_original ?? '',
  producto: f.producto ?? '', monto: f.monto, fechaVencimiento: f.fecha_vencimiento, aceptaWhatsapp: f.acepta_whatsapp === 1,
  estado: f.estado_fuente, estadoOriginal: f.estado_original ?? '', vistoEn: f.visto_en,
});

export class BaseDatos {
  private readonly db: Database.Database;

  constructor(ruta: string) {
    if (ruta !== ':memory:') mkdirSync(dirname(ruta), { recursive: true });
    this.db = new Database(ruta);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(ESQUEMA);
  }

  // ---------- Recibos (copia de la fuente) ----------

  guardarPagos(pagos: Pago[], marca: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO pagos (id, poliza, cliente, telefono, telefono_original, producto, monto, fecha_vencimiento,
        acepta_whatsapp, estado_fuente, estado_original, visto_en)
      VALUES (@id, @poliza, @cliente, @telefono, @telefonoOriginal, @producto, @monto, @fechaVencimiento,
        @acepta, @estado, @estadoOriginal, @marca)
      ON CONFLICT(id) DO UPDATE SET poliza=excluded.poliza, cliente=excluded.cliente, telefono=excluded.telefono,
        telefono_original=excluded.telefono_original, producto=excluded.producto, monto=excluded.monto,
        fecha_vencimiento=excluded.fecha_vencimiento, acepta_whatsapp=excluded.acepta_whatsapp,
        estado_fuente=excluded.estado_fuente, estado_original=excluded.estado_original, visto_en=excluded.visto_en`);
    this.db.transaction((lista: Pago[]) => {
      for (const p of lista) stmt.run({ ...p, acepta: p.aceptaWhatsapp ? 1 : 0, marca });
    })(pagos);
  }

  obtenerPago(id: string): PagoGuardado | undefined {
    const f = this.db.prepare('SELECT * FROM pagos WHERE id = ?').get(id) as FilaPago | undefined;
    return f ? aPago(f) : undefined;
  }

  listarPagos(): PagoGuardado[] {
    return (this.db.prepare('SELECT * FROM pagos ORDER BY fecha_vencimiento').all() as FilaPago[]).map(aPago);
  }

  /** Recibos que estaban abiertos y ya no aparecieron en la última lectura de la fuente. */
  abiertosNoVistos(marca: string): string[] {
    return (
      this.db
        .prepare(`SELECT p.id FROM pagos p LEFT JOIN seguimientos s ON s.pago_id = p.id
                  WHERE p.visto_en <> ? AND COALESCE(s.estado, 'pendiente') IN ('pendiente', 'reportado', 'escalado')`)
        .all(marca) as { id: string }[]
    ).map((r) => r.id);
  }

  contarAbiertos(): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM pagos p LEFT JOIN seguimientos s ON s.pago_id = p.id
                  WHERE p.estado_fuente = 'pendiente' AND COALESCE(s.estado, 'pendiente') IN ('pendiente', 'reportado', 'escalado')`)
        .get() as { n: number }
    ).n;
  }

  pagosDeTelefono(telefono: string): string[] {
    return (this.db.prepare('SELECT id FROM pagos WHERE telefono = ?').all(telefono) as { id: string }[]).map((r) => r.id);
  }

  // ---------- Seguimientos ----------

  obtenerSeguimiento(pagoId: string): Seguimiento | undefined {
    const f = this.db.prepare('SELECT * FROM seguimientos WHERE pago_id = ?').get(pagoId) as FilaSeguimiento | undefined;
    return f ? aSeguimiento(f) : undefined;
  }

  seguimientoONuevo(pagoId: string): Seguimiento {
    return this.obtenerSeguimiento(pagoId) ?? {
      pagoId, estado: 'pendiente', origenEstado: 'sistema', intentos: 0, ultimoEnvio: null, ultimoEnvioDia: null,
      proximoEnvio: null, ultimaRespuesta: null, fechaRespuesta: null, noReconocidas: 0, ultimoError: null,
    };
  }

  guardarSeguimiento(s: Seguimiento): void {
    this.db
      .prepare(`
        INSERT INTO seguimientos (pago_id, estado, origen_estado, intentos, ultimo_envio, ultimo_envio_dia, proximo_envio,
          ultima_respuesta, fecha_respuesta, no_reconocidas, ultimo_error)
        VALUES (@pagoId, @estado, @origenEstado, @intentos, @ultimoEnvio, @ultimoEnvioDia, @proximoEnvio,
          @ultimaRespuesta, @fechaRespuesta, @noReconocidas, @ultimoError)
        ON CONFLICT(pago_id) DO UPDATE SET estado=excluded.estado, origen_estado=excluded.origen_estado,
          intentos=excluded.intentos, ultimo_envio=excluded.ultimo_envio, ultimo_envio_dia=excluded.ultimo_envio_dia,
          proximo_envio=excluded.proximo_envio, ultima_respuesta=excluded.ultima_respuesta,
          fecha_respuesta=excluded.fecha_respuesta, no_reconocidas=excluded.no_reconocidas, ultimo_error=excluded.ultimo_error`)
      .run(s);
  }

  /** Recibos de ese teléfono con recordatorio enviado y aún pendientes, del más reciente al más antiguo. */
  pagosPendientesNotificados(telefono: string): string[] {
    return (
      this.db
        .prepare(`SELECT s.pago_id AS id FROM seguimientos s JOIN pagos p ON p.id = s.pago_id
                  WHERE p.telefono = ? AND s.estado = 'pendiente' AND s.intentos > 0 ORDER BY s.ultimo_envio DESC`)
        .all(telefono) as { id: string }[]
    ).map((r) => r.id);
  }

  ultimoEnvioATelefono(telefono: string): string | null {
    const f = this.db
      .prepare(`SELECT MAX(creado_en) AS f FROM mensajes WHERE telefono = ? AND direccion = 'saliente'`)
      .get(telefono) as { f: string | null };
    return f.f;
  }

  listarPanel(): FilaPanel[] {
    return this.db
      .prepare(`
        SELECT p.id, COALESCE(p.poliza, '') AS poliza, p.cliente, p.telefono, COALESCE(p.producto, '') AS producto, p.monto,
               p.fecha_vencimiento AS fechaVencimiento, p.estado_fuente AS estadoFuente,
               COALESCE(s.estado, CASE p.estado_fuente WHEN 'pagado' THEN 'pagado' WHEN 'cancelado' THEN 'cancelado' ELSE 'pendiente' END) AS estado,
               COALESCE(s.origen_estado, 'sistema') AS origenEstado,
               COALESCE(s.intentos, 0) AS intentos, s.ultimo_envio AS ultimoEnvio, s.proximo_envio AS proximoEnvio,
               s.ultima_respuesta AS ultimaRespuesta, s.ultimo_error AS ultimoError
        FROM pagos p LEFT JOIN seguimientos s ON s.pago_id = p.id
        ORDER BY CASE COALESCE(s.estado, 'pendiente') WHEN 'escalado' THEN 0 WHEN 'reportado' THEN 1 WHEN 'pendiente' THEN 2 ELSE 3 END,
                 p.fecha_vencimiento`)
      .all() as FilaPanel[];
  }

  // ---------- Mensajes ----------

  /** Registra un mensaje. Devuelve false si el wamid ya existía (evento duplicado). */
  registrarMensaje(m: { wamid: string; pagoId: string | null; telefono: string; direccion: 'saliente' | 'entrante'; tipo: string; contenido: unknown }, fecha: string): boolean {
    const r = this.db
      .prepare(`INSERT OR IGNORE INTO mensajes (wamid, pago_id, telefono, direccion, tipo, contenido, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(m.wamid, m.pagoId, m.telefono, m.direccion, m.tipo, JSON.stringify(m.contenido ?? null), fecha);
    return r.changes > 0;
  }

  pagoDeMensaje(wamid: string): string | null {
    const f = this.db.prepare('SELECT pago_id FROM mensajes WHERE wamid = ?').get(wamid) as { pago_id: string | null } | undefined;
    return f?.pago_id ?? null;
  }

  tieneMensaje(wamid: string): boolean {
    return this.db.prepare('SELECT 1 FROM mensajes WHERE wamid = ?').get(wamid) !== undefined;
  }

  actualizarEntrega(wamid: string, estado: string, error?: string): string | null {
    this.db.prepare('UPDATE mensajes SET estado_entrega = ?, error = COALESCE(?, error) WHERE wamid = ?').run(estado, error ?? null, wamid);
    return this.pagoDeMensaje(wamid);
  }

  // ---------- Bajas ----------

  esBaja(telefono: string): boolean {
    return this.db.prepare('SELECT 1 FROM bajas WHERE telefono = ?').get(telefono) !== undefined;
  }

  agregarBaja(telefono: string, fecha: string): void {
    this.db.prepare('INSERT OR IGNORE INTO bajas (telefono, creado_en) VALUES (?, ?)').run(telefono, fecha);
  }

  quitarBaja(telefono: string): void {
    this.db.prepare('DELETE FROM bajas WHERE telefono = ?').run(telefono);
  }

  // ---------- Bitácora por recibo ----------

  registrarEvento(fecha: string, pagoId: string | null, tipo: string, detalle: string): void {
    this.db.prepare('INSERT INTO eventos (fecha, pago_id, tipo, detalle) VALUES (?, ?, ?, ?)').run(fecha, pagoId, tipo, detalle);
  }

  eventos(pagoId?: string, limite = 50): Evento[] {
    const sql = pagoId
      ? 'SELECT fecha, pago_id AS pagoId, tipo, detalle FROM eventos WHERE pago_id = ? ORDER BY id DESC LIMIT ?'
      : 'SELECT fecha, pago_id AS pagoId, tipo, detalle FROM eventos ORDER BY id DESC LIMIT ?';
    return (pagoId ? this.db.prepare(sql).all(pagoId, limite) : this.db.prepare(sql).all(limite)) as Evento[];
  }

  // ---------- Varios ----------

  leer(clave: string): string | undefined {
    return (this.db.prepare('SELECT valor FROM kv WHERE clave = ?').get(clave) as { valor: string } | undefined)?.valor;
  }

  escribir(clave: string, valor: string): void {
    this.db.prepare('INSERT INTO kv (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor').run(clave, valor);
  }

  async respaldar(destino: string): Promise<void> {
    mkdirSync(dirname(destino), { recursive: true });
    await this.db.backup(destino);
  }

  cerrar(): void {
    this.db.close();
  }
}
