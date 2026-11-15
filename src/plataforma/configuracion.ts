import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import cron from 'node-cron';
import { parse as parsearYaml } from 'yaml';
import { z } from 'zod';
import { DIAS_SEMANA } from '../utils/fechas.js';

/**
 * Configuración en archivos YAML (sin secretos):
 *   config/sistema.yaml              → ajustes generales
 *   config/agentes/<agente>.yaml     → uno por agente: cuándo y cada cuándo enviar, número de WhatsApp, fuente
 *   config/portales/<perfil>.yaml    → cómo leer el portal de una aseguradora (selectores)
 * Los secretos (contraseñas, tokens) van cifrados en secretos/ (ver seguridad/boveda.ts).
 *
 * Los archivos aceptan variables de entorno: ${VARIABLE} o ${VARIABLE:-valor por defecto}.
 */

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'usa formato HH:MM, p. ej. 09:30');
const selector = z.string().min(1);
const cronValido = z.string().refine((c) => cron.validate(c), 'expresión cron inválida (ejemplo: "0 7 * * *" = diario 7:00)');

// ---------------- sistema.yaml ----------------

export const esquemaSistema = z
  .object({
    modo: z.enum(['simulacion', 'produccion']).default('produccion'),
    zona_horaria: z.string().default('America/Mexico_City'),
    puerto: z.number().int().default(3000),
    nivel_log: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    correo_admin: z.email().optional(),
    meta: z
      .object({
        graph_url: z.url().default('https://graph.facebook.com'),
        version_api: z.string().default('v23.0'),
        waba_id: z.string().optional(),
        plantillas: z
          .object({
            recordatorio: z.string().default('recordatorio_poliza_v1'),
            seguimiento: z.string().default('seguimiento_poliza_v1'),
            idioma: z.string().default('es_MX'),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    navegador: z
      .object({
        ruta_chromium: z.string().optional(),
        argumentos: z.array(z.string()).default(['--no-sandbox', '--disable-dev-shm-usage']),
        sincronizaciones_simultaneas: z.number().int().min(1).max(4).default(1),
        tiempo_espera_seg: z.number().int().min(5).default(45),
      })
      .strict()
      .prefault({}),
    correo: z
      .object({
        host: z.string().optional(),
        puerto: z.number().int().default(587),
        seguro: z.boolean().default(false),
        usuario: z.string().optional(),
        remitente: z.string().optional(),
      })
      .strict()
      .prefault({}),
    panel: z.object({ admin_usuario: z.string().min(3).default('admin') }).strict().prefault({}),
    envios: z.object({ pausa_entre_envios_ms: z.number().int().min(0).default(300) }).strict().prefault({}),
  })
  .strict();

export type ConfigSistema = z.infer<typeof esquemaSistema>;

// ---------------- agentes/<id>.yaml ----------------

export const esquemaAgente = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'solo minúsculas, números y guiones (p. ej. ana-lopez)'),
    nombre: z.string().min(2),
    activo: z.boolean().default(true),
    correo_avisos: z.email().optional(),
    whatsapp: z.object({ phone_number_id: z.string().min(1) }).strict(),
    panel: z.object({ usuario: z.string().min(3) }).strict(),
    fuente: z
      .object({
        tipo: z.enum(['portal', 'archivo']),
        perfil: z.string().min(1),
        sincronizar: cronValido.default('0 7 * * *'),
        carpeta: z.string().optional(),
        max_antiguedad_horas: z.number().int().min(1).default(30),
      })
      .strict(),
    envios: z
      .object({
        hora_revision: hora.default('10:00'),
        dias_semana: z.array(z.enum(DIAS_SEMANA)).min(1).default(['lun', 'mar', 'mie', 'jue', 'vie', 'sab']),
        horario: z.object({ inicio: hora.default('09:00'), fin: hora.default('20:00') }).strict().prefault({}),
        primer_aviso_dias_antes: z.number().int().min(0).max(60).default(5),
        repetir_cada_dias: z.number().int().min(1).max(30).default(1),
        repetir_cada_dias_vencido: z.number().int().min(1).max(30).default(1),
        dejar_de_avisar_dias_despues: z.number().int().min(0).max(120).default(30),
        max_avisos: z.number().int().min(1).max(60).default(10),
        reabrir_reportado_tras_dias: z.number().int().min(0).max(60).default(5),
        acepta_por_defecto: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.envios.horario.inicio >= a.envios.horario.fin) {
      ctx.addIssue({ code: 'custom', path: ['envios', 'horario'], message: 'el fin debe ser posterior al inicio' });
    }
    if (a.envios.hora_revision < a.envios.horario.inicio || a.envios.hora_revision >= a.envios.horario.fin) {
      ctx.addIssue({ code: 'custom', path: ['envios', 'hora_revision'], message: 'debe estar dentro del horario de envío' });
    }
    if (a.fuente.tipo === 'archivo' && !a.fuente.carpeta) {
      ctx.addIssue({ code: 'custom', path: ['fuente', 'carpeta'], message: 'indica la carpeta donde se dejan los archivos' });
    }
  });

export type ConfigAgente = z.infer<typeof esquemaAgente>;
export type ReglasEnvio = ConfigAgente['envios'];

// ---------------- portales/<perfil>.yaml ----------------

const paso = z.union([
  z.object({ ir: z.string().min(1) }).strict(),
  z.object({ clic: selector }).strict(),
  z.object({ esperar: selector }).strict(),
]);

export const CAMPOS = ['id', 'poliza', 'cliente', 'telefono', 'producto', 'monto', 'fecha_vencimiento', 'estado', 'acepta_whatsapp'] as const;
export type Campo = (typeof CAMPOS)[number];

export const esquemaPerfil = z
  .object({
    nombre: z.string(),
    url_login: z.string().min(1),
    login: z
      .object({
        usuario: selector,
        contrasena: selector,
        entrar: selector,
        exito: selector,
        error: selector.optional(),
        captcha: selector.optional(),
      })
      .strict()
      .optional(),
    pasos: z.array(paso).default([]),
    extraccion: z
      .object({
        tipo: z.enum(['tabla', 'descarga']).default('tabla'),
        tabla: selector.default('table'),
        siguiente: selector.optional(),
        descarga: selector.optional(),
        max_paginas: z.number().int().min(1).default(50),
      })
      .strict()
      .prefault({}),
    columnas: z
      .object({
        id: z.string(),
        cliente: z.string(),
        telefono: z.string(),
        fecha_vencimiento: z.string(),
        poliza: z.string().optional(),
        producto: z.string().optional(),
        monto: z.string().optional(),
        estado: z.string().optional(),
        acepta_whatsapp: z.string().optional(),
      })
      .strict(),
    estados: z
      .object({
        pendiente: z.array(z.string()).default([]),
        pagado: z.array(z.string()).default([]),
        cancelado: z.array(z.string()).default([]),
      })
      .strict()
      .prefault({}),
    formato_fecha: z.enum(['dd/mm/aaaa', 'mm/dd/aaaa', 'aaaa-mm-dd']).default('dd/mm/aaaa'),
  })
  .strict();

export type PerfilPortal = z.infer<typeof esquemaPerfil>;

// ---------------- Carga ----------------

export interface Rutas {
  config: string;
  secretos: string;
  claveMaestra: string;
  datos: string;
}

export function rutasDesdeEntorno(env: NodeJS.ProcessEnv = process.env): Rutas {
  const secretos = resolve(env.DIR_SECRETOS ?? './secretos');
  return {
    config: resolve(env.DIR_CONFIG ?? './config'),
    secretos,
    claveMaestra: resolve(env.CLAVE_MAESTRA ?? join(secretos, 'clave-maestra')),
    datos: resolve(env.DIR_DATOS ?? './data'),
  };
}

/** Sustituye ${VAR} y ${VAR:-defecto} por variables de entorno. */
export function expandirVariables(texto: string, env: NodeJS.ProcessEnv = process.env): string {
  return texto.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_m, nombre: string, defecto?: string) => env[nombre] ?? defecto ?? '');
}

export class ErrorConfiguracion extends Error {
  constructor(readonly errores: string[]) {
    super(`Errores de configuración:\n${errores.map((e) => `  - ${e}`).join('\n')}`);
    this.name = 'ErrorConfiguracion';
  }
}

/** Un campo vacío en YAML (p. ej. `ruta_chromium:` o una sección solo con comentarios) cuenta como "no indicado". */
function quitarVacios(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(quitarVacios);
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(
      Object.entries(valor).filter(([, v]) => v !== null && v !== '').map(([k, v]) => [k, quitarVacios(v)]),
    );
  }
  return valor;
}

function leerYaml(ruta: string): unknown {
  return quitarVacios(parsearYaml(expandirVariables(readFileSync(ruta, 'utf8'))) ?? {});
}

function formatear(archivo: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${archivo} → ${i.path.join('.') || '(raíz)'}: ${i.message}`);
}

export interface Configuracion {
  sistema: ConfigSistema;
  agentes: ConfigAgente[];
  perfiles: Map<string, PerfilPortal>;
}

export function cargarConfiguracion(dirConfig: string): Configuracion {
  const errores: string[] = [];

  const rutaSistema = join(dirConfig, 'sistema.yaml');
  let sistema = esquemaSistema.parse({});
  if (existsSync(rutaSistema)) {
    const r = esquemaSistema.safeParse(leerYaml(rutaSistema));
    if (r.success) sistema = r.data;
    else errores.push(...formatear('sistema.yaml', r.error));
  } else {
    errores.push(`No existe ${rutaSistema}`);
  }

  const perfiles = new Map<string, PerfilPortal>();
  const dirPerfiles = join(dirConfig, 'portales');
  if (existsSync(dirPerfiles)) {
    for (const archivo of readdirSync(dirPerfiles).filter((f) => f.endsWith('.yaml')).sort()) {
      const r = esquemaPerfil.safeParse(leerYaml(join(dirPerfiles, archivo)));
      if (r.success) perfiles.set(basename(archivo, '.yaml'), r.data);
      else errores.push(...formatear(`portales/${archivo}`, r.error));
    }
  }

  const agentes: ConfigAgente[] = [];
  const dirAgentes = join(dirConfig, 'agentes');
  if (existsSync(dirAgentes)) {
    for (const archivo of readdirSync(dirAgentes).filter((f) => f.endsWith('.yaml') && !f.startsWith('_')).sort()) {
      const r = esquemaAgente.safeParse(leerYaml(join(dirAgentes, archivo)));
      if (!r.success) {
        errores.push(...formatear(`agentes/${archivo}`, r.error));
        continue;
      }
      if (r.data.id !== basename(archivo, '.yaml')) {
        errores.push(`agentes/${archivo} → id: debe coincidir con el nombre del archivo ("${basename(archivo, '.yaml')}")`);
        continue;
      }
      if (!perfiles.has(r.data.fuente.perfil)) {
        errores.push(`agentes/${archivo} → fuente.perfil: no existe config/portales/${r.data.fuente.perfil}.yaml`);
      } else if (r.data.fuente.tipo === 'portal' && !perfiles.get(r.data.fuente.perfil)!.login) {
        errores.push(`agentes/${archivo} → el perfil "${r.data.fuente.perfil}" no define la sección login`);
      }
      agentes.push(r.data);
    }
  }

  const usuarios = new Map<string, string>([[sistema.panel.admin_usuario, 'admin']]);
  for (const a of agentes) {
    const previo = usuarios.get(a.panel.usuario);
    if (previo) errores.push(`agentes/${a.id}.yaml → panel.usuario "${a.panel.usuario}" ya lo usa ${previo}`);
    usuarios.set(a.panel.usuario, a.id);
  }

  if (errores.length > 0) throw new ErrorConfiguracion(errores);
  return { sistema, agentes, perfiles };
}
