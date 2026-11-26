import React, { useEffect, useRef, useState } from 'react';
import { File, Paperclip, Upload } from 'lucide-react';
import { FileTransfer, MAX_FILE_BYTES } from './file-transfer.mjs';
import { request } from './local.mjs';
import { RoomConnection } from './room.mjs';

const initialState = { ready: false, transfer: null };
const initialConnection = { peers: 0, hasTurn: false, closed: false, error: '' };
const offerTimeout = 30_000;
const hasFiles = (event) => event.dataTransfer.types.includes('Files');
const pending = ['offered','incoming','sending','receiving','confirming'];
const messages = {
  offered: 'Aguardando aceite',
  incoming: 'Quer enviar um arquivo para você',
  sending: 'Enviando arquivo',
  receiving: 'Recebendo arquivo',
  confirming: 'Confirmando recebimento',
  sent: 'Arquivo entregue',
  received: 'Arquivo recebido',
  declined: 'Arquivo recusado',
  busy: 'Seu colega já está com outra transferência',
  canceled: 'Transferência cancelada',
  interrupted: 'Transferência interrompida',
  expired: 'Transferência expirada',
  invalid: 'Arquivo incompleto ou inválido',
};

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const unit = bytes < 1024 * 1024 ? 'KiB' : 'MiB';
  const value = bytes / (unit === 'KiB' ? 1024 : 1024 * 1024);
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' ' + unit;
}

export function useFileShare(id, session) {
  const transfer = useRef(null);
  const input = useRef(null);
  const [state, setState] = useState(initialState);
  const [connection, setConnection] = useState(initialConnection);
  const [hint, setHint] = useState('');
  const [draft, setDraft] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    if (!id) return;
    setState(initialState);
    setConnection(initialConnection);
    const cancellation = new AbortController();
    const files = new FileTransfer(setState);
    const fail = (error) => {
      if (!cancellation.signal.aborted) setConnection((current) => ({ ...current, error: error.message }));
    };
    const room = new RoomConnection({ id, mode: 'files' }, { chat_mode: 'contact' }, session, null,
      (value) => setConnection((current) => ({ ...current, ...value })), fail, (channel) => files.bind(channel));
    transfer.current = files;
    request('groups/' + id + '/ice', undefined, { signal: cancellation.signal })
      .then((ice) => room.connect(ice))
      .catch(fail);
    return () => {
      cancellation.abort();
      transfer.current = null;
      files.close();
      room.onState = () => {};
      room.close();
    };
  }, [id, session, attempt]);

  useEffect(() => {
    if (!draft || draft.expired) return;
    if (state.ready && transfer.current?.ready) {
      setDraft(transfer.current.offer(draft.file) ? null : { ...draft, expired: true });
      return;
    }
    if (connection.error || connection.closed) {
      setDraft({ ...draft, expired: true });
      return;
    }
    const timer = setTimeout(() => setDraft({ ...draft, expired: true }), offerTimeout);
    return () => clearTimeout(timer);
  }, [draft, state.ready, connection.error, connection.closed]);

  if (!id) return {};

  const current = state.transfer;
  const active = current && (pending.includes(current.phase) || current.phase === 'received');
  const showDraft = draft && !active;
  const item = showDraft ? { name: draft.file.name, size: draft.file.size } : current;
  const busy = Boolean(draft || active);
  const moving = ['sending','receiving','confirming'].includes(item?.phase);
  let status = item && messages[item.phase];
  if (showDraft) {
    if (!draft.expired) status = connection.peers ? 'Conectando os navegadores…' : 'Aguardando seu amigo abrir esta conversa.';
    else if (state.ready) status = 'Pronto para tentar enviar novamente.';
    else if (connection.error) status = connection.error;
    else if (connection.closed) status = 'A conexão para arquivos foi encerrada.';
    else if (!connection.peers) status = 'Seu amigo precisa abrir a mesma conversa.';
    else status = connection.hasTurn ? 'Não foi possível conectar os navegadores.' : 'A conexão direta falhou. O servidor está sem TURN.';
  }
  const percent = item?.size ? Math.floor(item.bytes * 100 / item.size) : item?.phase === 'confirming' ? 100 : 0;

  function selectFiles(files) {
    if (!files.length) return;
    if (busy) { setHint('Conclua ou cancele a transferência atual antes de anexar outro arquivo.'); return; }
    if (files.length > 1) { setHint('Envie um arquivo por vez.'); return; }
    const file = files[0];
    if (file.size > MAX_FILE_BYTES) { setHint('O limite é de 64 MiB por arquivo.'); return; }
    setHint('');
    if (transfer.current?.ready) {
      if (!transfer.current.offer(file)) setHint('A conversa já tem uma transferência de arquivo.');
      return;
    }
    setDraft({ file, expired: false });
  }

  function retry() {
    if (!transfer.current?.ready) {
      setConnection(initialConnection);
      setAttempt((count) => count + 1);
    }
    setHint('');
    setDraft({ ...draft, expired: false });
  }

  const dropTarget = {
    onDragEnter(event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current++;
      setDragging(true);
    },
    onDragOver(event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave() {
      if (dragDepth.current > 0 && --dragDepth.current === 0) setDragging(false);
    },
    onDrop(event) {
      if (!hasFiles(event) && !event.dataTransfer.files.length) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      selectFiles(event.dataTransfer.files);
    },
  };

  return {
    dropTarget,
    dropPrompt: dragging && <div className="file-drop-prompt" aria-hidden="true">
      <Upload size={28} /> {busy ? 'Conclua a transferência atual' : 'Solte o arquivo para anexar'}
    </div>,
    attachment: <>
      <input type="file" ref={input} hidden aria-label="Selecionar arquivo" onChange={(event) => {
        selectFiles(event.currentTarget.files);
        event.currentTarget.value = '';
      }} />
      <button type="button" className="icon attach-file" aria-label="Anexar arquivo"
        title="Anexar arquivo de até 64 MiB" data-ready={state.ready} disabled={busy}
        onClick={() => input.current.click()}><Paperclip size={20} /></button>
    </>,
    panel: <>
      {hint && <p className="file-share-hint" role="status">{hint}</p>}
      {item && <section className="file-share" aria-label="Transferência de arquivo">
        <span className="item-icon"><File size={19} aria-hidden="true" /></span>
        <div className="file-share-details">
          <strong>{item.name}</strong>
          <small role="status">{status} · {formatSize(item.size)}</small>
          {moving && <progress value={percent} max={100} aria-label="Progresso da transferência" />}
        </div>
        <div className="file-share-actions">
          {showDraft ? <>
            <button type="button" className="quiet" onClick={() => { setDraft(null); setHint(''); }}>Cancelar anexo</button>
            {draft.expired && <button type="button" className="primary quiet" onClick={retry}>Tentar novamente</button>}
          </> : item.phase === 'incoming' ? <>
            <button type="button" className="quiet" onClick={() => transfer.current?.decline()}>Recusar arquivo</button>
            <button type="button" className="primary quiet" onClick={() => transfer.current?.accept()}>Aceitar arquivo</button>
          </> : item.phase === 'received' ?
            <button type="button" className="primary quiet" onClick={() => transfer.current?.save()}>Baixar arquivo</button>
            : pending.includes(item.phase) && <button type="button" className="quiet" onClick={() => transfer.current?.abort()}>Cancelar transferência</button>}
          {!showDraft && !pending.includes(item.phase) && <button type="button" className="quiet" onClick={() => transfer.current?.dismiss()}>Dispensar</button>}
        </div>
      </section>}
    </>,
  };
}
