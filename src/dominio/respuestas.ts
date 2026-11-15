import type { PagoGuardado } from '../db/baseDatos.js';
import type { ContextoAgente } from '../plataforma/contexto.js';
import { fechaEnZona } from '../utils/fechas.js';
import { enmascarar, normalizarTelefono } from '../utils/telefono.js';
import { formatearMonto } from '../utils/texto.js';
import { interpretarPayload } from '../whatsapp/plantillas.js';
import { clasificarTexto, type Intencion } from './clasificador.js';
import { MENSAJES } from './mensajes.js';
import { calcularProximoEnvio, describirCuando } from './revision.js';

// ---- Forma (simplificada) del webhook de WhatsApp Cloud API ----
export interface MensajeEntrante {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  context?: { id?: string };
  text?: { body?: string };
  button?: { payload?: string; text?: string };
  interactive?: { type?: string; button_reply?: { id?: string; title?: string } };
}

export interface EstadoEntrega {
  id: string;
  status: string;
  recipient_id?: string;
  errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[];
}

export interface ValorWebhook {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  messages?: MensajeEntrante[];
  statuses?: EstadoEntrega[];
}

export interface CuerpoWebhook {
  object?: string;
  entry?: { changes?: { field?: string; value?: ValorWebhook }[] }[];
}

type IntencionMensaje = Intencion | 'comprobante' | 'ignorar';

export function interpretarMensaje(m: MensajeEntrante): { intencion: IntencionMensaje; pagoId?: string; agenteId?: string; texto?: string } {
  switch (m.type) {
    case 'button': {
      const p = interpretarPayload(m.button?.payload);
      if (p) return { intencion: p.respuesta, pagoId: p.pagoId, agenteId: p.agenteId, texto: m.button?.text };
      return { intencion: clasificarTexto(m.button?.text), texto: m.button?.text };
    }
    case 'interactive': {
      const p = interpretarPayload(m.interactive?.button_reply?.id);
      if (p) return { intencion: p.respuesta, pagoId: p.pagoId, agenteId: p.agenteId, texto: m.interactive?.button_reply?.title };
      return { intencion: clasificarTexto(m.interactive?.button_reply?.title) };
    }
    case 'text':
      return { intencion: clasificarTexto(m.text?.body), texto: m.text?.body };
    case 'image':
    case 'document':
      return { intencion: 'comprobante' };
    case 'reaction':
    case 'system':
    case 'unsupported':
      return { intencion: 'ignorar' };
    default:
      return { intencion: 'otro' };
  }
}

function describir(pago: PagoGuardado | undefined, pagoId: string): string {
  if (!pago) return `Recibo ${pagoId}`;
  return `${pago.cliente} — póliza ${pago.poliza || '-'} (${pago.producto || 's/producto'}), ` +
    `${pago.monto != null ? formatearMonto(pago.monto) : 's/monto'}, recibo ${pago.id}, tel. ${pago.telefonoOriginal || pago.telefono}`;
}

async function responder(ctx: ContextoAgente, telefono: string, texto: string, pagoId: string | null): Promise<void> {
  try {
    const wamid = await ctx.whatsapp.enviarTexto(telefono, texto);
    ctx.db.registrarMensaje({ wamid, pagoId, telefono, direccion: 'saliente', tipo: 'texto', contenido: { texto } }, ctx.reloj.ahora().toISOString());
  } catch (e) {
    ctx.logger.error({ err: (e as Error).message, para: enmascarar(telefono) }, 'No se pudo responder al cliente');
  }
}

/** Estado de entrega (enviado, entregado, leído, fallido) de un mensaje de este agente. */
export async function procesarEstado(ctx: ContextoAgente, estado: EstadoEntrega): Promise<void> {
  const error = estado.errors?.[0];
  const textoError = error ? `${error.code ?? ''} ${error.title ?? ''} ${error.error_data?.details ?? ''}`.trim() : undefined;
  const pagoId = ctx.db.actualizarEntrega(estado.id, estado.status, textoError);
  if (estado.status !== 'failed' || !pagoId) return;

  const marca = ctx.reloj.ahora().toISOString();
  ctx.logger.warn({ recibo: pagoId, error: textoError }, 'WhatsApp no pudo entregar el recordatorio');
  ctx.db.guardarSeguimiento({ ...ctx.db.seguimientoONuevo(pagoId), ultimoError: `No entregado: ${textoError ?? 'sin detalle'}` });
  ctx.db.registrarEvento(marca, pagoId, 'no_entregado', textoError ?? 'sin detalle');
  await ctx.notificador.notificar(
    'Recordatorio no entregado',
    `${describir(ctx.db.obtenerPago(pagoId), pagoId)}\nWhatsApp no pudo entregar el mensaje (${textoError ?? 'sin detalle'}).\n` +
      'Revisa que el teléfono registrado en la aseguradora sea correcto y tenga WhatsApp.',
  );
}

/** A qué recibo se refiere el cliente: botón → mensaje citado → único pendiente notificado. */
function resolverPago(ctx: ContextoAgente, m: MensajeEntrante, telefono: string, pagoIdBoton?: string): { pagoId?: string; candidatos: number } {
  if (pagoIdBoton) return { pagoId: pagoIdBoton, candidatos: 1 };
  const citado = m.context?.id ? ctx.db.pagoDeMensaje(m.context.id) : null;
  if (citado) return { pagoId: citado, candidatos: 1 };
  const pendientes = ctx.db.pagosPendientesNotificados(telefono);
  if (pendientes.length === 1) return { pagoId: pendientes[0], candidatos: 1 };
  return { candidatos: pendientes.length };
}

/** Respuesta de un cliente de este agente. */
export async function procesarMensaje(ctx: ContextoAgente, m: MensajeEntrante): Promise<void> {
  const { db, agente, notificador } = ctx;
  const telefono = normalizarTelefono(m.from) ?? m.from;
  const { intencion, pagoId: pagoIdBoton, texto } = interpretarMensaje(m);
  const ahora = ctx.reloj.ahora();
  const marca = ahora.toISOString();
  const zona = ctx.sistema.zona_horaria;

  // Registro + idempotencia: Meta puede mandar el mismo evento más de una vez
  const nuevo = db.registrarMensaje({ wamid: m.id, pagoId: pagoIdBoton ?? null, telefono, direccion: 'entrante', tipo: m.type, contenido: m }, marca);
  if (!nuevo || intencion === 'ignorar') return;
  ctx.logger.info({ de: enmascarar(telefono), intencion }, 'Mensaje recibido');

  // ----- Baja / alta: aplica a todos los recibos del número con este agente -----
  if (intencion === 'baja' || intencion === 'alta') {
    if (intencion === 'baja') db.agregarBaja(telefono, marca);
    else db.quitarBaja(telefono);
    for (const id of db.pagosDeTelefono(telefono)) db.registrarEvento(marca, id, intencion, `El cliente escribió ${intencion.toUpperCase()}`);
    await responder(ctx, telefono, intencion === 'baja' ? MENSAJES.baja() : MENSAJES.alta(), null);
    if (intencion === 'baja') await notificador.notificar('Un cliente pidió no recibir avisos', `El número ${telefono} escribió BAJA. Ya no recibirá recordatorios por WhatsApp.`);
    return;
  }

  if (intencion === 'ayuda') {
    await responder(ctx, telefono, MENSAJES.ayuda(agente.nombre), null);
    const recibos = db.pagosDeTelefono(telefono).map((id) => describir(db.obtenerPago(id), id)).join('\n');
    await notificador.notificar('Un cliente pide ayuda', `El número ${telefono} escribió: "${texto ?? ''}".\n${recibos}`);
    return;
  }

  const { pagoId, candidatos } = resolverPago(ctx, m, telefono, pagoIdBoton);

  // ----- Sí / comprobante → reportado: se detienen los avisos -----
  if (intencion === 'si' || intencion === 'comprobante') {
    if (!pagoId) {
      if (candidatos > 1 && intencion === 'si') return responder(ctx, telefono, MENSAJES.variosPagos(candidatos), null);
      await responder(ctx, telefono, intencion === 'comprobante' ? MENSAJES.comprobanteRecibido(agente.nombre) : MENSAJES.sinPagos(), null);
      if (intencion === 'comprobante') await notificador.notificar('Comprobante recibido', `El número ${telefono} envió un archivo. Revísalo en WhatsApp.`);
      return;
    }
    const pago = db.obtenerPago(pagoId);
    const seg = db.seguimientoONuevo(pagoId);
    const cerrado = seg.estado === 'pagado' || seg.estado === 'cancelado';
    if (!cerrado) {
      db.guardarSeguimiento({ ...seg, estado: 'reportado', origenEstado: 'cliente', proximoEnvio: null, ultimaRespuesta: 'si', fechaRespuesta: marca, noReconocidas: 0 });
      db.registrarEvento(marca, pagoId, 'reportado', intencion === 'comprobante' ? 'El cliente envió comprobante' : 'El cliente respondió que ya pagó');
    }
    await responder(ctx, telefono, intencion === 'comprobante' ? MENSAJES.comprobanteRecibido(agente.nombre) : MENSAJES.graciasSi(agente.nombre, pago), pagoId);
    if (!cerrado) {
      await notificador.notificar(
        'Un cliente reporta que ya pagó',
        `${describir(pago, pagoId)}\nRespuesta: ${intencion === 'comprobante' ? 'envió comprobante' : 'SÍ, ya pagó'}.\n` +
          `Se detuvieron los avisos. Si en ${agente.envios.reabrir_reportado_tras_dias} días la aseguradora no lo aplica, se reanudan solos.`,
      );
    }
    return;
  }

  // ----- No → se vuelve a avisar según "repetir_cada_dias" -----
  if (intencion === 'no') {
    if (!pagoId) return responder(ctx, telefono, candidatos > 1 ? MENSAJES.variosPagos(candidatos) : MENSAJES.entendidoNo('pronto'), null);
    const seg = db.seguimientoONuevo(pagoId);
    const pago = db.obtenerPago(pagoId);
    const hoy = fechaEnZona(ahora, zona);
    const proximo = seg.estado === 'pendiente' && pago?.fechaVencimiento ? calcularProximoEnvio(hoy, pago.fechaVencimiento, agente.envios) : seg.proximoEnvio;
    db.guardarSeguimiento({ ...seg, ultimaRespuesta: 'no', fechaRespuesta: marca, proximoEnvio: proximo, noReconocidas: 0 });
    db.registrarEvento(marca, pagoId, 'respuesta', 'El cliente respondió que aún no paga');
    await responder(ctx, telefono, MENSAJES.entendidoNo(proximo ? describirCuando(proximo, hoy) : 'pronto'), pagoId);
    return;
  }

  // ----- Texto no reconocido: guía y, si se repite, aviso al agente -----
  if (pagoId) {
    const seg = db.seguimientoONuevo(pagoId);
    const veces = seg.noReconocidas + 1;
    db.guardarSeguimiento({ ...seg, noReconocidas: veces, ultimaRespuesta: 'otro', fechaRespuesta: marca });
    db.registrarEvento(marca, pagoId, 'respuesta', `Texto: ${(texto ?? `[${m.type}]`).slice(0, 120)}`);
    if (veces >= 2) {
      await responder(ctx, telefono, MENSAJES.derivado(agente.nombre), pagoId);
      await notificador.notificar('Un cliente necesita atención', `${describir(db.obtenerPago(pagoId), pagoId)}\nEscribió: "${texto ?? `[${m.type}]`}". El asistente no entendió la respuesta.`);
      return;
    }
  }
  await responder(ctx, telefono, MENSAJES.guia(), pagoId ?? null);
}
