# Hoja de ruta de HablaHora

Lo que viene después de la v1 (`docs/PLAN-v1.md`). Nada de esto se construye antes de terminar la
v1 y su piloto; cada versión tendrá su propio plan (`docs/PLAN-v2.md`, etc.) al empezarla.

El orden supone un piloto de servicios con hora (peluquería, estética, clínica). **Si el primer
cliente es un restaurante, las mesas (v3) pasan antes que WhatsApp (v2).**

## Base que ya existe

- **Canales:** el agente no sabe por dónde le escriben; cada canal es un adaptador que arma el
  `ConversationContext`. WhatsApp ya tiene código (webhook, deduplicación por `wa_message_id`, una
  cola por conversación) y está apagado.
- **Mesas:** el mismo motor que las horas (recurso + horario + capacidad), con la restricción
  `EXCLUDE` contra la doble reserva.
- **Pedidos:** previsto como un módulo aparte del de reservas.

## Versiones

| Versión | Qué | Notas | Tamaño |
|---|---|---|---|
| **v2** | WhatsApp y recordatorios | Verificación del negocio en Meta; un número por comercio (Embedded Signup); plantillas aprobadas para recordatorios fuera de la ventana de 24 h; pg-boss para las tareas programadas; versión vigente de la Graph API. | Mediano (mucho es trámite con Meta) |
| **v3** | Reserva de mesas | Mesas con capacidad, combinaciones para grupos grandes, turnos, plano simple en la consola, recursos con cupo compartido. | Mediano |
| **v4** | Pedidos con menú configurable | Catálogo, categorías, modificadores, carrito, totales calculados en el motor, estados del pedido; probablemente pagos. | Grande |
| **v4+** | Integración con POS | Enviar pedidos (y mesas, si el POS las maneja) al sistema de caja. Una integración por POS. | Mediano por POS |
| **v5** | Voz (Twilio) | Atención por teléfono: latencia, voz natural, interrupciones, costo por minuto. Twilio también puede servir para SMS o como proveedor de WhatsApp (en ese caso entra en v2). | Grande |
| **Después** | App móvil | El chat web y WhatsApp ya cubren el celular. Primero una PWA (chat instalable); app nativa solo si hay demanda. | Según demanda |

## POS para Chile (por decidir)

Clover no opera en Chile; queda para cuando se entre a EE.UU. Antes de la v4 hay que elegir el POS
de los primeros restaurantes chilenos y confirmar que tenga API para recibir pedidos (y mesas).
Candidatos a evaluar, sin verificar aún: Toteat, Fudo, Bsale. Lo mejor es preguntar qué usan los
primeros clientes y empezar por ese.

## Ideas sueltas (sin versión)

- Base de conocimiento del negocio (fichas por sucursal + tool `search_business_info`).
- Imagen de fondo propia en el chat, cuando un cliente la pida (el fondo teñido y las texturas van
  en H7a parte 4).
- Equivalente en pesos del costo del modelo en la plataforma, cuando los planes tengan precio.
- Instalación con otra marca para un tercero (por configuración), solo si hay acuerdo firmado.
