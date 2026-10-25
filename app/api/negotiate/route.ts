import { NextRequest, NextResponse } from 'next/server';
import {
  checkRateLimit, checkSessionLimit, createSession, getSession, removeSession,
  SESSION_COOKIE, SESSION_TTL_MS, signSessionCookie, touch, verifySessionCookie,
  type AppMode, type ConversationTopic, type Country, type Mood, type NegotiationStyle, type Turn,
} from '@/lib/session-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const countries: Record<Country, { name: string; language: string }> = {
  belarus: { name: 'Беларусь', language: 'только русский; иногда можно естественно вставить отдельное белорусское слово, но весь ответ остаётся русским' },
  usa: { name: 'США', language: 'только английский; не переключайся на русский' },
  finland: { name: 'Финляндия', language: 'только финский; не переключайся на русский или английский' },
  uk: { name: 'Великобритания', language: 'только английский; не переключайся на русский' },
};
const coachTopics: Record<ConversationTopic, string> = {
  nature: 'природа и окружающая среда', culture: 'культура, традиции и искусство', geography: 'география и особенности стран',
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
    required: ['reply', 'progress', 'rationale', 'mood', 'userVersion', 'explanation'],
    properties: {
      reply: { type: 'string' }, progress: { type: 'integer', minimum: 0, maximum: 100 },
      rationale: { type: 'string' }, mood: { type: 'string', enum: moods },
      userVersion: { type: 'string' }, explanation: { type: 'string' },
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
  const localizedReply = session.country === 'usa'
    ? 'Thank you for sharing your position. What practical step could help both sides move forward?'
    : session.country === 'finland'
      ? 'Kiitos näkökulmastasi. Mikä käytännön askel auttaisi molempia osapuolia etenemään?'
      : reply;
  const rationale = session.country === 'usa'
    ? 'We are clarifying each side’s interests and looking for practical common ground.'
    : session.country === 'finland'
      ? 'Selvitämme osapuolten etuja ja etsimme käytännöllistä yhteistä ratkaisua.'
      : collaborative ? 'Появились общие предложения; следующий шаг — уточнить взаимные обязательства.' : 'Уточняем интересы сторон и ищем точки для предметного компромисса.';
  return { reply: localizedReply, progress, rationale, mood, userVersion: '', explanation: '' };
}
function clampResult(value: unknown, previousProgress: number) {
  if (!value || typeof value !== 'object') throw new Error('Неверный формат ответа модели.');
  const result = value as Record<string, unknown>;
  if (typeof result.reply !== 'string' || !result.reply.trim() || result.reply.length > 4000 ||
      !Number.isFinite(result.progress) || typeof result.progress !== 'number' ||
      typeof result.rationale !== 'string' || !result.rationale.trim() || result.rationale.length > 400 ||
      typeof result.mood !== 'string' || !moods.includes(result.mood as Mood) ||
      typeof result.userVersion !== 'string' || result.userVersion.length > 1500 ||
      typeof result.explanation !== 'string' || result.explanation.length > 1000) throw new Error('Неверный формат ответа модели.');
  return {
    reply: result.reply.trim(), progress: Math.min(100, Math.max(previousProgress, Math.round(result.progress))),
    rationale: result.rationale.trim(), mood: result.mood as Mood,
    userVersion: result.userVersion.trim(), explanation: result.explanation.trim(),
  };
}

async function modelReply(turns: Turn[], country: Country, style: NegotiationStyle, progress: number, mode: AppMode, topic: ConversationTopic) {
  const isGroq = Boolean(process.env.GROQ_API_KEY);
  const apiKey = process.env.GROQ_API_KEY || process.env.XAI_API_KEY;
  if (!apiKey) return null;
  const baseUrl = (process.env.AI_BASE_URL || (isGroq ? 'https://api.groq.com/openai/v1' : process.env.XAI_BASE_URL || 'https://api.x.ai/v1')).replace(/\/$/, '');
  const model = process.env.AI_MODEL || (isGroq ? 'openai/gpt-oss-20b' : process.env.XAI_MODEL || 'grok-3-mini');
  const system = mode === 'coach'
    ? `Ты — Алекс, доброжелательный преподаватель языка. Страна/язык обучения: ${countries[country].name}, ${countries[country].language}. Тема урока: ${coachTopics[topic]}. Тренерские ответы, объяснение и перевод должны быть только на изучаемом языке; исключение — если нужно понять русское сообщение, поле userVersion содержит только его перевод на изучаемый язык, а explanation оставь пустым. Сначала определи язык сообщения ученика. Если оно написано по-русски, переведи его на изучаемый язык в userVersion, не меняя смысл. Если оно написано на изучаемом языке, исправь орфографию, лексику и грамматику, сохрани смысл и стиль ученика; верни улучшенный вариант в userVersion, а в explanation коротко и мягко объясни исправления на изучаемом языке. Если ошибок нет, повтори исходную фразу и похвали кратко на изучаемом языке. Затем ответь на смысл сообщения в reply и задай простой вопрос, чтобы продолжить беседу. Держись темы «${coachTopics[topic]}». Если ученик уходит от неё, мягко напомни тему на изучаемом языке и задай связанный вопрос. Не используй русский нигде в reply, explanation или rationale. Не проси персональные данные. Возвращай только один JSON по схеме; progress оставь 0, mood подбери по ситуации.`
    : `Ты — Алекс, учебный симулятор дипломатического собеседника, представляющий ${countries[country].name}. Веди реалистичные, уважительные учебные переговоры. Стиль: ${styles[style]}. И reply, и rationale пиши только на языке: ${countries[country].language}. Контекст страны — ориентир для моделирования позиции государства, а не утверждение о характере его жителей. Не выдавай себя за реального чиновника и не представляй вымышленные факты как актуальную официальную позицию. При сомнении уточняй условия. Не проси личные данные, имена или контакты; если пользователь делится ими, не повторяй. Оценивай сближение позиций от 0 до 100 по достижению исходной цели и конкретности взаимных договорённостей; прогресс обычно должен быть монотонным. Текущий прогресс: ${progress}%. userVersion и explanation должны быть пустыми строками. Ответь строго одним JSON-объектом по заданной схеме. mood — соответствующая эмоция.`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0.7, max_tokens: 700,
        messages: [{ role: 'system', content: system }, ...turns.slice(-16).map(turn => ({ role: turn.role, content: turn.content }))],
        response_format: { type: 'json_schema', json_schema: { name: 'conversation_turn', strict: true, schema: outputSchema() } },
      }),
    });
    if (!response.ok) {
      const status = response.status;
      console.error(`${isGroq ? 'Groq' : 'xAI'} API returned status`, status);
      throw new Error(status === 429 ? 'Сервис занят. Подождите немного и попробуйте ещё раз.' : 'ИИ сейчас недоступен. Попробуйте ещё раз через минуту.');
    }
    const payload: unknown = await response.json();
    const content = (payload as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('ИИ вернул неожиданный ответ. Попробуйте ещё раз.');
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { throw new Error('ИИ вернул неожиданный ответ. Попробуйте ещё раз.'); }
    const result = clampResult(parsed, progress);
    if (mode === 'coach' && !result.userVersion) throw new Error('ИИ не подготовил исправление или перевод. Попробуйте ещё раз.');
    return result;
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.message.startsWith('Сервис') || error.message.startsWith('ИИ') || error.message.startsWith('Языковой тренер'))) {
      if (error.name === 'AbortError') throw new Error('Ответ занимает слишком много времени. Попробуйте ещё раз.');
      throw error;
    }
    console.error(`${isGroq ? 'Groq' : 'xAI'} API request failed`);
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
  if (data.mode !== 'diplomat' && data.mode !== 'coach') return jsonError(400, 'Выберите режим приложения.');
  const mode: AppMode = data.mode === 'coach' ? 'coach' : 'diplomat';
  if (mode === 'coach' && data.topic !== 'nature' && data.topic !== 'culture' && data.topic !== 'geography') return jsonError(400, 'Выберите тему разговора.');
  const topic = (data.topic === 'culture' || data.topic === 'geography' ? data.topic : 'nature') as ConversationTopic;
  if (typeof data.message !== 'string' || data.message.trim().length === 0 || data.message.length > 1000)
    return jsonError(400, 'Сообщение должно содержать от 1 до 1000 символов.');
  const validCountry = mode === 'coach'
    ? data.country === 'finland' || data.country === 'uk'
    : data.country === 'belarus' || data.country === 'usa' || data.country === 'finland';
  if (!validCountry) return jsonError(400, 'Выберите страну для выбранного режима.');
  const country = data.country as Country;
  if (data.style !== 'friendly' && data.style !== 'constructive' && data.style !== 'firm') return jsonError(400, 'Выберите стиль переговоров.');
  if (!validHistory(data.history)) return jsonError(400, 'Контекст беседы слишком большой или имеет неверный формат.');

  const sessionId = verifySessionCookie(request.cookies.get(SESSION_COOKIE)?.value, ipKey);
  let session = sessionId ? getSession(sessionId, ipKey) : null;
  const isNew = !session;
  if (isNew && data.history.length > 0) return jsonError(410, 'Встреча завершилась после 10 минут бездействия. Начните новые переговоры.');
  if (!session) session = createSession(ipKey, country, data.style, mode, topic);
  if (!isNew && session.turns.length === 0) { session.country = country; session.style = data.style; session.mode = mode; session.topic = topic; }
  else if (!isNew && (session.country !== country || session.style !== data.style || session.mode !== mode || session.topic !== topic)) return jsonError(409, 'Начните новый диалог, чтобы изменить параметры.');
  // The server copy is authoritative; client-provided history is used only to detect a stale tab.
  if (data.history.length !== session.turns.length) return jsonError(409, 'Контекст беседы обновился. Обновите страницу и продолжите.');
  if (!checkSessionLimit(session)) return jsonError(429, 'Для этой встречи достигнут лимит сообщений. Начните новые переговоры.');
  const turns = [...session.turns, { role: 'user' as const, content: data.message.trim() }];
  try {
    if (session.mode === 'coach' && !(process.env.GROQ_API_KEY || process.env.XAI_API_KEY)) {
      throw new Error('Языковой тренер требует подключённого ИИ. Добавьте GROQ_API_KEY в настройках Vercel.');
    }
    const result = (await modelReply(turns, session.country, session.style, session.progress, session.mode, session.topic)) ?? { ...demoReply(session, data.message.trim()), demo: true };
    const addedTurns: Turn[] = [{ role: 'user', content: data.message.trim() }];
    if (session.mode === 'coach' && result.userVersion) {
      addedTurns.push({ role: 'assistant', content: [result.userVersion, result.explanation].filter(Boolean).join('\n') });
    }
    addedTurns.push({ role: 'assistant', content: result.reply });
    session.turns.push(...addedTurns);
    session.progress = result.progress;
    session.rationale = result.rationale;
    touch(session);
    const response = NextResponse.json({ ...result, demo: !(process.env.GROQ_API_KEY || process.env.XAI_API_KEY) }, { headers: { 'Cache-Control': 'no-store' } });
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
