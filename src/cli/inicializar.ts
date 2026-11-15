/**
 * Primer arranque. Crea la clave maestra y los secretos generales.
 *   npm run inicializar                 → producción (pregunta los valores de Meta y la contraseña del administrador)
 *   npm run inicializar -- --simulacion → demostración: llena todo con valores de prueba
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Boveda } from '../seguridad/boveda.js';
import { generarContrasena, hashContrasena, validarFortaleza } from '../seguridad/contrasenas.js';
import { preguntar, preguntarContrasenaDoble } from '../seguridad/entrada.js';
import { DEMO } from '../simulador/demo.js';
import { abrirBoveda, configuracion, ejecutar, rutas } from './comun.js';

await ejecutar(async () => {
  const simulacion = process.argv.includes('--simulacion');

  if (!existsSync(rutas.claveMaestra)) {
    Boveda.crearClaveMaestra(rutas.claveMaestra);
    console.log(`✔ Clave maestra creada en ${rutas.claveMaestra} (permisos 600).`);
    console.log('  Guárdala también fuera de la Raspberry (USB o gestor de contraseñas): sin ella no se pueden leer los secretos.');
  } else {
    console.log(`• Ya existe la clave maestra (${rutas.claveMaestra}); se reutiliza.`);
  }
  const boveda = abrirBoveda();

  if (simulacion) {
    boveda.actualizar('sistema', {
      'meta.app_secret': DEMO.appSecret,
      'meta.verify_token': DEMO.verifyToken,
      'meta.token': DEMO.metaToken,
      'panel.hash': hashContrasena(DEMO.panel.admin!),
    });
    const { agentes, sistema } = configuracion();
    for (const a of agentes) {
      const portal = DEMO.portal[a.id];
      boveda.actualizar(a.id, {
        'portal.usuario': portal?.usuario,
        'portal.contrasena': portal?.contrasena,
        'panel.hash': hashContrasena(DEMO.panel[a.id] ?? DEMO.panel.admin!),
      });
    }
    console.log('\n✔ Secretos de DEMOSTRACIÓN guardados (cifrados). Accesos al panel:');
    console.log(`   ${sistema.panel.admin_usuario.padEnd(14)} ${DEMO.panel.admin}   (administrador, ve a todos)`);
    for (const a of agentes) console.log(`   ${a.panel.usuario.padEnd(14)} ${DEMO.panel[a.id] ?? DEMO.panel.admin}   (${a.nombre})`);
    return;
  }

  console.log('\nDatos de tu app de Meta (developers.facebook.com → tu app):');
  const appSecret = await preguntar('Clave secreta de la app (App Secret)', { oculto: true });
  if (!appSecret) throw new Error('La clave secreta de la app es obligatoria');
  let verify = await preguntar('Verify token del webhook (Enter = generar uno)', { oculto: true });
  if (!verify) {
    verify = randomBytes(18).toString('base64url');
    console.log(`  Verify token generado: ${verify}\n  Cópialo: lo pegarás en Meta al configurar el webhook.`);
  }
  const token = await preguntar('Token permanente compartido de WhatsApp (Enter = cada agente tendrá el suyo)', { oculto: true });

  console.log('\nContraseña del administrador del panel (Enter = generar una):');
  let admin = await preguntarContrasenaDoble('Contraseña');
  if (!admin) {
    admin = generarContrasena();
    console.log(`  Contraseña generada: ${admin}\n  Guárdala ahora; no se vuelve a mostrar.`);
  } else {
    const debil = validarFortaleza(admin);
    if (debil) throw new Error(debil);
  }

  boveda.actualizar('sistema', {
    'meta.app_secret': appSecret,
    'meta.verify_token': verify,
    'meta.token': token || undefined,
    'panel.hash': hashContrasena(admin),
  });
  console.log('\n✔ Listo. Ahora agrega agentes con: npm run agente -- nuevo');
});
