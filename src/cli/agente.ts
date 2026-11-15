/**
 * Alta y consulta de agentes.
 *   npm run agente -- nuevo     crea config/agentes/<id>.yaml y pide sus credenciales
 *   npm run agente -- listar    muestra los agentes y sus reglas de envío
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashContrasena, generarContrasena, validarFortaleza } from '../seguridad/contrasenas.js';
import { preguntar, preguntarContrasenaDoble } from '../seguridad/entrada.js';
import { abrirBoveda, configuracion, ejecutar, rutas } from './comun.js';

const [comando] = process.argv.slice(2);

function slug(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

await ejecutar(async () => {
  if (comando === 'listar') {
    const { agentes } = configuracion();
    if (agentes.length === 0) console.log('No hay agentes. Crea uno con: npm run agente -- nuevo');
    for (const a of agentes) {
      const e = a.envios;
      console.log(`\n${a.nombre} (${a.id})${a.activo ? '' : ' — INACTIVO'}`);
      console.log(`  Fuente: ${a.fuente.tipo} · perfil ${a.fuente.perfil} · lectura "${a.fuente.sincronizar}"`);
      console.log(`  Revisión ${e.hora_revision} (${e.dias_semana.join(',')}) · primer aviso ${e.primer_aviso_dias_antes} días antes · repetir cada ${e.repetir_cada_dias}/${e.repetir_cada_dias_vencido} días · tope ${e.max_avisos}`);
      console.log(`  WhatsApp phone_number_id ${a.whatsapp.phone_number_id} · panel: ${a.panel.usuario}`);
    }
    return;
  }

  if (comando !== 'nuevo') {
    console.log('Comandos: nuevo · listar');
    return;
  }

  const nombre = await preguntar('Nombre del agente como aparecerá en los mensajes (p. ej. Ana López)');
  if (!nombre) throw new Error('El nombre es obligatorio');
  const id = await preguntar('Identificador', { porDefecto: slug(nombre) });
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) throw new Error('El identificador solo admite minúsculas, números y guiones');
  const destino = join(rutas.config, 'agentes', `${id}.yaml`);
  if (existsSync(destino)) throw new Error(`Ya existe ${destino}`);

  const phoneId = await preguntar('Phone Number ID de WhatsApp (Meta → WhatsApp → Configuración de la API)');
  const usuarioPanel = await preguntar('Usuario para el panel', { porDefecto: id });
  const correo = await preguntar('Correo para avisos (opcional)');
  const tipo = (await preguntar('Fuente de recibos: portal o archivo', { porDefecto: 'portal' })) === 'archivo' ? 'archivo' : 'portal';
  const perfil = await preguntar('Perfil del portal (archivo en config/portales/)', { porDefecto: 'seguros_monterrey' });

  const plantilla = readFileSync(join(rutas.config, 'agentes', '_plantilla.yaml.ejemplo'), 'utf8');
  const yaml = plantilla
    .replace('id: nuevo-agente', `id: ${id}`)
    .replace('nombre: Nombre Apellido', `nombre: ${JSON.stringify(nombre)}`)
    .replace('# correo_avisos: agente@ejemplo.com', correo ? `correo_avisos: ${correo}` : '# correo_avisos: agente@ejemplo.com')
    .replace('phone_number_id: "000000000000000"', `phone_number_id: "${phoneId}"`)
    .replace('usuario: nuevo-agente', `usuario: ${usuarioPanel}`)
    .replace('tipo: portal', `tipo: ${tipo}`)
    .replace('perfil: seguros_monterrey', `perfil: ${perfil}`)
    .replace('# carpeta: ./entrada/nuevo-agente', tipo === 'archivo' ? `carpeta: ./entrada/${id}` : '# carpeta: ./entrada/nuevo-agente');
  writeFileSync(destino, yaml);
  console.log(`✔ Configuración creada: ${destino}  (edítala para ajustar cuándo y cada cuándo se envían mensajes)`);

  const boveda = abrirBoveda();
  if (tipo === 'portal') {
    console.log('\nCredenciales del portal de la aseguradora (se guardan cifradas):');
    const usuario = await preguntar('Usuario del portal');
    const contrasena = await preguntar('Contraseña del portal', { oculto: true });
    if (usuario && contrasena) boveda.actualizar(id, { 'portal.usuario': usuario, 'portal.contrasena': contrasena });
  }
  let panel = await preguntarContrasenaDoble('Contraseña del panel para el agente (Enter = generar)');
  if (!panel) {
    panel = generarContrasena();
    console.log(`  Contraseña generada: ${panel}  (entrégasela al agente; no se vuelve a mostrar)`);
  } else if (validarFortaleza(panel)) throw new Error(validarFortaleza(panel)!);
  boveda.actualizar(id, { 'panel.hash': hashContrasena(panel) });

  configuracion(); // valida el archivo nuevo
  console.log(`\n✔ Agente ${id} listo. Comprueba todo con: npm run validar  · y reinicia el asistente.`);
});
