# Plan de la versión 1

HablaHora: plataforma SaaS multitenant con un agente de IA que agenda horas por chat.
Primer mercado: Chile (`hablahora.cl`); la arquitectura sigue lista para EE.UU.
Este documento es la guía de construcción para las sesiones de Claude Code:
cada hito se trabaja en una sesión (o en pocas) y se marca al terminar.

## Alcance de la v1

**Entra:**
- Reserva de **horas individuales**: un cliente, un servicio, un profesional
  (salones, barberías, clínicas, estética, consultas).
- **Canal de chat web**: una página pública por negocio donde el cliente escribe
  y el agente le agenda, mueve o cancela horas.
- **Consola del dueño del SaaS** (owner): configuración y operación de la plataforma.
- **Consola del negocio** (merchant): configuración y monitoreo de su negocio.

**Queda para después** (el diseño no debe impedirlo, pero no se construye):
- Canales: WhatsApp (ya hay código, se deja apagado), voz, app móvil, otros.
- Servicios: mesas de restaurante, servicios compartidos (clases, cupos), pedidos.
- Pagos y abonos, recordatorios automáticos, integraciones (POS, Google Calendar).

El orden y el alcance de lo que viene después están en `docs/ROADMAP.md`.

## Roles

| Rol | Quién es | Qué hace |
|---|---|---|
| `platform_admin` | Dueño del SaaS y su equipo | Da de alta negocios, define planes y límites, ve la operación de todos |
| `merchant_admin` | Dueño o administrador de un negocio | Configura su negocio, ve su agenda, conversaciones y métricas |
| `merchant_staff` | Profesional o recepción del negocio | Ve la agenda y atiende conversaciones en paso a humano |
| Cliente final | Quien pide la hora | Usa el chat público; no tiene cuenta |

## Arquitectura

Monorepo con workspaces de npm. Un solo backend; dos aplicaciones web.

```
packages/
  core/        motor de reservas, agente, herramientas, acceso a datos (lo que ya existe)
  db/          migraciones y seeds
apps/
  api/         Fastify: API REST + streaming del chat (SSE) + autenticación
  console/     React: consola del owner y del merchant (misma app, menú según rol)
  chat/        React: chat público del cliente, liviano y sin login
```

Por qué así:
- **Owner y merchant comparten app**: usan los mismos componentes (agenda, tablas,
  formularios de configuración, visor de conversaciones). Lo que ven depende del rol.
- **El chat público va aparte**: lo abren miles de personas sin cuenta, tiene que
  cargar rápido y no debe llevar código de administración.
- **Un solo backend**: toda la lógica de negocio sigue en `core`; la API solo
  autentica, valida y llama a `core`.

## Cambios al núcleo que pide la v1

1. **Conversaciones independientes del canal.** Hoy `conversations` se identifica por
   teléfono de WhatsApp. Pasa a `(channel, external_id)`: en el chat web, el
   `external_id` es una sesión anónima; el teléfono o email del cliente se pide en
   el chat antes de reservar y se guarda en `customers`.
2. **Adaptador de canal web** junto al de WhatsApp: recibe el mensaje por la API,
   usa el mismo `AgentRunner` y devuelve la respuesta por SSE (texto en streaming).
3. **Registro de uso del modelo** por negocio: tokens de entrada y salida, costo
   estimado, duración y errores por mensaje (tabla `llm_usage`). Lo necesitan las
   dos consolas.
4. **Traza de herramientas consultable**: cada llamada a herramienta con su entrada,
   resultado y duración, para mostrarla en la consola como en la demo del Salón Aurora.
5. **Usuarios y roles** (`users`, `memberships` con `tenant_id` y rol) y RLS para
   que un `merchant_*` solo vea su negocio.
6. **Migraciones versionadas** en lugar de un único `schema.sql`.
7. **Regla en las instrucciones del agente**: no afirmar ninguna acción que no
   aparezca en el resultado de una herramienta (aprendido en la demo).
8. **v1 solo con horas individuales**: `resource_kind = 'staff'`, `party_size = 1`.
   Las columnas de mesas se quedan en el esquema pero la API y la UI no las exponen.

## Consolas: qué pantallas lleva cada una

### Merchant: configuración
- Datos del negocio: nombre, dirección, zona horaria, idioma, logo.
- Servicios: nombre, descripción, duración, precio, tiempo de limpieza, quién lo hace.
- Equipo: profesionales, servicios que hacen, horario semanal de cada uno.
- Horario del local y excepciones (feriados, vacaciones, cierres).
- Políticas: anticipación mínima, días máximos hacia adelante, plazo para cancelar,
  confirmación automática o manual.
- Agente: tono, información que debe saber (preguntas frecuentes), qué derivar a una persona.
- Canal web: enlace público del chat y código para incrustarlo en su sitio.
- Usuarios del negocio e invitaciones.

### Merchant: monitoreo
- Agenda por día y por profesional (crear, mover y cancelar a mano también).
- Lista de reservas con filtros y origen (chat o manual).
- Conversaciones: transcripción y traza de herramientas.
- Bandeja de paso a humano: responder desde la consola y devolver al agente.
- Métricas: reservas por día, conversión (conversaciones → reservas), cancelaciones,
  horas más pedidas.

### Owner: configuración
- Alta, suspensión y baja de negocios; plantillas por rubro (salón, clínica...).
- Planes y límites (mensajes por mes, profesionales, sucursales).
- Configuración global del agente: modelo por defecto, instrucciones base, límites.
- Usuarios de la plataforma.

### Owner: operación y monitoreo
- Panel general: negocios activos, conversaciones, reservas y errores por día.
- Uso y costo del modelo por negocio (contra el plan).
- Salud: latencia del agente, errores de herramientas, conversaciones en paso a humano sin atender.
- Visor de conversaciones de cualquier negocio (para soporte), con registro de acceso.

## Hitos

Cada hito termina con tests en verde y algo que se puede probar a mano.

- [x] **H0. Reorganizar el repositorio.** Monorepo (`packages/core`, `packages/db`,
  `apps/api`), migraciones, scripts `dev`/`test`/`build`, Postgres local para desarrollo,
  GitHub Actions corriendo los tests. Ningún cambio de comportamiento.
- [x] **H1. Núcleo v1.** Conversaciones por canal, adaptador web, `llm_usage`, traza
  consultable, regla de "no afirmar acciones", seed de un negocio de ejemplo.
  Tests de los casos probados en la demo: reservar, mover, cancelar, vuelos, servicio
  inexistente, horarios imposibles, apartado vencido.
  - [x] Parte 1: conversaciones por canal, adaptador web con SSE, `llm_usage`, traza
    consultable, regla de "no afirmar acciones" (WhatsApp apagado pero funcionando).
  - [x] Parte 2: seed del Salón Aurora, tests de comportamiento con el modelo simulado, aviso de
    error sin promesas, `max_tokens` 4096 y `CLAUDE_EFFORT` opcional.
- [x] **H2. API y autenticación.** Login, roles y membresías, endpoints de configuración
  y de lectura del merchant, endpoint público de chat con SSE y límite de mensajes por sesión.
  - [x] Parte 1: Better Auth y roles, identificación del cliente con código por email, límites
    del chat (mensajes por sesión, sesiones por IP), chat movido a `/api/chat`.
  - [x] Parte 2: endpoints de configuración y de lectura del merchant, esquemas compartidos en
    `packages/contracts`, descripción por servicio.
- [x] **H3. Chat público.** App `chat` contra la API con el negocio de ejemplo. Al terminar
  este hito se puede reservar de verdad, de punta a punta, desde el navegador.
- [x] **H4. Consola del merchant: configuración.** Reemplaza el seed: un negocio nuevo
  se configura entero desde la consola y queda listo para atender por el chat.
  - [x] Parte 1: app `apps/console` (ingreso, contraseñas, invitaciones, elegir negocio), consola en
    español e inglés por usuario, usuarios del negocio, checklist de lo que falta, alta de negocios
    por script (`npm run business:create`).
  - [x] Parte 2: pantallas de configuración (negocio, servicios, equipo, horario, políticas, agente
    en tres partes con versión en inglés, chat web con interruptor, estilo y código para incrustar
    `embed.js`).
- [x] **H5. Consola del merchant: monitoreo.** Agenda, reservas, conversaciones con traza,
  bandeja de paso a humano, métricas.
  - [x] Parte 1: agenda del día por profesional (horario sombreado, reservas por estado, un
    profesional a la vez en el teléfono), listado de reservas con filtros y búsqueda, acciones del
    equipo (crear con cliente existente o nuevo, confirmar, mover, cancelar, atendida / no vino;
    fuera de horario solo si se marca), también para el staff; aviso por email al cliente en su
    idioma; reservas por confirmar en el inicio.
  - [x] Parte 2:
    - [x] 2a: conversaciones con traza, bandeja de paso a humano (responder, tomar, devolver al
      agente; contador y correo a los administradores), chat público que recibe las respuestas del
      equipo.
    - [x] 2b: métricas (Recharts: reservas por día y estado, chat, origen, servicios, ocupación del
      equipo) y mover arrastrando en la agenda (con confirmación).
- [x] **H6. Consola del owner.** Alta de negocios, planes, uso y costo, salud.
  - [x] Parte 1: negocios (alta con plantilla por rubro, suspender, reactivar, dar de baja), planes y
    límites aplicados en el motor (profesionales activos; conversaciones del mes con aviso al 80 % y
    cierre de nuevas al 100 %), modelo del agente por negocio y por defecto, usuarios de la plataforma.
  - [x] Parte 2: panel general, uso y costo por negocio, salud (latencia, errores, paso a humano sin
    atender) y visor de conversaciones para soporte con registro de acceso; los cambios de usuarios
    de un negocio suspendido o dado de baja se bloquean en Better Auth.
- [x] **H7a. Marca HablaHora y Chile.** El producto pasa a llamarse HablaHora (repositorio propio,
  dominio `hablahora.cl`) y el primer piloto es en Chile.
  - [x] Parte 1: identidad de marca (colores, fuentes, logo provisorio, voz) aplicada a las consolas, el
    chat y los correos; todo lo que identifica la marca en cuatro lugares (`styles.css`, `logo.tsx`,
    favicons, `BRAND`) para que otra marca sea solo configuración; nombres internos `@hablahora/*`.
  - [x] Parte 2: ajustes para Chile. País y moneda por negocio (CLP sin decimales, USD con centavos;
    precios en la unidad mínima de cada moneda y formateados con `Intl.NumberFormat` en la consola, los
    correos y lo que recibe el agente); teléfonos según el país del negocio (+56); `America/Santiago`
    por defecto en el alta; textos en español de Chile; el costo del modelo en la plataforma siempre
    como `US$`; Salón Aurora como negocio chileno de ejemplo.
  - [x] Parte 3: repositorio nuevo `hablahora` (historial anterior respaldado en un bundle y archivado).
  - [x] Parte 4: fondo del chat configurable por el negocio: fondo teñido con su color (un interruptor)
    y texturas curadas probadas en claro y oscuro. Una imagen propia queda para cuando un cliente la pida.
- [ ] **H7. Despliegue y piloto.** Ambiente de staging, dominio, copias de seguridad,
  monitoreo de errores; un negocio piloto real.
  - [x] Parte 1: código listo para producción. Configuración validada al arrancar, Dockerfile, la API
    sirve la consola y el chat por dominio (`@fastify/static`), cabeceras de seguridad y CSP,
    `trustProxy`, correo por Postmark, errores a Sentry (API y apps), logo del negocio en su chat,
    aviso de privacidad del chat y pruebas de punta a punta con Playwright (en CI).
  - [ ] Parte 2: staging (hosting, dominio, correo verificado, copias con prueba de restauración,
    monitor de disponibilidad).
  - [ ] Parte 3: producción y negocio piloto.

El orden pone el chat (H3) antes que las consolas a propósito: es la forma más rápida
de tener el producto funcionando de punta a punta, y las consolas se construyen
viendo datos reales en lugar de imaginarlos.

## Decisiones pendientes (resolver antes del hito que las necesita)

- ~~**H0:** Postgres de desarrollo~~ → resuelto: `postgres:17` con Docker Engine dentro de WSL
  (`compose.yaml`, puerto 5433). Migraciones con drizzle-kit (SQL a mano).
- ~~**H2:** Autenticación~~ → resuelto: Better Auth (email y contraseña, plugins organization y admin),
  tablas en el esquema `auth` con su propio rol de base (`auth_user`). Sin registro abierto: cuentas
  por invitación; administradores de plataforma por script.
- ~~**H2:** Identificación del cliente en el chat web~~ → resuelto: para reservar, nombre + teléfono +
  email, sin código. Para ver, mover o cancelar reservas hechas en otra sesión, código de 6 dígitos
  al correo (vence en 10 min, 5 intentos, 3 envíos por hora por sesión y por email).
- ~~**H7:** Proveedor de correo~~ → resuelto: Postmark por HTTP (`PostmarkEmailSender`); en
  desarrollo, `LogEmailSender`.
- **Tareas en segundo plano:** para el piloto (una instancia) basta `setInterval` para vencer apartados;
  pg-boss cuando lleguen los recordatorios o haga falta más de una instancia.
- ~~**H3:** Librería de componentes y estilo visual~~ → resuelto: Tailwind + shadcn/ui en un paquete
  de marca compartido (`packages/ui`). Marca HablaHora (H7a, `docs/marca/identidad.html`): Pacífico
  `#0B6B6B`, Mandarina `#F08A3C` para detalles, neutros Bruma `#F3F6F5` y Tinta `#13282B` (más modo
  oscuro), Bricolage Grotesque para títulos y Figtree para el resto, logo provisorio (globo de
  conversación con un reloj) en `docs/marca/hablahora-icon.svg`. Cada negocio elige la paleta de su chat
  (curada o color propio con contraste validado) y modo claro/oscuro/automático; su logo (PNG, JPEG o WebP), desde H7.
- ~~**Idiomas**~~ → resuelto: español e inglés en todo.
  - H3: la conversación guarda su idioma (navegador + selector ES/EN en el chat; WhatsApp usa el del
    negocio). Textos fijos, correos al cliente e interfaz del chat en ese idioma; el agente responde
    en el idioma en que le escriben.
  - H4: consolas en los dos idiomas según cada usuario, correos de las consolas en su idioma, y
    campos opcionales en inglés para servicios (nombre, descripción) e instrucciones del agente;
    si faltan, el agente traduce.
- **H7:** Hosting → recomendado un contenedor y Postgres 17 administrados en el este de EE. UU. (p. ej.
  Render), a confirmar en la parte 2 tras probar roles, RLS y `SECURITY DEFINER` en su Postgres.
