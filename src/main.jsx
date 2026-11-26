import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeft, ArrowUpRight, Bell, CircleHelp, LockKeyhole, Pencil, Phone, Plus, UserMinus, Users } from 'lucide-react';
import { readPreference, request, writePreference } from './local.mjs';
import { changeMembership, makeInvite, newGroup, postGroupMessage, readInvite,
  requestAdmission, restore, syncGroup } from './workspace.mjs';
import { Access, Brand, Conversation, initials, Modal, People, roomTypes, ThemePicker } from './views.jsx';
import { Meeting } from './Meeting.jsx';
import { Activity, Inbox } from './Inbox.jsx';
import { unlockChat } from './inbox.mjs';
import { Presence, WorkspaceRail } from './WorkspaceRail.jsx';
import './style.css';

function GroupRooms({ rooms, ready, canJoin, enter, canManage, rename }) {
  return <div className="group-rooms">
    <h2>Salas do grupo</h2>
    {!rooms.length && <p className="muted">{ready ? 'Nenhuma sala neste grupo.' : 'Carregando salas…'}</p>}
    <ul>{rooms.map((item) => {
      const { icon: Icon, label } = roomTypes[item.mode];
      return <li key={item.id}>
        <span className="room-symbol"><Icon size={19} aria-hidden="true" /></span>
        <span className="person-label"><strong>{item.name}</strong><small>{label}</small></span>
        <div className="room-actions">
          {canManage && <button className="icon" aria-label={'Renomear ' + item.name} title="Renomear sala" onClick={() => rename(item)}><Pencil size={17} /></button>}
          <button aria-label={'Entrar em ' + item.name} disabled={!canJoin} onClick={() => enter(item)}>Entrar <ArrowUpRight size={16} /></button>
        </div>
      </li>;
    })}</ul>
  </div>;
}

function Dashboard({ session, invite: invitation, clearInvite, onLogout, appearance, setChatKey }) {
  const [groups, setGroups] = useState([]);
  const [friends, setFriends] = useState([]);
  const [contactId, setContactId] = useState(null);
  const [contactCall, setContactCall] = useState(false);
  const [invites, setInvites] = useState([]);
  const [roomUnread, setRoomUnread] = useState({});
  const [selected, select] = useState(null);
  const [room, enter] = useState(null);
  const [roomList, setRoomList] = useState({ id: null, rooms: [] });
  const [groupView, setGroupView] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [inviteMethod, setInviteMethod] = useState('friend');
  const [feedback, setFeedback] = useState('');
  const [roomToRename, setRoomToRename] = useState(null);
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState('chat');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const feed = useRef(0);
  const appliedFeed = useRef(0);
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
  const notice = invites.length + friends.filter(({ roomId, incoming, calling, id }) =>
    (!roomId && incoming) || (calling && id !== contactId)).length;
  const invitees = friends.filter((person) => person.roomId &&
    !snapshot?.people.some(({ id }) => id === person.id) && !snapshot?.pending.some(({ id }) => id === person.id));

  const refreshWorkspace = useCallback(async () => {
    const ticket = ++feed.current;
    const next = await request('workspace');
    if (ticket < appliedFeed.current) return;
    appliedFeed.current = ticket;
    setGroups(next.groups);
    setFriends(next.friends);
    setInvites(next.invites);
    setRoomUnread(next.roomUnread ?? {});
    setReady(true);
  }, []);

  const onRead = useCallback(() => { void refreshWorkspace().catch(report); }, [refreshWorkspace, report]);
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
        await refreshWorkspace();
      } catch (problem) {
        if (canceled) return;
        if (problem.status === 401) { onLogout(); return; }
        report(problem);
      }
      if (!canceled) timer = setTimeout(poll, 1600);
    }
    const resume = () => { if (document.visibilityState === 'visible') void refreshWorkspace().catch(report); };
    void poll();
    document.addEventListener('visibilitychange', resume);
    return () => { canceled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', resume); };
  }, [report, onLogout, refreshWorkspace]);

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

  const legacyRead = legacy && !activeRoom && tab === 'chat' ? record?.seq : null;
  useEffect(() => {
    if (!legacyRead) return;
    const mark = () => {
      if (document.visibilityState === 'visible')
        request('groups/' + group.id + '/read', { seq: legacyRead }).then(onRead).catch(report);
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [legacyRead, group?.id, onRead, report]);

  function switchGroup(id) {
    enter(null);
    setContactId(null);
    setContactCall(false);
    select(id);
    setTab('chat');
    setError('');
    setFeedback('');
  }
  function openContact(person, call = false) {
    if (contact?.id === person.id && !call) return;
    switchGroup(null);
    setContactId(person.id);
    setContactCall(call);
  }

  function enterRoom(item) {
    enter(item);
    setError('');
    setFeedback('');
  }

  function open(kind, target = null) {
    setRoomToRename(target);
    if (kind === 'invite') setInviteMethod(invitees.length ? 'friend' : 'link');
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
        await refreshWorkspace();
        switchGroup(created.id);
        setDialog(null);
      } else if (dialog === 'friend') {
        await request('friends', { username: data.username });
        await refreshWorkspace();
        setFeedback('Pedido de amizade enviado.');
        setDialog(null);
      } else if (dialog === 'unlock') {
        setChatKey(await unlockChat(session.account, data.password));
        await refreshWorkspace();
        setDialog(null);
      } else if (dialog === 'remove-friend') {
        await request('friends/action', { id: contact.id, action: 'remove' });
        await refreshWorkspace();
        switchGroup(null);
        setDialog(null);
      } else if (dialog === 'invite') {
        if (inviteMethod === 'link') setLink(await makeInvite(group, data.role));
        else {
          await request('groups/' + group.id + '/invite-friend', { role: data.role, target: data.target });
          setFeedback('Convite enviado. Seu amigo pode aceitá-lo em Atividade.');
          setDialog(null);
        }
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
        enterRoom(created);
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
      await refreshWorkspace();
      switchGroup(invitation.group);
      clearInvite();
    });
  }

  function changeFriend(person, action) {
    return run(async () => {
      await request('friends/action', { id: person.id, action });
      await refreshWorkspace();
    });
  }

  function respondToInvite(item, accept) {
    return run(async () => {
      if (accept) await requestAdmission(session, item, false);
      else await request('invitations/decline', { token: item.token });
      await refreshWorkspace();
      if (accept) switchGroup(item.group);
    });
  }

  const isTextRoom = activeRoom?.mode === 'text';
  const surface = activeRoom && !isTextRoom || contact && contactCall ? 'meeting'
    : contact || active ? 'conversation' : 'activity';
  const HeaderIcon = activeRoom ? roomTypes[activeRoom.mode].icon : group ? Users : Bell;

  return <div className="workspace">
    <WorkspaceRail groups={groups} friends={friends} group={group} groupRooms={roomListForGroup} room={activeRoom} roomUnread={roomUnread}
      contact={contact} session={session} appearance={appearance} ready={ready}
      canJoin={canJoin} notice={notice} showActivity={() => switchGroup(null)} openContact={openContact}
      select={switchGroup} enter={enterRoom} create={open}
      logout={() => run(async () => { await request('logout', {}); onLogout(); })} />
    <main className="main-panel" data-surface={surface}>
      <header className="workspace-header">
        <div className="workspace-identity">
          {activeRoom && <button className="breadcrumb" onClick={() => enter(null)}><ArrowLeft size={16} aria-hidden="true" /> {group.name}</button>}
          {contactCall && contact && <button className="breadcrumb" onClick={() => setContactCall(false)}><ArrowLeft size={16} aria-hidden="true" /> Conversa</button>}
          {contact ? <div className="thread-heading">
            <span className="avatar" aria-hidden="true">{initials(contact.name)}</span>
            <div><h1>{contact.name}</h1><Presence person={contact} /></div>
          </div> : <div className="thread-heading">
            <span className="header-symbol"><HeaderIcon size={20} aria-hidden="true" /></span>
            <div>
              <h1>{activeRoom?.name ?? group?.name ?? 'Atividade'}</h1>
              {group && <small>{activeRoom ? roomTypes[activeRoom.mode].label : 'Grupo privado'}</small>}
            </div>
          </div>}
        </div>
        {contact && !contactCall && <div className="header-actions">
          <button className="icon" aria-label="Remover amigo" title="Remover amigo" onClick={() => open('remove-friend')}><UserMinus size={18} /></button>
          <button className="primary" onClick={() => setContactCall(true)}><Phone size={17} /> {contact.calling ? 'Atender' : 'Ligar'}</button>
        </div>}
        {active && !activeRoom && <div className="header-actions">
          {canJoin && <button onClick={() => open('room')}><Plus size={17} /> Nova sala</button>}
          {owner && canJoin && <button className="primary" onClick={() => open('invite')}><Users size={19} /> Convidar</button>}
        </div>}
      </header>
      {error && !dialog && <div className="error warning-bar" role="alert">{error}<button className="text-button" onClick={() => setError('')}>Fechar</button></div>}
      {feedback && <div className="notice" role="status">{feedback}<button className="text-button" onClick={() => setFeedback('')}>Fechar</button></div>}
      {invitation && <div className="notice"><p>Você recebeu um convite para um grupo.</p>
        <button className="primary" onClick={claim} disabled={busy}>Solicitar entrada <ArrowUpRight size={16} /></button></div>}
      {contact ? contactCall
        ? <Meeting key={contact.roomId} room={{ id: contact.roomId, mode: 'meet' }}
          group={{ id: contact.roomId, chat_mode: 'contact' }} session={session} leave={() => setContactCall(false)} report={report} />
        : <section className="group-view direct-thread" aria-label="Conversa individual">
          <Inbox key={contact.roomId} id={contact.roomId} contact session={session} unlock={() => open('unlock')} report={report} onRead={onRead} />
        </section>
        : !group ? <Activity friends={friends} invites={invites} ready={ready} busy={busy} add={() => open('friend')}
          reply={changeFriend} respond={respondToInvite} open={openContact} />
        : isTextRoom ? <section className="group-view direct-thread" aria-label="Sala de texto">
          <Inbox key={activeRoom.id} id={activeRoom.id} label={activeRoom.name} session={session}
            unlock={() => open('unlock')} report={report} onRead={onRead} />
        </section>
        : activeRoom ? <Meeting key={activeRoom.id} room={activeRoom} group={group} session={session} verified={record?.roster}
          leave={() => enter(null)} report={report} createLive={() => open('live')} />
        : active ? <section className="group-view" aria-label="Gerenciamento do grupo">
          <div className="pane-tabs" aria-label="Seções do grupo">
            <button aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}>Chat do grupo</button>
            <button aria-pressed={tab === 'rooms'} onClick={() => setTab('rooms')}>Salas <span>{roomListForGroup.length}</span></button>
            <button aria-pressed={tab === 'people'} onClick={() => setTab('people')}>Pessoas
              {snapshot?.pending.length > 0 && <span>{snapshot.pending.length}</span>}</button>
          </div>
          {tab === 'rooms'
            ? <GroupRooms rooms={roomListForGroup} ready={roomList.id === group.id} canJoin={canJoin} enter={enterRoom}
              canManage={canJoin && canManageRooms} rename={(item) => open('rename', item)} />
            : tab === 'chat' ? (!legacy
              ? <Inbox key={group.id} id={group.id} session={session} unlock={() => open('unlock')} report={report} onRead={onRead} />
              : session.identity ? <Conversation key={group.id} messages={record?.messages ?? []} roster={record?.roster ?? []}
                self={session.account.id} available={Boolean(record)} busy={busy} label="Chat do grupo"
                empty={record ? 'Nenhuma mensagem no grupo.' : 'Sincronizando as chaves do grupo…'}
                onSend={(text) => run(async () => update(group.id, await postGroupMessage(session, group, text)))} />
                : <div className="inbox-locked"><LockKeyhole size={25} /><p>Abra este grupo no navegador com as chaves originais.</p></div>)
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
    {dialog && <Modal title={{
      group: 'Novo grupo', room: 'Nova sala', live: 'Nova live', invite: 'Convidar para o grupo', rename: 'Renomear sala',
      friend: 'Adicionar amigo', unlock: 'Desbloquear histórico', 'remove-friend': 'Remover amigo',
    }[dialog]}
      close={() => { if (!busy) setDialog(null); }}>
      <form onSubmit={save}>
        {dialog === 'friend' ? <label>Adicionar pelo @usuário<input name="username" autoFocus placeholder="@usuário"
          required maxLength={33} autoComplete="off" /></label>
          : dialog === 'unlock' ? <label>Senha<input name="password" type="password" autoComplete="current-password"
            autoFocus required minLength={12} maxLength={200} /></label>
          : dialog === 'remove-friend' ? <p>Remover {contact?.name} da sua lista de amigos encerra o acesso à conversa atual.</p>
          : dialog === 'invite' ? <>
          <div className="form-switch" aria-label="Modo de convite">
            <button type="button" aria-pressed={inviteMethod === 'friend'} onClick={() => { setInviteMethod('friend'); setLink(''); }}>Convidar amigo</button>
            <button type="button" aria-pressed={inviteMethod === 'link'} onClick={() => setInviteMethod('link')}>Por link</button>
          </div>
          {inviteMethod === 'friend' && <label>Amigo<select name="target" required defaultValue="">
            <option value="" disabled>{invitees.length ? 'Selecione um amigo' : 'Nenhum amigo disponível'}</option>
            {invitees.map((person) => <option key={person.id} value={person.id}>{person.name} (@{person.username})</option>)}
          </select></label>}
          <label>Papel<select name="role"><option value="member">Membro</option><option value="moderator">Moderador</option></select></label>
          {link && <label>Link de convite<input value={link} readOnly onFocus={(event) => event.target.select()} /></label>}
          <p className="muted">{inviteMethod === 'link' ? 'O link vale por 24 horas e pode ser usado uma vez.'
            : 'O convite aparece na Atividade do seu amigo e vale por 24 horas.'}{legacy && ' O dono aprova a entrada neste grupo cifrado.'}</p>
        </> : <>
          <label>Nome<input name="name" autoFocus required maxLength={80} defaultValue={roomToRename?.name} /></label>
          {dialog === 'room' && <label>Tipo<select name="mode">
            {Object.entries(roomTypes).map(([mode, { label }]) => <option key={mode} value={mode}>{label}</option>)}
          </select></label>}
        </>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={() => setDialog(null)} disabled={busy}>{link ? 'Fechar' : 'Cancelar'}</button>
          {link ? <button type="button" className="primary" onClick={() => navigator.clipboard.writeText(link)
            .then(() => setCopied(true)).catch(report)}>{copied ? 'Copiado' : 'Copiar link'}</button>
            : <button className={dialog === 'remove-friend' ? 'danger' : 'primary'}
              disabled={busy || dialog === 'invite' && inviteMethod === 'friend' && !invitees.length}>
              {dialog === 'invite' ? (inviteMethod === 'link' ? 'Gerar convite' : 'Enviar convite')
                : ({ rename: 'Salvar nome', friend: 'Enviar pedido', unlock: 'Desbloquear', 'remove-friend': 'Remover amigo' }[dialog] ?? 'Criar')}
            </button>}
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
    ? <Dashboard session={session} invite={invite} clearInvite={() => setInvite(null)} onLogout={exit} appearance={appearance}
        setChatKey={(chatKey) => setSession((current) => ({ ...current, chatKey }))} />
    : <Access bootstrap={state.bootstrap} signup={state.signup} invite={invite} appearance={appearance}
        onSession={(value) => { setSession(value); setInvite(readInvite()); }} />;
}

createRoot(document.getElementById('root')).render(<App />);
