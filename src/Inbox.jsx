import React, { useEffect, useRef, useState } from 'react';
import { Bell, LockKeyhole, MailPlus, PhoneIncoming, ShieldCheck, UserRoundPlus } from 'lucide-react';
import { decryptMessage, sendMessage } from './inbox.mjs';
import { request } from './local.mjs';
import { Conversation } from './views.jsx';
import { useFileShare } from './FileShare.jsx';

export function Inbox({ id, contact, label = contact ? 'Conversa individual' : 'Chat do grupo', session, report, unlock, onRead }) {
  const [messages, setMessages] = useState([]);
  const [people, setPeople] = useState(null);
  const [older, setOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const latest = useRef(null);
  const read = useRef(0);
  const wake = useRef(null);
  const key = session.chatKey;
  const files = useFileShare(contact && key ? id : null, session);
  const path = 'groups/' + id + '/';

  useEffect(() => {
    if (!key) return;
    let stopped = false;
    let pending = false;
    let timer;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    async function pull() {
      if (pending || stopped) return;
      pending = true;
      clearTimeout(timer);
      try {
        const initial = latest.current === null;
        const [recipients, first] = await Promise.all([
          request(path + 'recipients', undefined, options),
          request(path + 'messages' + (initial ? '' : '?after=' + latest.current), undefined, options),
        ]);
        if (stopped) return;
        setPeople(recipients);
        if (initial) setOlder(first.more);
        let page = first;
        do {
          const next = await Promise.all(page.messages.map((item) => decryptMessage(id, key, item)));
          if (stopped) return;
          latest.current = next.at(-1)?.seq ?? latest.current ?? 0;
          if (next.length) setMessages((all) => [...all, ...next]);
          if (initial || !page.more) break;
          page = await request(path + 'messages?after=' + latest.current, undefined, options);
        } while (!stopped);
        if (!stopped && document.visibilityState === 'visible' && latest.current > read.current) {
          const seq = latest.current;
          await request(path + 'read', { seq }, options);
          if (!stopped) { read.current = seq; onRead(id); }
        }
        if (!stopped) setDisconnected(false);
      } catch {
        if (!stopped) setDisconnected(true);
      } finally {
        pending = false;
        if (!stopped) timer = setTimeout(pull, 1800);
      }
    }
    wake.current = pull;
    void pull();
    document.addEventListener('visibilitychange', pull);
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', pull);
    };
  }, [id, key, onRead, path]);

  async function loadOlder() {
    setLoadingOlder(true);
    try {
      const page = await request(path + 'messages?before=' + messages[0].seq);
      const next = await Promise.all(page.messages.map((item) => decryptMessage(id, key, item)));
      setMessages((all) => [...next, ...all]);
      setOlder(page.more);
    } catch (error) { report(error); }
    finally { setLoadingOlder(false); }
  }

  async function send(value) {
    setSending(true);
    try {
      const current = await request(path + 'recipients');
      if (contact && current.some(({ publicKey }) => !publicKey))
        throw Error('Seu amigo precisa entrar na versão atualizada para receber mensagens.');
      await sendMessage(id, session.account, current, value);
      void wake.current?.();
      return true;
    } catch (error) { report(error); return false; }
    finally { setSending(false); }
  }

  if (!key) return <div className="inbox-locked">
    <LockKeyhole size={28} aria-hidden="true" /><h2>Desbloqueie suas conversas</h2>
    <p>Confirme sua senha para acessar as mensagens cifradas neste navegador.</p>
    <button className="primary" onClick={unlock}>Desbloquear histórico</button>
  </div>;

  const missing = people?.some(({ publicKey }) => !publicKey);
  const ready = !!people?.some(({ id, publicKey }) => id === session.account.id && publicKey) && (!contact || !missing);
  return <>
    <div className="thread-info"><ShieldCheck size={16} aria-hidden="true" />
      {disconnected ? 'Recuperando a conexão…' : contact && missing ? 'Aguardando seu amigo entrar na versão atualizada.'
        : !contact && missing ? 'Alguns membros ainda precisam entrar na versão atualizada para receber mensagens.'
          : 'Mensagens cifradas'}</div>
    <Conversation messages={messages} roster={people ?? []} label={label}
      empty={!people ? 'Carregando conversa…' : 'Envie a primeira mensagem.'}
      self={session.account.id} busy={sending} available={ready} onSend={send}
      attachment={files.attachment} after={files.panel}
      before={older && <div className="thread-older"><button className="quiet" disabled={loadingOlder}
        onClick={loadOlder}>{loadingOlder ? 'Carregando…' : 'Mensagens anteriores'}</button></div>} />
  </>;
}

export function Activity({ friends, invites, ready, busy, add, respond, reply, open }) {
  const requests = friends.filter(({ roomId }) => !roomId);
  const calls = friends.filter(({ calling }) => calling);
  return <section className="activity" aria-label="Atividade e pedidos">
    {invites.length > 0 && <section className="activity-block">
      <h2>Convites de grupo</h2>
      <ul>{invites.map((item) => <li key={item.token}>
        <div className="activity-detail">
          <span className="item-icon"><MailPlus size={19} aria-hidden="true" /></span>
          <div><strong>{item.name}</strong><p>{item.inviter} convidou você como {item.role === 'moderator' ? 'moderador' : 'membro'}.</p></div>
        </div>
        <div className="activity-actions"><button disabled={busy} onClick={() => respond(item, false)}>Recusar</button>
          <button className="primary" disabled={busy} onClick={() => respond(item, true)}>Aceitar convite</button></div>
      </li>)}</ul>
    </section>}
    {requests.length > 0 && <section className="activity-block">
      <h2>Pedidos de amizade</h2>
      <ul>{requests.map((person) => <li key={person.id}>
        <div className="activity-detail">
          <span className="item-icon"><UserRoundPlus size={19} aria-hidden="true" /></span>
          <div><strong>{person.name}</strong><p>@{person.username} · {person.incoming ? 'Pedido recebido' : 'Pedido enviado'}</p></div>
        </div>
        <div className="activity-actions"><button disabled={busy} onClick={() => reply(person, 'remove')}>
          {person.incoming ? 'Recusar' : 'Cancelar pedido'}</button>
          {person.incoming && <button className="primary" disabled={busy} onClick={() => reply(person, 'accept')}>Aceitar</button>}</div>
      </li>)}</ul>
    </section>}
    {!requests.length && !invites.length && !calls.length && <div className="activity-empty">
      <span className="empty-symbol"><Bell size={24} aria-hidden="true" /></span>
      <h2>{ready ? 'Nenhum pedido pendente' : 'Carregando a atividade'}</h2>
      {ready && <p>Escolha uma conversa na lista ou adicione alguém pelo @usuário.</p>}
      {ready && <button className="primary" onClick={add}>Adicionar amigo</button>}
    </div>}
    {calls.length > 0 && <section className="activity-block"><h2>Chamadas recebidas</h2>
      <ul>{calls.map((person) => <li key={person.id}>
        <div className="activity-detail">
          <span className="item-icon"><PhoneIncoming size={19} aria-hidden="true" /></span><strong>{person.name}</strong>
        </div>
        <button className="primary" onClick={() => open(person, true)}>Atender</button>
      </li>)}</ul></section>}
  </section>;
}
