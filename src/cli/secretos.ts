/**
 * Administración de secretos (todo se guarda cifrado; las contraseñas se escriben sin mostrarse).
 *
 *   npm run secretos -- portal <agente>      usuario y contraseña del portal de la aseguradora
 *   npm run secretos -- whatsapp <agente>    token propio de WhatsApp del agente (opcional)
 *   npm run secretos -- panel <agente|admin> contraseña del panel
 *   npm run secretos -- meta                 App Secret, verify token y token compartido de Meta
 *   npm run secretos -- correo               contraseña del correo SMTP
 *   npm run secretos -- ver [agente|sistema] qué secretos hay (sin mostrar valores)
 *   npm run secretos -- borrar <agente>      elimina todos los secretos de un agente
 *   npm run secretos -- rotar-clave          cambia la clave maestra y vuelve a cifrar todo
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, writeFileSync } from 'node:fs';
import { enmascararSecreto } from '../seguridad/boveda.js';
import { generarContrasena, hashContrasena, validarFortaleza } from '../seguridad/contrasenas.js';
import { confirmar, preguntar, preguntarContrasenaDoble } from '../seguridad/entrada.js';
import { abrirBoveda, configuracion, ejecutar, rutas } from './comun.js';

const [comando, objetivo] = process.argv.slice(2);

function agenteValido(id: string | undefined): string {
  if (!id) throw new Error('Indica el agente, p. ej.: npm run secretos -- portal ana-lopez');
  const ids = configuracion().agentes.map((a) => a.id);
  if (!ids.includes(id)) throw new Error(`No existe el agente "${id}". Agentes: ${ids.join(', ') || '(ninguno)'}`);
  return id;
}

await ejecutar(async () => {
  const boveda = abrirBoveda();
  switch (comando) {
    case 'portal': {
      const id = agenteValido(objetivo);
      console.log(`Credenciales del portal de la aseguradora para ${id}:`);
      const usuario = await preguntar('Usuario');
      const contrasena = await preguntar('Contraseña', { oculto: true });
      if (!usuario || !contrasena) throw new Error('Usuario y contraseña son obligatorios');
      boveda.actualizar(id, { 'portal.usuario': usuario, 'portal.contrasena': contrasena });
      console.log(`✔ Guardadas cifradas. Pruébalas con: npm run probar-portal -- ${id}`);
      break;
    }
    case 'whatsapp': {
      const id = agenteValido(objetivo);
      const token = await preguntar(`Token permanente de WhatsApp de ${id} (vacío = usar el compartido)`, { oculto: true });
      boveda.actualizar(id, { 'whatsapp.token': token || undefined });
      console.log(token ? '✔ Token guardado.' : '✔ Se usará el token compartido.');
      break;
    }
    case 'panel': {
      const ambito = objetivo === 'admin' ? 'sistema' : agenteValido(objetivo);
      let contrasena = await preguntarContrasenaDoble(`Nueva contraseña del panel para ${objetivo} (Enter = generar)`);
      if (!contrasena) {
        contrasena = generarContrasena();
        console.log(`  Contraseña generada: ${contrasena}  (guárdala; no se vuelve a mostrar)`);
      } else {
        const debil = validarFortaleza(contrasena);
        if (debil) throw new Error(debil);
      }
      boveda.actualizar(ambito, { 'panel.hash': hashContrasena(contrasena) });
      console.log('✔ Contraseña actualizada. Reinicia el asistente para aplicarla.');
      break;
    }
    case 'meta': {
      const appSecret = await preguntar('App Secret (Enter = no cambiar)', { oculto: true });
      const verify = await preguntar('Verify token (Enter = no cambiar)', { oculto: true });
      const token = await preguntar('Token compartido de WhatsApp (Enter = no cambiar)', { oculto: true });
      boveda.actualizar('sistema', {
        'meta.app_secret': appSecret || boveda.obtener('sistema', 'meta.app_secret'),
        'meta.verify_token': verify || boveda.obtener('sistema', 'meta.verify_token'),
        'meta.token': token || boveda.obtener('sistema', 'meta.token'),
      });
      console.log('✔ Datos de Meta actualizados.');
      break;
    }
    case 'correo': {
      const c = await preguntar('Contraseña del correo SMTP (p. ej. contraseña de aplicación de Gmail)', { oculto: true });
      boveda.actualizar('sistema', { 'correo.contrasena': c || undefined });
      console.log('✔ Guardada.');
      break;
    }
    case 'ver': {
      const ambitos = objetivo ? [objetivo] : boveda.ambitos();
      for (const a of ambitos) {
        console.log(`\n[${a}]`);
        const s = boveda.leer(a);
        if (Object.keys(s).length === 0) console.log('  (sin secretos)');
        for (const [k, v] of Object.entries(s).sort()) {
          const visible = k === 'portal.usuario' ? v : k.endsWith('.hash') ? '(hash scrypt)' : enmascararSecreto(v);
          console.log(`  ${k.padEnd(22)} ${visible}`);
        }
      }
      break;
    }
    case 'borrar': {
      const id = objetivo ?? '';
      if (!(await confirmar(`¿Borrar TODOS los secretos de "${id}"?`))) return;
      boveda.borrar(id);
      console.log('✔ Borrados.');
      break;
    }
    case 'rotar-clave': {
      if (!(await confirmar('Se generará una clave maestra nueva y se volverán a cifrar todos los secretos. ¿Continuar?'))) return;
      const respaldo = `${rutas.claveMaestra}.anterior-${Date.now()}`;
      copyFileSync(rutas.claveMaestra, respaldo);
      const nueva = randomBytes(32);
      boveda.recifrar(nueva);
      writeFileSync(rutas.claveMaestra, `${nueva.toString('base64')}\n`, { mode: 0o600 });
      console.log(`✔ Clave rotada. La anterior quedó en ${respaldo}: bórrala cuando confirmes que todo funciona.`);
      break;
    }
    default:
      console.log('Comandos: portal <agente> · whatsapp <agente> · panel <agente|admin> · meta · correo · ver [ámbito] · borrar <agente> · rotar-clave');
  }
});
