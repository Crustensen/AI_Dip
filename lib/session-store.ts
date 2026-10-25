import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type Country = 'belarus' | 'usa' | 'finland' | 'uk';
export type AppMode = 'diplomat' | 'coach';
export type ConversationTopic = 'nature' | 'culture' | 'geography';
export type NegotiationStyle = 'friendly' | 'constructive' | 'firm';
export type Mood = 'neutral' | 'friendly' | 'thinking' | 'curious' | 'concerned' | 'happy';
export type Turn = { role: 'user' | 'assistant'; content: string };
export type NegotiationSession = {
  id: string;
  ipKey: string;
  country: Country;
  mode: AppMode;
  topic: ConversationTopic;
  style: NegotiationStyle;
  turns: Turn[];
  progress: number;
  rationale: string;
  updatedAt: number;
  requests: number;
};

const sessions = new Map<string, NegotiationSession>();
const ipRequests = new Map<string, { count: number; windowStarted: number }>();
const processSecret = randomBytes(32).toString('hex');
export const SESSION_COOKIE = 'vd_session';
export const SESSION_TTL_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_MINUTE = 12;
const MAX_REQUESTS_PER_SESSION = 40;

function secret() {
  return process.env.SESSION_SECRET || process.env.XAI_API_KEY || processSecret;
}
function signature(id: string, ipKey: string) {
  return createHmac('sha256', secret()).update(`${id}.${ipKey}`).digest('hex');
}
export function signSessionCookie(id: string, ipKey: string) {
  return `${id}.${signature(id, ipKey)}`;
}
export function verifySessionCookie(value: string | undefined, ipKey: string) {
  if (!value) return null;
  const [id, supplied, ...extra] = value.split('.');
  if (!id || !supplied || extra.length || !/^[a-f0-9]{48}$/.test(id)) return null;
  const expected = signature(id, ipKey);
  const a = Buffer.from(supplied, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}
export function getSession(id: string, ipKey: string) {
  const session = sessions.get(id);
  if (!session || session.ipKey !== ipKey) return null;
  if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
    sessions.delete(id);
    return null;
  }
  return session;
}
export function createSession(ipKey: string, country: Country, style: NegotiationStyle, mode: AppMode, topic: ConversationTopic) {
  const now = Date.now();
  const session: NegotiationSession = {
    id: randomBytes(24).toString('hex'), ipKey, country, style, mode, topic,
    turns: [], progress: 0, rationale: 'Начните с темы и своей цели переговоров.', updatedAt: now, requests: 0,
  };
  sessions.set(session.id, session);
  return session;
}
export function touch(session: NegotiationSession) {
  session.updatedAt = Date.now();
}
export function removeSession(id: string) {
  sessions.delete(id);
}
export function checkRateLimit(ipKey: string) {
  const now = Date.now();
  const current = ipRequests.get(ipKey);
  if (!current || now - current.windowStarted >= RATE_WINDOW_MS) {
    ipRequests.set(ipKey, { count: 1, windowStarted: now });
    return true;
  }
  if (current.count >= MAX_REQUESTS_PER_MINUTE) return false;
  current.count += 1;
  return true;
}
export function checkSessionLimit(session: NegotiationSession) {
  if (session.requests >= MAX_REQUESTS_PER_SESSION) return false;
  session.requests += 1;
  return true;
}

// Expire idle entries and keep transient demo state bounded per server process.
const MAX_SESSIONS = 5000;
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) if (now - session.updatedAt > SESSION_TTL_MS) sessions.delete(id);
  for (const [ip, bucket] of ipRequests) if (now - bucket.windowStarted > RATE_WINDOW_MS * 2) ipRequests.delete(ip);
  if (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const session of oldest.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(session.id);
  }
}, 60_000).unref();
