import React, { useState } from 'react';
import { Bell, LogOut, Menu, Plus, Radio, Search, UserPlus, Users, Video, X } from 'lucide-react';
import { Brand, initials } from './views.jsx';

function Count({ value, label }) {
  return value > 0 && <><span className="nav-count" aria-hidden="true" title={String(value)}>{value > 99 ? '99+' : value}</span>
    {label && <span className="sr-only">{value} {label}</span>}</>;
}

export function Presence({ person }) {
  const status = person.calling ? 'Chamando' : person.online ? 'Online' : 'Offline';
  return <span className="presence" data-online={person.online || person.calling}><i aria-hidden="true" />{status}</span>;
}

export function WorkspaceRail({ groups, friends, group, groupRooms, room, contact, canJoin, notice,
  showActivity, openContact, select, enter, create, logout, session, appearance, ready }) {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const query = search.trim().toLocaleLowerCase('pt-BR').replace(/^@/, '');
  const matches = (value) => value.toLocaleLowerCase('pt-BR').includes(query);
  const contacts = friends.filter(({ roomId, name, username, calling, unread }) =>
    roomId && (calling || unread || matches(name) || matches(username)));
  const visibleGroups = groups.filter(({ name, unread }) => unread || matches(name));
  const navigate = (action) => { setExpanded(false); action(); };

  return <aside className="sidebar" onKeyDown={(event) => {
    if (event.key === 'Escape' && expanded) {
      setExpanded(false);
      event.currentTarget.querySelector('.mobile-nav-toggle')?.focus();
    }
  }}>
    <div className="sidebar-top">
      <Brand />
      <button className="icon mobile-nav-toggle" aria-label={expanded ? 'Fechar navegação' : 'Abrir navegação'}
        aria-expanded={expanded} aria-controls="workspace-nav" onClick={() => setExpanded(!expanded)}>
        <Count value={expanded ? 0 : notice + friends.reduce((sum, item) => sum + item.unread, 0) +
          groups.reduce((sum, item) => sum + item.unread, 0)} />
        {expanded ? <X size={21} /> : <Menu size={21} />}
      </button>
    </div>
    <div id="workspace-nav" className="sidebar-body" data-expanded={expanded}>
      <label className="rail-search"><Search size={17} aria-hidden="true" /><span className="sr-only">Buscar amigos e grupos</span>
        <input type="search" placeholder="Buscar amigos e grupos" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <nav aria-label="Conversas, grupos e salas">
        <button className="nav-item activity-link" aria-current={!group && !contact ? 'page' : undefined} onClick={() => navigate(showActivity)}>
          <Bell size={18} /><span>Atividade</span><Count value={notice} label="pendentes" />
        </button>
        <div className="nav-heading"><h2>Amigos</h2>
          <button className="rail-add" aria-label="Adicionar amigo" onClick={() => navigate(() => create('friend'))}><UserPlus size={16} /> Adicionar</button>
        </div>
        <ul className="contact-list">{contacts.map((person) => <li key={person.id}>
          <button className="nav-item contact-item" aria-current={person.id === contact?.id ? 'page' : undefined}
            onClick={() => navigate(() => openContact(person))}>
            <span className="avatar" aria-hidden="true">{initials(person.name)}</span>
            <span className="contact-summary"><strong>{person.name}</strong><Presence person={person} /></span>
            <Count value={person.unread} label="mensagens não lidas" />
          </button>
        </li>)}</ul>
        {!contacts.length && <p className="nav-empty">{!ready ? 'Carregando…' : search ? 'Nenhum contato encontrado' : 'Nenhum amigo adicionado'}</p>}
        <div className="nav-heading"><h2>Grupos</h2>
          <button className="icon" aria-label="Novo grupo" title="Novo grupo" onClick={() => navigate(() => create('group'))}><Plus size={19} /></button>
        </div>
        <ul className="group-list">{visibleGroups.map((item) => <li key={item.id}>
          <button className="nav-item" aria-current={item.id === group?.id && !room ? 'page' : undefined}
            onClick={() => navigate(() => select(item.id))}>
            <span className="nav-symbol"><Users size={17} aria-hidden="true" /></span>
            <span className="nav-item-name">{item.name}</span><Count value={item.unread} label="mensagens não lidas" />
          </button>
        </li>)}</ul>
        {group?.status === 'active' && <section className="rail-rooms" aria-label="Salas do grupo">
          <div className="nav-heading"><h2>Salas</h2>
            <button className="icon" aria-label="Nova sala" disabled={!canJoin} onClick={() => navigate(() => create('room'))}><Plus size={19} /></button>
          </div>
          <ul>{groupRooms.map((item) => <li key={item.id}>
            <button className="nav-item" aria-current={item.id === room?.id ? 'page' : undefined} disabled={!canJoin}
              onClick={() => navigate(() => enter(item))}>{item.mode === 'live' ? <Radio size={17} /> : <Video size={17} />}
              <span>{item.name}</span></button>
          </li>)}</ul>
        </section>}
      </nav>
      <div className="sidebar-footer">
        {appearance}
        <div className="account">
          <span className="avatar solid" aria-hidden="true">{initials(session.account.name)}</span>
          <div><strong>{session.account.name}</strong><small>@{session.account.username}</small></div>
          <button className="icon" onClick={logout} aria-label="Sair da conta" title="Sair da conta"><LogOut size={18} /></button>
        </div>
      </div>
    </div>
  </aside>;
}
