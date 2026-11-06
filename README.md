# MarketCloud MS5 · Mensajería

Configurar privadamente `JWT_SECRET` de MS1, `MS4_URL`, `MS5_INTERNAL_KEY` compartida con MS4, `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`. En Astro configurar `MS5_URL`, `MS5_CHAT_ENABLED=true` y `PUBLIC_MS5_CHAT_ENABLED=true` solo para DEV después de configurar ambos servicios. El valor público únicamente controla visibilidad. Mantener las banderas financieras desactivadas.

| Método | Ruta | Contrato |
|---|---|---|
| GET | `/health` | Salud del Worker |
| POST | `/api/conversations` | `{order_id}`; apertura idempotente y adhesión del actor autorizado |
| GET | `/api/conversations` | Hasta 10 conversaciones activas autorizadas y cursor |
| GET | `/api/conversations/:id/messages` | Hasta 50 mensajes y cursor opaco para historia |
| POST | `/api/conversations/:id/messages` | `{client_message_id,text}`; reintento con la misma clave, 429 al exceder 12/min |
| GET | `/api/conversations/:id/events` | SSE privado con invalidación mínima; vuelve a validar MS4 y membresía cada ciclo |
| GET | `/api/notifications?conversation_id=…` | Hasta 50 avisos propios del chat autorizado |
| PATCH | `/api/notifications/:id/read` | Marca como leído un aviso propio, idempotente |
| GET | `/api/disputes?order_id=…` | Estados de disputa de un pedido autorizado |
| POST | `/api/disputes` | 503; contrato de congelación pendiente |

Todos los endpoints de negocio requieren JWT HS256 con emisor y expiración, además de comprobación MS4 y membresía activa en las operaciones de chat. No se emiten JWT Supabase Realtime. La política Broadcast incluida en SQL debe revisarse y comprobarse en el proyecto antes de habilitarla. SSE transmite únicamente una señal de actualización tras leer la fila persistida. Los clientes vuelven a consultar mensajes a través del BFF. SSE tiene una ventana corta y revalida cada 3 segundos más la latencia de las consultas. No se almacenan tokens. React presenta el contenido como texto.

El envío inserta notificaciones internas para participantes ya vinculados. Falta el outbox de productores y reconciliación, la revocación de flota con MS1, chat de DRIVER y SUPPORT, y la integración de evidencias privadas con MS3. La UI no ofrece carga, congelación, resolución ni acciones financieras.