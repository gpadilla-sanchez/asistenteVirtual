import express, { type NextFunction, type Request, type Response } from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ACCIONES, aplicarAccion, type AccionPanel } from '../dominio/acciones.js';
import type { CuerpoWebhook } from '../dominio/respuestas.js';
import type { Plataforma, UsuarioPanel } from '../plataforma/plataforma.js';
import { verificarContrasena } from '../seguridad/contrasenas.js';
import { fechaEnZona } from '../utils/fechas.js';
import { verificarFirma } from '../whatsapp/cliente.js';
import { contar, renderizarAgente, renderizarResumen } from './panel.js';

type RequestConCuerpo = Request & { cuerpoCrudo?: Buffer };
type RequestConUsuario = Request & { usuarioPanel?: UsuarioPanel };

function igualSeguro(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Inicio de sesión del panel (usuario y contraseña, sobre HTTPS):
 * - contraseñas verificadas contra hash scrypt de la bóveda,
 * - bloqueo temporal de la IP tras 8 intentos fallidos en 15 minutos,
 * - cada agente solo ve sus propios clientes; el administrador ve a todos.
 */
function crearAutenticacion(plataforma: Plataforma) {
  const fallos = new Map<string, { n: number; hasta: number }>();
  const validadas = new Map<string, number>(); // huella de credenciales correctas → expiración (evita recalcular scrypt)

  return (req: RequestConUsuario, res: Response, next: NextFunction) => {
    const ip = req.ip ?? 'desconocida';
    const ahora = Date.now();
    const registro = fallos.get(ip);
    if (registro && registro.n >= 8 && registro.hasta > ahora) {
      res.status(429).send('Demasiados intentos fallidos. Intenta de nuevo en 15 minutos.');
      return;
    }
    const [tipo, valor] = (req.headers.authorization ?? '').split(' ');
    if (tipo === 'Basic' && valor) {
      const decodificado = Buffer.from(valor, 'base64').toString();
      const separador = decodificado.indexOf(':');
      const usuario = decodificado.slice(0, separador);
      const contrasena = decodificado.slice(separador + 1);
      const cuenta = plataforma.seguridad.usuariosPanel.find((u) => igualSeguro(u.usuario, usuario));
      const huella = createHash('sha256').update(`${usuario}\0${contrasena}\0${cuenta?.hash ?? ''}`).digest('hex');
      const ok = cuenta && ((validadas.get(huella) ?? 0) > ahora || verificarContrasena(contrasena, cuenta.hash));
      if (ok) {
        validadas.set(huella, ahora + 10 * 60_000);
        fallos.delete(ip);
        req.usuarioPanel = cuenta;
        next();
        return;
      }
      const n = (registro && registro.hasta > ahora ? registro.n : 0) + 1;
      fallos.set(ip, { n, hasta: ahora + 15 * 60_000 });
      plataforma.logger.warn({ ip, usuario, intentos: n }, 'Inicio de sesión fallido en el panel');
    }
    res.set('WWW-Authenticate', 'Basic realm="Panel del asistente", charset="UTF-8"').status(401).send('Acceso restringido');
  };
}

export function crearApp(plataforma: Plataforma) {
  const { logger, sistema, seguridad } = plataforma;
  const app = express();
  const secretoCsrf = randomBytes(32);
  const tokenCsrf = (usuario: string) => createHmac('sha256', secretoCsrf).update(usuario).digest('hex').slice(0, 32);
  const zona = sistema.zona_horaria;
  const simulacion = sistema.modo === 'simulacion';

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback, uniquelocal');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    next();
  });

  app.get('/salud', (_req, res) => {
    res.json({ ok: true, modo: sistema.modo, agentes: plataforma.agentes().length, fecha: plataforma.reloj.ahora().toISOString() });
  });

  // ---------------- Webhook de Meta (uno para todos los agentes) ----------------

  app.get('/webhook', (req, res) => {
    const token = req.query['hub.verify_token'];
    if (req.query['hub.mode'] === 'subscribe' && typeof token === 'string' && igualSeguro(token, seguridad.verifyToken)) {
      logger.info('Webhook verificado por Meta');
      res.status(200).type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
      return;
    }
    res.sendStatus(403);
  });

  app.post(
    '/webhook',
    express.json({ limit: '1mb', verify: (req, _res, buf) => { (req as RequestConCuerpo).cuerpoCrudo = Buffer.from(buf); } }),
    (req: RequestConCuerpo, res) => {
      if (!verificarFirma(req.cuerpoCrudo, req.header('x-hub-signature-256'), seguridad.appSecret)) {
        logger.warn({ ip: req.ip }, 'Webhook con firma inválida rechazado');
        res.sendStatus(401);
        return;
      }
      res.sendStatus(200); // Meta espera respuesta inmediata; se procesa después
      void plataforma.procesarWebhook(req.body as CuerpoWebhook).catch((e: Error) => logger.error({ err: e.message }, 'Error en el webhook'));
    },
  );

  // ---------------- Panel ----------------

  const autenticar = crearAutenticacion(plataforma);
  const formulario = express.urlencoded({ extended: false, limit: '10kb' });

  /** Valida el token CSRF y que el formulario venga del mismo sitio. */
  const verificarFormulario = (req: RequestConUsuario, res: Response, next: NextFunction) => {
    const origen = req.header('origin');
    if (origen && new URL(origen).host !== req.header('host')) {
      res.status(403).send('Origen no permitido');
      return;
    }
    const enviado = typeof req.body?.csrf === 'string' ? req.body.csrf : '';
    if (!igualSeguro(enviado, tokenCsrf(req.usuarioPanel!.usuario))) {
      res.status(403).send('El formulario expiró. Recarga la página.');
      return;
    }
    next();
  };

  /** El agente solo puede ver lo suyo. */
  const puedeVer = (req: RequestConUsuario, res: Response, agenteId: string): boolean => {
    const u = req.usuarioPanel!;
    if (!plataforma.contextos.has(agenteId) || (u.agenteId !== null && u.agenteId !== agenteId)) {
      res.status(404).send('No encontrado');
      return false;
    }
    return true;
  };

  const volver = (res: Response, agenteId: string, aviso: string) =>
    res.redirect(303, `/panel/agentes/${encodeURIComponent(agenteId)}?aviso=${encodeURIComponent(aviso)}`);

  app.get('/', (_req, res) => res.redirect('/panel'));

  app.get('/panel', autenticar, (req: RequestConUsuario, res) => {
    const u = req.usuarioPanel!;
    if (u.agenteId) {
      res.redirect(`/panel/agentes/${encodeURIComponent(u.agenteId)}`);
      return;
    }
    const resumenes = plataforma.agentes().map((agente) => {
      const { db } = plataforma.contexto(agente.id);
      return {
        agente,
        conteo: contar(db.listarPanel()),
        ultimaSincronizacion: db.leer('ultima_sincronizacion'),
        ultimaRevision: db.leer('ultima_revision'),
        errorSincronizacion: db.leer('ultimo_error_sincronizacion') || undefined,
      };
    });
    res.type('html').send(renderizarResumen(resumenes, zona, simulacion, typeof req.query.aviso === 'string' ? req.query.aviso : undefined));
  });

  app.get('/panel/agentes/:id', autenticar, (req: RequestConUsuario, res) => {
    const id = String(req.params.id);
    if (!puedeVer(req, res, id)) return;
    const { db, agente } = plataforma.contexto(id);
    res.type('html').send(renderizarAgente({
      agente,
      filas: db.listarPanel(),
      eventos: db.eventos(undefined, 20),
      zona,
      simulacion,
      esAdmin: req.usuarioPanel!.agenteId === null,
      csrf: tokenCsrf(req.usuarioPanel!.usuario),
      ultimaSincronizacion: db.leer('ultima_sincronizacion'),
      ultimaRevision: db.leer('ultima_revision'),
      errorSincronizacion: db.leer('ultimo_error_sincronizacion') || undefined,
      aviso: typeof req.query.aviso === 'string' ? req.query.aviso : undefined,
    }));
  });

  app.post('/panel/agentes/:id/sincronizar', autenticar, formulario, verificarFormulario, async (req: RequestConUsuario, res) => {
    const id = String(req.params.id);
    if (!puedeVer(req, res, id)) return;
    try {
      const r = await plataforma.sincronizarAgente(id);
      volver(res, id, `Aseguradora leída: ${r.recibos} recibos, ${r.pagados + r.ausentes} pagados desde la última lectura.`);
    } catch (e) {
      volver(res, id, `No se pudo leer la aseguradora: ${(e as Error).message}`);
    }
  });

  app.post('/panel/agentes/:id/revisar', autenticar, formulario, verificarFormulario, async (req: RequestConUsuario, res) => {
    const id = String(req.params.id);
    if (!puedeVer(req, res, id)) return;
    try {
      const r = await plataforma.revisarAgente(id, { ignorarHorario: false });
      volver(res, id, r.ejecutada
        ? `Revisión terminada: ${r.enviados} recordatorios enviados, ${r.escalados} requieren atención, ${r.errores} errores.`
        : `No se enviaron recordatorios: ${r.motivo}.`);
    } catch (e) {
      volver(res, id, `Error: ${(e as Error).message}`);
    }
  });

  app.post('/panel/agentes/:id/recibos/:recibo', autenticar, formulario, verificarFormulario, (req: RequestConUsuario, res) => {
    const id = String(req.params.id);
    if (!puedeVer(req, res, id)) return;
    const accion = String(req.body?.accion) as AccionPanel;
    if (!(accion in ACCIONES)) {
      res.status(400).send('Acción inválida');
      return;
    }
    try {
      aplicarAccion(plataforma.contexto(id), String(req.params.recibo), accion, req.usuarioPanel!.usuario);
      volver(res, id, `Recibo ${req.params.recibo}: ${ACCIONES[accion].toLowerCase()}.`);
    } catch (e) {
      volver(res, id, (e as Error).message);
    }
  });

  // ---------------- Controles del simulador (solo en modo simulación) ----------------

  if (simulacion && seguridad.tokenSimulacion) {
    const token = seguridad.tokenSimulacion;
    const soloSimulador = (req: Request, res: Response, next: NextFunction) => {
      if (!igualSeguro(req.header('x-simulacion-token') ?? '', token)) {
        res.sendStatus(403);
        return;
      }
      next();
    };
    app.use('/simulacion', express.json(), soloSimulador);
    app.get('/simulacion/estado', (_req, res) => {
      res.json({
        fecha: fechaEnZona(plataforma.reloj.ahora(), zona),
        desfaseDias: plataforma.reloj.desfaseDias,
        agentes: plataforma.agentes().map((a) => ({ id: a.id, nombre: a.nombre, phoneNumberId: a.whatsapp.phone_number_id })),
      });
    });
    app.post('/simulacion/reloj', (req, res) => {
      plataforma.reloj.fijarDesfaseDias(Number(req.body?.desfaseDias ?? 0));
      res.json({ fecha: fechaEnZona(plataforma.reloj.ahora(), zona) });
    });
    app.post('/simulacion/sincronizar', async (_req, res) => {
      res.json(await plataforma.paraTodos((id) => plataforma.sincronizarAgente(id)));
    });
    app.post('/simulacion/revisar', async (_req, res) => {
      res.json(await plataforma.paraTodos((id) => plataforma.revisarAgente(id, { ignorarHorario: true })));
    });
  }

  return app;
}
