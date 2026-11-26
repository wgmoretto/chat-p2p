import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Hash, Link2, LockKeyhole, MessageSquare, Monitor, MonitorUp, Moon, Radio, Send, ShieldCheck, Sun, UserPlus, Users, Video, Volume2, X } from 'lucide-react';
import { login, register } from './workspace.mjs';

export const roomTypes = {
  text: { label: 'Chat de texto', icon: Hash },
  voice: { label: 'Chat de voz', icon: Volume2 },
  meet: { label: 'Reunião', icon: Video },
  live: { label: 'Live', icon: Radio },
};

export function Brand() {
  return <div className="brand">
    <span className="brand-mark" aria-hidden="true"><Link2 size={23} strokeWidth={2.4} /></span>
    <span>Chat P2P</span>
  </div>;
}

export function ThemePicker({ theme, change }) {
  const Icon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  return <label className="theme-picker"><Icon size={17} aria-hidden="true" /><span className="sr-only">Tema</span>
    <select value={theme} onChange={(event) => change(event.target.value)}>
      <option value="system">Sistema</option><option value="light">Claro</option><option value="dark">Escuro</option>
    </select>
  </label>;
}

export function Access({ bootstrap, signup, invite, onSession, appearance }) {
  const [create, setCreate] = useState(Boolean(bootstrap || invite && signup));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const form = Object.fromEntries(new FormData(event.currentTarget));
      onSession(await (create ? register(form, invite) : login(form)));
    } catch (problem) {
      setError(problem.message);
    } finally { setBusy(false); }
  }

  return <main className="access">
    <section className="access-intro">
      <Brand />
      <div className="access-copy">
        <h1>Conversas e reuniões da sua equipe</h1>
        <p>Um espaço privado para trabalhar junto, em uma instalação gerenciada pela sua equipe.</p>
        <ul className="access-features">
          <li><MessageSquare size={18} aria-hidden="true" /> Conversas com histórico cifrado</li>
          <li><Video size={18} aria-hidden="true" /> Reuniões e lives</li>
          <li><MonitorUp size={18} aria-hidden="true" /> Compartilhamento de tela</li>
        </ul>
      </div>
    </section>
    <section className="access-panel">
      {appearance}
      <div className="access-form">
        <h2>{create ? 'Criar conta' : 'Entrar no Chat P2P'}</h2>
        {bootstrap && create && <p className="muted">Configure a primeira conta desta instalação.</p>}
        {invite && <p className="muted">Você recebeu um convite de grupo.</p>}
        <form onSubmit={submit}>
          {create && <label>Nome (opcional)<input name="name" autoComplete="name" maxLength={80} /></label>}
          <label>Usuário<input name="username" autoComplete="username" required minLength={3} maxLength={32}
            pattern="[A-Za-z0-9][A-Za-z0-9._\-]{2,31}" spellCheck={false} /></label>
          <label>Senha<input name="password" type="password" autoComplete={create ? 'new-password' : 'current-password'}
            required minLength={12} maxLength={200} />{create && <small>Mínimo de 12 caracteres.</small>}</label>
          {create && bootstrap && <label>Código de instalação<input name="bootstrapToken" type="password"
            autoComplete="off" required minLength={24} /></label>}
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary wide" disabled={busy}>{create ? 'Criar conta' : 'Entrar'}<ArrowRight size={18} /></button>
        </form>
        {signup && <button className="text-button" disabled={busy}
          onClick={() => { setCreate(!create); setError(''); }}>{create ? 'Já tenho conta' : 'Criar conta'}</button>}
      </div>
    </section>
  </main>;
}

export function Modal({ title, children, close }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current.showModal();
  }, []);
  return <dialog ref={ref} className="modal" aria-labelledby="modal-title" onCancel={(event) => { event.preventDefault(); close(); }}>
    <header className="modal-header">
      <h2 id="modal-title">{title}</h2>
      <button className="icon" type="button" onClick={close} aria-label="Dispensar janela"><X size={19} /></button>
    </header>
    {children}
  </dialog>;
}

const date = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const calendarDay = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
export const initials = (value = '') => value.trim().split(/\s+/).slice(0, 2).map((item) => item[0]?.toUpperCase()).join('');

function Message({ item, roster, self }) {
  const author = roster.find(({ id }) => id === item.author)?.name ?? item.name ?? 'Participante';
  return <div className={'message' + (item.author === self ? ' message-own' : '')}>
    <span className="avatar" aria-hidden="true">{initials(author)}</span>
    <div className="message-content">
      <div className="message-meta"><strong>{author}</strong><time dateTime={new Date(item.created).toISOString()}>{date.format(item.created)}</time></div>
      <p>{item.text}</p>
    </div>
  </div>;
}

export function Conversation({ messages, roster, onSend, busy, label, available, empty, before, self }) {
  const scroll = useRef(null);
  const [value, setValue] = useState('');
  const latest = messages.at(-1)?.id;
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [latest]);
  async function submit(event) {
    event.preventDefault();
    const outgoing = value.trim();
    if (!busy && available && outgoing && await onSend(outgoing)) {
      setValue((current) => current === value ? '' : current);
    }
  }
  const today = messages.length ? calendarDay.format(Date.now()) : '';
  return <>
    {before}
    <div className="conversation-scroll" ref={scroll} role="log" aria-label={label}>
      {messages.length ? <div className="conversation-history">{messages.map((item, index) => {
        const day = calendarDay.format(item.created);
        const previous = messages[index - 1];
        return <React.Fragment key={item.id}>
          {(!previous || calendarDay.format(previous.created) !== day) &&
            <div className="message-day"><span>{day === today ? 'Hoje' : day}</span></div>}
          <Message item={item} roster={roster} self={self} />
        </React.Fragment>;
      })}</div>
        : <div className="chat-empty"><span className="empty-symbol"><MessageSquare size={22} aria-hidden="true" /></span><p>{empty}</p></div>}
    </div>
    <form className="composer" onSubmit={submit}>
      <div className="composer-inner">
        <label className="sr-only" htmlFor="chat-message">Mensagem</label>
        <textarea id="chat-message" rows={1} placeholder="Escreva uma mensagem" value={value}
          onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form.requestSubmit();
            }
          }} autoComplete="off" maxLength={1500} disabled={!available} />
        <button className="primary" title="Enviar mensagem" disabled={busy || !available || !value.trim()}>
          Enviar <Send size={16} aria-hidden="true" />
        </button>
      </div>
    </form>
  </>;
}

const roles = { owner: 'Dono', moderator: 'Moderador', member: 'Membro' };
export function People({ roster, pending = [], approve, change, busy, verified }) {
  return <div className="people-list">
    {pending.length > 0 && <section>
      <h3>Pedidos de entrada</h3>
      <ul>{pending.map((person) => <li key={person.id}>
        <span className="avatar"><UserPlus size={16} aria-hidden="true" /></span>
        <span className="person-label"><strong>{person.name}</strong><small>{roles[person.role]}</small></span>
        <button className="quiet" disabled={busy} onClick={() => approve(person)}>Aprovar</button>
      </li>)}</ul>
    </section>}
    <section>
      <h3><Users size={17} aria-hidden="true" /> Participantes do grupo</h3>
      <ul>{roster.map((person) => <li key={person.id}>
        <span className="avatar" aria-hidden="true">{initials(person.name)}</span>
        <span className="person-label"><strong>{person.name}</strong><small>{roles[person.role]}</small></span>
        {change && person.role !== 'owner' && <select aria-label={'Gerenciar ' + person.name}
          value="" disabled={busy} onChange={(event) => change(person, event.target.value)}>
          <option value="">Gerenciar</option><option value="remove">Remover do grupo</option><option value="ban">Banir do grupo</option>
        </select>}
      </li>)}</ul>
    </section>
    {verified && <p className="privacy"><ShieldCheck size={16} /> Dispositivos verificados pelo grupo</p>}
  </div>;
}
