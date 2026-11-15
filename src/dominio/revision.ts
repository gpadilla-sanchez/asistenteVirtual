import { randomBytes } from 'node:crypto';
import type { Seguimiento } from '../db/baseDatos.js';
import { ErrorPortal } from '../fuentes/portal.js';
import type { Pago } from '../fuentes/tipos.js';
import type { ReglasEnvio } from '../plataforma/configuracion.js';
import type { ContextoAgente } from '../plataforma/contexto.js';
import { diaSemana, diasEntre, fechaEnZona, horaEnZona, sumarDias } from '../utils/fechas.js';
import { enmascarar } from '../utils/telefono.js';
import { esperar, formatearMonto } from '../utils/texto.js';
import { ErrorWhatsApp } from '../whatsapp/cliente.js';
import { payloadsPara, variablesPara } from '../whatsapp/plantillas.js';

// =====================================================================
//  Reglas: ¿cuándo y cada cuándo se avisa?
// =====================================================================

export type Decision =
  | { tipo: 'omitir'; motivo: string }
  | { tipo: 'enviar'; plantilla: 'recordatorio' | 'seguimiento' }
  | { tipo: 'escalar' };

/**
 * Decide qué hacer HOY con un recibo. Función pura: fácil de probar.
 *  - Primer aviso: `primer_aviso_dias_antes` días antes del vencimiento.
 *  - Si responde "No" o no responde: otro aviso cada `repetir_cada_dias` (antes) o `repetir_cada_dias_vencido` (después).
 *  - Si responde "Sí": se detiene (lo maneja el estado "reportado").
 *  - Tope: `max_avisos` o `dejar_de_avisar_dias_despues` → se escala al agente.
 */
export function decidir(pago: Pago, seg: Seguimiento | undefined, hoy: string, reglas: ReglasEnvio, dadoDeBaja: boolean): Decision {
  if (pago.estado !== 'pendiente') return { tipo: 'omitir', motivo: `la aseguradora lo marca ${pago.estado}` };
  if (seg && seg.estado !== 'pendiente') return { tipo: 'omitir', motivo: `seguimiento ${seg.estado}` };
  if (!pago.telefono) return { tipo: 'omitir', motivo: 'teléfono inválido' };
  if (!pago.aceptaWhatsapp) return { tipo: 'omitir', motivo: 'sin consentimiento' };
  if (dadoDeBaja) return { tipo: 'omitir', motivo: 'cliente dado de baja' };
  if (!pago.fechaVencimiento) return { tipo: 'omitir', motivo: 'sin fecha límite' };

  const diasParaVencer = diasEntre(hoy, pago.fechaVencimiento);
  if (diasParaVencer > reglas.primer_aviso_dias_antes) return { tipo: 'omitir', motivo: 'aún no toca avisar' };
  if (-diasParaVencer > reglas.dejar_de_avisar_dias_despues) {
    return (seg?.intentos ?? 0) > 0 ? { tipo: 'escalar' } : { tipo: 'omitir', motivo: 'vencido hace demasiado (sin avisos previos)' };
  }
  if (seg?.ultimoEnvioDia === hoy) return { tipo: 'omitir', motivo: 'ya se avisó hoy' };
  if (seg?.proximoEnvio && seg.proximoEnvio > hoy) return { tipo: 'omitir', motivo: 'programado para otro día' };
  if ((seg?.intentos ?? 0) >= reglas.max_avisos) return { tipo: 'escalar' };
  return { tipo: 'enviar', plantilla: hoy <= pago.fechaVencimiento ? 'recordatorio' : 'seguimiento' };
}

/** Siguiente día en que se puede volver a avisar. Antes del vencimiento nunca se salta el día límite. */
export function calcularProximoEnvio(hoy: string, vencimiento: string, reglas: ReglasEnvio): string {
  if (hoy < vencimiento) {
    const siguiente = sumarDias(hoy, reglas.repetir_cada_dias);
    return siguiente < vencimiento ? siguiente : vencimiento;
  }
  return sumarDias(hoy, reglas.repetir_cada_dias_vencido);
}

export function describirCuando(dia: string, hoy: string): string {
  const dias = diasEntre(hoy, dia);
  if (dias <= 1) return 'mañana';
  return `en ${dias} días`;
}

// =====================================================================
//  Sincronización con la aseguradora
// =====================================================================

export interface ResultadoSincronizacion {
  recibos: number;
  pagados: number;
  ausentes: number;
}

/** Lee la fuente (portal o archivo), guarda la copia local y aplica lo que la aseguradora ya marcó como pagado. */
export async function sincronizar(ctx: ContextoAgente): Promise<ResultadoSincronizacion> {
  const { db, logger } = ctx;
  const ahora = ctx.reloj.ahora();
  const marca = ahora.toISOString();
  // Marca única de esta lectura (para saber qué recibos ya no aparecieron)
  const lectura = `${marca}#${randomBytes(4).toString('hex')}`;
  const r: ResultadoSincronizacion = { recibos: 0, pagados: 0, ausentes: 0 };

  let pagos: Pago[];
  try {
    pagos = await ctx.fuente.leerPagos();
  } catch (e) {
    db.escribir('ultimo_error_sincronizacion', `${marca} ${(e as Error).message}`);
    if (e instanceof ErrorPortal && (e.tipo === 'credenciales' || e.tipo === 'captcha')) {
      await ctx.notificador.notificar(
        e.tipo === 'credenciales' ? 'El portal rechazó tu usuario o contraseña' : 'El portal pide captcha',
        `${e.message}\n\nActualiza tus credenciales con: npm run secretos -- portal ${ctx.agente.id}\n` +
          'Mientras tanto no se envían recordatorios para no avisar con información vieja.',
      );
    }
    throw e;
  }

  // Protección: si la fuente devuelve 0 recibos pero había abiertos, probablemente falló la lectura
  if (pagos.length === 0 && db.contarAbiertos() > 0) {
    const mensaje = 'La fuente no devolvió recibos aunque había pendientes; se conserva la información anterior';
    db.escribir('ultimo_error_sincronizacion', `${marca} ${mensaje}`);
    throw new Error(mensaje);
  }

  db.guardarPagos(pagos, lectura);
  r.recibos = pagos.length;

  for (const pago of pagos) {
    if (pago.estado !== 'pagado' && pago.estado !== 'cancelado') continue;
    const seg = db.obtenerSeguimiento(pago.id);
    if (seg?.estado === pago.estado) continue;
    db.guardarSeguimiento({ ...db.seguimientoONuevo(pago.id), estado: pago.estado, origenEstado: 'fuente', proximoEnvio: null });
    if (seg) db.registrarEvento(marca, pago.id, pago.estado, `La aseguradora lo marca como ${pago.estado}`);
    if (pago.estado === 'pagado') r.pagados++;
  }

  // Recibos que estaban abiertos y ya no aparecen en el portal: se asume que se pagaron
  for (const id of db.abiertosNoVistos(lectura)) {
    db.guardarSeguimiento({ ...db.seguimientoONuevo(id), estado: 'pagado', origenEstado: 'ausente_en_fuente', proximoEnvio: null });
    db.registrarEvento(marca, id, 'pagado', 'Ya no aparece en la aseguradora (se asume pagado)');
    r.ausentes++;
  }

  db.escribir('ultima_sincronizacion', marca);
  db.escribir('ultimo_error_sincronizacion', '');
  logger.info({ ...r }, `Sincronización con ${ctx.fuente.nombre} terminada`);
  return r;
}

// =====================================================================
//  Revisión diaria: enviar recordatorios
// =====================================================================

export interface ResultadoRevision {
  ejecutada: boolean;
  motivo?: string;
  revisados: number;
  enviados: number;
  escalados: number;
  reabiertos: number;
  errores: number;
  omitidos: Record<string, number>;
}

const enCurso = new Set<string>();

export async function revisar(ctx: ContextoAgente, opciones: { ignorarHorario?: boolean } = {}): Promise<ResultadoRevision> {
  const { agente, sistema, db, logger } = ctx;
  const reglas = agente.envios;
  const r: ResultadoRevision = { ejecutada: false, revisados: 0, enviados: 0, escalados: 0, reabiertos: 0, errores: 0, omitidos: {} };
  const ahora = ctx.reloj.ahora();
  const zona = sistema.zona_horaria;
  const hoy = fechaEnZona(ahora, zona);

  if (!agente.activo) return { ...r, motivo: 'agente inactivo' };
  if (!opciones.ignorarHorario) {
    const hora = horaEnZona(ahora, zona);
    if (hora < reglas.horario.inicio || hora >= reglas.horario.fin) {
      return { ...r, motivo: `fuera del horario de envío (${reglas.horario.inicio}-${reglas.horario.fin})` };
    }
  }
  if (!reglas.dias_semana.includes(diaSemana(ahora, zona))) return { ...r, motivo: `hoy (${diaSemana(ahora, zona)}) no es día de envío` };

  // No avisar con información vieja: la última lectura de la aseguradora debe ser reciente
  const ultima = db.leer('ultima_sincronizacion');
  const horasDesde = ultima ? (ahora.getTime() - new Date(ultima).getTime()) / 3_600_000 : Infinity;
  if (horasDesde > agente.fuente.max_antiguedad_horas) {
    try {
      await sincronizar(ctx);
    } catch (e) {
      const motivo = `no se pudo actualizar la información de la aseguradora: ${(e as Error).message}`;
      await ctx.notificador.notificar('No se enviaron recordatorios hoy', `${motivo}\nNo se envía nada para no avisar a quien ya pagó.`);
      return { ...r, motivo };
    }
  }

  if (enCurso.has(agente.id)) return { ...r, motivo: 'ya hay una revisión en curso' };
  enCurso.add(agente.id);
  try {
    const marca = ahora.toISOString();
    const pagos = db.listarPagos();
    r.ejecutada = true;
    r.revisados = pagos.length;
    const escalados: Pago[] = [];
    const reabiertos: Pago[] = [];
    const fallidos: string[] = [];

    for (const pago of pagos) {
      let seg = db.obtenerSeguimiento(pago.id);

      // Dijo que pagó, pero pasaron N días y la aseguradora sigue sin aplicarlo: se reanudan los avisos
      if (seg?.estado === 'reportado' && pago.estado === 'pendiente' && reglas.reabrir_reportado_tras_dias > 0 && seg.fechaRespuesta) {
        const dias = diasEntre(fechaEnZona(new Date(seg.fechaRespuesta), zona), hoy);
        if (dias >= reglas.reabrir_reportado_tras_dias) {
          seg = { ...seg, estado: 'pendiente', origenEstado: 'sistema', proximoEnvio: null };
          db.guardarSeguimiento(seg);
          db.registrarEvento(marca, pago.id, 'reabierto', `El cliente reportó el pago hace ${dias} días y la aseguradora aún no lo aplica`);
          reabiertos.push(pago);
          r.reabiertos++;
        }
      }

      const decision = decidir(pago, seg, hoy, reglas, pago.telefono ? db.esBaja(pago.telefono) : false);
      if (decision.tipo === 'omitir') {
        r.omitidos[decision.motivo] = (r.omitidos[decision.motivo] ?? 0) + 1;
        continue;
      }
      const actual = seg ?? db.seguimientoONuevo(pago.id);

      if (decision.tipo === 'escalar') {
        db.guardarSeguimiento({ ...actual, estado: 'escalado', origenEstado: 'sistema', proximoEnvio: null });
        db.registrarEvento(marca, pago.id, 'escalado', `${actual.intentos} avisos sin confirmación`);
        escalados.push(pago);
        r.escalados++;
        continue;
      }

      const plantilla = decision.plantilla === 'recordatorio' ? sistema.meta.plantillas.recordatorio : sistema.meta.plantillas.seguimiento;
      const variables = variablesPara(pago, agente.nombre);
      try {
        const wamid = await ctx.whatsapp.enviarPlantilla({
          para: pago.telefono!,
          plantilla,
          idioma: sistema.meta.plantillas.idioma,
          variables,
          payloadsBotones: payloadsPara(agente.id, pago.id),
        });
        db.registrarMensaje({ wamid, pagoId: pago.id, telefono: pago.telefono!, direccion: 'saliente', tipo: `plantilla:${plantilla}`, contenido: { variables } }, marca);
        db.guardarSeguimiento({
          ...actual,
          estado: 'pendiente',
          intentos: actual.intentos + 1,
          ultimoEnvio: marca,
          ultimoEnvioDia: hoy,
          proximoEnvio: calcularProximoEnvio(hoy, pago.fechaVencimiento!, reglas),
          ultimaRespuesta: 'sin_respuesta',
          ultimoError: null,
        });
        db.registrarEvento(marca, pago.id, 'aviso', `Aviso ${actual.intentos + 1} (${decision.plantilla})`);
        r.enviados++;
      } catch (e) {
        r.errores++;
        const mensaje = (e as Error).message;
        logger.error({ recibo: pago.id, para: enmascarar(pago.telefono!), err: mensaje }, 'No se pudo enviar el recordatorio');
        db.guardarSeguimiento({ ...actual, ultimoError: mensaje });
        db.registrarEvento(marca, pago.id, 'error', mensaje);
        fallidos.push(`${pago.cliente} (recibo ${pago.id}): ${mensaje}`);
        if (e instanceof ErrorWhatsApp && e.esDeAutenticacion) {
          logger.fatal('El token de WhatsApp es inválido o venció; se detiene la revisión');
          break;
        }
      }
      if (sistema.envios.pausa_entre_envios_ms > 0) await esperar(sistema.envios.pausa_entre_envios_ms);
    }

    db.escribir('ultima_revision', marca);

    const lineas = (lista: Pago[]) =>
      lista.map((p) => `• ${p.cliente} — póliza ${p.poliza || '-'} (${p.producto || 's/producto'}), ${p.monto != null ? formatearMonto(p.monto) : ''}, recibo ${p.id}`).join('\n');
    if (escalados.length > 0) {
      await ctx.notificador.notificar(
        `${escalados.length} recibo(s) requieren tu atención`,
        `Estos clientes no confirmaron su pago después de los avisos configurados. Contáctalos directamente:\n\n${lineas(escalados)}`,
      );
    }
    if (reabiertos.length > 0) {
      await ctx.notificador.notificar(
        'Pagos reportados que la aseguradora aún no aplica',
        `Estos clientes dijeron que ya pagaron hace ${reglas.reabrir_reportado_tras_dias}+ días, pero el recibo sigue pendiente. Se reanudan los recordatorios:\n\n${lineas(reabiertos)}`,
      );
    }
    if (fallidos.length > 0) await ctx.notificador.notificar('Recordatorios que no se pudieron enviar', fallidos.join('\n'));

    logger.info({ ...r, hoy }, 'Revisión terminada');
    return r;
  } finally {
    enCurso.delete(agente.id);
  }
}
