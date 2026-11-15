import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cargarConfiguracion, ErrorConfiguracion, expandirVariables } from '../src/plataforma/configuracion.js';

describe('archivos de configuración', () => {
  it('carga la configuración de simulación incluida', () => {
    const c = cargarConfiguracion('config-simulacion');
    expect(c.sistema.modo).toBe('simulacion');
    expect(c.agentes.map((a) => a.id)).toEqual(['ana-lopez', 'luis-martinez']);
    const luis = c.agentes[1]!;
    expect(luis.envios.repetir_cada_dias).toBe(2);
    expect(luis.envios.dias_semana).toEqual(['lun', 'mar', 'mie', 'jue', 'vie']);
    expect(c.perfiles.get('aseguradora_demo_descarga')!.extraccion.tipo).toBe('descarga');
  });

  it('carga la plantilla de producción y el perfil de Seguros Monterrey', () => {
    const c = cargarConfiguracion('config');
    expect(c.sistema.modo).toBe('produccion');
    expect(c.sistema.meta.graph_url).toBe('https://graph.facebook.com');
    expect(c.perfiles.has('seguros_monterrey')).toBe(true);
    expect(c.agentes).toHaveLength(0); // _plantilla.yaml.ejemplo no cuenta
  });

  it('expande variables de entorno', () => {
    expect(expandirVariables('url: ${X_URL:-http://localhost:4100}/login', {})).toBe('url: http://localhost:4100/login');
    expect(expandirVariables('url: ${X_URL:-http://localhost:4100}/login', { X_URL: 'http://simulador:4100' })).toBe('url: http://simulador:4100/login');
  });

  it('explica los errores con archivo y campo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    cpSync('config-simulacion', dir, { recursive: true });
    writeFileSync(join(dir, 'agentes', 'ana-lopez.yaml'), `
id: ana-lopez
nombre: Ana
whatsapp: { phone_number_id: "1" }
panel: { usuario: luis }
fuente: { tipo: portal, perfil: no-existe, sincronizar: "cada día" }
envios: { hora_revision: "25:00", repetir_cada_dias: 0, campo_inventado: 1 }
`);
    try {
      cargarConfiguracion(dir);
      expect.unreachable();
    } catch (e) {
      const errores = (e as ErrorConfiguracion).errores.join('\n');
      expect(errores).toMatch(/agentes\/ana-lopez.yaml → fuente.sincronizar: expresión cron inválida/);
      expect(errores).toMatch(/envios.hora_revision: usa formato HH:MM/);
      expect(errores).toMatch(/envios.repetir_cada_dias/);
      expect(errores).toMatch(/campo_inventado/);
    }
  });

  it('detecta usuarios de panel repetidos y perfiles inexistentes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    cpSync('config-simulacion', dir, { recursive: true });
    mkdirSync(join(dir, 'agentes'), { recursive: true });
    writeFileSync(join(dir, 'agentes', 'pepe.yaml'), `id: pepe\nnombre: Pepe\nwhatsapp: { phone_number_id: "9" }\npanel: { usuario: ana }\nfuente: { tipo: portal, perfil: inventado }\n`);
    expect(() => cargarConfiguracion(dir)).toThrow(/panel.usuario "ana" ya lo usa ana-lopez[\s\S]*no existe config\/portales\/inventado.yaml|no existe config\/portales\/inventado.yaml[\s\S]*ya lo usa/);
  });
});
