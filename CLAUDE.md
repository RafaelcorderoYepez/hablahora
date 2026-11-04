# HablaHora — contexto para Claude Code

Plataforma SaaS multitenant con un agente de IA que atiende a los clientes de cada
negocio por chat. A largo plazo: varios canales (web, WhatsApp, voz, app) y varios
servicios (horas, mesas, cupos compartidos, pedidos). Mercado inicial: Chile (dominio
`hablahora.cl`), con la arquitectura lista para EE.UU.; bilingüe español/inglés.

**Este repositorio es solo HablaHora.** Existen otros proyectos del mismo autor con
sus propios repositorios. No traer código, nombres, esquemas ni decisiones de ellos, ni
asumir que comparten algo, salvo que se indique explícitamente.

**Marca:** HablaHora es el producto del autor. Una instalación para un tercero con otra marca
se hace por configuración (colores, logo, nombre), nunca con una copia del código; no se
agregan marcas de terceros al repositorio mientras no exista ese acuerdo.

**Versión en construcción: v1.** Solo reserva de horas individuales, solo canal de
chat web, consola del owner y consola del merchant. El plan, los hitos y lo que
queda fuera están en `docs/PLAN-v1.md`. Trabajar un hito a la vez, en orden, y
marcarlo al terminar. No construir nada que el plan deje para después.

## Decisiones de arquitectura (no cambiar sin hablarlo)

- **Una sola aplicación, separada por capacidad, no por tipo de negocio.**
  Citas y mesas son el mismo motor (recurso + horario + capacidad).
  Pedidos será otro módulo.
- **Monolito modular en TypeScript + PostgreSQL.** Separar servicios solo cuando un módulo lo justifique.
- **Multitenancy con RLS forzado.** Todo acceso pasa por `withTenant()`; la app usa
  un rol sin `BYPASSRLS`. `tenant_id` en todas las tablas.
- **El LLM nunca recibe ni elige tenant, sucursal ni teléfono.** Los arma el webhook
  (`resolve_wa_location` + número que escribe) en `ConversationContext`.
- **La lógica de negocio vive en el backend.** El modelo decide qué hacer; disponibilidad,
  validaciones y totales los calcula el código y se exponen como tools.
- **Sin doble reserva por construcción:** restricción `EXCLUDE` en `booking_resources`.
  `hold_slot` reintenta con el siguiente recurso al capturar `23P01`.
- **Flujo de reserva en el chat:** check_availability → el cliente elige → hold_slot
  (TTL ~5 min) → resumen → confirm_booking solo tras un "sí" explícito.
- **Día de servicio:** un turno que cruza medianoche pertenece al día en que abre.
  El servicio debe terminar antes del cierre (pendiente: "última hora de ingreso").
- **Webhook:** responde 200 de inmediato, procesa en segundo plano, deduplica por
  `wa_message_id`, un mensaje a la vez por conversación (`KeyedQueue`, un proceso).
- **Paso a humano:** `request_human` marca `conversations.handoff`; el agente calla.
- **El agente no afirma acciones que no hizo.** Solo puede decir que apartó, confirmó,
  movió o canceló algo si está en el resultado de una herramienta. Mover una reserva
  es siempre `reschedule_booking` (atómico), nunca cancelar + reservar.
- **Lo que tiene consecuencias vive en el motor, no en las instrucciones:** servicios
  válidos, horarios, quién atiende qué. Las instrucciones guían el tono y el flujo.

## Stack (no agregar ni cambiar librerías sin consultarlo)

Entorno de desarrollo: WSL 2 (Ubuntu), proyecto dentro del disco de Linux, VS Code conectado a WSL.

**Backend**
- TypeScript + Node 22 LTS; monorepo con workspaces de npm.
- Fastify (API REST + Server-Sent Events para el chat).
- PostgreSQL 17 con RLS. Drizzle ORM + drizzle-kit para esquema y migraciones;
  las políticas RLS, la restricción `EXCLUDE` y las funciones `SECURITY DEFINER` van en SQL dentro de las migraciones.
- Zod para validar entradas (esquemas compartidos con el frontend).
- Better Auth (con organizaciones y roles) para usuarios de las consolas.
- pg-boss para tareas en segundo plano (vencer apartados, procesar mensajes, más adelante recordatorios).
- SDK oficial de Anthropic; modelo por defecto Sonnet, configurable por negocio.
- pino para logs (integrado en Fastify).
- Tests: Vitest + Postgres embebido; Playwright para pruebas de punta a punta.

**Frontend** (`apps/console` y `apps/chat`)
- React + Vite + TypeScript.
- TanStack Router + TanStack Query.
- Tailwind CSS + shadcn/ui.
- react-hook-form + Zod.
- Agenda: componente propio (como el de la demo), sin librería de calendario.
- Recharts para métricas.
- Sin Next.js: el backend es aparte y las consolas están detrás de login.

**Desarrollo local:** Postgres 17 en Docker dentro de WSL (`npm run db:up`, contenedor
`hablahora-postgres`, puerto **5433**); los tests no lo necesitan. El 5432 es de otro
proyecto: no tocarlo.
**Hosting:** un contenedor (`Dockerfile`; la API sirve también las dos apps) y Postgres 17
administrado; el proveedor se confirma en H7 parte 2 tras probar roles, RLS y `SECURITY DEFINER`.
Correo: Postmark (por HTTP, `PostmarkEmailSender`). Errores: Sentry (`@sentry/node`, `@sentry/react`).
Archivos estáticos: `@fastify/static`. Pruebas de punta a punta: Playwright (`e2e/`).

## Cómo trabajar

- `npm test` corre unitarios + integración contra un Postgres embebido (no requiere Postgres instalado).
- Los tests de integración usan el rol `app_user` para que RLS aplique de verdad.
- Los tests del agente usan un LLM simulado con guion (`test/support/fake-llm.ts`). Los casos de
  comportamiento (`apps/api/test/integration/agent-behavior.test.ts`) corren contra el seed del
  Salón Aurora y verifican herramientas llamadas (`tool_calls`) y estado de la agenda, no solo el texto.
  Un guion no mide el criterio del modelo real: eso requiere una evaluación con la API.
- Comentarios y textos para el usuario final en español.
- Monorepo: `packages/core` (motor, agente, datos), `packages/db` (migraciones y seed),
  `packages/contracts` (esquemas Zod de entrada y salida de la API, compartidos con las consolas;
  `contracts/browser` tiene lo que usa el navegador sin Zod), `packages/ui` (marca HablaHora:
  colores, fuentes, logo, componentes shadcn/ui; se usa desde el código fuente con Vite),
  `apps/api` (Fastify), `apps/chat` (chat público, React + Vite + Tailwind, puerto 5173),
  `apps/console` (consola del negocio: TanStack Router + Query, react-hook-form, cliente de
  Better Auth, puerto 5174).
  La infraestructura de tests compartida está en `test/support/`.
- Idiomas: español e inglés en todo. Cada conversación guarda su idioma (`conversations.locale`);
  los textos fijos y la interfaz lo usan, y el agente responde en el idioma en que le escriben.
  Todo texto nuevo para el cliente o el usuario va en los dos idiomas.
- Marca (HablaHora, `docs/marca/`): todo lo que la identifica está en cuatro lugares. Colores y
  fuentes en `packages/ui/src/styles.css` (variables neutras `--ui-*`; Pacífico `#0B6B6B`, Mandarina
  `#F08A3C` solo para detalles, neutros Bruma/Tinta; Bricolage Grotesque para títulos y logo, Figtree
  para el resto); logo en `packages/ui/src/logo.tsx` (`BrandMark`, `BrandWordmark`) y en los
  `favicon.svg`; nombre y fondos en `BRAND` (`contracts/browser`), que usan los correos. Nunca hex
  sueltos en componentes. El color de cada negocio es `accent` (paleta por defecto: Pacífico); el
  contraste se valida en `contracts`. `.light` / `.dark` fijan un modo dentro de la página (vistas previas).
- Chat activo (`locations.chat_enabled`): apagado, el chat público responde 409 y muestra "no
  disponible". Solo se enciende con lo mínimo (servicio con profesional, horario, enlace).
- Agente: tono (`agent_tone`), lo que debe saber (`agent_instructions` + `_en`) y cuándo pasar con
  una persona (`agent_handoff` + `_en`); servicios con `name_en`/`description_en` opcionales.
- **El `system` del agente no cambia dentro de una conversación** (`AgentRunner.systemPrompt`). Lo que
  cambia (fecha y hora, idioma, si el cliente dejó sus datos) va como mensaje `role: "system"` que se
  agrega y se guarda (`contextMessage`, autor `system`); el historial solo crece, nunca se edita. La
  API liga cada bloque de pensamiento a todo lo anterior y rechaza (400) uno reenviado si algo cambió.
  Red de seguridad: `prefix_mismatch_behavior: "drop_block"` (beta `thinking-binding-controls-2026-08-01`
  en `main.ts`); un descarte se reporta como error. Haiku 5.5 no acepta mensajes de sistema: `forModel`
  los pasa como `<contexto>` al final del mensaje del cliente. El LLM simulado de los tests firma sus
  bloques de pensamiento y aplica la misma comprobación.
- Errores de negocio de la API: `{ error, reason, message }`; las consolas traducen `reason`.
- Endpoints del merchant (`/api/merchant/*`, `apps/api/src/routes/merchant.ts`): la API autentica,
  valida con `contracts` y llama a `core/src/merchant/*` dentro de `withTenant()`. Leen todos los
  miembros; escriben solo merchant_admin y solo desde un origen de confianza, salvo las rutas con
  `config: { staffCanWrite: true }` (reservas), que también usa merchant_staff. Una sucursal por
  negocio en la API de la v1.
- Reservas desde la consola (`BookingService.staff*`): sin anticipación mínima ni plazo de
  cancelación, pero nunca en el pasado ni encima de otra (la `EXCLUDE` sigue mandando). Fuera de
  horario solo con `outsideHours`. Mover es atómico (nueva reserva + la anterior cancelada, o nada).
  `booking_events.actor = 'staff:<id del usuario>'`. Al confirmar, mover o cancelar se avisa al
  cliente por email en su idioma (`bookingNoticeEmail`), si tiene.
- Paso a humano en la consola (`core/src/merchant/inbox.ts`): el equipo responde solo con
  `handoff` activo (mensaje `role: assistant`, `author: staff`, `author_user_id`), toma o devuelve.
  Al devolverla, el agente ve esas respuestas marcadas con `[Persona del equipo]` (`loadHistory`).
  Al pasar al equipo, correo a los administradores (`apps/api/src/handoff-notify.ts`, vía `onHandoff`).
  El costo del modelo no se muestra al negocio (es de la consola del owner).
- Plataforma (`core/src/platform/*`, `apps/api/src/routes/platform.ts`, consola en `/plataforma`):
  `plans`, `platform_settings` y las columnas de estado, plan y modelo de `tenants` no tienen RLS
  (no son datos de un negocio). Lo que se lee de cada negocio pasa por su propio `withTenant()`; la
  plataforma no tiene accesos que se salten RLS. Estado del negocio: `suspended` = chat cerrado y
  consola en solo lectura; `closed` = además sin acceso a la consola. Límites del plan en el motor
  (profesionales activos en `merchant/config.ts`, conversaciones del mes en `web/chat.ts`, aviso del
  80 % por `onUsageWarning`). Modelo del agente: el del negocio, si no el de la plataforma, si no
  `CLAUDE_MODEL` (`AgentSettings.model`).
- Operación de la plataforma (`core/src/platform/operations.ts`, `support.ts`): panel, uso y salud se
  calculan recorriendo los negocios con su propio `withTenant()`. Soporte es solo lectura, siempre con
  motivo, por POST (el motivo no va en la URL) y cada acceso queda en `support_access_log` (sin RLS;
  el negocio no lo ve). Los cambios de usuarios de la organización (invitar, rol, quitar, renombrar)
  se bloquean en los hooks de Better Auth según `tenants.status`, que `auth_user` lee con la función
  `organization_status()`; aceptar una invitación solo se bloquea si el negocio está dado de baja.
- Métricas (`core/src/merchant/metrics.ts`): reservas por fecha de la cita; ocupación = minutos de
  atención reservados sobre minutos de horario (con `dayWindows`). Recharts con `react-is` forzado a la
  versión de React (`overrides` en el `package.json` raíz). Horas y fechas siempre en hora local del negocio.
- Cada cambio de esquema es una migración nueva en `packages/db/migrations/`
  (`npm run db:new -- <nombre>`, SQL a mano; nunca editar una migración ya aplicada)
  y se refleja en los fixtures de `test/support/fixtures.ts`. Las funciones nuevas
  necesitan su `GRANT EXECUTE ... TO app_user` en la misma migración.
- Scripts: `npm run dev`, `build`, `typecheck`, `test`, `db:up`, `db:down`, `db:migrate`, `db:seed`, `db:psql`.
  Alta de un negocio nuevo: consola de la plataforma (`/plataforma`) o
  `npm run business:create -w @hablahora/api -- "<negocio>" <email> "<nombre>" [--pais CL|US] [--en] [--tz <zona>] [--plantilla <rubro>]`.
- País y moneda (`tenants.country`, `tenants.currency`; `COUNTRIES` en `contracts/browser`): se eligen en
  el alta (Chile por defecto) y no se cambian después. El país pone la zona horaria y el idioma por
  defecto, completa los teléfonos sin prefijo (`normalizePhone(número, país)`: Chile +56 con 9 dígitos,
  EE.UU. +1 con 10; con "+" se acepta cualquiera) y llega a las instrucciones fijas del agente (español de
  Chile, precios en su moneda). `services.price` va en la unidad mínima de la moneda (pesos o centavos);
  se muestra con `formatMoney` (el formato sigue a la moneda, no al idioma: `$18.000`, `$18.50`) y se lee
  con `parseMoney`. El costo del modelo en la plataforma es siempre `US$`.
- Negocio de ejemplo: `npm run db:seed` (re)crea el Salón Aurora en Santiago, con precios en pesos
  (`packages/db/src/seed/salon-aurora.ts`,
  chat en `/api/chat/salon-aurora`) y sus usuarios de desarrollo (contraseña `aurora-dev-2026`):
  `admin@hablahora.test` (plataforma), `valeria@salon-aurora.test` (merchant_admin),
  `camila@salon-aurora.test` (merchant_staff). Solo borra datos de ese negocio.
- Usuarios de las consolas: Better Auth (`apps/api/src/auth.ts`), tablas en el esquema `auth` con el
  rol `auth_user`; `app_user` no las ve. Cada negocio es una organización (`tenants.auth_organization_id`).
  Roles: `user.role = "admin"` → platform_admin; miembro owner/admin → merchant_admin; member →
  merchant_staff (`apps/api/src/identity.ts`). Sin registro abierto: solo con invitación pendiente.
- Correos: interfaz `EmailSender`; en desarrollo `LogEmailSender` los escribe en el log del servidor
  (ahí se leen los códigos del chat y los enlaces); en producción, `PostmarkEmailSender`.
- Producción (`apps/api/src/config.ts`, `static.ts`, `monitoring.ts`): la configuración se valida al
  arrancar. La API sirve la consola y el chat según el `Host` (`CONSOLE_URL`, `CHAT_PUBLIC_URL`); las
  rutas del cliente devuelven `index.html`. Cabeceras de seguridad y CSP en `securityHeaders()`.
  Los caminos reservados del dominio del chat no pueden ser el enlace de un negocio (`RESERVED_SLUGS`).
- Logo del negocio en `location_logos` (bytea, ≤ 256 KB, PNG/JPEG/WebP validados por sus primeros
  bytes, nunca SVG); URL con versión (`?v=`) y caché larga. Aviso de privacidad del chat en
  `platform_settings` (lo escribe la plataforma; sin texto no hay enlace).

## Referencia de comportamiento

La demo "Salón Aurora" (chat + traza de herramientas + agenda) es la referencia de cómo
debe comportarse el agente y de cómo se ve la traza en la consola. Casos ya probados a
mano que deben quedar como tests: reservar, mover de día, cancelar, pedir algo ajeno al
negocio (vuelos), un servicio que no existe, horarios imposibles, apartado vencido.

## Ideas para después de la v1

Están en `docs/ROADMAP.md` (versiones v2 en adelante: WhatsApp y recordatorios, mesas, pedidos,
integración con POS, voz, app). No se construye nada de ahí antes de terminar la v1 y su piloto.
Pendientes sueltos de WhatsApp: primera prueba real con el número de prueba de Meta y verificar la
versión vigente de la Graph API (`WA_GRAPH_VERSION`, default v23.0).
