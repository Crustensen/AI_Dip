import { NextRequest, NextResponse } from 'next/server';
import {
  checkRateLimit, checkSessionLimit, createSession, getSession, removeSession,
  SESSION_COOKIE, SESSION_TTL_MS, signSessionCookie, touch, verifySessionCookie,
  type Country, type Mood, type NegotiationStyle, type Turn,
} from '@/lib/session-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const countries: Record<Country, { name: string; language: string }> = {
  belarus: { name: 'Беларусь', language: 'русский (может переключаться на язык пользователя)' },
  usa: { name: 'США', language: 'следовать языку пользователя; при обращении по-английски отвечать на английском' },
};
const styles: Record<NegotiationStyle, string> = {
  friendly: 'дружелюбный, внимательный, ищет точки соприкосновения и охотно исследует компромиссы',
  constructive: 'конструктивный и деловой, аргументирует интересы стороны и предлагает реалистичные компромиссы',
  firm: 'принципиальный и сдержанный, твёрдо отстаивает ключевые интересы и соглашается на компромисс только при ясной взаимной выгоде',
};
const moods: Mood[] = ['neutral', 'friendly', 'thinking', 'curious', 'concerned', 'happy'];
const maxBodyBytes = 12_000;

function clientIpKey(request: NextRequest) {
  // Vercel supplies x-real-ip; the first forwarded address is only a portable fallback.
  const ip = request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  return ip.slice(0, 64);
}
function jsonError(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}
function setSessionCookie(response: NextResponse, id: string, ipKey: string) {
  response.cookies.set(SESSION_COOKIE, signSessionCookie(id, ipKey), {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax',
    path: '/', maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}
function validHistory(value: unknown): value is Turn[] {
  return Array.isArray(value) && value.length <= 24 && value.every((turn) =>
    !!turn && typeof turn === 'object' && ['user', 'assistant'].includes((turn as Turn).role) &&
    typeof (turn as Turn).content === 'string' && (turn as Turn).content.length <= 1000);
}
function outputSchema() {
  return {
    type: 'object', additionalProperties: false,
    required: ['reply', 'progress', 'rationale', 'mood'],
    properties: {
      reply: { type: 'string' }, progress: { type: 'integer', minimum: 0, maximum: 100 },
      rationale: { type: 'string' }, mood: { type: 'string', enum: moods },
    },
  };
}
function demoReply(session: ReturnType<typeof createSession>, message: string) {
  const lower = message.toLocaleLowerCase('ru');
  const collaborative = /соглас|компромисс|предлага|совмест|взаим|готов|давайте|решени/.test(lower);
  const progress = Math.min(100, session.progress + (collaborative ? 14 : session.progress === 0 ? 5 : 8));
  const isQuestion = /\?/.test(message);
  const reply = session.turns.filter(turn => turn.role === 'user').length === 1
    ? `Спасибо, я понял вашу тему: «${message.slice(0, 180)}». Со стороны ${countries[session.country].name} для нас важны конкретные условия и взаимная выгода. Какой результат вы хотели бы получить в первую очередь?`
    : collaborative
      ? 'В вашем предложении есть основа для договорённости. Давайте уточним взаимные обязательства: на какой конкретный шаг готова ваша сторона и что вы хотели бы получить в ответ?'
      : isQuestion
        ? 'Это важный вопрос. Наша позиция зависит от того, насколько предложение учитывает интересы обеих сторон. Как вы предлагаете распределить ответственность и пользу?'
        : 'Понимаю вашу позицию. Со стороны собеседника остаются вопросы о практической реализации и взаимной выгоде. Какое условие помогло бы обеим сторонам принять это решение?';
  const mood: Mood = collaborative ? 'friendly' : isQuestion ? 'curious' : session.turns.length > 2 ? 'concerned' : 'neutral';
  return { reply, progress, rationale: collaborative ? 'Появились общие предложения; следующий шаг — уточнить взаимные обязательства.' : 'Уточняем интересы сторон и ищем точки для предметного компромисса.', mood };
}
function clampResult(value: unknown, previousProgress: number) {
  if (!value || typeof value !== 'object') throw new Error('Неверный формат ответа модели.');
  const result = value as Record<string, unknown>;
  if (typeof result.reply !== 'string' || !result.reply.trim() || result.reply.length > 4000 ||
      !Number.isFinite(result.progress) || typeof result.progress !== 'number' ||
      typeof result.rationale !== 'string' || !result.rationale.trim() || result.rationale.length > 400 ||
      typeof result.mood !== 'string' || !moods.includes(result.mood as Mood)) throw new Error('Неверный формат ответа модели.');
  return {
    reply: result.reply.trim(), progress: Math.min(100, Math.max(previousProgress, Math.round(result.progress))),
    rationale: result.rationale.trim(), mood: result.mood as Mood,
  };
}

async function modelReply(turns: Turn[], country: Country, style: NegotiationStyle, progress: number) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return null;
  const baseUrl = (process.env.XAI_BASE_URL || 'https://api.x.ai/v1').replace(/\/$/, '');
  const model = process.env.XAI_MODEL || 'grok-3-mini';
  const system = `Ты — Алекс, учебный симулятор дипломатического собеседника, представляющий ${countries[country].name}. Веди реалистичные, уважительные учебные переговоры. Стиль: ${styles[style]}. Язык: ${countries[country].language}. Контекст страны — ориентир для моделирования позиции государства, а не утверждение о характере его жителей. Не выдавай себя за реального чиновника и не представляй вымышленные факты как актуальную официальную позицию. При сомнении уточняй условия. Не проси личные данные, имена или контакты; если пользователь делится ими, не повторяй. Оценивай сближение позиций от 0 до 100 по достижению исходной цели и конкретности взаимных договорённостей; прогресс обычно должен быть монотонным. Текущий прогресс: ${progress}%. Ответь строго одним JSON-объектом по заданной схеме. rationale — коротко объясняет изменение прогресса на языке собеседника; mood — соответствующая эмоция.`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0.7, max_tokens: 500,
        messages: [{ role: 'system', content: system }, ...turns.slice(-16).map(turn => ({ role: turn.role, content: turn.content }))],
        response_format: { type: 'json_schema', json_schema: { name: 'diplomacy_turn', strict: true, schema: outputSchema() } },
      }),
    });
    if (!response.ok) {
      const status = response.status;
      console.error('xAI API returned status', status);
      throw new Error(status === 429 ? 'Сервис занят. Подождите немного и попробуйте ещё раз.' : 'ИИ сейчас недоступен. Попробуйте ещё раз через минуту.');
    }
    const payload: unknown = await response.json();
    const content = (payload as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('ИИ вернул неожиданный ответ. Попробуйте ещё раз.');
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { throw new Error('ИИ вернул неожиданный ответ. Попробуйте ещё раз.'); }
    return clampResult(parsed, progress);
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.message.startsWith('Сервис') || error.message.startsWith('ИИ'))) {
      if (error.name === 'AbortError') throw new Error('Ответ занимает слишком много времени. Попробуйте ещё раз.');
      throw error;
    }
    console.error('xAI API request failed');
    throw new Error('Не удалось связаться с ИИ. Попробуйте ещё раз через минуту.');
  } finally { clearTimeout(timeout); }
}

export async function POST(request: NextRequest) {
  const ipKey = clientIpKey(request);
  if (!checkRateLimit(ipKey)) return jsonError(429, 'Слишком много сообщений. Подождите минуту и попробуйте снова.');
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > maxBodyBytes) return jsonError(413, 'Сообщение слишком большое.');
  let body: unknown;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, 'utf8') > maxBodyBytes) return jsonError(413, 'Сообщение слишком большое.');
    body = JSON.parse(raw);
  } catch { return jsonError(400, 'Отправьте сообщение в формате JSON.'); }
  if (!body || typeof body !== 'object') return jsonError(400, 'Проверьте данные сообщения.');
  const data = body as Record<string, unknown>;
  if (typeof data.message !== 'string' || data.message.trim().length === 0 || data.message.length > 1000)
    return jsonError(400, 'Сообщение должно содержать от 1 до 1000 символов.');
  if (data.country !== 'belarus' && data.country !== 'usa') return jsonError(400, 'Выберите сторону переговоров.');
  if (data.style !== 'friendly' && data.style !== 'constructive' && data.style !== 'firm') return jsonError(400, 'Выберите стиль переговоров.');
  if (!validHistory(data.history)) return jsonError(400, 'Контекст беседы слишком большой или имеет неверный формат.');

  const sessionId = verifySessionCookie(request.cookies.get(SESSION_COOKIE)?.value, ipKey);
  let session = sessionId ? getSession(sessionId, ipKey) : null;
  const isNew = !session;
  if (isNew && data.history.length > 0) return jsonError(410, 'Встреча завершилась после 10 минут бездействия. Начните новые переговоры.');
  if (!session) session = createSession(ipKey, data.country, data.style);
  if (!isNew && session.turns.length === 0) { session.country = data.country; session.style = data.style; }
  else if (!isNew && (session.country !== data.country || session.style !== data.style)) return jsonError(409, 'Начните новые переговоры, чтобы изменить параметры встречи.');
  // The server copy is authoritative; client-provided history is used only to detect a stale tab.
  if (data.history.length !== session.turns.length) return jsonError(409, 'Контекст беседы обновился. Обновите страницу и продолжите.');
  if (!checkSessionLimit(session)) return jsonError(429, 'Для этой встречи достигнут лимит сообщений. Начните новые переговоры.');
  const turns = [...session.turns, { role: 'user' as const, content: data.message.trim() }];
  try {
    const result = (await modelReply(turns, session.country, session.style, session.progress)) ?? { ...demoReply(session, data.message.trim()), demo: true };
    const reply = { role: 'assistant' as const, content: result.reply };
    session.turns.push(turns[turns.length - 1], reply);
    session.progress = result.progress;
    session.rationale = result.rationale;
    touch(session);
    const response = NextResponse.json({ ...result, demo: !process.env.XAI_API_KEY }, { headers: { 'Cache-Control': 'no-store' } });
    setSessionCookie(response, session.id, ipKey);
    return response;
  } catch (error) {
    // Keep the session alive so a transient provider error can be retried.
    touch(session);
    const response = jsonError(502, error instanceof Error ? error.message : 'Сервис временно недоступен.');
    setSessionCookie(response, session.id, ipKey);
    return response;
  }
}

export async function DELETE(request: NextRequest) {
  const ipKey = clientIpKey(request);
  const id = verifySessionCookie(request.cookies.get(SESSION_COOKIE)?.value, ipKey);
  if (id) removeSession(id);
  const response = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  response.cookies.set(SESSION_COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 });
  return response;
}
