import { normalizar } from '../utils/texto.js';

export type Intencion = 'si' | 'no' | 'baja' | 'alta' | 'ayuda' | 'otro';

const BAJA = [
  'baja', 'darme de baja', 'stop', 'unsubscribe', 'no me escriban', 'no me escribas', 'no me manden',
  'no me envien', 'no quiero mensajes', 'no quiero recibir', 'dejen de escribir', 'dejen de mandar', 'cancelar avisos',
];
const ALTA = ['alta', 'reactivar', 'volver a recibir'];

const SI_EXACTO = ['si', 'sii', 'sip', 'ya', 'listo', 'hecho', 'claro', 'ok ya', 'simon', 'afirmativo', 'pagado', 'ya esta', 'ya quedo'];
const SI_FRASES = [
  'ya pague', 'ya pagamos', 'ya lo pague', 'ya realice', 'ya hice el pago', 'ya hice la transferencia', 'ya deposite',
  'ya transferi', 'ya lo hice', 'ya lo realice', 'ya quedo', 'ya esta pagado', 'ya se pago', 'pago realizado',
  'ya cubri', 'ya liquide', 'si ya',
];

const NO_EXACTO = ['no', 'nop', 'nel', 'aun no', 'todavia no', 'no aun', 'no todavia', 'nada'];
const NO_FRASES = ['aun no', 'todavia no', 'no he', 'no hemos', 'no ha', 'no puedo', 'no pude'];
/** Indican "todavía no" solo si no hay una confirmación clara (p. ej. "ya pagué en la mañana" es un sí). */
const NO_DEBIL = ['manana', 'pasado manana', 'mas tarde', 'la proxima semana', 'en la quincena', 'el viernes', 'despues', 'luego'];

const AYUDA = ['ayuda', 'asesor', 'humano', 'persona', 'duda', 'dudas', 'clabe', 'cuenta', 'datos para pagar', 'como pago',
  'aclaracion', 'llamar', 'llamenme', 'informacion', 'error'];

function contiene(texto: string, frase: string): boolean {
  return new RegExp(`(^| )${frase}( |$)`).test(texto);
}

/**
 * Clasifica un mensaje de texto libre. Ante la duda devuelve 'otro', y el asistente
 * deriva a una persona en lugar de adivinar.
 */
export function clasificarTexto(texto: string | undefined): Intencion {
  const t = normalizar(texto ?? '');
  if (t === '') return 'otro';
  if (BAJA.some((f) => contiene(t, f))) return 'baja';
  if (ALTA.some((f) => t === f || t.startsWith(`${f} `))) return 'alta';

  const esSi = SI_EXACTO.includes(t) || SI_FRASES.some((f) => contiene(t, f)) || /^si( |$)/.test(t);
  const esNo = NO_EXACTO.includes(t) || NO_FRASES.some((f) => contiene(t, f)) || /^no( |$)/.test(t);

  if (esSi && esNo) return 'otro'; // p. ej. "si no he pagado": ambiguo, mejor que lo vea una persona
  if (esSi) return 'si';
  if (esNo || NO_DEBIL.some((f) => contiene(t, f))) return 'no';
  if (AYUDA.some((f) => contiene(t, f))) return 'ayuda';
  return 'otro';
}
