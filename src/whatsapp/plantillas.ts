import type { Pago } from '../fuentes/tipos.js';
import { fechaLegible } from '../utils/fechas.js';
import { formatearMonto, limpiarVariable, primerNombre } from '../utils/texto.js';

/** Botones de respuesta rápida, en el mismo orden en que se definen en Meta. */
export const BOTON_SI = 'Sí, ya pagué';
export const BOTON_NO = 'Aún no';

/**
 * Cada botón lleva un "payload" con el agente y el recibo: SI|<agente>|<recibo>.
 * Así la respuesta llega al agente y recibo correctos aunque varios agentes compartan número.
 */
export function payloadsPara(agenteId: string, pagoId: string): string[] {
  return [`SI|${agenteId}|${pagoId}`, `NO|${agenteId}|${pagoId}`];
}

export function interpretarPayload(payload: string | undefined): { respuesta: 'si' | 'no'; agenteId: string; pagoId: string } | null {
  const m = payload?.match(/^(SI|NO)\|([^|]+)\|(.+)$/);
  if (!m) return null;
  return { respuesta: m[1] === 'SI' ? 'si' : 'no', agenteId: m[2]!, pagoId: m[3]! };
}

/** {{1}} cliente, {{2}} agente, {{3}} producto, {{4}} póliza, {{5}} monto, {{6}} fecha */
export function variablesPara(pago: Pago, nombreAgente: string): string[] {
  return [
    primerNombre(pago.cliente) || 'cliente',
    nombreAgente,
    pago.producto || 'seguro',
    pago.poliza || pago.id,
    pago.monto !== null ? formatearMonto(pago.monto) : 'el monto indicado',
    pago.fechaVencimiento ? fechaLegible(pago.fechaVencimiento) : 'la fecha acordada',
  ].map(limpiarVariable);
}

const EJEMPLO = [['Juan', 'Ana López', 'Gastos Médicos Mayores', 'GMM-123456', '$3,450.00 MXN', '15 de noviembre']];

const BOTONES = {
  type: 'BUTTONS',
  buttons: [
    { type: 'QUICK_REPLY', text: BOTON_SI },
    { type: 'QUICK_REPLY', text: BOTON_NO },
  ],
};

export interface DefinicionPlantilla {
  name: string;
  language: string;
  category: 'UTILITY';
  components: ({ type: 'BODY'; text: string; example: unknown } | { type: 'FOOTER'; text: string } | typeof BOTONES)[];
}

/**
 * Plantillas tal como se envían a Meta para su aprobación (categoría UTILITY: solo información
 * del recibo, sin promociones). Las comparten todos los agentes; el nombre del agente es una variable.
 */
export function definicionesPlantillas(nombreRecordatorio: string, nombreSeguimiento: string, idioma: string): DefinicionPlantilla[] {
  return [
    {
      name: nombreRecordatorio,
      language: idioma,
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text:
            'Hola {{1}}, soy {{2}}, tu asesor de seguros. Te recuerdo que el recibo de tu póliza de {{3}} número {{4}} ' +
            'por *{{5}}* vence el {{6}}.\n\n¿Ya realizaste el pago?',
          example: { body_text: EJEMPLO },
        },
        { type: 'FOOTER', text: 'Si no deseas recibir estos avisos, responde BAJA' },
        BOTONES,
      ],
    },
    {
      name: nombreSeguimiento,
      language: idioma,
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text:
            'Hola {{1}}, soy {{2}}, tu asesor de seguros. El recibo de tu póliza de {{3}} número {{4}} por *{{5}}* ' +
            'venció el {{6}} y todavía aparece pendiente. Te recomiendo pagarlo para mantener tu cobertura vigente.\n\n¿Ya lo pagaste?',
          example: { body_text: EJEMPLO },
        },
        { type: 'FOOTER', text: 'Responde BAJA para dejar de recibir avisos' },
        BOTONES,
      ],
    },
  ];
}

/** Texto final de una plantilla con sus variables (lo usa el simulador para mostrar el mensaje). */
export function renderizarPlantilla(def: DefinicionPlantilla, variables: string[]): { cuerpo: string; pie?: string; botones: string[] } {
  const cuerpo = def.components.find((c) => c.type === 'BODY') as { text: string };
  const pie = def.components.find((c) => c.type === 'FOOTER') as { text: string } | undefined;
  return {
    cuerpo: cuerpo.text.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => variables[Number(n) - 1] ?? `{{${n}}}`),
    pie: pie?.text,
    botones: BOTONES.buttons.map((b) => b.text),
  };
}

export function contarVariables(def: DefinicionPlantilla): number {
  const cuerpo = def.components.find((c) => c.type === 'BODY') as { text: string };
  return new Set(cuerpo.text.match(/\{\{\d+\}\}/g) ?? []).size;
}
