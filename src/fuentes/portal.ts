import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { Logger } from '../logger.js';
import type { PerfilPortal } from '../plataforma/configuracion.js';
import { leerTablaDeArchivo } from './archivo.js';
import { interpretarTabla } from './columnas.js';
import type { FuenteDatos, Pago } from './tipos.js';

export interface CredencialesPortal {
  usuario: string;
  contrasena: string;
}

export interface OpcionesPortal {
  perfil: PerfilPortal;
  /** Se piden justo antes de usarse; no se guardan en el objeto. */
  credenciales: () => CredencialesPortal;
  aceptaPorDefecto: boolean;
  rutaChromium?: string;
  argumentos: string[];
  tiempoEsperaMs: number;
  /** Carpeta para descargas temporales y capturas de error. */
  dirTrabajo: string;
  /** Guarda una captura después de cada paso (para ajustar el perfil). */
  capturas?: boolean;
  logger: Logger;
}

/** Errores que no se arreglan reintentando: hay que avisar al agente. */
export class ErrorPortal extends Error {
  constructor(
    mensaje: string,
    readonly tipo: 'credenciales' | 'captcha' | 'estructura' | 'conexion',
  ) {
    super(mensaje);
    this.name = 'ErrorPortal';
  }
}

/**
 * Lee los recibos pendientes del portal de la aseguradora con un navegador sin pantalla (Chromium).
 * Todo lo específico del portal (direcciones, selectores, columnas) vive en config/portales/<perfil>.yaml,
 * así que adaptar otra aseguradora o un cambio del portal no requiere tocar código.
 */
export class FuentePortal implements FuenteDatos {
  readonly nombre: string;

  constructor(private readonly op: OpcionesPortal) {
    this.nombre = `Portal: ${op.perfil.nombre}`;
  }

  async leerPagos(): Promise<Pago[]> {
    const { perfil, logger } = this.op;
    mkdirSync(this.op.dirTrabajo, { recursive: true });
    let navegador: Browser | undefined;
    let pagina: Page | undefined;
    let paso = 'abrir navegador';
    try {
      navegador = await chromium.launch({
        headless: true,
        executablePath: this.op.rutaChromium,
        args: this.op.argumentos,
      });
      const contexto = await navegador.newContext({ acceptDownloads: true, locale: 'es-MX', timezoneId: 'America/Mexico_City' });
      contexto.setDefaultTimeout(this.op.tiempoEsperaMs);
      pagina = await contexto.newPage();

      paso = 'iniciar sesión';
      await this.iniciarSesion(pagina);
      await this.captura(pagina, '1-sesion');

      for (const [i, p] of perfil.pasos.entries()) {
        paso = `paso ${i + 1} (${JSON.stringify(p)})`;
        if ('ir' in p) await pagina.goto(new URL(p.ir, pagina.url()).toString(), { waitUntil: 'domcontentloaded' });
        else if ('clic' in p) await pagina.click(p.clic);
        else await pagina.waitForSelector(p.esperar);
        await this.captura(pagina, `2-paso-${i + 1}`);
      }

      paso = 'extraer recibos';
      const filas = perfil.extraccion.tipo === 'descarga' ? await this.descargar(pagina) : await this.leerTablas(pagina);
      const pagos = interpretarTabla(filas, perfil, this.op.aceptaPorDefecto);
      logger.info({ recibos: pagos.length }, 'Portal leído');
      return pagos;
    } catch (e) {
      if (pagina) await this.guardarErrorCaptura(pagina);
      if (e instanceof ErrorPortal) throw e;
      const mensaje = (e as Error).message.split('\n')[0];
      const tipo = /net::|ECONN|ENOTFOUND|Timeout/i.test(mensaje ?? '') && paso === 'iniciar sesión' ? 'conexion' : 'estructura';
      throw new ErrorPortal(`Falló "${paso}": ${mensaje}`, tipo);
    } finally {
      await navegador?.close().catch(() => undefined);
    }
  }

  private async iniciarSesion(pagina: Page): Promise<void> {
    const { perfil } = this.op;
    const login = perfil.login!;
    await pagina.goto(perfil.url_login, { waitUntil: 'domcontentloaded' });
    if (login.captcha && (await pagina.locator(login.captcha).count()) > 0) {
      throw new ErrorPortal('El portal pide captcha; no se puede automatizar. Usa la fuente "archivo".', 'captcha');
    }
    const { usuario, contrasena } = this.op.credenciales();
    await pagina.fill(login.usuario, usuario);
    await pagina.fill(login.contrasena, contrasena);
    await pagina.click(login.entrar);
    const esperado = login.error ? `${login.exito}, ${login.error}` : login.exito;
    await pagina.waitForSelector(esperado);
    if (login.error && (await pagina.locator(login.error).count()) > 0 && (await pagina.locator(login.exito).count()) === 0) {
      const detalle = (await pagina.locator(login.error).first().innerText()).trim();
      throw new ErrorPortal(`El portal rechazó el usuario o la contraseña${detalle ? `: ${detalle}` : ''}`, 'credenciales');
    }
  }

  /** Lee la tabla de recibos, siguiendo la paginación si existe. */
  private async leerTablas(pagina: Page): Promise<unknown[][]> {
    const { extraccion } = this.op.perfil;
    let encabezados: string[] | null = null;
    const filas: unknown[][] = [];
    for (let n = 1; n <= extraccion.max_paginas; n++) {
      const tabla = pagina.locator(extraccion.tabla).first();
      await tabla.waitFor();
      const datos = await tabla.evaluate((t) => {
        const el = t as HTMLTableElement;
        const celdas = (fila: HTMLTableRowElement) => Array.from(fila.cells).map((c) => (c as HTMLElement).innerText.trim());
        const cabecera = el.tHead?.rows[0] ?? el.rows[0];
        const cuerpo = Array.from(el.tBodies.length > 0 ? el.tBodies[0]!.rows : el.rows).filter((r) => r !== cabecera);
        return { encabezados: cabecera ? celdas(cabecera) : [], filas: cuerpo.map(celdas) };
      });
      encabezados ??= datos.encabezados;
      filas.push(...datos.filas);
      if (!extraccion.siguiente) break;
      const siguiente = pagina.locator(extraccion.siguiente).first();
      if ((await siguiente.count()) === 0 || !(await siguiente.isEnabled()) || (await siguiente.getAttribute('aria-disabled')) === 'true') break;
      await Promise.all([pagina.waitForLoadState('domcontentloaded'), siguiente.click()]);
      await this.captura(pagina, `3-pagina-${n + 1}`);
    }
    return encabezados ? [encabezados, ...filas] : [];
  }

  /** Hace clic en "exportar" y lee el archivo descargado (.xlsx o .csv). */
  private async descargar(pagina: Page): Promise<unknown[][]> {
    const selectorDescarga = this.op.perfil.extraccion.descarga;
    if (!selectorDescarga) throw new ErrorPortal('El perfil usa extracción "descarga" pero no indica el selector "descarga"', 'estructura');
    const [descarga] = await Promise.all([pagina.waitForEvent('download'), pagina.click(selectorDescarga)]);
    const nombre = descarga.suggestedFilename() || 'reporte.csv';
    const ruta = join(this.op.dirTrabajo, `descarga-${Date.now()}-${nombre.replace(/[^\w.-]/g, '_')}`);
    await descarga.saveAs(ruta);
    try {
      return await leerTablaDeArchivo(ruta);
    } finally {
      unlinkSync(ruta);
    }
  }

  private async captura(pagina: Page, nombre: string): Promise<void> {
    if (!this.op.capturas) return;
    const ruta = join(this.op.dirTrabajo, 'capturas', `${nombre}.png`);
    mkdirSync(join(this.op.dirTrabajo, 'capturas'), { recursive: true });
    await pagina.screenshot({ path: ruta, fullPage: true }).catch(() => undefined);
  }

  /** Guarda una captura del momento del error (se conservan las últimas 5). */
  private async guardarErrorCaptura(pagina: Page): Promise<void> {
    const dir = join(this.op.dirTrabajo, 'errores');
    mkdirSync(dir, { recursive: true });
    await pagina.screenshot({ path: join(dir, `error-${Date.now()}.png`), fullPage: true }).catch(() => undefined);
    const viejas = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    for (const f of viejas.slice(0, Math.max(0, viejas.length - 5))) unlinkSync(join(dir, f));
  }
}
