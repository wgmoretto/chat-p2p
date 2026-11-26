import React, { useEffect, useRef, useState } from 'react';
import { AudioLines, Camera, CameraOff, Crown, Maximize, MessageSquare, Mic, MicOff, Minimize, MonitorUp, PhoneOff, Radio, ScreenShareOff, Users, Video, X } from 'lucide-react';
import { RoomConnection, videoProfiles } from './room.mjs';
import { request } from './local.mjs';
import { Conversation, initials } from './views.jsx';

function Media({ stream, muted, audio = false, label, onResolution }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.srcObject = stream;
    const video = ref.current;
    void video.play().catch(() => {});
    return () => { video.srcObject = null; };
  }, [stream]);
  return audio
    ? <audio ref={ref} autoPlay aria-label={label} />
    : <video ref={ref} autoPlay playsInline muted={muted} aria-label={label}
      onResize={onResolution} onLoadedMetadata={onResolution} />;
}

function StreamViewer({ stream, label, close }) {
  const ref = useRef(null);
  const content = useRef(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [resolution, setResolution] = useState('');
  useEffect(() => {
    const dialog = ref.current;
    const sync = () => setFullscreen(document.fullscreenElement === content.current);
    dialog.showModal();
    document.addEventListener('fullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      if (dialog.open) dialog.close();
    };
  }, []);

  function readResolution({ currentTarget: { videoWidth, videoHeight } }) {
    if (videoWidth && videoHeight) setResolution(videoWidth + ' × ' + videoHeight);
  }

  function dismiss() {
    ref.current.close();
    close();
  }

  async function toggleFullscreen() {
    try {
      if (fullscreen) await document.exitFullscreen();
      else await content.current.requestFullscreen();
    } catch {
      // The dialog already fills the viewport when the browser blocks native fullscreen.
    }
  }

  return <dialog ref={ref} className="stream-viewer" aria-label={label} onCancel={(event) => { event.preventDefault(); dismiss(); }}>
    <div className="stream-viewer-content" ref={content}>
      <header>
        <div><h2>{label}</h2>{resolution && <small>Resolução atual: {resolution}</small>}</div>
        <div className="stream-actions">
          {document.fullscreenEnabled && <button onClick={toggleFullscreen} aria-label={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}>
            {fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
            <span>{fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}</span>
          </button>}
          <button autoFocus title="Fechar visualização" aria-label="Fechar visualização" onClick={dismiss}><X size={21} /></button>
        </div>
      </header>
      <Media stream={stream} muted label={label} onResolution={readResolution} />
    </div>
  </dialog>;
}

function VisualStream({ stream, label }) {
  const [expanded, setExpanded] = useState(false);
  return <>
    <Media stream={stream} muted label={label} />
    <button className="stream-expand" aria-label={'Maximizar ' + label.toLocaleLowerCase('pt-BR')}
      title="Maximizar" onClick={() => setExpanded(true)}><Maximize size={17} /></button>
    {expanded && <StreamViewer stream={stream} label={label} close={() => setExpanded(false)} />}
  </>;
}

function Tile({ person, host }) {
  const camera = person.media.camera;
  return <div className="tile">
    {camera ? <VisualStream stream={camera} label={'Câmera de ' + person.name} />
      : <span aria-hidden="true" className="tile-avatar">{initials(person.name)}</span>}
    {!person.self && person.media.mic && <Media audio stream={person.media.mic} label={'Áudio de ' + person.name} />}
    <span className="tile-label">{person.name}{person.self ? ' (você)' : ''}{host && <Crown size={14} aria-label="Host" />}</span>
  </div>;
}

function RoomPeople({ state, session, connection, report }) {
  const self = state.people.find(({ self }) => self);
  const role = self?.role ?? 'member';
  const action = (type, person) => {
    if (type === 'host.transfer') connection.send({ type, target: person.id, term: state.term });
    else if (!connection.send({ type: 'moderate', action: type, target: person.id })) report(Error('A sala está desconectada.'));
  };
  return <div className="people-list">
    <h3><Users size={17} /> Pessoas na sala</h3>
    <ul>{state.people.map((person) => <li key={person.id}>
      <span className="avatar" aria-hidden="true">{initials(person.name)}</span>
      <span className="person-label"><strong>{person.name}</strong>
        <small>{person.id === state.host ? 'Host da sessão' : person.role === 'moderator' ? 'Moderador' : 'Participante'}
          {person.muted ? ' · Silenciado' : ''}{person.videoBlocked ? ' · Vídeo bloqueado' : ''}</small></span>
      {!person.self && (role === 'owner' || role === 'moderator' && person.role === 'member' || state.host === session.account.id) &&
        <select aria-label={'Ações para ' + person.name} value="" onChange={(event) => action(event.target.value, person)}>
          <option value="">Ações</option>
          {state.host === session.account.id && <option value="host.transfer">Transferir host</option>}
          {(role === 'owner' || role === 'moderator' && person.role === 'member') && <>
            <option value={person.muted ? 'unmute' : 'mute'}>{person.muted ? 'Liberar microfone' : 'Silenciar'}</option>
            <option value={person.videoBlocked ? 'allowVideo' : 'blockVideo'}>{person.videoBlocked ? 'Liberar vídeo' : 'Bloquear vídeo'}</option>
            <option value="kick">Remover da sessão</option>
          </>}
        </select>}
    </li>)}</ul>
  </div>;
}

const initial = { people: [], messages: [], status: 'Conectando', media: 'Conectando', policy: {}, quality: 720 };
export function Meeting({ room, group, session, verified, leave, report, createLive }) {
  const runtime = useRef(null);
  const roster = useRef(verified);
  roster.current = verified;
  const [state, setState] = useState(initial);
  const [tab, setTab] = useState('chat');
  const [capturing, setCapturing] = useState(false);
  const [sending, setSending] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [changingQuality, setChangingQuality] = useState(false);
  const isLive = room.mode === 'live';
  useEffect(() => {
    const connection = new RoomConnection(room, group, session, roster.current, setState, report);
    runtime.current = connection;
    request('groups/' + group.id + '/ice').then((ice) => connection.connect(ice)).catch(report);
    return () => { connection.onState = () => {}; connection.close(); };
  }, [room.id, group.id, session]);
  useEffect(() => { runtime.current?.setRoster(verified); }, [verified]);

  const self = state.people.find(({ self }) => self);
  const presentations = state.people.filter((person) => person.media.screen);
  const onStage = isLive && state.publisher ? state.people.filter(({ id }) => id === state.publisher) : state.people;
  const people = state.people.length;
  const canCapture = self && state.canPublish && !capturing && !changingQuality && !state.closed;
  const connected = state.status === 'Conectado';

  async function toggle(kind) {
    setCapturing(true);
    try { await runtime.current.toggle(kind); }
    catch (problem) {
      if (problem.name === 'NotAllowedError') report(Error('Captura cancelada ou bloqueada pelo navegador.'));
      else report(problem);
    } finally { setCapturing(false); }
  }

  async function changeQuality(event) {
    setChangingQuality(true);
    try { await runtime.current.setQuality(Number(event.target.value)); }
    catch (problem) { report(problem); }
    finally { setChangingQuality(false); }
  }

  return <div className={'meeting' + (panelOpen ? '' : ' panel-hidden')}>
    <section className="meeting-center" aria-label="Vídeo da sala">
      <div className={'stage' + (presentations.length ? ' stage-presenting' : '')}>
        <div className="stage-status" aria-live="polite">
          {state.publisher && <span className="live-indicator"><Radio size={16} /> Ao vivo</span>}
          <span className="connection-indicator"><AudioLines size={16} /> {state.media}</span>
        </div>
        {presentations.length > 0 ? <>
          <div className="screens">{presentations.map((person) => <div className="screen" key={person.id}>
            <VisualStream stream={person.media.screen} label={'Tela de ' + person.name} />
            <span className="tile-label">Tela de {person.name}</span>
          </div>)}</div>
          <div className="tiles thumbnails">{onStage.map((person) => <Tile key={person.id} person={person} host={person.id === state.host} />)}</div>
        </> : onStage.length && (!isLive || state.publisher)
          ? <div className={'tiles' + (onStage.length > 2 ? ' many' : '')}>{onStage.map((person) =>
            <Tile key={person.id} person={person} host={person.id === state.host} />)}</div>
          : <div className="stage-empty">{isLive ? <Radio size={36} /> : <Video size={36} />}
            <p>{isLive && connected ? 'Aguardando uma transmissão' : state.status}</p>
            {isLive && connected && <small>{people} {people === 1 ? 'pessoa na sala' : 'pessoas na sala'}</small>}
          </div>}
      </div>
      {state.mediaFailed && <p className="media-notice" role="status">
        {state.hasTurn ? 'A conexão de mídia falhou.' : 'A conexão direta falhou e o servidor não tem TURN configurado.'}
        {state.canChat && ' O chat segue disponível.'}
      </p>}
      <div className="meeting-controls" aria-label="Controles de mídia">
        <button aria-pressed={Boolean(self?.media.mic)} disabled={!canCapture || state.policy.muted} onClick={() => toggle('mic')}>
          {self?.media.mic ? <Mic size={19} /> : <MicOff size={19} />} Microfone</button>
        <button aria-pressed={Boolean(self?.media.camera)} disabled={!canCapture || state.policy.videoBlocked} onClick={() => toggle('camera')}>
          {self?.media.camera ? <Camera size={19} /> : <CameraOff size={19} />} Câmera</button>
        <button aria-pressed={Boolean(self?.media.screen)} disabled={!canCapture || state.policy.videoBlocked} onClick={() => toggle('screen')}>
          {self?.media.screen ? <ScreenShareOff size={19} /> : <MonitorUp size={19} />} {self?.media.screen ? 'Parar compartilhamento' : 'Compartilhar tela'}</button>
        {isLive
          ? <button disabled={!connected || state.policy.videoBlocked && state.publisher !== session.account.id || Boolean(state.publisher && state.publisher !== session.account.id)}
              onClick={() => runtime.current.send({ type: state.publisher === session.account.id ? 'live.stop' : 'live.start' })}>
            <Radio size={19} /> {state.publisher === session.account.id ? 'Encerrar live' : 'Iniciar live'}</button>
          : createLive && <button onClick={createLive}><Radio size={19} /> Criar live</button>}
        <button aria-expanded={panelOpen} aria-controls="meeting-panel" onClick={() => setPanelOpen(!panelOpen)}>
          <MessageSquare size={17} /> {panelOpen ? 'Ocultar painel' : 'Mostrar painel'}</button>
        {(!isLive || state.publisher === session.account.id) &&
          <label className="quality" title="A resolução efetiva depende da fonte e da rede">Qualidade de envio
            <select value={state.quality} onChange={changeQuality} disabled={!self || capturing || changingQuality || state.closed}>
              {Object.keys(videoProfiles).map((quality) => <option key={quality} value={quality}>{quality}p</option>)}
            </select>
          </label>}
        <button className="danger" onClick={leave}><PhoneOff size={19} /> Sair da sala</button>
      </div>
    </section>
    <aside id="meeting-panel" className="chat-panel" hidden={!panelOpen}>
      <div className="pane-tabs" aria-label="Painel da sala">
        <button aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}>Chat da sala</button>
        <button aria-pressed={tab === 'people'} onClick={() => setTab('people')}>Pessoas <span>{people}</span></button>
      </div>
      {tab === 'chat' ? <Conversation messages={state.messages} roster={state.people} label="Chat da sala" self={session.account.id} busy={sending} available={state.canChat}
        empty="As mensagens da sala ficam disponíveis durante esta sessão."
        onSend={async (text) => {
          setSending(true);
          try { await runtime.current.chat(text); return true; }
          catch (error) { report(error); return false; }
          finally { setSending(false); }
        }} /> : <RoomPeople state={state} session={session} connection={runtime.current} report={report} />}
    </aside>
  </div>;
}
