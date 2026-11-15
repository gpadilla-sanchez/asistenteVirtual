/**
 * Prueba la lectura del portal (o archivo) de UN agente, sin enviar mensajes ni guardar nada.
 *   npm run probar-portal -- <agente> [--capturas]
 * Con --capturas guarda una imagen de cada paso en data/agentes/<agente>/portal/capturas/
 * (útil para ajustar config/portales/<perfil>.yaml con el portal real).
 */
import { join, resolve } from 'node:path';
import { FuenteArchivo } from '../fuentes/archivo.js';
import { FuentePortal } from '../fuentes/portal.js';
import { crearLogger } from '../logger.js';
import { fechaLegible } from '../utils/fechas.js';
import { enmascarar } from '../utils/telefono.js';
import { formatearMonto } from '../utils/texto.js';
import { abrirBoveda, configuracion, ejecutar, rutas } from './comun.js';

const id = process.argv[2];

await ejecutar(async () => {
  const { agentes, perfiles, sistema } = configuracion();
  const agente = agentes.find((a) => a.id === id);
  if (!agente) throw new Error(`Uso: npm run probar-portal -- <agente>. Agentes: ${agentes.map((a) => a.id).join(', ')}`);
  const perfil = perfiles.get(agente.fuente.perfil)!;
  const boveda = abrirBoveda();
  const dir = join(rutas.datos, 'agentes', agente.id, 'portal');
  const fuente = agente.fuente.tipo === 'portal'
    ? new FuentePortal({
        perfil,
        credenciales: () => ({ usuario: boveda.requerir(agente.id, 'portal.usuario'), contrasena: boveda.requerir(agente.id, 'portal.contrasena') }),
        aceptaPorDefecto: agente.envios.acepta_por_defecto,
        rutaChromium: sistema.navegador.ruta_chromium,
        argumentos: sistema.navegador.argumentos,
        tiempoEsperaMs: sistema.navegador.tiempo_espera_seg * 1000,
        dirTrabajo: dir,
        capturas: process.argv.includes('--capturas'),
        logger: crearLogger('warn'),
      })
    : new FuenteArchivo(resolve(agente.fuente.carpeta!), perfil, agente.envios.acepta_por_defecto);

  console.log(`Leyendo ${fuente.nombre} para ${agente.nombre}...`);
  const inicio = Date.now();
  const pagos = await fuente.leerPagos();
  console.log(`✔ ${pagos.length} recibos leídos en ${((Date.now() - inicio) / 1000).toFixed(1)} s\n`);
  for (const p of pagos.slice(0, 25)) {
    console.log(
      `${p.id.padEnd(14)} ${p.cliente.slice(0, 26).padEnd(26)} ${(p.telefono ? enmascarar(p.telefono) : `INVÁLIDO (${p.telefonoOriginal})`).padEnd(14)} ` +
        `${(p.monto != null ? formatearMonto(p.monto) : '—').padStart(16)}  ${p.fechaVencimiento ? fechaLegible(p.fechaVencimiento) : 'SIN FECHA'}  ${p.estado}`,
    );
  }
  if (pagos.length > 25) console.log(`... y ${pagos.length - 25} más`);
  const sinTel = pagos.filter((p) => !p.telefono).length;
  const sinFecha = pagos.filter((p) => !p.fechaVencimiento).length;
  const desconocidos = pagos.filter((p) => p.estado === 'desconocido').length;
  if (sinTel) console.log(`\n⚠ ${sinTel} recibo(s) sin teléfono válido`);
  if (sinFecha) console.log(`⚠ ${sinFecha} recibo(s) sin fecha válida (revisa formato_fecha en el perfil)`);
  if (desconocidos) console.log(`⚠ ${desconocidos} recibo(s) con estado no reconocido (agrega el texto en "estados" del perfil)`);
  if (process.argv.includes('--capturas')) console.log(`\nCapturas en ${join(dir, 'capturas')}`);
});
