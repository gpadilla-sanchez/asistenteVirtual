/**
 * Revisa toda la configuración y los secretos antes de arrancar.
 *   npm run validar
 */
import { existsSync } from 'node:fs';
import { revisarSecretos } from '../plataforma/plataforma.js';
import { abrirBoveda, configuracion, ejecutar, rutas } from './comun.js';

await ejecutar(() => {
  const config = configuracion();
  console.log(`✔ Archivos de configuración válidos · modo ${config.sistema.modo} · ${config.agentes.length} agente(s) · perfiles: ${[...config.perfiles.keys()].join(', ')}`);
  const { errores, advertencias } = revisarSecretos(config, abrirBoveda());
  console.log('✔ Bóveda de secretos abierta correctamente');
  for (const a of config.agentes) {
    if (a.fuente.tipo === 'archivo' && !existsSync(a.fuente.carpeta!)) advertencias.push(`${a.id}: no existe la carpeta ${a.fuente.carpeta}`);
  }
  for (const a of advertencias) console.log(`⚠ ${a}`);
  for (const e of errores) console.log(`✘ ${e}`);
  if (config.sistema.modo === 'produccion' && config.sistema.meta.graph_url !== 'https://graph.facebook.com') {
    console.log(`⚠ En producción meta.graph_url debería ser https://graph.facebook.com (está en ${config.sistema.meta.graph_url})`);
  }
  if (errores.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(`\nTodo listo para arrancar. (config: ${rutas.config} · secretos: ${rutas.secretos} · datos: ${rutas.datos})`);
});
