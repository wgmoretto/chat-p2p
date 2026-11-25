import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Link2, LockKeyhole, Send, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { login, recoverAccount, register } from './workspace.mjs';

export function Brand() {
  return <div className="brand"><Link2 aria-hidden="true" size={32} strokeWidth={2.7} /><span>Chat P2P</span></div>;
}

export function Access({ bootstrap, recovery, invite, onSession }) {
  const [mode, setMode] = useState(bootstrap || invite ? 'register' : 'login');
  const create = mode === 'register';
  const recover = mode === 'recovery';
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function switchMode(next) { setMode(next); setError(''); }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const form = Object.fromEntries(new FormData(event.currentTarget));
      onSession(await (recover ? recoverAccount(form) : create ? register(form, invite) : login(form)));
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
        <h2>{recover ? 'Vincular este navegador' : create ? 'Criar conta' : 'Entrar no Chat P2P'}</h2>
        <p className="muted">{recover
          ? 'Use a senha da primeira conta e o código configurado no servidor. Isso encerra a sessão do navegador anterior.'
          : invite ? 'Use este convite para solicitar entrada no grupo.'
          : create ? 'Configure a primeira conta desta instalação.' : 'Entre pelo perfil e endereço usados para criar a conta.'}</p>
        <form onSubmit={submit}>
          {create && <label>Nome<input name="name" autoComplete="name" required maxLength={80} /></label>}
          <label>Usuário<input name="username" autoComplete="username" required minLength={3} maxLength={32}
            pattern="[A-Za-z0-9][A-Za-z0-9._\-]{2,31}" spellCheck={false} /></label>
          <label>Senha<input name="password" type="password" autoComplete={create ? 'new-password' : 'current-password'}
            required minLength={12} maxLength={200} />{create && <small>Mínimo de 12 caracteres.</small>}</label>
          {create && !invite && <label>Código de instalação<input name="bootstrapToken" type="password"
            autoComplete="off" required minLength={24} /></label>}
          {recover && <label>Código de recuperação<input name="recoveryCode" type="password"
            autoComplete="off" required minLength={32} /></label>}
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary wide" disabled={busy}>{recover ? 'Vincular navegador' : create ? 'Criar conta' : 'Entrar'}<ArrowRight size={18} /></button>
        </form>
        {recover
          ? <button className="text-button" disabled={busy} onClick={() => switchMode('login')}>Voltar para entrar</button>
          : (bootstrap || invite) && <button className="text-button" disabled={busy}
              onClick={() => switchMode(create ? 'login' : 'register')}>{create ? 'Já tenho conta' : 'Criar conta'}</button>}
        {recovery && !invite && mode === 'login' && <button className="text-button" disabled={busy}
          onClick={() => switchMode('recovery')}>Vincular este navegador</button>}
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
export function People({ roster, pending = [], approve, change, busy }) {
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
    <p className="privacy"><ShieldCheck size={16} /> Dispositivos verificados pelo grupo</p>
  </div>;
}
