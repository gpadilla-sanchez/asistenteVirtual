import { join, resolve } from 'node:path';
import cron from 'node-cron';
import { BaseDatos } from '../db/baseDatos.js';
import { procesarEstado, procesarMensaje, type CuerpoWebhook, type MensajeEntrante } from '../dominio/respuestas.js';
import { revisar, sincronizar, type ResultadoRevision, type ResultadoSincronizacion } from '../dominio/revision.js';
import { FuenteArchivo } from '../fuentes/archivo.js';
import { FuentePortal } from '../fuentes/portal.js';
import type { FuenteDatos } from '../fuentes/tipos.js';
import { crearLogger, type Logger } from '../logger.js';
import { crearTransporte, NotificadorCorreo, NotificadorLog, type Notificador } from '../notificaciones.js';
import { Boveda } from '../seguridad/boveda.js';
import { fechaEnZona, horaEnZona } from '../utils/fechas.js';
import { normalizarTelefono } from '../utils/telefono.js';
import { ClienteCloudApi } from '../whatsapp/cliente.js';
import { interpretarPayload } from '../whatsapp/plantillas.js';
import { cargarConfiguracion, type ConfigAgente, type ConfigSistema, type Configuracion, type Rutas } from './configuracion.js';
import type { ContextoAgente } from './contexto.js';
import { Candado, Reloj, Semaforo } from './reloj.js';

export interface UsuarioPanel {
  usuario: string;
  hash: string | undefined;
  /** null = administrador (ve a todos los agentes) */
  agenteId: string | null;
}

export interface SeguridadPlataforma {
  appSecret: string;
  verifyToken: string;
  usuariosPanel: UsuarioPanel[];
  /** Solo en modo simulación: protege los controles del simulador. */
  tokenSimulacion?: string;
}

/** Revisa que cada agente tenga sus secretos. Devuelve errores (impiden arrancar) y advertencias. */
export function revisarSecretos(config: Configuracion, boveda: Boveda): { errores: string[]; advertencias: string[] } {
  const errores: string[] = [];
  const advertencias: string[] = [];
  const sistema = boveda.leer('sistema');
  if (!sistema['meta.app_secret']) errores.push('Falta la clave secreta de la app de Meta → npm run secretos -- meta');
  if (!sistema['meta.verify_token']) errores.push('Falta el verify token del webhook → npm run secretos -- meta');
  if (!sistema['panel.hash']) advertencias.push('El administrador no tiene contraseña del panel → npm run secretos -- panel admin');
  if (config.sistema.correo.host && config.sistema.correo.usuario && !sistema['correo.contrasena']) {
    advertencias.push('Falta la contraseña del correo SMTP → npm run secretos -- correo');
  }
  for (const a of config.agentes) {
    const s = boveda.leer(a.id);
    if (!s['whatsapp.token'] && !sistema['meta.token']) errores.push(`${a.id}: no hay token de WhatsApp (propio ni compartido) → npm run secretos -- whatsapp ${a.id}`);
    if (a.fuente.tipo === 'portal' && (!s['portal.usuario'] || !s['portal.contrasena'])) {
      advertencias.push(`${a.id}: faltan usuario/contraseña del portal → npm run secretos -- portal ${a.id}`);
    }
    if (!s['panel.hash']) advertencias.push(`${a.id}: sin contraseña del panel → npm run secretos -- panel ${a.id}`);
  }
  return { errores, advertencias };
}

export class Plataforma {
  readonly contextos = new Map<string, ContextoAgente>();
  private readonly colaWebhooks = new Candado();
  private readonly semaforo: Semaforo;

  constructor(
    readonly sistema: ConfigSistema,
    readonly seguridad: SeguridadPlataforma,
    readonly reloj: Reloj,
    readonly logger: Logger,
    contextos: ContextoAgente[],
  ) {
    for (const c of contextos) this.contextos.set(c.agente.id, c);
    this.semaforo = new Semaforo(sistema.navegador.sincronizaciones_simultaneas);
  }

  /** Arma la plataforma a partir de config/ y secretos/. */
  static crear(rutas: Rutas, opciones: { reloj?: Reloj; tokenSimulacion?: string } = {}): Plataforma {
    const config = cargarConfiguracion(rutas.config);
    const { sistema } = config;
    const logger = crearLogger(sistema.nivel_log);
    const boveda = Boveda.abrir(rutas.secretos, rutas.claveMaestra);
    const { errores, advertencias } = revisarSecretos(config, boveda);
    for (const a of advertencias) logger.warn(a);
    if (errores.length > 0) throw new Error(`Faltan secretos:\n${errores.map((e) => `  - ${e}`).join('\n')}`);

    const reloj = opciones.reloj ?? new Reloj();
    const secretosSistema = boveda.leer('sistema');
    const transporte = sistema.correo.host
      ? crearTransporte({ ...sistema.correo, host: sistema.correo.host, contrasena: secretosSistema['correo.contrasena'] })
      : undefined;
    const remitente = sistema.correo.remitente ?? sistema.correo.usuario ?? 'asistente@localhost';

    const contextos = config.agentes.map((agente): ContextoAgente => {
      const log = logger.child({ agente: agente.id });
      const dirAgente = join(rutas.datos, 'agentes', agente.id);
      const perfil = config.perfiles.get(agente.fuente.perfil)!;
      const fuente: FuenteDatos =
        agente.fuente.tipo === 'portal'
          ? new FuentePortal({
              perfil,
              credenciales: () => ({
                usuario: boveda.requerir(agente.id, 'portal.usuario'),
                contrasena: boveda.requerir(agente.id, 'portal.contrasena'),
              }),
              aceptaPorDefecto: agente.envios.acepta_por_defecto,
              rutaChromium: sistema.navegador.ruta_chromium,
              argumentos: sistema.navegador.argumentos,
              tiempoEsperaMs: sistema.navegador.tiempo_espera_seg * 1000,
              dirTrabajo: join(dirAgente, 'portal'),
              logger: log,
            })
          : new FuenteArchivo(resolve(agente.fuente.carpeta!), perfil, agente.envios.acepta_por_defecto);
      const destinatarios = [agente.correo_avisos].filter((x): x is string => !!x);
      const notificador: Notificador =
        transporte && destinatarios.length > 0
          ? new NotificadorCorreo(transporte, remitente, destinatarios, `Asistente · ${agente.nombre}`, log)
          : new NotificadorLog(log);
      return {
        agente,
        sistema,
        logger: log,
        db: new BaseDatos(join(dirAgente, 'asistente.db')),
        fuente,
        whatsapp: new ClienteCloudApi({
          graphUrl: sistema.meta.graph_url,
          versionApi: sistema.meta.version_api,
          phoneNumberId: agente.whatsapp.phone_number_id,
          token: boveda.obtener(agente.id, 'whatsapp.token') ?? boveda.requerir('sistema', 'meta.token'),
          logger: log,
        }),
        notificador,
        reloj,
      };
    });

    const usuariosPanel: UsuarioPanel[] = [
      { usuario: sistema.panel.admin_usuario, hash: secretosSistema['panel.hash'], agenteId: null },
      ...config.agentes.map((a) => ({ usuario: a.panel.usuario, hash: boveda.obtener(a.id, 'panel.hash'), agenteId: a.id })),
    ];

    return new Plataforma(
      sistema,
      {
        appSecret: secretosSistema['meta.app_secret']!,
        verifyToken: secretosSistema['meta.verify_token']!,
        usuariosPanel,
        tokenSimulacion: sistema.modo === 'simulacion' ? opciones.tokenSimulacion : undefined,
      },
      reloj,
      logger,
      contextos,
    );
  }

  agentes(): ConfigAgente[] {
    return [...this.contextos.values()].map((c) => c.agente);
  }

  contexto(agenteId: string): ContextoAgente {
    const c = this.contextos.get(agenteId);
    if (!c) throw new Error(`No existe el agente ${agenteId}`);
    return c;
  }

  // ---------------- Webhook: a qué agente pertenece cada evento ----------------

  private candidatos(phoneNumberId: string | undefined): ContextoAgente[] {
    const todos = [...this.contextos.values()];
    const delNumero = todos.filter((c) => c.agente.whatsapp.phone_number_id === phoneNumberId);
    return delNumero.length > 0 ? delNumero : todos;
  }

  /** Varios agentes pueden compartir un número: se decide por el botón, el mensaje citado o el último aviso enviado. */
  private agenteDeMensaje(candidatos: ContextoAgente[], m: MensajeEntrante): ContextoAgente | undefined {
    const payload = interpretarPayload(m.button?.payload ?? m.interactive?.button_reply?.id);
    if (payload && this.contextos.has(payload.agenteId)) return this.contextos.get(payload.agenteId);
    if (candidatos.length === 1) return candidatos[0];
    if (m.context?.id) {
      const porCita = candidatos.find((c) => c.db.tieneMensaje(m.context!.id!));
      if (porCita) return porCita;
    }
    const telefono = normalizarTelefono(m.from) ?? m.from;
    let mejor: ContextoAgente | undefined;
    let fecha = '';
    for (const c of candidatos) {
      const f = c.db.ultimoEnvioATelefono(telefono);
      if (f && f > fecha) { fecha = f; mejor = c; }
    }
    return mejor;
  }

  procesarWebhook(cuerpo: CuerpoWebhook): Promise<void> {
    return this.colaWebhooks.ejecutar(async () => {
      if (cuerpo.object !== 'whatsapp_business_account') return;
      for (const entrada of cuerpo.entry ?? []) {
        for (const cambio of entrada.changes ?? []) {
          if (cambio.field !== 'messages' || !cambio.value) continue;
          const candidatos = this.candidatos(cambio.value.metadata?.phone_number_id);
          for (const estado of cambio.value.statuses ?? []) {
            const ctx = candidatos.find((c) => c.db.tieneMensaje(estado.id));
            if (ctx) await procesarEstado(ctx, estado).catch((e) => ctx.logger.error({ err: (e as Error).message }, 'Error al procesar estado'));
          }
          for (const mensaje of cambio.value.messages ?? []) {
            const ctx = this.agenteDeMensaje(candidatos, mensaje);
            if (!ctx) {
              this.logger.warn('Mensaje de un número sin recordatorios; se ignora');
              continue;
            }
            await procesarMensaje(ctx, mensaje).catch((e) => ctx.logger.error({ err: (e as Error).message }, 'Error al procesar mensaje'));
          }
        }
      }
    });
  }

  // ---------------- Tareas ----------------

  sincronizarAgente(agenteId: string): Promise<ResultadoSincronizacion> {
    const ctx = this.contexto(agenteId);
    return this.semaforo.ejecutar(() => sincronizar(ctx));
  }

  async revisarAgente(agenteId: string, opciones: { ignorarHorario?: boolean } = {}): Promise<ResultadoRevision> {
    return revisar(this.contexto(agenteId), opciones);
  }

  async paraTodos<T>(fn: (id: string) => Promise<T>): Promise<Record<string, T | { error: string }>> {
    const r: Record<string, T | { error: string }> = {};
    for (const a of this.agentes().filter((x) => x.activo)) {
      try {
        r[a.id] = await fn(a.id);
      } catch (e) {
        r[a.id] = { error: (e as Error).message };
      }
    }
    return r;
  }

  /** Programa, por agente, la lectura de la aseguradora y la revisión diaria según su archivo de configuración. */
  iniciarProgramador(): () => void {
    const zona = this.sistema.zona_horaria;
    const tareas: { stop(): unknown }[] = [];
    let retraso = 5_000;

    for (const agente of this.agentes().filter((a) => a.activo)) {
      const log = this.contexto(agente.id).logger;
      const sincronizarYa = async (origen: string) => {
        try {
          log.info({ origen }, 'Leyendo la aseguradora');
          await this.sincronizarAgente(agente.id);
        } catch (e) {
          log.error({ err: (e as Error).message }, 'Falló la lectura de la aseguradora');
        }
      };
      const revisarYa = async (origen: string) => {
        try {
          log.info({ origen }, 'Revisión de recordatorios');
          const r = await this.revisarAgente(agente.id);
          if (!r.ejecutada) log.info({ motivo: r.motivo }, 'Revisión no ejecutada');
        } catch (e) {
          log.error({ err: (e as Error).message }, 'Falló la revisión');
        }
      };

      tareas.push(cron.schedule(agente.fuente.sincronizar, () => sincronizarYa('programada'), { timezone: zona, name: `sync-${agente.id}` }));
      const [hh, mm] = agente.envios.hora_revision.split(':').map(Number);
      tareas.push(cron.schedule(`${mm} ${hh} * * *`, () => revisarYa('programada'), { timezone: zona, name: `rev-${agente.id}` }));

      // Recuperación tras un apagón o reinicio: si hoy no se ha revisado y ya pasó la hora, se hace ahora
      const ctx = this.contexto(agente.id);
      const ahora = this.reloj.ahora();
      const ultima = ctx.db.leer('ultima_revision');
      const revisadoHoy = ultima ? fechaEnZona(new Date(ultima), zona) === fechaEnZona(ahora, zona) : false;
      if (!revisadoHoy && horaEnZona(ahora, zona) >= agente.envios.hora_revision) {
        setTimeout(() => void revisarYa('recuperación al arrancar'), retraso);
        retraso += 20_000;
      }
      log.info(`Lectura de la aseguradora: "${agente.fuente.sincronizar}" · revisión diaria: ${agente.envios.hora_revision} (${zona})`);
    }
    return () => tareas.forEach((t) => t.stop());
  }

  cerrar(): void {
    for (const c of this.contextos.values()) c.db.cerrar();
  }
}
