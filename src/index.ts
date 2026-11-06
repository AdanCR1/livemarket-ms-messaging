import { Hono, type Context } from 'hono';
import { verify } from 'hono/jwt';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';

type Actor = { id: string; role: 'B2B' | 'B2C'; token: string; exp: number };
type Env = { Bindings: { JWT_SECRET: string; MS4_URL: string; MS5_INTERNAL_KEY: string; SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }; Variables: { actor: Actor } };
type Chat = { id: string; order_id: string; store_id: string; status: string };
type Message = { id: string; sender_id: string; body: string; created_at: string };
const app = new Hono<Env>();
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
class Failure extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503;
  constructor(status: Failure['status'], message: string) { super(message); this.status = status; }
}
const hidden = () => new Failure(404, 'Conversación no disponible');
const unavailable = () => new Failure(503, 'Servicio de mensajería no disponible');
app.onError((error, c) => error instanceof Failure
  ? c.json({ success: false, error: error.message }, error.status)
  : c.json({ success: false, error: 'Servicio de mensajería no disponible' }, 503));
app.get('/health', c => c.json({ success: true, service: 'marketcloud-ms5' }));
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const token = /^Bearer (\S+)$/i.exec(c.req.header('Authorization') ?? '')?.[1];
  if (!token) throw new Failure(401, 'Sesión requerida');
  if (!c.env.JWT_SECRET) throw unavailable();
  const claims = await verify(token, c.env.JWT_SECRET, 'HS256').catch(() => null);
  if (!claims || claims.iss !== 'ms1-auth' || !uuid(claims.sub) || typeof claims.exp !== 'number' ||
      claims.exp <= Date.now() / 1000) throw new Failure(401, 'Sesión inválida');
  if (claims.role !== 'B2B' && claims.role !== 'B2C') throw new Failure(403, 'Rol no habilitado para chat');
  c.set('actor', { id: claims.sub, role: claims.role, token, exp: claims.exp });
  await next();
});
app.use('/api/*', bodyLimit({ maxSize: 8192, onError: c => c.json({ success: false, error: 'Solicitud demasiado grande' }, 413) }));

async function database<T>(c: Context<Env>, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const { SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: key } = c.env;
  if (!base || !key) throw unavailable();
  const response = await fetch(base.replace(/\/$/, '') + '/rest/v1/' + path, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
      Accept: method === 'POST' ? 'application/vnd.pgrst.object+json' : 'application/json',
      ...(method === 'PATCH' ? { Prefer: 'return=representation' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  const result = await response.json();
  if (response.ok) return result as T;
  if (result?.code === '42501') throw hidden();
  if (result?.code === '23505') throw new Failure(409, 'Clave de mensaje reutilizada');
  if (result?.message === 'MESSAGE_RATE_LIMIT') throw new Failure(429, 'Espera antes de volver a enviar');
  throw unavailable();
}

async function orderAccess(c: Context<Env>, id: string): Promise<{ order_id: string; store_id: string }> {
  const actor = c.get('actor');
  if (actor.exp <= Date.now() / 1000) throw new Failure(401, 'Sesión vencida');
  if (!c.env.MS4_URL || !c.env.MS5_INTERNAL_KEY) throw unavailable();
  const response = await fetch(`${c.env.MS4_URL.replace(/\/$/, '')}/api/ms5/order-access/${id}`, {
    headers: { Authorization: `Bearer ${actor.token}`, 'X-Internal-Key': c.env.MS5_INTERNAL_KEY },
    signal: AbortSignal.timeout(4000), redirect: 'error',
  });
  if (response.status === 404) throw hidden();
  if (!response.ok) throw unavailable();
  const result = await response.json();
  if (result?.success !== true || result.data?.order_id !== id || !uuid(result.data?.store_id)) throw unavailable();
  return result.data;
}

async function chatAccess(c: Context<Env>, id: string) {
  if (!uuid(id)) throw hidden();
  const [chat] = await database<Chat[]>(c, `ms5_conversations?select=id,order_id,store_id,status&id=eq.${id}&kind=eq.ORDER`);
  if (!chat || chat.status === 'ARCHIVED') throw hidden();
  const order = await orderAccess(c, chat.order_id);
  if (order.store_id !== chat.store_id) throw hidden();
  const [membership] = await database(c, `ms5_conversation_participants?select=user_id&conversation_id=eq.${id}&user_id=eq.${c.get('actor').id}&revoked_at=is.null`) as unknown[];
  if (!membership) throw hidden();
  return chat;
}

app.post('/api/conversations', async c => {
  const body = await c.req.json().catch(() => null);
  if (!uuid(body?.order_id) || Object.keys(body).length !== 1) throw new Failure(400, 'Pedido inválido');
  const order = await orderAccess(c, body.order_id.toLowerCase());
  const actor = c.get('actor');
  const chat = await database<Chat>(c, 'rpc/ms5_open_order', {
    p_order: order.order_id, p_store: order.store_id, p_actor: actor.id, p_role: actor.role,
  });
  return c.json({ success: true, data: { id: chat.id, status: chat.status } });
});

app.get('/api/conversations', async c => {
  const cursor = c.req.query('cursor');
  if (cursor !== undefined && !uuid(cursor)) throw new Failure(400, 'Cursor inválido');
  const actor = c.get('actor');
  const rows = await database<{ conversation_id: string }[]>(c,
    `ms5_conversation_participants?select=conversation_id&user_id=eq.${actor.id}&revoked_at=is.null&order=conversation_id.asc&limit=11`
      + (cursor ? `&conversation_id=gt.${cursor}` : ''));
  const page = rows.slice(0, 10);
  const authorized: Pick<Chat, 'id' | 'order_id' | 'status'>[] = [];
  for (const row of page) {
    try {
      const chat = await chatAccess(c, row.conversation_id);
      authorized.push({ id: chat.id, order_id: chat.order_id, status: chat.status });
    } catch (error) {
      if (!(error instanceof Failure) || error.status !== 404) throw error;
    }
  }
  return c.json({ success: true, data: { conversations: authorized,
    next_cursor: rows.length > 10 ? page.at(-1)?.conversation_id : null } });
});

function cursorFilter(cursor: string | undefined) {
  if (!cursor) return '';
  const [date, id, extra] = cursor.split('|');
  if (extra !== undefined || !uuid(id) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(date))
    throw new Failure(400, 'Cursor inválido');
  return '&or=' + encodeURIComponent(`(created_at.lt.${date},and(created_at.eq.${date},id.lt.${id}))`);
}
const messages = (c: Context<Env>, id: string, limit: number, filter = '') =>
  database<Message[]>(c, `ms5_messages?select=id,sender_id,body,created_at&conversation_id=eq.${id}&deleted_at=is.null&order=created_at.desc,id.desc&limit=${limit}${filter}`);

app.get('/api/conversations/:id/messages', async c => {
  const chat = await chatAccess(c, c.req.param('id'));
  const rows = await messages(c, chat.id, 51, cursorFilter(c.req.query('cursor')));
  const page = rows.slice(0, 50);
  const last = page.at(-1);
  return c.json({ success: true, data: { messages: page, viewer_id: c.get('actor').id,
    next_cursor: rows.length > 50 && last ? `${last.created_at}|${last.id}` : null } });
});
app.post('/api/conversations/:id/messages', async c => {
  const chat = await chatAccess(c, c.req.param('id'));
  const body = await c.req.json().catch(() => null);
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!uuid(body?.client_message_id) || !text || text.length > 1500 || Object.keys(body).length !== 2 ||
      /MC-(?:QR|ACC)-|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/i.test(text))
    throw new Failure(400, 'Mensaje inválido o contiene un token');
  const message = await database<Message>(c, 'rpc/ms5_send_message', {
    p_chat: chat.id, p_actor: c.get('actor').id, p_client: body.client_message_id, p_body: text,
  });
  return c.json({ success: true, data: { id: message.id } });
});
app.get('/api/conversations/:id/events', async c => {
  const chat = await chatAccess(c, c.req.param('id'));
  return streamSSE(c, async stream => {
    let last: string | undefined;
    for (let check = 0; check < 6 && !stream.aborted; check++) {
      if (check > 0) {
        await stream.sleep(3000);
        if (stream.aborted) break;
        try { await chatAccess(c, chat.id); } catch { break; }
      }
      const head = (await messages(c, chat.id, 1))[0]?.id ?? '';
      if (head !== last) {
        await stream.writeSSE({ event: 'refresh', data: '{}' });
        last = head;
      }
    }
  });
});
app.get('/api/notifications', async c => {
  const id = c.req.query('conversation_id');
  if (!uuid(id)) throw new Failure(400, 'Conversación requerida');
  const chat = await chatAccess(c, id);
  const data = await database(c, `ms5_notifications?select=id,event_type,created_at,read_at&conversation_id=eq.${chat.id}&recipient_user_id=eq.${c.get('actor').id}&order=created_at.desc&limit=50`);
  return c.json({ success: true, data });
});

app.patch('/api/notifications/:id/read', async c => {
  const id = c.req.param('id');
  if (!uuid(id)) throw hidden();
  const scope = `id=eq.${id}&recipient_user_id=eq.${c.get('actor').id}`;
  const [notice] = await database<{ conversation_id: string; read_at: string | null }[]>(c,
    `ms5_notifications?select=conversation_id,read_at&${scope}`);
  if (!notice) throw hidden();
  await chatAccess(c, notice.conversation_id);
  if (!notice.read_at) {
    await database(c, `ms5_notifications?${scope}&read_at=is.null`, { read_at: new Date().toISOString() }, 'PATCH');
  }
  return c.json({ success: true, data: { id } });
});

app.get('/api/disputes', async c => {
  const id = c.req.query('order_id');
  if (!uuid(id)) throw new Failure(400, 'Pedido requerido');
  const order = await orderAccess(c, id.toLowerCase());
  const data = await database(c, `ms5_disputes?select=id,status,created_at,escrow_sync_confirmed_at,resolution_notes&order_id=eq.${order.order_id}&order=created_at.desc&limit=20`);
  return c.json({ success: true, data });
});
app.post('/api/disputes', c => c.json({ success: false, error: 'La disputa requiere sincronización verificada con MS4 y MS6' }, 503));
export default app;
