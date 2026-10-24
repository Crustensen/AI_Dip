'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import Image from 'next/image';

type Mood = 'neutral' | 'friendly' | 'thinking' | 'curious' | 'concerned' | 'happy';
type Message = { role: 'user' | 'assistant'; content: string };
type Country = 'belarus' | 'usa';
type Style = 'friendly' | 'constructive' | 'firm';
const moods: Record<Mood, string> = { neutral: 'Спокоен', friendly: 'Дружелюбен', thinking: 'Обдумывает', curious: 'Заинтересован', concerned: 'Осторожен', happy: 'Доволен' };
const countryNames: Record<Country, string> = { belarus: 'Беларусь', usa: 'США' };
const countryFlags: Record<Country, string> = { belarus: '🇧🇾', usa: '🇺🇸' };
const moodEmojis: Record<Mood, string> = { neutral: '😐', friendly: '🙂', thinking: '🤔', curious: '🧐', concerned: '😟', happy: '😊' };

function PersonAvatar({ className }: { className: string }) {
  return <span className={className} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="3.15" fill="currentColor"/><path d="M5.5 19.2c.45-3.25 2.95-5.1 6.5-5.1s6.05 1.85 6.5 5.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg></span>;
}

function Mascot({ mood }: { mood: Mood }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [mood]);
  if (!imageFailed) return <Image className="mascot-image" src={`/images/alex-${mood}.png`} alt={`Алекс: ${moods[mood].toLowerCase()}`} width={110} height={120} unoptimized onError={() => setImageFailed(true)} />;
  return <div className={`mascot-fallback mood-${mood}`} aria-label={`Алекс: ${moods[mood].toLowerCase()}`}><span className="mascot-halo" /><span className="mascot-face"><i className="eye eye-left" /><i className="eye eye-right" /><i className="mouth" /></span><span className="mascot-caption">{moodEmojis[mood]} Алекс · {moods[mood]}</span></div>;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [topic, setTopic] = useState('');
  const [country, setCountry] = useState<Country>('belarus');
  const [style, setStyle] = useState<Style>('constructive');
  const [progress, setProgress] = useState(0);
  const [rationale, setRationale] = useState('Начните с темы и своей цели переговоров.');
  const [mood, setMood] = useState<Mood>('neutral');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const conversationRef = useRef<HTMLDivElement>(null);
  const active = messages.length > 0;

  useEffect(() => { conversationRef.current?.scrollTo({ top: conversationRef.current.scrollHeight, behavior: 'smooth' }); }, [messages, loading]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = topic.trim();
    if (!text || loading) return;
    if (text.length > 1000) { setError('Сообщение слишком длинное. Максимум — 1000 символов.'); return; }
    const pending = [...messages, { role: 'user' as const, content: text }];
    setMessages(pending); setTopic(''); setError(''); setNotice(''); setLoading(true); setMood('thinking');
    try {
      const response = await fetch('/api/negotiate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, country, style, history: messages }) });
      const data = await response.json();
      if (response.status === 410) { setMessages([]); setProgress(0); setRationale('Начните с темы и своей цели переговоров.'); setMood('neutral'); }
      if (!response.ok) throw new Error(data.error || 'Не удалось получить ответ. Попробуйте ещё раз.');
      setMessages([...pending, { role: 'assistant', content: data.reply }]);
      setProgress(data.progress); setRationale(data.rationale); setMood(data.mood); setNotice(data.demo ? 'Демо-режим · добавьте GROQ_API_KEY в настройки Vercel для ответов ИИ.' : '');
    } catch (e) {
      setMessages(messages); setTopic(text); setError(e instanceof Error ? e.message : 'Что-то пошло не так. Попробуйте ещё раз.'); setMood('concerned');
    } finally { setLoading(false); }
  }

  async function resetNegotiation() {
    if (loading) return;
    try { await fetch('/api/negotiate', { method: 'DELETE' }); } catch { /* the next request can create a new local session */ }
    setMessages([]); setProgress(0); setRationale('Начните с темы и своей цели переговоров.'); setMood('neutral'); setTopic(''); setError(''); setNotice('');
  }

  return <main className="page-shell">
    <section className="workspace" aria-label="Тренажёр переговоров">
      <div className="chat-card">
        <div className="chat-topbar"><div className="chat-identity"><PersonAvatar className="avatar-small"/><div><strong>Алекс</strong><span className="online-label"><i /> Дипломат · {countryFlags[country]} {countryNames[country]}</span></div></div><div className="live-tag"><span /> {active ? '🤝 Переговоры идут' : '💬 Готов к диалогу'}</div></div>
        <div className={`conversation ${active ? 'has-messages' : ''}`} ref={conversationRef} aria-live="polite">
          {!active ? <div className="welcome-state"><div className="welcome-symbol"><PersonAvatar className="welcome-avatar-person"/><i>✳</i></div><span className="welcome-overline">ВАШ СОБЕСЕДНИК СЕГОДНЯ</span><h2>Давайте договоримся.</h2><p>Выберите тему переговоров и начните беседу. Я помогу отработать аргументы и найти решение.</p><div className="welcome-prompt"><span>✦</span> Какую задачу вы хотите решить?</div></div> : <div className="message-list">{messages.map((message, i) => <div key={`${i}-${message.role}`} className={`message-row ${message.role === 'user' ? 'user-row' : ''}`}>{message.role === 'assistant' && <PersonAvatar className="message-avatar"/>}<div className={`message-bubble ${message.role === 'user' ? 'user-bubble' : 'assistant-bubble'}`}><span className="message-sender">{message.role === 'user' ? 'Вы' : 'Алекс'}</span><p>{message.content}</p></div></div>)}{loading && <div className="message-row"><PersonAvatar className="message-avatar"/><div className="message-bubble assistant-bubble typing-bubble"><span className="message-sender">Алекс обдумывает ответ</span><div className="typing-dots"><i /><i /><i /></div></div></div>}</div>}
        </div>
        <form className="composer" onSubmit={sendMessage}><label className="sr-only" htmlFor="topic">Тема переговоров или сообщение</label><textarea id="topic" value={topic} onChange={e => setTopic(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} placeholder={active ? 'Напишите ваш ответ…' : 'Например, предложите сотрудничество по защите лесов…'} rows={2} maxLength={1000} disabled={loading} /><div className="composer-footer"><span className="composer-hint">↵ Отправить <span>·</span> ⇧↵ Новая строка</span><span className="composer-actions"><span className="char-count">{topic.length}/1000</span><button type="submit" className="send-button" disabled={!topic.trim() || loading} aria-label="Отправить сообщение"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></button></span></div></form>
        {error && <div className="error-note" role="alert">{error}</div>}{notice && <div className="demo-note" role="status">{notice}</div>}
        <div className="privacy-note"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.7 13 3.6v3.8c0 3-2.1 5.6-5 6.8-2.9-1.2-5-3.8-5-6.8V3.6L8 1.7Z" stroke="currentColor" strokeWidth="1.3"/><path d="m5.7 7.8 1.5 1.5 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg> Учебный диалог · не вводите личные данные</div>
      </div>
      <aside className="side-panel">
        <div className="settings-card"><div className="section-heading"><span className="section-index">01</span><h2>Параметры встречи</h2></div><div className="field-group"><label htmlFor="country">🌍 СТОРОНА ПЕРЕГОВОРОВ</label><div className="select-wrap"><span className="select-icon">◎</span><select id="country" value={country} disabled={active || loading} onChange={e => setCountry(e.target.value as Country)}><option value="belarus">🇧🇾 Беларусь</option><option value="usa">🇺🇸 США</option></select><svg viewBox="0 0 16 16" fill="none"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></div><span className="field-help">Позиция, которую представляет Алекс</span></div><div className="field-group"><label htmlFor="style">🎭 СТИЛЬ ПЕРЕГОВОРОВ</label><div className="select-wrap"><span className="select-icon">✳</span><select id="style" value={style} disabled={active || loading} onChange={e => setStyle(e.target.value as Style)}><option value="friendly">🤝 Дружелюбный</option><option value="constructive">🧭 Конструктивный</option><option value="firm">🛡️ Несговорчивый</option></select><svg viewBox="0 0 16 16" fill="none"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></div><span className="field-help">Тон и готовность идти на компромисс</span></div></div>
        <div className="progress-card"><div className="section-heading"><span className="section-index">02</span><h2>📈 Ход переговоров</h2></div><div className="progress-meta"><span>🎯 Сближение позиций</span><span className="progress-number">{progress}<small>%</small></span></div><div className="progress-track" role="progressbar" aria-label="Прогресс переговоров" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><div className="progress-fill" style={{ width: `${progress}%` }}><span /></div></div><p className="progress-rationale">{rationale}</p></div>
        <div className="mascot-card"><div className="mascot-glow"/><Mascot mood={mood}/><div className="mascot-quote"><span>{moodEmojis[mood]} АЛЕКС ГОВОРИТ</span><p>{mood === 'thinking' ? 'Взвешиваю ваши аргументы…' : mood === 'happy' ? 'Кажется, мы нашли общий язык!' : mood === 'curious' ? 'Интересная позиция. Расскажите подробнее.' : mood === 'concerned' ? 'У нас есть разногласия. Давайте разберёмся.' : mood === 'friendly' ? 'Я открыт к вашим предложениям.' : 'Уважение и ясная цель — хорошее начало.'}</p></div><span className="mascot-sparkle sparkle-one">✳</span><span className="mascot-sparkle sparkle-two">✳</span></div>
        <button type="button" className="new-session-button" onClick={resetNegotiation} disabled={loading}><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M16.2 7.2A6.5 6.5 0 0 0 4.8 5.5L3.5 7m0 0V3.8M3.5 7h3.2M3.8 12.8A6.5 6.5 0 0 0 15.2 14l1.3-1.5m0 0v3.2m0-3.2h-3.2" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round"/></svg> Начать новые переговоры</button><p className="side-footnote">{active ? 'Чтобы сменить сторону или стиль, начните новую встречу.' : 'Выберите сторону и стиль до начала диалога.'}</p>
      </aside>
    </section>
    <footer className="page-footer"><span className="alpha-badge">ALPHA 0.1</span></footer>
  </main>;
}
