import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Boveda } from '../src/seguridad/boveda.js';
import { generarContrasena, hashContrasena, validarFortaleza, verificarContrasena } from '../src/seguridad/contrasenas.js';

function bovedaTemporal() {
  const dir = mkdtempSync(join(tmpdir(), 'boveda-'));
  const clave = join(dir, 'clave-maestra');
  Boveda.crearClaveMaestra(clave);
  return { dir, clave, boveda: Boveda.abrir(dir, clave) };
}

describe('bóveda de secretos', () => {
  it('guarda cifrado y lee de vuelta', () => {
    const { dir, clave, boveda } = bovedaTemporal();
    boveda.actualizar('ana-lopez', { 'portal.usuario': 'ana.lopez', 'portal.contrasena': 'MiClaveSecreta!2026' });
    const enDisco = readFileSync(join(dir, 'ana-lopez.secreto'), 'utf8');
    expect(enDisco).not.toContain('MiClaveSecreta');
    expect(enDisco).not.toContain('ana.lopez');
    expect(Boveda.abrir(dir, clave).obtener('ana-lopez', 'portal.contrasena')).toBe('MiClaveSecreta!2026');
  });

  it('el archivo y la clave quedan con permisos 600', () => {
    const { dir, clave, boveda } = bovedaTemporal();
    boveda.actualizar('sistema', { x: '1' });
    expect(statSync(clave).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'sistema.secreto')).mode & 0o777).toBe(0o600);
  });

  it('rechaza una clave maestra legible por otros usuarios', () => {
    const { clave, dir } = bovedaTemporal();
    chmodSync(clave, 0o644);
    expect(() => Boveda.abrir(dir, clave)).toThrow(/chmod 600/);
  });

  it('no descifra con otra clave ni si se copia el archivo a otro agente', () => {
    const { dir, boveda } = bovedaTemporal();
    boveda.actualizar('ana', { 'portal.contrasena': 'secreta' });
    const otra = mkdtempSync(join(tmpdir(), 'otra-'));
    Boveda.crearClaveMaestra(join(otra, 'k'));
    expect(() => Boveda.abrir(dir, join(otra, 'k')).leer('ana')).toThrow(/no corresponde|alterado/);
    writeFileSync(join(dir, 'luis.secreto'), readFileSync(join(dir, 'ana.secreto')));
    expect(() => new Boveda(dir, Buffer.from(readFileSync(join(dir, 'clave-maestra'), 'utf8').trim(), 'base64')).leer('luis')).toThrow();
  });

  it('detecta archivos alterados', () => {
    const { dir, clave, boveda } = bovedaTemporal();
    boveda.actualizar('ana', { a: 'b' });
    const archivo = JSON.parse(readFileSync(join(dir, 'ana.secreto'), 'utf8'));
    archivo.datos = Buffer.from('manipulado').toString('base64');
    writeFileSync(join(dir, 'ana.secreto'), JSON.stringify(archivo));
    expect(() => Boveda.abrir(dir, clave).leer('ana')).toThrow();
  });

  it('rota la clave maestra conservando los secretos', () => {
    const { dir, boveda } = bovedaTemporal();
    boveda.actualizar('ana', { 'portal.contrasena': 'uno' });
    boveda.actualizar('sistema', { 'meta.app_secret': 'dos' });
    const nueva = Buffer.alloc(32, 7);
    boveda.recifrar(nueva);
    const otra = new Boveda(dir, nueva);
    expect(otra.obtener('ana', 'portal.contrasena')).toBe('uno');
    expect(otra.obtener('sistema', 'meta.app_secret')).toBe('dos');
  });

  it('no acepta ámbitos que salgan de la carpeta', () => {
    const { boveda } = bovedaTemporal();
    expect(() => boveda.leer('../etc/passwd')).toThrow(/inválido/);
    expect(existsSync('/etc/passwd.secreto')).toBe(false);
  });
});

describe('contraseñas del panel', () => {
  it('guarda hash scrypt y verifica', () => {
    const h = hashContrasena('Panel-Seguro-2026');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(h).not.toContain('Panel-Seguro');
    expect(verificarContrasena('Panel-Seguro-2026', h)).toBe(true);
    expect(verificarContrasena('otra', h)).toBe(false);
    expect(verificarContrasena('x', undefined)).toBe(false);
  });
  it('exige contraseñas fuertes', () => {
    expect(validarFortaleza('corta1')).toMatch(/10/);
    expect(validarFortaleza('solamenteletras')).toMatch(/letras y números/);
    expect(validarFortaleza('Buena-Clave-2026')).toBeNull();
    expect(validarFortaleza(generarContrasena())).toBeNull();
  });
});
