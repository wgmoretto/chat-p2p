import React, { useState } from 'react';
import { MessageSquare, PhoneIncoming, UserPlus, Users } from 'lucide-react';
import { initials } from './views.jsx';

export function Friends({ people, ready, busy, send, update, enter }) {
  const [username, setUsername] = useState('');
  const confirmed = people.filter(({ roomId }) => roomId);
  const received = people.filter(({ roomId, incoming }) => !roomId && incoming);
  const sent = people.filter(({ roomId, incoming }) => !roomId && !incoming);

  async function submit(event) {
    event.preventDefault();
    if (await send(username.trim())) setUsername('');
  }

  return <section className="friends-panel" aria-label="Amizades">
    <form className="friend-form" onSubmit={submit}>
      <label>Adicionar pelo @usuário<input value={username} onChange={(event) => setUsername(event.target.value)}
        placeholder="@usuário" maxLength={33} autoComplete="off" required /></label>
      <button className="primary" disabled={busy || !username.trim()}><UserPlus size={18} /> Enviar pedido</button>
    </form>
    <div className="people-list friends-list">
      {received.length > 0 && <FriendList title="Pedidos recebidos" people={received} state="received" {...{ busy, update, enter }} />}
      {sent.length > 0 && <FriendList title="Pedidos enviados" people={sent} state="sent" {...{ busy, update, enter }} />}
      <FriendList title="Seus amigos" people={confirmed} state="accepted" {...{ busy, update, enter }} />
      {!confirmed.length && <p className="muted">{ready ? 'Quando alguém aceitar seu pedido, a conversa aparece aqui.' : 'Carregando amigos…'}</p>}
    </div>
  </section>;
}

function FriendList({ title, people, state, busy, update, enter }) {
  return <section>
    <h3><Users size={17} aria-hidden="true" /> {title}</h3>
    <ul>{people.map((person) => <li key={person.id}>
      <span className="avatar" aria-hidden="true">{initials(person.name)}</span>
      <span className="person-label"><strong>{person.name}</strong><small>@{person.username}</small></span>
      <div className="friend-actions">
        {state === 'accepted' && <button className={person.calling ? 'primary' : 'quiet'} onClick={() => enter(person)}>
          {person.calling ? <PhoneIncoming size={16} /> : <MessageSquare size={16} />}
          {person.calling ? 'Atender' : 'Conversar'}
        </button>}
        {state === 'received' && <button className="primary" disabled={busy} onClick={() => update(person, 'accept')}>Aceitar</button>}
        <button className="quiet" disabled={busy} onClick={() => update(person, 'remove')}>
          {state === 'received' ? 'Recusar' : state === 'sent' ? 'Cancelar' : 'Remover'}
        </button>
      </div>
    </li>)}</ul>
  </section>;
}
