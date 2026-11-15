# Plataforma de recordatorios de pago de pólizas por WhatsApp

Cada **agente de seguros** tiene su propio asistente. Este lee los recibos pendientes del portal de la aseguradora con el usuario y la contraseña del agente, avisa por WhatsApp a cada cliente cuando su recibo está por vencer y le pregunta si ya pagó:

- **"Sí, ya pagué"** (o envía foto del comprobante) → deja de escribirle y avisa al agente.
- **"Aún no" o no contesta** → vuelve a escribirle según la configuración del agente (p. ej. al día siguiente).
- **La aseguradora aplica el pago** → se detiene solo, aunque el cliente no haya contestado.
- **Dijo que sí, pero en N días la aseguradora no lo aplica** → se reanudan los avisos.
- **Llega al tope de avisos** → pasa a *Requiere atención* para que el agente le llame.
- **BAJA** → no vuelve a recibir mensajes.

Todo corre en una Raspberry Pi y se puede **simular completo** (WhatsApp falso + aseguradora ficticia) antes de usar cuentas reales.

---

## Índice

1. [Cómo está organizado](#1-cómo-está-organizado)
2. [Simular todo en la Raspberry (empieza aquí)](#2-simular-todo-en-la-raspberry-empieza-aquí)
3. [Configuración por agente: cuándo y cada cuándo](#3-configuración-por-agente-cuándo-y-cada-cuándo)
4. [Usuarios y contraseñas de forma segura](#4-usuarios-y-contraseñas-de-forma-segura)
5. [Conectar el portal real de Seguros Monterrey](#5-conectar-el-portal-real-de-seguros-monterrey)
6. [Pasar a producción](#6-pasar-a-producción)
7. [Escalar: más agentes, más equipos](#7-escalar-más-agentes-más-equipos)
8. [Mantenimiento y problemas comunes](#8-mantenimiento-y-problemas-comunes)
9. [Referencia técnica](#9-referencia-técnica)

---

## 1. Cómo está organizado

```
                        ┌──────────────────────── Raspberry Pi ────────────────────────┐
 Portal de la           │  Plataforma (un proceso para todos los agentes)              │
 aseguradora  ◄─────────┤   · por agente: lectura del portal (Chromium sin pantalla)   │
 (usuario de cada       │   · por agente: revisión diaria y reglas de envío            │──► WhatsApp Cloud API ──► Clientes
  agente)               │   · webhook único: reparte cada respuesta a su agente        │◄── (respuestas)
                        │   · panel web: cada agente ve solo lo suyo                   │
                        │                                                              │
                        │  config/            ← reglas de cada agente (YAML, sin secretos)
                        │  secretos/          ← contraseñas y tokens CIFRADOS (AES-256)
                        │  data/agentes/<id>/ ← base de datos propia de cada agente
                        └──────────────────────────────────────────────────────────────┘
```

| Carpeta | Qué contiene | ¿Secreto? |
| --- | --- | --- |
| `config/sistema.yaml` | Ajustes generales (zona horaria, Meta, correo) | No |
| `config/agentes/<id>.yaml` | **Un archivo por agente**: cuándo y cada cuándo enviar, su número de WhatsApp, su fuente | No |
| `config/portales/<perfil>.yaml` | Cómo leer el portal de una aseguradora (direcciones, selectores, columnas) | No |
| `secretos/*.secreto` | Usuarios y contraseñas del portal, tokens de Meta, contraseñas del panel. **Cifrados** | Sí |
| `secretos/clave-maestra` | La llave que descifra lo anterior (permisos 600) | **Sí, la más importante** |
| `data/agentes/<id>/` | Historial, seguimiento y bitácora de cada agente | Datos personales |
| `config-simulacion/` | Lo mismo, pero para la simulación (2 agentes de ejemplo) | No |

---

## 2. Simular todo en la Raspberry (empieza aquí)

### 2.1 Preparar la Raspberry

1. Instala **Raspberry Pi OS Lite (64-bit)** con Raspberry Pi Imager. Activa SSH y pon la zona horaria `America/Mexico_City`.
   - Comprueba que sea de 64 bits: `uname -m` debe mostrar `aarch64`.
   - Recomendado: Raspberry Pi 4 (4 GB) o Pi 5, con SSD por USB en lugar de microSD.
2. Instala Docker:
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER
   exit        # vuelve a entrar por SSH
   ```
3. Copia el proyecto (desde tu computadora):
   ```bash
   scp plataforma-asistente-seguros.zip pi@<ip-de-la-raspberry>:~/
   ssh pi@<ip-de-la-raspberry>
   unzip plataforma-asistente-seguros.zip && cd plataforma-asistente-seguros
   ```

### 2.2 Arrancar la simulación

```bash
./asistente.sh simulacion
```

La primera vez tarda varios minutos porque compila e instala Chromium para ARM. Después abre en tu computadora o celular (misma red):

| Qué | Dirección | Acceso |
| --- | --- | --- |
| **WhatsApp simulado** (lo que ven los clientes) | `http://<ip>:4000` | — |
| **Portal de la aseguradora ficticia** | `http://<ip>:4100` | `ana.lopez` / `Demo-Ana-2026` · `luis.martinez` / `Demo-Luis-2026` |
| **Panel del asistente** | `http://<ip>:3000/panel` | `admin` / `Admin-Demo-2026` · `ana` / `Ana-Panel-2026` · `luis` / `Luis-Panel-2026` |

### 2.3 Qué probar

1. En el WhatsApp simulado pulsa **▶ Simular día completo**. El asistente entra al portal ficticio con el usuario de cada agente, lee los recibos y envía los recordatorios a quien corresponde según las reglas de cada agente.
   - Ana avisa 5 días antes; Luis 3 días antes, solo de lunes a viernes y cada 2 días. Si hoy es sábado, Luis no envía nada; eso también es parte de la prueba.
2. Abre un contacto y pulsa **Sí, ya pagué**. El asistente responde y el recibo pasa a *Cliente dice que pagó* en el panel.
3. En otro contacto pulsa **Aún no** o escribe "mañana". Luego **Avanzar 1 día ⏭** y **Simular día completo**: le vuelve a llegar el recordatorio.
4. Escribe `BAJA`, `ayuda`, `ya pagué` o "hola" como cliente y observa cómo responde.
5. Pulsa **Registrar pago** en un recibo (simula que la aseguradora aplicó el pago) y luego **Leer aseguradora**: el panel lo marca *Pagado* y ya no se avisa.
6. Avanza varios días sin contestar: el recibo llega al tope y pasa a *Requiere atención*.
7. Un cliente tiene un teléfono que termina en 9999: WhatsApp "no puede entregar" el mensaje y el panel lo muestra en rojo.
8. Entra al panel como `ana`: solo ves los clientes de Ana. Como `admin` ves a los dos agentes.

Para empezar de cero: `./asistente.sh reiniciar-simulacion`. Para apagar: `./asistente.sh detener-simulacion`.

> Cambia las reglas en `config-simulacion/agentes/*.yaml` y reinicia con `./asistente.sh reiniciar-simulacion` para ver el efecto.

---

## 3. Configuración por agente: cuándo y cada cuándo

Cada agente tiene su archivo `config/agentes/<id>.yaml`. La plantilla comentada está en `config/agentes/_plantilla.yaml.ejemplo`, y la forma fácil de crear uno es `./asistente.sh agente nuevo`.

```yaml
id: ana-lopez
nombre: Ana López                 # aparece en el mensaje: "soy Ana López, tu asesor de seguros"
activo: true                      # false = pausa sus envíos
correo_avisos: ana@ejemplo.com    # opcional: avisos de "cliente pagó", "requiere atención", etc.

whatsapp:
  phone_number_id: "123456789012345"

panel:
  usuario: ana

fuente:
  tipo: portal                    # portal (entra con su usuario) | archivo (lee el reporte que deje en su carpeta)
  perfil: seguros_monterrey
  sincronizar: "0 7 * * *"        # CUÁNDO leer la aseguradora (formato cron)

envios:
  # CUÁNDO
  hora_revision: "10:00"
  dias_semana: [lun, mar, mie, jue, vie, sab]
  horario: { inicio: "09:00", fin: "20:00" }
  primer_aviso_dias_antes: 5
  # CADA CUÁNDO
  repetir_cada_dias: 1            # si dice "No" o no contesta (antes de vencer; siempre avisa el día límite)
  repetir_cada_dias_vencido: 1    # una vez vencido
  # HASTA CUÁNDO
  max_avisos: 10
  dejar_de_avisar_dias_despues: 30
  reabrir_reportado_tras_dias: 5
  acepta_por_defecto: true
```

| Ejemplo de `sincronizar` | Significa |
| --- | --- |
| `"0 7 * * *"` | Todos los días a las 7:00 |
| `"30 6 * * 1-5"` | Lunes a viernes 6:30 |
| `"0 7,13 * * 1-6"` | 7:00 y 13:00, lunes a sábado |

**Ejemplo con `primer_aviso_dias_antes: 5` y `repetir_cada_dias: 2`**, recibo que vence el día 20, cliente que nunca contesta: avisos los días 15, 17, 19, 20 (día límite) y, ya vencido, cada `repetir_cada_dias_vencido`, hasta `max_avisos`.

Si el archivo tiene un error, el asistente no arranca y dice exactamente dónde está, por ejemplo: `agentes/ana-lopez.yaml → envios.hora_revision: usa formato HH:MM`. Revisa todo con `./asistente.sh validar`. Después de cambiar un archivo, aplica con `./asistente.sh reiniciar`.

---

## 4. Usuarios y contraseñas de forma segura

**Ninguna contraseña se escribe en archivos de texto, en la línea de comandos ni en la bitácora.**

| Qué | Cómo se guarda | Comando |
| --- | --- | --- |
| Usuario y contraseña del **portal** de cada agente | Cifrados con AES-256-GCM en `secretos/<agente>.secreto` | `./asistente.sh secretos portal <agente>` |
| Token de WhatsApp (compartido o por agente) | Cifrado | `./asistente.sh secretos whatsapp <agente>` |
| App Secret y verify token de Meta | Cifrados | `./asistente.sh secretos meta` |
| Contraseña del **panel** de cada agente y del admin | Solo un hash scrypt: no se puede recuperar, solo verificar | `./asistente.sh secretos panel <agente\|admin>` |
| Contraseña del correo SMTP | Cifrada | `./asistente.sh secretos correo` |

Cómo funciona:
- Al escribir una contraseña no se muestra en pantalla.
- La **clave maestra** (`secretos/clave-maestra`, permisos 600) cifra todo. Si alguien copia los archivos `.secreto` sin la clave, no puede leerlos. El asistente se niega a arrancar si la clave puede leerla otro usuario del sistema.
- Cada archivo está ligado a su agente: copiar el archivo de un agente al de otro no funciona.
- Las contraseñas del portal solo se descifran en memoria en el momento de iniciar sesión.
- El panel bloquea la IP 15 minutos tras 8 intentos fallidos. Los formularios llevan protección contra falsificación (CSRF) y cada agente solo puede ver y modificar sus propios clientes.
- `./asistente.sh secretos ver` muestra qué secretos existen sin revelar valores.
- `./asistente.sh secretos rotar-clave` cambia la clave maestra y vuelve a cifrar todo.

**Importante:** guarda una copia de `secretos/clave-maestra` fuera de la Raspberry (USB guardada o gestor de contraseñas). Los respaldos automáticos copian los secretos cifrados pero **no** la clave, a propósito.

---

## 5. Conectar el portal real de Seguros Monterrey

Todavía no conocemos la estructura del portal real, así que `config/portales/seguros_monterrey.yaml` tiene los campos marcados como `PENDIENTE`. Cuando tengas usuario y contraseña:

1. **Antes de nada:** revisa las condiciones de uso del portal o pregunta a la aseguradora si permiten el acceso automatizado. Pregunta también si ofrecen un reporte descargable o una API para agentes, que sería más estable.
2. Entra al portal en Chrome y ubica la sección de recibos pendientes o cobranza.
3. Para cada elemento (campo usuario, campo contraseña, botón entrar, menú, tabla, botón "siguiente" o "exportar"): clic derecho → **Inspeccionar** → clic derecho en el código resaltado → **Copiar → Copiar selector**. Pégalo en el perfil.
4. En `columnas`, escribe el **texto exacto** de cada encabezado de la tabla tal como aparece en el portal.
5. Prueba sin enviar nada:
   ```bash
   ./asistente.sh secretos portal ana-lopez
   ./asistente.sh probar-portal ana-lopez --capturas
   ```
   Verás los recibos leídos (con teléfonos enmascarados) y avisos como "3 recibos sin teléfono válido". Las capturas de cada paso quedan en `data/agentes/ana-lopez/portal/capturas/`.
6. Ajusta y repite hasta que lea bien. **Si el portal tiene botón para exportar a Excel o CSV, usa `extraccion.tipo: descarga`**: es más confiable que leer la tabla.

**Si el portal pide captcha o un código por SMS o correo (doble factor):** el inicio de sesión no se puede automatizar. Usa `fuente.tipo: archivo` con `perfil: archivo_generico`. El agente descarga su reporte y lo deja en `entrada/<agente>/` (por ejemplo, desde una carpeta compartida). El asistente usa siempre el archivo más reciente.

**Protecciones incluidas:**
- Si el portal rechaza la contraseña, se avisa al agente y no se envía nada.
- Si la lectura más reciente tiene más de `max_antiguedad_horas`, no se envían recordatorios, para no escribirle a quien ya pagó.
- Si el portal devuelve 0 recibos de golpe, se conserva la información anterior.
- Si un recibo desaparece de la lista de pendientes, se asume pagado.

---

## 6. Pasar a producción

1. **Meta / WhatsApp Business** (los pasos detallados están en el README del asistente anterior, `asistente-cobranza-whatsapp`): crea la app, verifica el negocio, registra el número o los números y genera un token permanente con un usuario del sistema.
   - Cada agente puede tener **su propio número**. Todos deben estar en la misma app de Meta, porque el webhook es uno solo.
   - También pueden **compartir un número**: el asistente sabe a qué agente responde cada cliente por el botón que pulsó o por el mensaje que cita.
   - Si vas a vender el servicio a agentes independientes (cada uno con su propio negocio en Meta), lo correcto a largo plazo es registrarte como *Tech Provider* de Meta. Mientras tanto, cada agente puede tener su propio token: `secretos whatsapp <agente>`.
2. En la Raspberry:
   ```bash
   ./asistente.sh inicializar              # clave maestra, datos de Meta, contraseña del admin
   nano config/sistema.yaml                # waba_id, correo (opcional)
   ./asistente.sh agente nuevo             # repite por cada agente
   ./asistente.sh crear-plantillas         # envía las 2 plantillas a Meta (esperar aprobación)
   ./asistente.sh validar
   ```
3. **Dominio y HTTPS** (tu dominio de Nuebox con DDNS):
   - Redirige en el router los puertos **80 y 443** a la IP fija de la Raspberry.
   - Comprueba que tu proveedor no use CGNAT: la IP WAN del router debe coincidir con la de <https://ifconfig.me>.
   - Crea un archivo `.env` junto a `docker-compose.yml` con `DOMINIO=cobranza.tudominio.com`.
4. Arranca: `./asistente.sh produccion`. Verifica `https://cobranza.tudominio.com/salud` desde datos móviles.
5. En Meta → WhatsApp → Configuración → Webhook: URL `https://cobranza.tudominio.com/webhook`, el verify token de `inicializar`, y suscríbete a **messages**.
6. Piloto con pocos clientes de un solo agente durante 1–2 semanas antes de activar a todos.

> La simulación y la producción usan carpetas distintas (`config-simulacion/`, `secretos-simulacion/`, `data-simulacion/`), así que los datos de prueba nunca se mezclan con los reales.

---

## 7. Escalar: más agentes, más equipos

- **Agregar un agente** = un archivo YAML + sus secretos. No se toca código.
- **Otra aseguradora** = un perfil nuevo en `config/portales/`. Los agentes que vendan varias marcas pueden tener una configuración por cada portal.
- **Cada agente tiene su propia base de datos** (`data/agentes/<id>/`): se puede respaldar, mover o borrar por separado.
- **Capacidad en una Raspberry Pi 4/5:** decenas de agentes y miles de recibos sin problema. El límite real es Chromium (unos 250 MB por lectura). Las lecturas van una a la vez (`navegador.sincronizaciones_simultaneas`), así que conviene escalonar los horarios de `sincronizar` entre agentes (6:00, 6:10, 6:20…).
- **Crecer más allá:** la misma imagen de Docker corre en una PC o en la nube (amd64). Puedes repartir agentes entre varios equipos copiando sus archivos de `config/agentes/`, `secretos/<id>.secreto` y `data/agentes/<id>/`. El código ya está separado por piezas (fuente, base, WhatsApp, panel) para cambiar SQLite por PostgreSQL si algún día hace falta un servidor central.

---

## 8. Mantenimiento y problemas comunes

| Tarea | Comando |
| --- | --- |
| Ver bitácora | `./asistente.sh logs` |
| Aplicar cambios de configuración | `./asistente.sh reiniciar` |
| Lectura y envío a mano | `./asistente.sh revision todos --sincronizar` |
| Respaldo diario automático | `crontab -e` → `15 3 * * * /home/pi/plataforma-asistente-seguros/deploy/respaldo-cron.sh >> /home/pi/plataforma-asistente-seguros/data/respaldo.log 2>&1` |
| Actualizar | Copia la nueva versión y ejecuta `./asistente.sh produccion` |

| Problema | Solución |
| --- | --- |
| `No existe la clave maestra` | Ejecuta `./asistente.sh inicializar`, o restaura tu copia de `secretos/clave-maestra` |
| `la clave maestra no corresponde` | La clave no es la que cifró esos secretos; restaura la correcta |
| `puede leerla cualquier usuario` | `chmod 600 secretos/clave-maestra` |
| `Permission denied` en `data/` o `secretos/` | `sudo chown -R 1000:1000 data secretos` (el contenedor corre como usuario 1000) |
| `El portal rechazó el usuario o la contraseña` | `./asistente.sh secretos portal <agente>` |
| `Falló "paso 2 ..."` al leer el portal | El portal cambió: revisa `data/agentes/<id>/portal/errores/` y ajusta el perfil |
| No se envía nada | Revisa la bitácora: cada revisión dice por qué (horario, día no permitido, información vieja, etc.) |
| Error de Meta 131030 / 132001 / 132000 / 131026 / 190 | Destinatario no permitido con número de prueba / plantilla inexistente o no aprobada / número de variables distinto (son 6) / el número no tiene WhatsApp / token inválido o vencido |

---

## 9. Referencia técnica

```
src/
  index.ts                     Arranque
  plataforma/
    configuracion.ts           Esquemas y carga de sistema.yaml, agentes/*.yaml, portales/*.yaml
    plataforma.ts              Contextos por agente, enrutamiento del webhook, programador
    reloj.ts                   Reloj (adelantable en simulación), semáforo, candado
  seguridad/
    boveda.ts                  Secretos cifrados (AES-256-GCM, clave maestra 600)
    contrasenas.ts             Hash scrypt para el panel
    entrada.ts                 Preguntas en terminal sin mostrar contraseñas
  fuentes/
    portal.ts                  Lectura del portal con Chromium (tabla paginada o descarga)
    archivo.ts                 Reporte .xlsx/.csv dejado en una carpeta
    columnas.ts                Interpretación de columnas, fechas, montos y estados
  dominio/
    revision.ts                Reglas de cuándo y cada cuándo, sincronización, envío
    respuestas.ts              Sí / No / BAJA / ayuda / comprobante / entregas fallidas
    acciones.ts                Acciones del panel (pagado, cancelar, reabrir)
    clasificador.ts, mensajes.ts
  whatsapp/                    Cliente Cloud API, firma del webhook, plantillas
  db/baseDatos.ts              SQLite por agente
  servidor/                    Webhook, panel (autenticación, CSRF), controles de simulación
  simulador/                   Portal ficticio, WhatsApp simulado (API + teléfono web)
  cli/                         inicializar, secretos, agente, validar, probar-portal, revision, crear-plantillas, respaldo
tests/                         63 pruebas, incluida una de punta a punta con Chromium real
```

**Rutas HTTP:** `GET/POST /webhook` (Meta, firma HMAC verificada) · `/panel` (usuario y contraseña) · `/salud` · `/simulacion/*` (solo en modo simulación, con token).

**Desarrollo sin Docker:**
```bash
npm install && npm run build
export DIR_CONFIG=./config-simulacion DIR_SECRETOS=./secretos-simulacion DIR_DATOS=./data-simulacion SIMULACION_TOKEN=token-control-SIMULACION
npm run inicializar -- --simulacion
npm start &          # asistente en :3000
npm run simulador    # WhatsApp :4000 y portal :4100
npm test
```
(Para leer el portal fuera de Docker instala Chromium con `npx playwright-core install chromium` o indica `RUTA_CHROMIUM`.)

**Datos personales:** el sistema maneja nombres, teléfonos y pólizas de los asegurados. Menciona los avisos por WhatsApp en el aviso de privacidad (LFPDPPP), conserva el consentimiento de los clientes y limita el acceso a la Raspberry.
