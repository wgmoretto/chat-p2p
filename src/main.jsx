import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, CircleHelp, LockKeyhole, LogOut, MessageSquare, Plus, Radio, Users, Video } from 'lucide-react';
import { request } from './local.mjs';
import { changeMembership, makeInvite, newGroup, postGroupMessage, readInvite,
  requestAdmission, restore, syncGroup } from './workspace.mjs';
import { Access, Brand, Conversation, initials, Modal, People } from './views.jsx';
import { Meeting } from './Meeting.jsx';
import './style.css';

function Sidebar({ groups, group, groupRooms, room, select, enter, create, logout, session }) {
  return <aside className="sidebar">
    <Brand />
    <nav aria-label="Grupos e salas">
      <div className="nav-heading"><h2>Grupos</h2><button className="icon" aria-label="Novo grupo" onClick={() => create('group')}><Plus size={19} /></button></div>
      <ul>{groups.map((item) => <li key={item.id}><button className="nav-item" aria-current={item.id === group?.id ? 'true' : undefined}
        onClick={() => select(item.id)}><Users size={19} /><span>{item.name}</span></button></li>)}</ul>
      {group?.status === 'active' && <>
        <div className="nav-heading"><h2>Salas</h2><button className="icon" aria-label="Nova sala" onClick={() => create('room')}><Plus size={19} /></button></div>
        <ul>{groupRooms.map((item) => <li key={item.id}><button className="nav-item" aria-current={item.id === room?.id ? 'true' : undefined}
          onClick={() => enter(item)}>{item.mode === 'live' ? <Radio size={19} /> : <Video size={19} />}<span>{item.name}</span></button></li>)}</ul>
        {!groupRooms.length && <p className="nav-empty">Nenhuma sala neste grupo</p>}
      </>}
    </nav>
    <div className="account">
      <span className="avatar solid" aria-hidden="true">{initials(session.account.name)}</span>
      <div><strong>{session.account.name}</strong><small>@{session.account.username}</small></div>
      <button className="icon" onClick={logout} aria-label="Sair da conta"><LogOut size={19} /></button>
    </div>
  </aside>;
}

function Dashboard({ session, invite, onLogout }) {
  const [groups, setGroups] = useState([]);
  const [selected, select] = useState(null);
  const [room, enter] = useState(null);
  const [roomList, setRoomList] = useState({ id: null, rooms: [] });
  const [groupView, setGroupView] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState('chat');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [invitation, setInvitation] = useState(invite);
  const report = useCallback((problem) => setError(problem.message || String(problem)), []);

  const group = groups.find(({ id }) => id === selected) ?? groups[0];
  const active = group?.status === 'active';
  const owner = group?.role === 'owner';
  const record = groupView?.id === group?.id ? groupView?.record : null;
  const roomListForGroup = roomList.id === group?.id ? roomList.rooms : [];
  const activeRoom = active && roomListForGroup.some(({ id }) => id === room?.id) ? room : null;

  const refreshGroups = useCallback(async () => { setGroups(await request('groups')); setReady(true); }, []);
  const update = (id, data, pending) => setGroupView((current) => {
    if (current?.id === id && data.seq < current.record.seq) return current;
    return { id, record: data, pending: pending ?? (current?.id === id ? current.pending : []) };
  });

  useEffect(() => {
    let canceled = false;
    let timer;
    async function poll() {
      try {
        const list = await request('groups');
        if (!canceled) { setGroups(list); setReady(true); }
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
        const [data, rooms, pending] = await Promise.all([
          syncGroup(session.account, group), request(prefix + '/rooms'), owner ? request(prefix + '/pending') : [],
        ]);
        if (!canceled) {
          update(group.id, data, pending);
          setRoomList({ id: group.id, rooms });
        }
      } catch (problem) {
        if (!canceled && problem.status !== 404) report(problem);
      }
      if (!canceled) timer = setTimeout(poll, 1800);
    }
    void poll();
    return () => { canceled = true; clearTimeout(timer); };
  }, [active, group?.id, group?.ownerSigning, group?.owner, owner, session.account, report]);

  function switchGroup(id) {
    enter(null);
    select(id);
    setTab('chat');
    setError('');
  }
  function open(kind) {
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
        const created = await newGroup(session, data.name.trim());
        await refreshGroups();
        switchGroup(created.id);
        setDialog(null);
      } else if (dialog === 'invite') {
        setLink(await makeInvite(group, data.role));
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
      const updated = await changeMembership(session, group, person, kind);
      const pending = await request('groups/' + group.id + '/pending');
      update(group.id, updated, pending);
    });
  }
  async function claim() {
    await run(async () => {
      await requestAdmission(session, invitation);
      await refreshGroups();
      switchGroup(invitation.group);
      setInvitation(null);
    });
  }

  return <div className="workspace">
    <Sidebar groups={groups} group={group} groupRooms={roomListForGroup} room={activeRoom} session={session}
      select={switchGroup} enter={(item) => { enter(item); setError(''); }} create={open}
      logout={() => run(async () => { await request('logout', {}); onLogout(); })} />
    <main className="main-panel">
      <header className="workspace-header">
        <div>
          {activeRoom && <button className="breadcrumb" onClick={() => enter(null)}>{group.name} <span aria-hidden="true">›</span></button>}
          <h1>{activeRoom?.name ?? group?.name ?? 'Seus grupos'}</h1>
        </div>
        {active && <div className="header-actions">
          {!activeRoom && <button onClick={() => open('room')}><Plus size={17} /> Nova sala</button>}
          {owner && <button className="primary" onClick={() => open('invite')}><Users size={19} /> Convidar</button>}
        </div>}
      </header>
      {error && !dialog && <div className="error warning-bar" role="alert">{error}<button className="text-button" onClick={() => setError('')}>Fechar</button></div>}
      {invitation && <div className="notice"><p>Você recebeu um convite para um grupo.</p>
        <button className="primary" onClick={claim} disabled={busy}>Solicitar entrada <ArrowUpRight size={16} /></button></div>}
      {activeRoom && record ? <Meeting key={activeRoom.id} room={activeRoom} group={group} session={session} record={record}
        leave={() => enter(null)} report={report} createLive={() => open('live')} />
        : active ? <section className="group-view" aria-label="Conversa do grupo">
          <div className="pane-tabs">
            <button aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}>Chat do grupo</button>
            <button aria-pressed={tab === 'people'} onClick={() => setTab('people')}>Pessoas
              {groupView?.id === group.id && groupView.pending.length > 0 && <span>{groupView.pending.length}</span>}</button>
          </div>
          {tab === 'chat' ? <Conversation key={group.id} messages={record?.messages ?? []} roster={record?.roster ?? []}
            available={Boolean(record)} busy={busy} label="Chat do grupo" empty={record ? 'Nenhuma mensagem no grupo.' : 'Sincronizando as chaves do grupo…'}
            onSend={(text) => run(async () => update(group.id, await postGroupMessage(session, group, text)))} />
            : <People roster={record?.roster ?? []} pending={groupView?.id === group.id ? groupView.pending : []} busy={busy}
              approve={(person) => membership(person, 'add')} change={owner ? membership : undefined} />}
        </section>
        : <section className="empty-workspace">
          <div className="empty-symbol">{group ? <LockKeyhole size={38} /> : <MessageSquare size={38} />}</div>
          <h2>{group ? 'Aguardando aprovação' : ready ? 'Crie um grupo para começar' : 'Carregando grupos…'}</h2>
          {group ? <p>O dono do grupo precisa aprovar a entrada deste dispositivo.</p>
            : ready && <button className="primary" onClick={() => open('group')}><Plus size={19} /> Novo grupo</button>}
        </section>}
    </main>
    {dialog && <Modal title={{ group: 'Novo grupo', room: 'Nova sala', live: 'Nova live', invite: 'Convidar para o grupo' }[dialog]}
      close={() => { if (!busy) setDialog(null); }}>
      <form onSubmit={save}>
        {dialog === 'invite' ? <>
          <label>Papel<select name="role"><option value="member">Membro</option><option value="moderator">Moderador</option></select></label>
          {link && <label>Link de convite<input value={link} readOnly onFocus={(event) => event.target.select()} /></label>}
          <p className="muted">O link vale por 24 horas e pode ser usado uma vez. A entrada precisa ser aprovada pelo dono.</p>
        </> : <>
          <label>Nome<input name="name" autoFocus required maxLength={80} /></label>
          {dialog === 'room' && <label>Tipo<select name="mode"><option value="meet">Reunião</option><option value="live">Live</option></select></label>}
        </>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={() => setDialog(null)} disabled={busy}>{link ? 'Fechar' : 'Cancelar'}</button>
          {link ? <button type="button" className="primary" onClick={() => navigator.clipboard.writeText(link)
            .then(() => setCopied(true)).catch(report)}>{copied ? 'Copiado' : 'Copiar link'}</button>
            : <button className="primary" disabled={busy}>{dialog === 'invite' ? 'Gerar convite' : 'Criar'}</button>}
        </div>
      </form>
    </Modal>}
  </div>;
}

function App() {
  const [session, setSession] = useState(null);
  const [state, setState] = useState(null);
  const [problem, setProblem] = useState('');
  const invite = readInvite();
  const exit = useCallback(() => { setSession(null); setState({ bootstrap: false }); }, []);
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
    ? <Dashboard session={session} invite={invite} onLogout={exit} />
    : <Access bootstrap={state.bootstrap} invite={invite} onSession={setSession} />;
}

createRoot(document.getElementById('root')).render(<App />);
