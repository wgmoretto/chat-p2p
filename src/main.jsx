import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeft, ArrowUpRight, CircleHelp, LockKeyhole, LogOut, Menu, Pencil, Plus, Radio, UserRound, Users, Video, X } from 'lucide-react';
import { readPreference, request, writePreference } from './local.mjs';
import { changeMembership, makeInvite, newGroup, postGroupMessage, readInvite,
  requestAdmission, restore, syncGroup } from './workspace.mjs';
import { Access, Brand, Conversation, initials, Modal, People, ThemePicker } from './views.jsx';
import { Meeting } from './Meeting.jsx';
import { Friends } from './Friends.jsx';
import './style.css';

function Sidebar({ groups, group, groupRooms, room, contact, canJoin, friendsNotice, showFriends, select, enter, create, logout, session, appearance }) {
  const [expanded, setExpanded] = useState(false);
  const navigate = (action) => { setExpanded(false); action(); };
  return <aside className="sidebar">
    <div className="sidebar-top">
      <Brand />
      <button className="icon mobile-nav-toggle" aria-label={expanded ? 'Fechar navegação' : 'Abrir navegação'}
        aria-expanded={expanded} aria-controls="workspace-nav" onClick={() => setExpanded(!expanded)}>
        {expanded ? <X size={22} /> : <Menu size={22} />}
      </button>
    </div>
    <div id="workspace-nav" className="sidebar-body" data-expanded={expanded}>
      <nav aria-label="Grupos e salas">
        <button className="nav-item" aria-current={!group && !contact ? 'page' : undefined} onClick={() => navigate(showFriends)}>
          <UserRound size={19} /><span>Amigos</span>{friendsNotice > 0 && <span className="nav-count">{friendsNotice}</span>}
        </button>
        <div className="nav-heading"><h2>Grupos</h2><button className="icon" aria-label="Novo grupo" onClick={() => navigate(() => create('group'))}><Plus size={19} /></button></div>
        <ul>{groups.map((item) => <li key={item.id}><button className="nav-item" aria-current={item.id === group?.id && !room ? 'page' : undefined}
          onClick={() => navigate(() => select(item.id))}><Users size={19} /><span>{item.name}</span></button></li>)}</ul>
        {group?.status === 'active' && <>
          <div className="nav-heading"><h2>Salas</h2><button className="icon" aria-label="Nova sala" disabled={!canJoin} onClick={() => navigate(() => create('room'))}><Plus size={19} /></button></div>
          <ul>{groupRooms.map((item) => <li key={item.id}><button className="nav-item" aria-current={item.id === room?.id ? 'page' : undefined}
            disabled={!canJoin} onClick={() => navigate(() => enter(item))}>{item.mode === 'live' ? <Radio size={19} /> : <Video size={19} />}<span>{item.name}</span></button></li>)}</ul>
          {!groupRooms.length && <p className="nav-empty">Nenhuma sala neste grupo</p>}
        </>}
      </nav>
      <div className="sidebar-footer">
        {appearance}
        <div className="account">
          <span className="avatar solid" aria-hidden="true">{initials(session.account.name)}</span>
          <div><strong>{session.account.name}</strong><small>@{session.account.username}</small></div>
          <button className="icon" onClick={logout} aria-label="Sair da conta"><LogOut size={19} /></button>
        </div>
      </div>
    </div>
  </aside>;
}

function GroupRooms({ rooms, ready, canJoin, enter, canManage, rename }) {
  return <div className="group-rooms">
    <h2>Salas do grupo</h2>
    {!rooms.length && <p className="muted">{ready ? 'Nenhuma sala neste grupo.' : 'Carregando salas…'}</p>}
    <ul>{rooms.map((item) => {
      const Icon = item.mode === 'live' ? Radio : Video;
      return <li key={item.id}>
        <span className="room-symbol"><Icon size={19} aria-hidden="true" /></span>
        <span className="person-label"><strong>{item.name}</strong><small>{item.mode === 'live' ? 'Live' : 'Reunião'}</small></span>
        <div className="room-actions">
          {canManage && <button className="icon" aria-label={'Renomear ' + item.name} title="Renomear sala" onClick={() => rename(item)}><Pencil size={17} /></button>}
          <button aria-label={'Entrar em ' + item.name} disabled={!canJoin} onClick={() => enter(item)}>Entrar <ArrowUpRight size={16} /></button>
        </div>
      </li>;
    })}</ul>
  </div>;
}

function Dashboard({ session, invite: invitation, clearInvite, onLogout, appearance }) {
  const [groups, setGroups] = useState([]);
  const [friends, setFriends] = useState([]);
  const [contactId, setContactId] = useState(null);
  const [selected, select] = useState(null);
  const [room, enter] = useState(null);
  const [roomList, setRoomList] = useState({ id: null, rooms: [] });
  const [groupView, setGroupView] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [roomToRename, setRoomToRename] = useState(null);
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState('rooms');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const report = useCallback((problem) => setError(problem.message || String(problem)), []);

  const group = groups.find(({ id }) => id === selected);
  const active = group?.status === 'active';
  const owner = group?.role === 'owner';
  const canManageRooms = owner || group?.role === 'moderator';
  const legacy = group?.chat_mode === 'mls';
  const snapshot = groupView?.id === group?.id ? groupView : null;
  const record = snapshot?.record;
  const canJoin = active && (!legacy || !!record);
  const roomListForGroup = roomList.id === group?.id ? roomList.rooms : [];
  const activeRoom = canJoin ? roomListForGroup.find(({ id }) => id === room?.id) : null;
  const contact = friends.find(({ id, roomId }) => id === contactId && roomId);
  const friendsNotice = friends.filter(({ roomId, incoming, calling, id }) =>
    (!roomId && incoming) || (calling && id !== contactId)).length;

  const refreshGroups = useCallback(async () => { setGroups(await request('groups')); setReady(true); }, []);
  const update = (id, data, pending, people) => setGroupView((current) => {
    const previous = current?.id === id ? current : null;
    if (data && previous?.record && data.seq < previous.record.seq) return current;
    return { id, record: data, pending: pending ?? previous?.pending ?? [], people: people ?? previous?.people ?? [] };
  });

  useEffect(() => {
    let canceled = false;
    let timer;
    async function poll() {
      try {
        const [groups, friends] = await Promise.all([request('groups'), request('friends')]);
        if (!canceled) { setGroups(groups); setFriends(friends); setReady(true); }
      } catch (problem) {
        if (canceled) return;
        if (problem.status === 401) { onLogout(); return; }
        report(problem);
      }
      if (!canceled) timer = setTimeout(poll, 2500);
    }
    void poll();
    return () => { canceled = true; clearTimeout(timer); };
  }, [report, onLogout]);

  useEffect(() => {
    if (!active) return;
    let canceled = false;
    let timer;
    async function poll() {
      try {
        const prefix = 'groups/' + group.id;
        const [rooms, pending, people] = await Promise.all([
          request(prefix + '/rooms'), legacy && owner && session.identity ? request(prefix + '/pending') : [],
          request(prefix + '/people'),
        ]);
        const record = legacy && session.identity ? await syncGroup(session.account, group) : null;
        if (!canceled) {
          update(group.id, record, pending, people);
          setRoomList({ id: group.id, rooms });
        }
      } catch (problem) {
        if (!canceled && problem.status !== 404) report(problem);
      }
      if (!canceled) timer = setTimeout(poll, 1800);
    }
    void poll();
    return () => { canceled = true; clearTimeout(timer); };
  }, [active, legacy, group?.id, group?.ownerSigning, group?.owner, owner, session, report]);

  function switchGroup(id) {
    enter(null);
    setContactId(null);
    select(id);
    setTab('rooms');
    setError('');
  }
  function openContact(person) {
    switchGroup(null);
    setContactId(person.id);
  }

  function enterRoom(item) {
    enter(item);
    setError('');
  }

  function open(kind, target = null) {
    setRoomToRename(target);
    setError('');
    setLink('');
    setCopied(false);
    setDialog(kind);
  }
  async function run(action) {
    if (busy) return false;
    setBusy(true);
    setError('');
    try { await action(); return true; }
    catch (problem) { report(problem); return false; }
    finally { setBusy(false); }
  }
  async function save(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    await run(async () => {
      if (dialog === 'group') {
        const created = await newGroup(data.name.trim());
        await refreshGroups();
        switchGroup(created.id);
        setDialog(null);
      } else if (dialog === 'invite') {
        setLink(await makeInvite(group, data.role));
      } else if (dialog === 'rename') {
        const updated = await request('groups/' + group.id + '/rooms/' + roomToRename.id + '/rename', { name: data.name });
        setRoomList((current) => current.id === group.id
          ? { ...current, rooms: current.rooms.map((item) => item.id === updated.id ? updated : item) }
          : current);
        setDialog(null);
      } else {
        const mode = dialog === 'live' ? 'live' : data.mode;
        const created = await request('groups/' + group.id + '/rooms', { name: data.name, mode });
        setRoomList((current) => ({ id: group.id, rooms: [created, ...(current.id === group.id ? current.rooms : [])] }));
        enter(created);
        setDialog(null);
      }
    });
  }
  async function membership(person, kind) {
    if (kind !== 'add' && !window.confirm((kind === 'ban' ? 'Banir ' : 'Remover ') + person.name + ' do grupo?')) return;
    await run(async () => {
      if (legacy) {
        const updated = await changeMembership(session, group, person, kind);
        const pending = await request('groups/' + group.id + '/pending');
        update(group.id, updated, pending);
      } else {
        const path = 'groups/' + group.id + '/people';
        await request(path, { target: person.id, action: kind });
        update(group.id, null, [], await request(path));
      }
    });
  }
  async function claim() {
    await run(async () => {
      await requestAdmission(session, invitation);
      await refreshGroups();
      switchGroup(invitation.group);
      clearInvite();
    });
  }

  function changeFriends(path, body) {
    return run(async () => {
      await request(path, body);
      setFriends(await request('friends'));
    });
  }

  return <div className="workspace">
    <Sidebar groups={groups} group={group} groupRooms={roomListForGroup} room={activeRoom} contact={contact} session={session} appearance={appearance}
      canJoin={canJoin} friendsNotice={friendsNotice} showFriends={() => switchGroup(null)}
      select={switchGroup} enter={enterRoom} create={open}
      logout={() => run(async () => { await request('logout', {}); onLogout(); })} />
    <main className="main-panel">
      <header className="workspace-header">
        <div>
          {activeRoom && <button className="breadcrumb" onClick={() => enter(null)}><ArrowLeft size={16} aria-hidden="true" /> {group.name}</button>}
          {contact && <button className="breadcrumb" onClick={() => setContactId(null)}><ArrowLeft size={16} aria-hidden="true" /> Amigos</button>}
          <h1>{activeRoom?.name ?? group?.name ?? contact?.name ?? 'Amigos'}</h1>
        </div>
        {active && !activeRoom && <div className="header-actions">
          {canJoin && <button onClick={() => open('room')}><Plus size={17} /> Nova sala</button>}
          {owner && canJoin && <button className="primary" onClick={() => open('invite')}><Users size={19} /> Convidar</button>}
        </div>}
      </header>
      {error && !dialog && <div className="error warning-bar" role="alert">{error}<button className="text-button" onClick={() => setError('')}>Fechar</button></div>}
      {invitation && <div className="notice"><p>Você recebeu um convite para um grupo.</p>
        <button className="primary" onClick={claim} disabled={busy}>Solicitar entrada <ArrowUpRight size={16} /></button></div>}
      {contact ? <Meeting key={contact.roomId} room={{ id: contact.roomId, mode: 'meet' }}
        group={{ id: contact.roomId, chat_mode: 'contact' }} session={session} leave={() => setContactId(null)} report={report} />
        : !group ? <Friends people={friends} ready={ready} busy={busy} enter={openContact}
          send={(username) => changeFriends('friends', { username })}
          update={(person, action) => changeFriends('friends/action', { id: person.id, action })} />
        : activeRoom ? <Meeting key={activeRoom.id} room={activeRoom} group={group} session={session} verified={record?.roster}
          leave={() => enter(null)} report={report} createLive={() => open('live')} />
        : active ? <section className="group-view" aria-label="Gerenciamento do grupo">
          <div className="pane-tabs" aria-label="Seções do grupo">
            <button aria-pressed={tab === 'rooms'} onClick={() => setTab('rooms')}>Salas <span>{roomListForGroup.length}</span></button>
            {legacy && session.identity && <button aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}>Chat do grupo</button>}
            <button aria-pressed={tab === 'people'} onClick={() => setTab('people')}>Pessoas
              {snapshot?.pending.length > 0 && <span>{snapshot.pending.length}</span>}</button>
          </div>
          {tab === 'rooms'
            ? <GroupRooms rooms={roomListForGroup} ready={roomList.id === group.id} canJoin={canJoin} enter={enterRoom}
              canManage={canJoin && canManageRooms} rename={(item) => open('rename', item)} />
            : legacy && session.identity && tab === 'chat' ? <Conversation key={group.id} messages={record?.messages ?? []} roster={record?.roster ?? []}
            available={Boolean(record)} busy={busy} label="Chat do grupo" empty={record ? 'Nenhuma mensagem no grupo.' : 'Sincronizando as chaves do grupo…'}
            onSend={(text) => run(async () => update(group.id, await postGroupMessage(session, group, text)))} />
            : <People roster={record?.roster ?? snapshot?.people ?? []} pending={snapshot?.pending} busy={busy}
              verified={!!record} approve={(person) => membership(person, 'add')}
              change={owner && canJoin ? membership : undefined} />}
          {legacy && !session.identity && <p className="group-hint muted">O histórico e as salas deste grupo cifrado usam as chaves do navegador original.</p>}
        </section>
        : <section className="empty-workspace">
          <div className="empty-symbol"><LockKeyhole size={38} /></div>
          <h2>Aguardando aprovação</h2>
          <p>O dono do grupo precisa aprovar a entrada deste dispositivo.</p>
        </section>}
    </main>
    {dialog && <Modal title={{ group: 'Novo grupo', room: 'Nova sala', live: 'Nova live', invite: 'Convidar para o grupo', rename: 'Renomear sala' }[dialog]}
      close={() => { if (!busy) setDialog(null); }}>
      <form onSubmit={save}>
        {dialog === 'invite' ? <>
          <label>Papel<select name="role"><option value="member">Membro</option><option value="moderator">Moderador</option></select></label>
          {link && <label>Link de convite<input value={link} readOnly onFocus={(event) => event.target.select()} /></label>}
          <p className="muted">O link vale por 24 horas e pode ser usado uma vez.{legacy && ' O dono aprova a entrada neste grupo cifrado.'}</p>
        </> : <>
          <label>Nome<input name="name" autoFocus required maxLength={80} defaultValue={roomToRename?.name} /></label>
          {dialog === 'room' && <label>Tipo<select name="mode"><option value="meet">Reunião</option><option value="live">Live</option></select></label>}
        </>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={() => setDialog(null)} disabled={busy}>{link ? 'Fechar' : 'Cancelar'}</button>
          {link ? <button type="button" className="primary" onClick={() => navigator.clipboard.writeText(link)
            .then(() => setCopied(true)).catch(report)}>{copied ? 'Copiado' : 'Copiar link'}</button>
            : <button className="primary" disabled={busy}>{dialog === 'invite' ? 'Gerar convite' : dialog === 'rename' ? 'Salvar nome' : 'Criar'}</button>}
        </div>
      </form>
    </Modal>}
  </div>;
}

const themes = ['system', 'light', 'dark'];
const savedTheme = readPreference('theme');
const initialTheme = themes.includes(savedTheme) ? savedTheme : 'system';
document.documentElement.dataset.theme = initialTheme;

function App() {
  const [theme, setTheme] = useState(initialTheme);
  const appearance = <ThemePicker theme={theme} change={(value) => {
    document.documentElement.dataset.theme = value;
    writePreference('theme', value);
    setTheme(value);
  }} />;
  const [session, setSession] = useState(null);
  const [state, setState] = useState(null);
  const [problem, setProblem] = useState('');
  const [invite, setInvite] = useState(() => readInvite());
  useEffect(() => {
    const update = () => setInvite(readInvite());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const exit = useCallback(() => { setSession(null); setState({ bootstrap: false, signup: true }); }, []);
  useEffect(() => {
    async function boot() {
      try {
        if (!window.isSecureContext || !navigator.locks) throw Error('Use HTTPS ou localhost em um navegador compatível.');
        const status = await request('session');
        if (status.account) setSession(await restore(status.account));
        setState(status);
      } catch (error) { setProblem(error.message); }
    }
    void boot();
  }, []);
  if (problem) return <main className="startup"><Brand /><p role="alert"><CircleHelp size={20} /> {problem}</p></main>;
  if (!state) return <main className="startup"><Brand /><p role="status">Carregando…</p></main>;
  return session
    ? <Dashboard session={session} invite={invite} clearInvite={() => setInvite(null)} onLogout={exit} appearance={appearance} />
    : <Access bootstrap={state.bootstrap} signup={state.signup} invite={invite} appearance={appearance}
        onSession={(value) => { setSession(value); setInvite(readInvite()); }} />;
}

createRoot(document.getElementById('root')).render(<App />);
