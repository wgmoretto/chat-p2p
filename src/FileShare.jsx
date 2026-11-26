import React, { useEffect, useRef, useState } from 'react';
import { File, Paperclip } from 'lucide-react';
import { FileTransfer, MAX_FILE_BYTES } from './file-transfer.mjs';
import { request } from './local.mjs';
import { RoomConnection } from './room.mjs';

const initialState = { ready: false, transfer: null };
const initialConnection = { peers: 0, failed: false };
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
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    if (!id) return;
    setState(initialState);
    setConnection(initialConnection);
    setHint('');
    setWaiting(false);
    const cancellation = new AbortController();
    const files = new FileTransfer((value) => {
      if (value.ready) setWaiting(false);
      setState(value);
    });
    const room = new RoomConnection({ id, mode: 'files' }, { chat_mode: 'contact' }, session, null,
      setConnection, () => setConnection({ peers: 0, failed: true }), (channel) => files.bind(channel));
    transfer.current = files;
    request('groups/' + id + '/ice', undefined, { signal: cancellation.signal })
      .then((ice) => room.connect(ice))
      .catch(() => {
        if (!cancellation.signal.aborted) setConnection({ peers: 0, failed: true });
      });
    return () => {
      cancellation.abort();
      transfer.current = null;
      files.close();
      room.onState = () => {};
      room.close();
    };
  }, [id, session]);

  if (!id) return {};

  const item = state.transfer;
  const busy = item && (pending.includes(item.phase) || item.phase === 'received');
  const moving = ['sending','receiving','confirming'].includes(item?.phase);
  const transferNotice = hint || (waiting && !state.ready && (connection.failed
    ? 'A conexão para arquivos está indisponível. Reabra a conversa e tente novamente.'
    : connection.peers ? 'Aguardando a conexão entre os navegadores.'
      : 'Os dois precisam abrir esta conversa para enviar arquivos.'));
  const percent = item?.size ? Math.floor(item.bytes * 100 / item.size) : item?.phase === 'confirming' ? 100 : 0;

  function openPicker() {
    if (state.ready) { setHint(''); input.current.click(); return; }
    setHint('');
    setWaiting(true);
  }

  function selectFile(event) {
    const file = event.currentTarget.files[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { setHint('O limite é de 64 MiB por arquivo.'); return; }
    if (!transfer.current?.offer(file)) setHint('Não foi possível iniciar o envio. Verifique a conexão e tente novamente.');
    else setHint('');
  }

  return {
    attachment: <>
      <input type="file" ref={input} hidden aria-label="Selecionar arquivo" onChange={selectFile} />
      <button type="button" className="icon attach-file" aria-label="Anexar arquivo"
        title="Anexar arquivo de até 64 MiB" data-ready={state.ready} disabled={Boolean(busy)}
        onClick={openPicker}><Paperclip size={20} /></button>
    </>,
    panel: <>
      {transferNotice && <p className="file-share-hint" role="status">{transferNotice}</p>}
      {item && <section className="file-share" aria-label="Transferência de arquivo">
        <span className="item-icon"><File size={19} aria-hidden="true" /></span>
        <div className="file-share-details">
          <strong>{item.name}</strong>
          <small role="status">{messages[item.phase]} · {formatSize(item.size)}</small>
          {moving && <progress value={percent} max={100} aria-label="Progresso da transferência" />}
        </div>
        <div className="file-share-actions">
          {item.phase === 'incoming' ? <>
            <button type="button" className="quiet" onClick={() => transfer.current?.decline()}>Recusar arquivo</button>
            <button type="button" className="primary quiet" onClick={() => transfer.current?.accept()}>Aceitar arquivo</button>
          </> : item.phase === 'received' ?
            <button type="button" className="primary quiet" onClick={() => transfer.current?.save()}>Baixar arquivo</button>
            : pending.includes(item.phase) && <button type="button" className="quiet" onClick={() => transfer.current?.abort()}>Cancelar transferência</button>}
          {!pending.includes(item.phase) && <button type="button" className="quiet" onClick={() => transfer.current?.dismiss()}>Dispensar</button>}
        </div>
      </section>}
    </>,
  };
}
