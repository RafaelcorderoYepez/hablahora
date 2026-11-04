# HablaHora

Agente multitenant para reservas por chat (web y WhatsApp): canales de entrada,
loop del agente con Claude, servicio transaccional de reservas sobre PostgreSQL y cálculo de horarios.

```bash
npm install
npm test             # 202 tests: unitarios + integración contra un Postgres real embebido

# desarrollo (WSL + Docker)
cp .env.example .env
npm run db:up        # Postgres 17 en Docker, puerto 5433
npm run db:migrate   # aplica packages/db/migrations
npm run db:seed      # negocio de ejemplo: Salón Aurora
npm run dev          # API :3000, chat http://localhost:5173/salon-aurora, consola http://localhost:5174
```

## Probar a mano

Con `ANTHROPIC_API_KEY` en `.env` (opcional: `CLAUDE_EFFORT=low|medium|high`), `npm run dev` y abrir
**http://localhost:5173/salon-aurora** en el navegador. El chat detecta el idioma del navegador
(selector ES/EN arriba), recuerda la conversación al recargar y el ícono del lápiz abre una nueva.
Los correos (códigos para gestionar reservas de otra sesión) aparecen en la consola del servidor.

Sin navegador, con `curl`:

```bash
SESSION=$(curl -s -X POST localhost:3000/api/chat/salon-aurora/sessions | sed -E 's/.*"sessionId":"([^"]+)".*/\1/')
curl -N -X POST localhost:3000/api/chat/salon-aurora/sessions/$SESSION/messages \
     -H 'content-type: application/json' -d '{"text":"Hola, ¿tienen hora para corte el miércoles?"}'
```

La respuesta llega por SSE. El uso y la traza quedan en `llm_usage` y `tool_calls` (`npm run db:psql`).
El Salón Aurora abre de martes a sábado de 9:00 a 19:00 (America/New_York), con Valeria, Camila
y Diego; servicios: corte de mujer y de hombre, color, peinado y manicure.

## Flujo de un mensaje de WhatsApp

```
Meta ──POST /webhook──► firma HMAC ──► 200 inmediato
                                  │
                                  ▼ (segundo plano)
        resolve_wa_location(phone_number_id) → tenant y sucursal
        wa_inbound_events  → descarta reintentos de Meta
        conversations      → un hilo por cliente y sucursal
        KeyedQueue         → un mensaje a la vez por conversación
                                  │
                                  ▼
        AgentRunner: historial + system prompt del negocio + tools
            Claude ⇄ tools (check_availability, hold_slot, confirm_booking, ...)
            cada mensaje y resultado se guarda en conversation_messages
                                  │
                                  ▼
        GraphWhatsAppSender → respuesta al cliente
```

## Estructura

Monorepo con workspaces de npm.

```
packages/core/src/            motor de reservas, agente y acceso a datos
  web/chat.ts                 canal de chat web: sesión anónima por slug, respuesta como eventos
  whatsapp/webhook.ts         firma, parseo de la Cloud API, corte de mensajes largos
  whatsapp/sender.ts          envío por la Graph API
  whatsapp/inbound.ts         pipeline de un mensaje entrante
  agent/runner.ts             loop del agente, system prompt, request_human
  agent/conversations.ts      historial y su normalización
  agent/tools.ts              tools de reservas para el LLM (+ save_customer_contact en la web)
  agent/trace.ts              registro de llm_usage y tool_calls; getConversationTrace para las consolas
  agent/pricing.ts            precios por modelo para estimar el costo de cada llamada
  booking/service.ts          BookingService (hold, confirmar, reprogramar, cancelar)
  slots.ts                    cálculo de horarios (función pura)
packages/db/migrations/       esquema con RLS, en migraciones SQL (drizzle-kit)
packages/db/src/              migrate(): aplica las migraciones pendientes
apps/chat/                    chat público (React + Vite): una página por negocio, /{slug}
packages/ui/                  marca HablaHora: colores claro/oscuro, fuentes, logo, componentes
packages/contracts/           esquemas Zod compartidos (contracts/browser: sin Zod, para el navegador)
docs/marca/                   identidad de HablaHora (identidad.html) e ícono en vectorial
apps/api/src/server.ts        Fastify: /health y los canales activos
apps/api/src/routes/          web-chat.ts (sesiones + mensajes por SSE), whatsapp.ts (/webhook)
apps/api/src/main.ts          arranque: variables de entorno, pool, cliente de Claude, job de holds
test/support/                 Postgres embebido, fixtures y payloads compartidos por los tests
compose.yaml                  Postgres de desarrollo
```

## Base de datos

- **Migraciones:** `npm run db:new -- <nombre>` crea un SQL vacío en `packages/db/migrations/`;
  `npm run db:migrate` aplica las pendientes con `DATABASE_ADMIN_URL` (dueño del esquema).
  Los tests aplican las mismas migraciones sobre el Postgres embebido.
- **Rol de la app:** `app_user`, sin `BYPASSRLS`. La migración base lo crea sin login si no existe
  y le da los permisos; cada entorno le pone LOGIN y contraseña (en Docker lo hace
  `docker/postgres/init/`, en los tests `test/support/global-setup.ts`).
- **Desarrollo:** contenedor `hablahora-postgres` (`postgres:17`) en `127.0.0.1:5433`, volumen
  `hablahora-pgdata`. `npm run db:psql` abre una consola; `npm run db:down` lo detiene sin borrar datos.

## Chat web

```
GET  /api/chat/:slug                                → nombre, idioma, color, apariencia, bienvenida
POST /api/chat/:slug/sessions  { locale? }          → 201 { sessionId, locale }   (429 si la IP abrió demasiadas)
GET  /api/chat/:slug/sessions/:sessionId/messages   → transcripción visible (para retomar al recargar)
POST /api/chat/:slug/sessions/:sessionId/messages   { text, locale? } → text/event-stream (429 al llegar al límite)
     event: text     { text }    fragmento de la respuesta
     event: tool     { name }    el agente usa una herramienta (sin entradas)
     event: handoff  {}          pasó a una persona
     event: error    { message }
     event: done     {}
```

El negocio sale del slug (`locations.web_chat_slug`, función `resolve_web_location`) y el cliente
es una sesión anónima. Para reservar, el agente pide nombre, teléfono y email (sin código) y los
guarda con `save_customer_contact`; si falta alguno, `hold_slot` devuelve `customer_contact_required`
con los datos que faltan (`missing`). Desde una conversación solo se ven las
reservas hechas en ella; para ver, mover o cancelar otras, el agente manda un código de 6 dígitos al
correo (`request_email_code` / `verify_email_code`) y, verificado, la sesión ve todas las reservas del
negocio con ese email.
WhatsApp queda apagado salvo que estén sus variables de entorno.

## Consola del negocio

**http://localhost:5174** (con `npm run dev`). Ingresa con un usuario de desarrollo (abajo). Un negocio
se configura entero desde aquí: negocio, servicios (con versión en inglés), equipo y su horario,
horario del local y cierres, políticas, agente (tono, lo que debe saber, cuándo pasar con una
persona), chat web (activarlo, enlace, estilo con vista previa y código para incrustar) y usuarios.
El inicio muestra lo que falta para que el chat atienda y las reservas por confirmar. Idioma por
usuario (menú de arriba).

**Agenda** (`/agenda`): el día en columnas por profesional, con su horario (lo de fuera, sombreado)
y las reservas por estado. Clic en una reserva: confirmar, atendida / no vino, mover (a una hora libre
o, marcándolo, fuera de horario) o cancelar con motivo. En la computadora también se mueve arrastrando
la reserva a otra hora o profesional (pide confirmación y avisa si queda fuera de horario). Clic en un
hueco o en "Nueva reserva": reserva hecha por el equipo, con un cliente existente o nuevo. En el
teléfono, un profesional a la vez.
**Reservas** (`/reservas`): listado por fechas, estado, profesional y búsqueda por cliente. El staff
también opera reservas; la configuración la cambia solo el administrador. Cuando el negocio confirma,
mueve o cancela, el cliente recibe un correo en su idioma (si dejó email).
**Conversaciones** (`/conversaciones`): lo que hablaron los clientes con el agente y con el equipo,
con la traza (herramientas, qué recibieron y qué devolvieron) y las reservas que salieron de cada una.
Cuando el agente pasa una conversación al equipo, el menú muestra el contador y los administradores
reciben un correo; desde la conversación se responde (el cliente lo ve en su chat, que consulta cada
5 s mientras el equipo atiende), se toma una que atiende el agente o se devuelve al agente.
**Métricas** (`/metricas`, Recharts): últimos 7, 30 o 90 días; reservas por día y estado, cancelaciones
y ausencias, conversaciones que terminan en reserva, paso al equipo y su tiempo de respuesta, origen,
servicios más reservados y ocupación de cada profesional. Sin costos del modelo (son de la plataforma).

Chat en el sitio del negocio (lo copia desde Chat web):

```html
<script src="http://localhost:5173/embed.js" data-slug="salon-aurora" async></script>
```

Negocio nuevo, de punta a punta:

```bash
npm run business:create -w @hablahora/api -- "Barbería Norte" marta@ejemplo.com "Marta" --plantilla barberia  # Chile por defecto; --pais US para EE.UU.
# en el log: el correo de bienvenida con el enlace para crear la contraseña → abrirlo
```

## Consola de la plataforma

Con `admin@hablahora.test`, la consola abre en **/plataforma**:

- **Panel**: negocios por estado y, por día (UTC) y período de 7, 30 o 90 días, conversaciones,
  reservas creadas y errores (llamadas al modelo y herramientas que fallaron).
- **Uso y costo**: por mes y por negocio, conversaciones contra el plan, llamadas, tokens y costo
  estimado del modelo (total y por conversación); avisa de las llamadas de un modelo sin precio conocido.
  El mes se mide en la zona horaria de cada negocio.
- **Salud** (últimos 7 días): latencia del agente (mediana y p95), errores del modelo y de herramientas,
  qué herramientas fallan y conversaciones que pasaron al equipo hace más de 15 min sin respuesta.
- **Soporte**: ver las conversaciones de cualquier negocio, con su traza, en solo lectura. Sin un motivo
  (mínimo 5 caracteres) no se entra, y cada acceso queda en el registro (quién, cuándo, qué negocio, qué
  conversación y por qué). El registro solo lo ve la plataforma.
- **Negocios**: estado, plan y uso del mes (conversaciones y profesionales contra el plan). Alta con
  plantilla por rubro (salón, barbería, clínica, estética: servicios de ejemplo, horario típico y el
  dueño como profesional; el dueño recibe el correo para crear su contraseña). Modelo del agente por
  negocio. **Suspender** (chat cerrado, consola del negocio en solo lectura), **reactivar** y **dar de
  baja** (sin acceso a la consola; los datos se conservan).
- **Planes**: conversaciones del agente por mes y profesionales activos (vacío = sin límite); sucursales
  se guarda para después. Se aplican en el motor: no deja activar más profesionales que el plan; al 80 %
  de las conversaciones del mes avisa por correo al negocio y a la plataforma, y al 100 % el chat no abre
  conversaciones nuevas (las abiertas siguen). Los planes no cobran: en la v1 no hay pagos.
- **Configuración**: modelo por defecto del agente (sin elegir, el de `CLAUDE_MODEL`). Las instrucciones
  base del agente están en el código y sus tests.
- **Usuarios**: invitar y quitar administradores de la plataforma.

## Usuarios de las consolas

Better Auth en `/api/auth/*` (email y contraseña, cookie de sesión). Cada negocio es una organización:

| Rol | En Better Auth | Usuario de desarrollo (`npm run db:seed`) |
|---|---|---|
| platform_admin | `user.role = "admin"` | `admin@hablahora.test` |
| merchant_admin | miembro `owner` / `admin` | `valeria@salon-aurora.test` |
| merchant_staff | miembro `member` | `camila@salon-aurora.test` |

Contraseña de desarrollo: `aurora-dev-2026`. `GET /api/me` devuelve el usuario, si es administrador de
plataforma y su negocio activo con su rol. No hay registro abierto: una cuenta solo se crea con una
invitación pendiente (`/api/auth/organization/invite-member`). Administradores de plataforma:
`ADMIN_PASSWORD=... npm run auth:create-admin -w @hablahora/api -- <email> "<nombre>"`.
Los correos (invitaciones, recuperar contraseña, códigos del chat) van al log del servidor en
desarrollo y por Postmark en producción.

```bash
curl -c /tmp/hablahora.txt -X POST localhost:3000/api/auth/sign-in/email -H 'origin: http://localhost:3000' \
     -H 'content-type: application/json' -d '{"email":"valeria@salon-aurora.test","password":"aurora-dev-2026"}'
curl -b /tmp/hablahora.txt localhost:3000/api/me
```

## Consola del merchant (API)

Con sesión de un miembro del negocio. Leen todos; la configuración la cambia solo `merchant_admin` y
las reservas también `merchant_staff`; toda escritura, solo desde un origen de confianza (`TRUSTED_ORIGINS`). Entradas y salidas definidas en `packages/contracts`
(Zod); horas y fechas en la hora local del negocio. Errores: `{ error, message, issues? }`.

| Endpoint | |
|---|---|
| `GET`/`PATCH /api/merchant/business` | nombre, sucursal, dirección, zona horaria, idioma, instrucciones del agente, slug del chat |
| `GET`/`POST /api/merchant/services`, `PATCH /…/:id` | servicios (se desactivan, no se borran); un servicio activo necesita un profesional activo |
| `GET`/`POST /api/merchant/staff`, `PATCH /…/:id`, `PUT /…/:id/schedule` | equipo, servicios que hace y horario propio (`null` = el del local) |
| `GET`/`PUT /api/merchant/hours` | horario semanal del local (se reemplaza entero) |
| `GET`/`POST /api/merchant/closures`, `DELETE /…/:id` | cierres por días completos, del local o de un profesional |
| `GET`/`PUT /api/merchant/policies` | grilla, anticipación, días hacia adelante, plazo para cancelar, confirmación automática |
| `GET /api/merchant/web-chat` | slug y enlace público del chat (`CHAT_PUBLIC_URL`) |
| `GET /api/merchant/bookings?from&to&status&staffId&source&q` | reservas por fechas locales (hasta 62 días); `q` busca por nombre, teléfono o email |
| `GET /api/merchant/agenda?date` | el día: horario del local y de cada profesional y reservas vigentes, en minutos desde la medianoche |
| `GET /api/merchant/availability?serviceId&date&staffId&bookingId` | horas libres para el equipo (sin anticipación mínima; `bookingId` cuenta su horario como libre) |
| `GET /api/merchant/customers?q` | clientes por nombre, teléfono o email (hasta 10) |
| `POST /api/merchant/bookings` | reserva del equipo, confirmada; cliente `{ id }` o `{ name, phone?, email? }`; `outsideHours` para fuera de horario |
| `POST /api/merchant/bookings/:id/confirm` · `/reschedule` · `/cancel` · `/status` | confirmar, mover (atómico), cancelar sin plazo, atendida / no vino (desde la hora de inicio) |
| `GET /api/merchant/handoff/count` | conversaciones que esperan al equipo |
| `GET /api/merchant/metrics?from&to` | métricas del período (hasta 92 días) |

Plataforma (`/api/platform/*`, solo `platform_admin`; escrituras desde un origen de confianza):

| Endpoint | |
|---|---|
| `GET`/`POST /api/platform/businesses`, `GET`/`PATCH /…/:id` | negocios con uso del mes; alta con plantilla; plan, modelo y estado (`active`, `suspended`, `closed`) |
| `GET`/`POST /api/platform/plans`, `PUT`/`DELETE /…/:id` | planes y límites (no se borra uno en uso ni el por defecto) |
| `GET`/`PUT /api/platform/settings` | modelo por defecto del agente |
| `GET /api/platform/overview?days` · `/usage?month` · `/health` | panel (7, 30 o 90 días), uso y costo del mes y salud |
| `POST /api/platform/support/businesses/:id/conversations[/:conversationId]` | soporte: listado y detalle de conversaciones; el motivo va en el cuerpo (no en la URL) y se registra |
| `GET /api/platform/support/log?limit&cursor&businessId` | registro de accesos de soporte |
| `GET`/`POST /api/platform/users`, `DELETE /…/:id` | administradores de la plataforma |
| `POST /api/merchant/conversations/:id/reply` · `/take` · `/release` | responder (solo con la conversación tomada y en el chat web), tomar, devolver al agente |
| `GET /api/merchant/conversations?handoff&channel&cursor&limit`, `GET /…/:id` | conversaciones; el detalle trae la traza y las reservas |

## Decisiones importantes

- **El LLM no maneja identidad.** Tenant, sucursal y teléfono los arma el webhook; ningún tool los recibe.
- **Responder 200 antes de procesar.** El agente tarda segundos; si el webhook tarda, Meta reintenta.
  Los reintentos se descartan por `wa_message_id`.
- **Un mensaje a la vez por conversación.** Si el cliente manda dos seguidos, el segundo espera
  y el modelo ve la respuesta al primero. `KeyedQueue` funciona en un proceso: con varias instancias,
  usar una cola particionada por conversación (p. ej. SQS FIFO con `MessageGroupId`).
- **Historial a prueba de cortes.** Se guarda en formato de la API de Claude y se normaliza al leerlo:
  un crash entre un `tool_use` y su resultado no deja la conversación rota.
- **Paso a humano.** `request_human` marca la conversación; desde ahí el agente calla y los mensajes
  quedan guardados para el equipo. `releaseHandoff()` la devuelve al agente.
  También se pasa a humano si el modelo encadena más de 8 llamadas a tools.
- **Fallas visibles.** Si la API de Claude falla, el cliente recibe un aviso en lugar de silencio.
- **Prompt caching.** El bloque fijo del system prompt (por negocio) lleva `cache_control`;
  la fecha y el nombre del cliente van en un bloque aparte.

## Despliegue

Un solo servicio: la API sirve también la consola y el chat compilados, cada uno en su dominio
(`CONSOLE_URL` y `CHAT_PUBLIC_URL`, p. ej. `app.` y `chat.`); en los dos, `/api` es la misma API.

```bash
docker build -t hablahora .
# antes de cada despliegue (con DATABASE_ADMIN_URL, el dueño del esquema):
docker run --env-file .env.production hablahora node packages/db/dist/cli.js
docker run --env-file .env.production -p 3000:3000 hablahora
```

- **Base de datos**: Postgres 17. Crear `app_user` y `auth_user` con LOGIN y contraseña (las
  migraciones los crean sin login); el rol que corre las migraciones debe poder crear roles,
  políticas RLS y funciones `SECURITY DEFINER` que se salten RLS.
- **Configuración**: la API la valida al arrancar y no arranca si falta algo (`apps/api/src/config.ts`).
  Con `NODE_ENV=production` exige `https`, correo por Postmark (`EMAIL_PROVIDER=postmark`,
  `POSTMARK_SERVER_TOKEN`, `EMAIL_FROM`) y un `BETTER_AUTH_SECRET` propio. Ver `.env.example`.
- **Errores**: con `SENTRY_DSN`, la API y las dos apps reportan a Sentry (las apps lo leen de
  `GET /api/public-config`). Todo lo que la API registra como error se reporta.
- **Seguridad**: HSTS, `nosniff`, CSP en las páginas (la consola no se puede incrustar; el chat sí,
  para `embed.js`) y `TRUST_PROXY` para la IP real del cliente detrás del balanceador.
- **Una sola instancia**: la cola por conversación, el límite por IP y el vencimiento de apartados
  viven en memoria. Para varias instancias, pasar a pg-boss.
- **Salud**: `GET /health`.

Pruebas de punta a punta (Playwright): `npm run build && npm run e2e` levanta su propio servidor
(`e2e/server.mjs`: Postgres embebido, datos de prueba y LLM simulado) en `app.localhost` y
`chat.localhost`. Con el Chrome instalado: `PW_CHANNEL=chrome npm run e2e`. Contra staging solo las
de humo: `E2E_CONSOLE_URL=… E2E_CHAT_URL=… E2E_EMAIL=… E2E_PASSWORD=… npm run e2e`.

## Pendiente

- Responder desde la consola en conversaciones de WhatsApp (hoy solo en el chat web): enviar la
  respuesta del equipo con `GraphWhatsAppSender`.
- Tokens por negocio con Embedded Signup (hoy `WA_ACCESS_TOKEN` es uno solo).
- Notificaciones fuera de la ventana de 24 h (recordatorios) con plantillas aprobadas.
- Combinaciones de mesas, recursos con cupo compartido, última hora de ingreso.
- La tabla `tenants` no tiene RLS: no exponerla al rol de la app si guarda datos sensibles.
