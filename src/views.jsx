import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Link2, LockKeyhole, Send, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { login, register } from './workspace.mjs';

export function Brand() {
  return <div className="brand"><Link2 aria-hidden="true" size={32} strokeWidth={2.7} /><span>Chat P2P</span></div>;
}

export function Access({ bootstrap, signup, invite, onSession }) {
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
      <div>
        <h1>Onde a equipe se encontra.</h1>
        <p>Reuniões, conversas e compartilhamento de tela em um espaço privado.</p>
      </div>
      <p className="privacy"><LockKeyhole size={17} /> Comunicação criptografada</p>
    </section>
    <section className="access-panel">
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
    <h2 id="modal-title">{title}</h2>
    {children}
  </dialog>;
}

const date = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
export const initials = (value = '') => value.trim().split(/\s+/).slice(0, 2).map((item) => item[0]?.toUpperCase()).join('');

function Message({ item, roster }) {
  const author = roster.find(({ id }) => id === item.author)?.name ?? item.name ?? 'Participante';
  return <div className="message">
    <span className="avatar" aria-hidden="true">{initials(author)}</span>
    <div className="message-content">
      <div className="message-meta"><strong>{author}</strong><time dateTime={new Date(item.created).toISOString()}>{date.format(item.created)}</time></div>
      <p>{item.text}</p>
    </div>
  </div>;
}

export function Conversation({ messages, roster, onSend, busy, label, available, empty }) {
  const scroll = useRef(null);
  const [value, setValue] = useState('');
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [messages.length]);
  async function submit(event) {
    event.preventDefault();
    const outgoing = value.trim();
    if (outgoing && await onSend(outgoing)) setValue('');
  }
  return <>
    <div className="conversation-scroll" ref={scroll} role="log" aria-label={label}>
      {messages.length ? messages.map((item) => <Message key={item.id} item={item} roster={roster} />)
        : <div className="chat-empty"><LockKeyhole size={23} /><p>{empty}</p></div>}
    </div>
    <form className="composer" onSubmit={submit}>
      <label className="sr-only" htmlFor="chat-message">Mensagem</label>
      <input id="chat-message" placeholder="Mensagem" value={value} onChange={(event) => setValue(event.target.value)}
        autoComplete="off" maxLength={1500} disabled={!available} />
      <button className="primary" disabled={busy || !available || !value.trim()}>Enviar<Send size={15} aria-hidden="true" /></button>
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
