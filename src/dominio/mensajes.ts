import type { Pago } from '../fuentes/tipos.js';
import { formatearMonto, primerNombre } from '../utils/texto.js';

/**
 * Textos que el asistente responde dentro de la ventana de 24 horas.
 * Se pueden cambiar libremente: no requieren aprobación de Meta.
 */
export const MENSAJES = {
  graciasSi: (agente: string, pago?: Pago) =>
    `¡Gracias${pago ? `, ${primerNombre(pago.cliente)}` : ''}! Registré tu confirmación` +
    (pago?.monto != null ? ` del pago de ${formatearMonto(pago.monto)}` : '') +
    (pago?.poliza ? ` de la póliza ${pago.poliza}` : '') +
    `. En cuanto la aseguradora lo aplique quedará reflejado y no te enviaré más recordatorios de este recibo. — ${agente}`,

  entendidoNo: (cuando: string) =>
    `Entendido. Te lo recordaré ${cuando}. Si necesitas la referencia o los datos para pagar, escribe AYUDA.`,

  comprobanteRecibido: (agente: string) =>
    `Recibí tu comprobante, ¡gracias! Lo revisaré y no te enviaré más recordatorios de este recibo. — ${agente}`,

  baja: () => 'Listo, ya no recibirás recordatorios por WhatsApp. Si cambias de opinión, escribe ALTA.',

  alta: () => 'Listo, volverás a recibir recordatorios de pago por WhatsApp.',

  ayuda: (agente: string) => `Con gusto. ${agente} te contactará en breve.`,

  guia: () =>
    'Gracias por tu mensaje. Para registrar tu respuesta usa los botones del recordatorio o escribe SÍ (si ya pagaste) o NO. ' +
    'Si necesitas ayuda, escribe AYUDA.',

  derivado: (agente: string) => `Gracias por tu mensaje. ${agente} te contactará para ayudarte.`,

  variosPagos: (n: number) =>
    `Tienes ${n} recibos con recordatorio. Para saber a cuál te refieres, responde con los botones de cada mensaje.`,

  sinPagos: () => 'Gracias por tu mensaje. No tenemos recordatorios pendientes para este número.',
};
