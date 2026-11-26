import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

async function account(page, name, username, bootstrap = false) {
  await page.getByLabel('Nome (opcional)', { exact: true }).fill(name);
  await page.getByLabel('Usuário').fill(username);
  await page.getByLabel('Senha').fill('senha-para-teste-e2e');
  if (bootstrap) await page.getByLabel('Código de instalação').fill('local-browser-test-bootstrap-key');
  await page.getByRole('button', { name: 'Criar conta', exact: true }).click();
}
async function invite(owner, visitor, role) {
  await owner.getByRole('button', { name: 'Convidar' }).click();
  await owner.getByRole('button', { name: 'Por link' }).click();
  await owner.getByLabel('Papel').selectOption(role);
  await owner.getByRole('button', { name: 'Gerar convite' }).click();
  const invite = owner.getByLabel('Link de convite');
  await expect(invite).toHaveValue(/#invite=/);
  const link = await invite.inputValue();
  await owner.getByRole('dialog').getByRole('button', { name: 'Fechar' }).click();
  await visitor.goto(link);
  await visitor.getByRole('button', { name: 'Solicitar entrada' }).click();
  await expect(visitor.getByRole('heading', { name: 'Equipe', exact: true })).toBeVisible();
}
async function send(page, text) {
  await page.getByLabel('Mensagem', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Enviar' }).click();
  await expect(page.getByRole('log').getByText(text)).toBeVisible();
}
async function waitVideo(page, label) {
  await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  await expect.poll(() => page.getByLabel(label, { exact: true }).evaluate((video) => video.videoWidth)).toBeGreaterThan(0);
}
async function newRoom(page, name, mode) {
  await page.getByRole('button', { name: 'Nova sala', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('Nome').fill(name);
  await page.getByRole('dialog').getByLabel('Tipo').selectOption(mode);
  await page.getByRole('dialog').getByRole('button', { name: 'Criar', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
const navRoom = (page, name) => page.getByRole('navigation').getByRole('button', { name, exact: true });
const contact = (page, name) => page.getByRole('navigation').locator('.contact-item').filter({ hasText: name });
const blockedIce = process.env.TEST_ICE_BLOCKED === '1';
const mediaPath = process.env.FORCE_TURN === '1' ? 'Relay TURN' : 'Direta';

test('login no segundo navegador, amigos, reunião P2P e moderação', async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()));
  try {
    if (blockedIce) await Promise.all(contexts.map((context) => context.addInitScript(() => {
      const PeerConnection = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends PeerConnection {
        constructor(config) { super({ ...config, iceServers: [], iceTransportPolicy: 'relay' }); }
      };
    })));
    await contexts[1].addInitScript(() => {
      const media = navigator.mediaDevices;
      if (!media) return;
      const capture = media.getUserMedia.bind(media);
      media.getUserMedia = async (options) => {
        const stream = await capture(options);
        if (options.audio) window.qaMicTrack = stream.getAudioTracks()[0];
        return stream;
      };
    });
    const [alice, bob, carol, serverBrowser] = await Promise.all(contexts.map((ctx) => ctx.newPage()));
    const relayed = [];
    const fileSignals = [];
    alice.on('websocket', (socket) => {
      const url = new URL(socket.url());
      if (!url.pathname.endsWith('/signal')) return;
      socket.on('framesent', ({ payload }) => {
        if (url.searchParams.get('purpose') === 'files') fileSignals.push(payload);
        if (typeof payload !== 'string') return;
        const frame = JSON.parse(payload);
        if (frame.type === 'chat') relayed.push(frame);
      });
    });
    const faults = [];
    for (const page of [alice, bob, carol]) page.on('pageerror', (error) => faults.push(error.message));
    await serverBrowser.goto('/');
    await account(serverBrowser, 'Marina', 'marina', true);
    await expect(serverBrowser.getByRole('heading', { name: 'Atividade', exact: true })).toBeVisible();

    await alice.goto('/');
    await expect(alice.getByRole('heading', { name: 'Entrar no Chat P2P' })).toBeVisible();
    await alice.screenshot({ path: testInfo.outputPath('login-desktop.png') });
    await alice.setViewportSize({ width: 390, height: 844 });
    await expect(alice.getByRole('button', { name: 'Entrar', exact: true })).toBeInViewport();
    await alice.screenshot({ path: testInfo.outputPath('login-mobile.png') });
    await alice.setViewportSize({ width: 1440, height: 900 });
    await alice.getByLabel('Usuário').fill('marina');
    await alice.getByLabel('Senha').fill('senha-para-teste-e2e');
    await alice.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(alice.getByRole('heading', { name: 'Atividade', exact: true })).toBeVisible();
    await alice.getByLabel('Tema').selectOption('dark');
    await expect(alice.locator('html')).toHaveCSS('color-scheme', 'dark');
    await alice.reload();
    await expect(alice.getByRole('heading', { name: 'Atividade', exact: true })).toBeVisible();
    await expect(alice.getByLabel('Tema')).toHaveValue('dark');
    await expect(alice.locator('html')).toHaveCSS('background-color', 'rgb(16, 19, 24)');
    await alice.screenshot({ path: testInfo.outputPath('amigos-escuro.png') });
    await alice.getByLabel('Tema').selectOption('light');
    await expect(alice.locator('html')).toHaveCSS('color-scheme', 'light');
    for (const [page, name, handle] of [[bob, 'Rafael', 'rafael'], [carol, 'Carolina', 'carolina']]) {
      await page.goto('/');
      await page.getByRole('button', { name: 'Criar conta', exact: true }).click();
      await account(page, name, handle);
      await expect(page.getByRole('heading', { name: 'Atividade', exact: true })).toBeVisible();
    }

    await alice.getByRole('navigation').getByRole('button', { name: 'Adicionar amigo' }).click();
    await alice.getByRole('dialog').getByLabel('Adicionar pelo @usuário').fill('@rafael');
    await alice.getByRole('dialog').getByRole('button', { name: 'Enviar pedido' }).click();
    await expect(alice.getByText(/Pedido enviado/)).toBeVisible();
    await bob.getByRole('button', { name: 'Aceitar', exact: true }).click();
    await expect(contact(alice, 'Rafael')).toContainText('Online');
    await alice.getByRole('searchbox', { name: 'Buscar amigos e grupos' }).fill('inexistente');
    await expect(alice.getByText('Nenhum contato encontrado')).toBeVisible();
    await alice.getByRole('searchbox', { name: 'Buscar amigos e grupos' }).fill('@rafael');
    await expect(contact(alice, 'Rafael')).toBeVisible();
    await alice.getByRole('searchbox', { name: 'Buscar amigos e grupos' }).clear();
    await alice.screenshot({ path: testInfo.outputPath('amigos-desktop.png') });
    await bob.setViewportSize({ width: 390, height: 844 });
    expect(await bob.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(await bob.locator('.sidebar').evaluate((element) => element.offsetHeight)).toBeLessThan(230);
    await expect(bob.getByRole('navigation')).toBeHidden();
    await bob.getByRole('button', { name: 'Abrir navegação' }).click();
    await expect(bob.getByRole('navigation')).toBeVisible();
    await bob.getByRole('navigation').getByRole('button', { name: 'Atividade', exact: true }).click();
    await expect(bob.getByRole('navigation')).toBeHidden();
    await bob.screenshot({ path: testInfo.outputPath('amigos-mobile.png'), fullPage: true });
    await bob.setViewportSize({ width: 1440, height: 900 });

    await contact(alice, 'Rafael').click();
    await expect(alice.getByRole('heading', { name: 'Rafael' })).toBeVisible();
    const ciphertext = alice.waitForRequest((req) => req.method() === 'POST' && req.url().endsWith('/messages'));
    const privateText = 'Recado individual para Rafael.';
    await send(alice, privateText);
    const posted = (await ciphertext).postDataJSON();
    expect(JSON.stringify(posted)).not.toContain(privateText);
    expect(posted.recipients).toHaveLength(2);
    const composer = alice.getByRole('textbox', { name: 'Mensagem' });
    await composer.fill('Segunda mensagem na conversa.');
    await composer.press('End');
    await composer.press('Shift+Enter');
    await composer.pressSequentially('Uma segunda linha.');
    await expect(composer).toHaveValue('Segunda mensagem na conversa.\nUma segunda linha.');
    await composer.press('Enter');
    await expect(alice.getByRole('log').getByText(/Uma segunda linha/)).toBeVisible();
    await expect(contact(bob, 'Marina').locator('.nav-count')).toHaveText('2');
    const friends = await (await alice.request.get('/api/friends')).json();
    const chatId = friends.find(({ username }) => username === 'rafael').roomId;
    expect((await carol.request.get('/api/groups/' + chatId + '/messages')).status()).toBe(404);
    const clip = alice.getByRole('button', { name: 'Anexar arquivo', exact: true });
    const bytes = Buffer.alloc(520 * 1024 + 17);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    const file = { name: 'relatorio-teste.bin', mimeType: 'application/octet-stream', buffer: bytes };
    const picker = alice.waitForEvent('filechooser');
    await clip.click();
    await (await picker).setFiles(file);
    await expect(alice.getByText(/Aguardando seu amigo abrir esta conversa/)).toBeVisible();
    await expect(clip).toBeDisabled();
    await contact(bob, 'Marina').click();
    await expect(bob.getByText(privateText)).toBeVisible();
    await expect(contact(bob, 'Marina').locator('.nav-count')).toHaveCount(0);
    await send(bob, 'Recebi. Vamos conversar aqui.');
    await expect(alice.getByText('Recebi. Vamos conversar aqui.')).toBeVisible();
    if (blockedIce) {
      await expect(clip).toHaveAttribute('data-ready', 'false');
      const retryFile = alice.getByRole('button', { name: 'Tentar novamente' });
      await expect(retryFile).toBeVisible({ timeout: 36_000 });
      await expect(alice.getByText(/A conexão direta falhou|Não foi possível conectar os navegadores/)).toBeVisible();
      const retrySignal = alice.waitForEvent('websocket', (socket) => new URL(socket.url()).searchParams.get('purpose') === 'files');
      await retryFile.click();
      await retrySignal;
      await expect(alice.getByText(file.name)).toBeVisible();
      await alice.getByRole('button', { name: 'Cancelar anexo' }).click();
      await expect(alice.getByText(file.name)).toBeHidden();
    } else {
      await expect(clip).toHaveAttribute('data-ready', 'true', { timeout: 15_000 });
      await expect(alice.getByText(/Aguardando seu amigo abrir esta conversa/)).toBeHidden();
      await expect(bob.getByRole('button', { name: 'Atender', exact: true })).toHaveCount(0);
      const input = alice.getByLabel('Selecionar arquivo');
      const acceptFile = bob.getByRole('button', { name: 'Aceitar arquivo' });
      const saveFile = bob.getByRole('button', { name: 'Baixar arquivo' });

      await expect(acceptFile).toBeVisible();
      await expect(saveFile).toHaveCount(0);
      await bob.getByRole('button', { name: 'Recusar arquivo' }).click();
      await expect(alice.getByText(/Arquivo recusado/)).toBeVisible();

      await input.setInputFiles(file);
      await expect(acceptFile).toBeVisible();
      await alice.getByRole('button', { name: 'Cancelar transferência' }).click();
      await expect(bob.getByText(/Transferência cancelada/)).toBeVisible();

      const dragged = await alice.evaluateHandle(({ size, name, type }) => {
        const data = new DataTransfer();
        const payload = Uint8Array.from({ length: size }, (_, index) => index % 251);
        data.items.add(new File([payload], name, { type }));
        return data;
      }, { size: bytes.length, name: file.name, type: file.mimeType });
      const log = alice.getByRole('log', { name: 'Conversa individual' });
      await log.dispatchEvent('dragenter', { dataTransfer: dragged });
      await expect(alice.getByText('Solte o arquivo para anexar')).toBeVisible();
      await alice.screenshot({ path: testInfo.outputPath('arquivo-arrastar-desktop.png') });
      await log.dispatchEvent('dragleave', { dataTransfer: dragged });
      await expect(alice.getByText('Solte o arquivo para anexar')).toBeHidden();
      await log.dispatchEvent('dragenter', { dataTransfer: dragged });
      await log.dispatchEvent('dragover', { dataTransfer: dragged });
      await log.dispatchEvent('drop', { dataTransfer: dragged });
      await dragged.dispose();
      await expect(alice.getByText('Solte o arquivo para anexar')).toBeHidden();
      await expect(acceptFile).toBeVisible();
      await bob.setViewportSize({ width: 390, height: 844 });
      await expect(acceptFile).toBeInViewport();
      await expect(bob.getByRole('button', { name: 'Anexar arquivo' })).toBeInViewport();
      expect(await bob.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await bob.screenshot({ path: testInfo.outputPath('arquivo-oferta-mobile.png') });
      await acceptFile.click();
      await expect(alice.getByText(/Arquivo entregue/)).toBeVisible();
      const download = bob.waitForEvent('download');
      await saveFile.click();
      const downloaded = await download;
      expect(downloaded.suggestedFilename()).toBe(file.name);
      expect(await readFile(await downloaded.path())).toEqual(bytes);
      await expect(saveFile).toBeVisible();
      await bob.getByRole('button', { name: 'Dispensar' }).click();
      await expect(saveFile).toHaveCount(0);
      await bob.setViewportSize({ width: 1440, height: 900 });
    }
    expect(fileSignals.length).toBeGreaterThan(0);
    for (const signal of fileSignals) {
      expect(typeof signal).toBe('string');
      expect(['sdp', 'ice', 'leave']).toContain(JSON.parse(signal).type);
      expect(signal).not.toContain('relatorio-teste.bin');
    }

    await contact(serverBrowser, 'Rafael').click();
    await expect(serverBrowser.getByText(privateText)).toBeVisible();
    await serverBrowser.getByLabel('Selecionar arquivo').setInputFiles(file);
    await expect(serverBrowser.getByText(/Esta conta já abriu a conexão para arquivos em outra aba ou navegador/)).toBeVisible();
    await serverBrowser.getByRole('button', { name: 'Cancelar anexo' }).click();
    await alice.getByLabel('Tema').selectOption('dark');
    await alice.screenshot({ path: testInfo.outputPath('conversa-escura.png') });
    await alice.getByLabel('Tema').selectOption('light');
    await alice.screenshot({ path: testInfo.outputPath('conversa-clara.png') });
    await alice.setViewportSize({ width: 390, height: 844 });
    await expect(composer).toBeInViewport();
    await alice.screenshot({ path: testInfo.outputPath('conversa-mobile.png') });
    await alice.getByRole('button', { name: 'Abrir navegação' }).click();
    await alice.screenshot({ path: testInfo.outputPath('navegacao-mobile.png') });
    await alice.keyboard.press('Escape');
    await expect(alice.getByRole('navigation')).toBeHidden();
    await alice.setViewportSize({ width: 1440, height: 900 });
    await alice.getByRole('button', { name: 'Ligar' }).click();
    await bob.getByRole('button', { name: 'Atender', exact: true }).click();
    if (!blockedIce) await expect(bob.getByText(mediaPath, { exact: true })).toBeVisible({ timeout: 18_000 });
    await send(alice, 'Mensagem temporária entre amigos.');
    await expect(bob.getByText('Mensagem temporária entre amigos.')).toBeVisible();
    if (blockedIce) {
      expect(relayed).toHaveLength(1);
      expect(relayed[0].content).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(JSON.stringify(relayed[0])).not.toContain('Mensagem temporária');
      await expect(bob.getByText('Mídia indisponível', { exact: true })).toBeVisible({ timeout: 24_000 });
      await expect(bob.getByRole('status')).toContainText('O chat segue disponível.');
      expect(faults).toEqual([]);
    }
    await alice.getByRole('button', { name: 'Sair da sala' }).click();
    await bob.getByRole('button', { name: 'Sair da sala' }).click();
    await expect(alice.getByRole('heading', { name: 'Rafael', exact: true })).toBeVisible();
    await alice.getByRole('button', { name: 'Novo grupo', exact: true }).last().click();
    await alice.getByRole('dialog').getByLabel('Nome').fill('Equipe');
    await alice.getByRole('dialog').getByRole('button', { name: 'Criar', exact: true }).click();
    await expect(alice.getByRole('heading', { name: 'Equipe', exact: true })).toBeVisible();
    await alice.getByRole('button', { name: 'Convidar' }).click();
    await alice.getByRole('combobox', { name: 'Amigo', exact: true }).selectOption({ label: 'Rafael (@rafael)' });
    await alice.getByRole('button', { name: 'Enviar convite' }).click();
    await expect(alice.getByText(/Convite enviado/)).toBeVisible();
    await bob.getByRole('navigation').getByRole('button', { name: /^Atividade/ }).click();
    await expect(bob.getByRole('heading', { name: 'Convites de grupo' })).toBeVisible();
    await bob.screenshot({ path: testInfo.outputPath('convite-interno.png') });
    await bob.getByRole('button', { name: 'Aceitar convite' }).click();
    await expect(bob.getByRole('heading', { name: 'Equipe', exact: true })).toBeVisible();
    await bob.getByRole('navigation').getByRole('button', { name: /^Atividade/ }).click();
    await send(alice, 'Mensagem persistente do grupo.');
    const bobGroup = bob.getByRole('navigation').getByRole('button', { name: /^Equipe/ });
    await expect(bobGroup.locator('.nav-count')).toHaveText('1');
    await bob.screenshot({ path: testInfo.outputPath('grupo-nao-lida.png') });
    await bobGroup.click();
    await expect(bob.getByText('Mensagem persistente do grupo.')).toBeVisible();
    await bob.screenshot({ path: testInfo.outputPath('grupo-desktop.png') });
    await expect(bobGroup.locator('.nav-count')).toHaveCount(0);
    await invite(alice, carol, 'moderator');
    await newRoom(alice, 'Avisos', 'text');
    await expect(navRoom(alice, 'Avisos')).toHaveAttribute('title', 'Chat de texto');
    await expect(alice.getByRole('button', { name: 'Microfone' })).toHaveCount(0);
    await send(alice, 'Mensagem exclusiva do canal de avisos.');
    await expect(bob.getByText('Mensagem exclusiva do canal de avisos.')).toHaveCount(0);
    await expect(bobGroup.locator('.nav-count')).toHaveText('1');
    const unreadRoom = bob.getByRole('navigation').getByRole('button', { name: /^Avisos/ });
    await expect(unreadRoom.locator('.nav-count')).toHaveText('1');
    await unreadRoom.click();
    await expect(bob.getByRole('log').getByText('Mensagem exclusiva do canal de avisos.')).toBeVisible();
    await expect(unreadRoom.locator('.nav-count')).toHaveCount(0);
    await expect(bobGroup.locator('.nav-count')).toHaveCount(0);
    await expect(bob.getByText('Mensagem persistente do grupo.')).toHaveCount(0);
    await bob.screenshot({ path: testInfo.outputPath('sala-texto.png') });

    await newRoom(alice, 'Conversas', 'voice');
    await expect(navRoom(alice, 'Conversas')).toHaveAttribute('title', 'Chat de voz');
    await navRoom(bob, 'Conversas').click();
    if (!blockedIce) {
      await navRoom(carol, 'Conversas').click();
      await expect(alice.getByText(mediaPath, { exact: true })).toBeVisible({ timeout: 18_000 });
    }
    const microphone = (page) => page.getByRole('button', { name: 'Microfone', exact: true });
    const headphone = alice.getByRole('button', { name: 'Fone', exact: true });
    await expect(microphone(bob)).toHaveAttribute('aria-pressed', 'false');
    await expect(alice.getByRole('button', { name: 'Câmera', exact: true })).toBeVisible();
    await expect(alice.getByRole('button', { name: 'Compartilhar tela', exact: true })).toBeVisible();
    await send(alice, 'Texto na chamada de voz.');
    await expect(bob.getByRole('log').getByText('Texto na chamada de voz.')).toBeVisible();
    if (!blockedIce) {
      const voiceCamera = alice.getByRole('button', { name: 'Câmera', exact: true });
      await voiceCamera.click();
      await waitVideo(bob, 'Câmera de Marina');
      await voiceCamera.click();
      await expect(bob.getByLabel('Câmera de Marina', { exact: true })).toHaveCount(0);
    }
    await microphone(bob).click();
    await expect(microphone(bob)).toHaveAttribute('aria-pressed', 'true');
    const noise = bob.getByRole('button', { name: 'Redução de ruído' });
    await expect(noise).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => bob.evaluate(() => window.qaMicTrack?.getConstraints().noiseSuppression)).toBe(true);
    await noise.click();
    await expect(noise).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => bob.evaluate(() => window.qaMicTrack?.getConstraints().noiseSuppression)).toBe(false);
    await expect(microphone(bob)).toHaveAttribute('aria-pressed', 'true');
    await alice.getByRole('button', { name: /^Pessoas/ }).click();
    const volume = alice.getByRole('slider', { name: 'Volume de Rafael' });
    await expect(volume).toHaveValue('100');
    await volume.press('Home');
    await volume.press('ArrowRight');
    await expect(volume).toHaveValue('5');
    await headphone.click();
    await expect(headphone).toHaveAttribute('aria-pressed', 'false');
    await expect(microphone(bob)).toHaveAttribute('aria-pressed', 'true');
    if (!blockedIce) {
      const audio = (page) => page.locator('audio[aria-label="Áudio de Rafael"]');
      await expect(audio(alice)).toHaveJSProperty('volume', 0.05);
      await expect(audio(alice)).toHaveJSProperty('muted', true);
      await expect(audio(carol)).toHaveJSProperty('volume', 1);
      await expect(audio(carol)).toHaveJSProperty('muted', false);
      await expect.poll(() => audio(carol).evaluate((player) => player.srcObject?.getAudioTracks().length)).toBe(1);
      await headphone.click();
      await expect(audio(alice)).toHaveJSProperty('muted', false);
      await expect(audio(alice)).toHaveJSProperty('volume', 0.05);
    }
    await alice.getByRole('button', { name: 'Chat da sala' }).click();
    await alice.screenshot({ path: testInfo.outputPath('sala-voz-desktop.png') });
    await alice.getByLabel('Tema').selectOption('dark');
    await alice.setViewportSize({ width: 390, height: 844 });
    expect(await alice.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expect(headphone).toBeInViewport();
    await alice.screenshot({ path: testInfo.outputPath('sala-voz-mobile.png') });
    await alice.setViewportSize({ width: 1440, height: 900 });
    await alice.getByLabel('Tema').selectOption('light');
    await microphone(bob).click();
    await expect(microphone(bob)).toHaveAttribute('aria-pressed', 'false');
    await expect(alice.locator('audio')).toHaveCount(0);
    await alice.getByRole('button', { name: 'Sair da sala' }).click();
    await navRoom(alice, 'Conversas').click();
    await alice.getByRole('button', { name: /^Pessoas/ }).click();
    await expect(alice.getByRole('slider', { name: 'Volume de Rafael' })).toHaveValue('5');
    await alice.getByRole('button', { name: 'Sair da sala' }).click();
    await bob.getByRole('button', { name: 'Sair da sala' }).click();
    if (blockedIce) { expect(faults).toEqual([]); return; }
    await carol.getByRole('button', { name: 'Sair da sala' }).click();

    await newRoom(alice, 'Reunião semanal', 'meet');
    await alice.getByRole('button', { name: 'Sair da sala' }).click();
    await alice.getByRole('button', { name: /^Salas/ }).last().click();
    await expect(alice.getByRole('heading', { name: 'Salas do grupo' })).toBeVisible();
    const groups = await (await bob.request.get('/api/groups')).json();
    const groupId = groups.find(({ name }) => name === 'Equipe').id;
    const [newMeeting] = await (await bob.request.get('/api/groups/' + groupId + '/rooms')).json();
    const denied = await bob.request.post('/api/groups/' + groupId + '/rooms/' + newMeeting.id + '/rename', {
      data: { name: 'Nome sem autorização' },
    });
    expect(denied.status()).toBe(403);
    await alice.getByRole('button', { name: 'Renomear Reunião semanal' }).click();
    await alice.getByRole('dialog').getByLabel('Nome').fill('Reunião da equipe');
    await alice.getByRole('button', { name: 'Salvar nome' }).click();
    await expect(alice.getByRole('button', { name: 'Entrar em Reunião da equipe' })).toBeVisible();
    await bob.getByRole('button', { name: /^Salas/ }).last().click();
    await expect(bob.getByRole('button', { name: 'Renomear Reunião da equipe' })).toHaveCount(0);
    await alice.screenshot({ path: testInfo.outputPath('salas-desktop.png') });
    await alice.getByRole('button', { name: 'Entrar em Reunião da equipe' }).click();
    await navRoom(bob, 'Reunião da equipe').click();
    if (!blockedIce) await expect(bob.getByText(mediaPath, { exact: true })).toBeVisible({ timeout: 18_000 });
    await send(alice, 'Bom dia! Vamos começar a reunião?');
    await expect(bob.getByText('Bom dia! Vamos começar a reunião?')).toBeVisible();
    await send(bob, 'Bom dia! Podemos começar.');
    await expect(alice.getByText('Bom dia! Podemos começar.')).toBeVisible();
    await expect(alice.getByLabel('Qualidade de envio')).toBeInViewport();
    await expect(alice.getByRole('heading', { name: 'Reunião da equipe', exact: true })).toBeInViewport();
    await alice.screenshot({ path: testInfo.outputPath('reuniao-desktop.png') });
    await bob.setViewportSize({ width: 390, height: 844 });
    expect(await bob.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await bob.screenshot({ path: testInfo.outputPath('reuniao-mobile.png'), fullPage: true });
    await bob.setViewportSize({ width: 1440, height: 900 });

    await bob.getByRole('button', { name: 'Câmera', exact: true }).click();
    await waitVideo(bob, 'Câmera de Rafael');
    await waitVideo(alice, 'Câmera de Rafael');
    await alice.getByRole('button', { name: 'Câmera', exact: true }).click();
    await waitVideo(bob, 'Câmera de Marina');
    await alice.getByRole('button', { name: 'Câmera', exact: true }).click();
    await bob.getByRole('button', { name: 'Microfone', exact: true }).click();
    const remoteAudio = alice.locator('audio[aria-label="Áudio de Rafael"]');
    await expect(remoteAudio).toHaveCount(1);
    await expect.poll(() => remoteAudio.evaluate((audio) => audio.srcObject?.getAudioTracks().length)).toBe(1);
    const captureSource = await contexts[1].newPage();
    await captureSource.setContent('<title>Chat P2P Capture Fixture</title><h1>Apresentação interna de teste</h1>');
    await bob.bringToFront();
    await bob.getByRole('button', { name: 'Compartilhar tela', exact: true }).click();
    await waitVideo(alice, 'Tela de Rafael');
    const expand = alice.getByRole('button', { name: 'Maximizar tela de rafael', exact: true });
    await expand.click();
    const viewer = alice.getByRole('dialog', { name: 'Tela de Rafael' });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByText(/Resolução atual: \d+ × \d+/)).toBeVisible();
    const expandedVideo = viewer.getByLabel('Tela de Rafael', { exact: true });
    await expect(expandedVideo).toHaveCSS('object-fit', 'contain');
    expect((await expandedVideo.boundingBox()).height).toBeGreaterThan(760);
    await alice.screenshot({ path: testInfo.outputPath('stream-maximizada.png') });
    await viewer.getByRole('button', { name: 'Tela cheia', exact: true }).click();
    await expect.poll(() => alice.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await viewer.getByRole('button', { name: 'Sair da tela cheia' }).click();
    await expect.poll(() => alice.evaluate(() => !!document.fullscreenElement)).toBe(false);
    await alice.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    await expect(expand).toBeFocused();
    await alice.getByRole('button', { name: 'Ocultar painel' }).click();
    await expect(alice.getByRole('button', { name: 'Chat da sala' })).toBeHidden();
    await alice.getByRole('button', { name: 'Chat e pessoas' }).click();
    await expect(alice.getByRole('button', { name: 'Chat da sala' })).toBeVisible();
    await bob.getByLabel('Qualidade de envio').selectOption('1440');
    await expect(bob.getByLabel('Qualidade de envio')).toHaveValue('1440');
    await expect(bob.getByLabel('Qualidade de envio')).toBeEnabled();
    await waitVideo(alice, 'Tela de Rafael');
    await captureSource.evaluate(() => { document.title = 'Apresentação de Rafael'; });
    const otherSource = await contexts[0].newPage();
    await otherSource.setContent('<title>Chat P2P Capture Fixture</title><h1>Segunda apresentação de teste</h1>');
    await alice.bringToFront();
    await alice.getByRole('button', { name: 'Compartilhar tela', exact: true }).click();
    await waitVideo(bob, 'Tela de Marina');
    await navRoom(carol, 'Reunião da equipe').click();
    await waitVideo(carol, 'Tela de Marina');
    await waitVideo(carol, 'Tela de Rafael');
    await expect(carol.getByRole('group', { name: 'Telas compartilhadas' }).locator('video')).toHaveCount(2);
    await carol.screenshot({ path: testInfo.outputPath('duas-telas-desktop.png') });
    await bob.getByRole('button', { name: 'Parar compartilhamento' }).click();
    await expect(carol.getByLabel('Tela de Rafael', { exact: true })).toHaveCount(0);
    await waitVideo(carol, 'Tela de Marina');
    await captureSource.close();
    await alice.getByRole('button', { name: 'Parar compartilhamento' }).click();
    await expect(bob.getByLabel('Tela de Marina', { exact: true })).toHaveCount(0);
    await otherSource.close();
    await waitVideo(carol, 'Câmera de Rafael');
    await carol.getByRole('button', { name: /^Pessoas/ }).click();
    await expect(carol.getByText('Host da sessão')).toBeVisible();
    await carol.getByLabel('Ações para Rafael').selectOption('mute');
    await expect(bob.getByRole('button', { name: 'Microfone', exact: true })).toBeDisabled();
    await expect(remoteAudio).toHaveCount(0);
    await carol.getByLabel('Ações para Rafael').selectOption('unmute');
    await expect(bob.getByRole('button', { name: 'Microfone', exact: true })).toBeEnabled();
    await alice.close();
    await expect(carol.getByText('Marina', { exact: true })).toHaveCount(0);
    await expect(carol.getByText('Host da sessão')).toBeVisible();
    await waitVideo(carol, 'Câmera de Rafael');
    await carol.getByRole('button', { name: 'Chat da sala' }).click();
    await send(bob, 'A reunião continua sem a anfitriã.');
    await expect(carol.getByText('A reunião continua sem a anfitriã.')).toBeVisible();

    await newRoom(bob, 'Apresentação', 'live');
    await navRoom(carol, 'Apresentação').click();
    await bob.getByRole('button', { name: 'Iniciar live' }).click();
    await expect(bob.getByLabel('Qualidade de envio')).toHaveValue('1440');
    await expect(carol.getByLabel('Qualidade de envio')).toHaveCount(0);
    await expect(carol.getByText('Ao vivo', { exact: true })).toBeVisible();
    await expect(carol.getByRole('button', { name: 'Iniciar live' })).toBeDisabled();
    await bob.getByRole('button', { name: 'Câmera', exact: true }).click();
    await waitVideo(carol, 'Câmera de Rafael');
    await carol.screenshot({ path: testInfo.outputPath('live-desktop.png') });
    await carol.setViewportSize({ width: 390, height: 844 });
    await carol.getByRole('button', { name: 'Maximizar câmera de rafael' }).click();
    await expect(carol.getByRole('dialog', { name: 'Câmera de Rafael' }).getByText(/Resolução atual/)).toBeVisible();
    await carol.screenshot({ path: testInfo.outputPath('live-maximizada-mobile.png') });
    await bob.getByRole('button', { name: 'Encerrar live' }).click();
    await expect(carol.getByRole('dialog')).toBeHidden();
    await carol.setViewportSize({ width: 1440, height: 900 });
    await expect(carol.getByText('Aguardando uma transmissão')).toBeVisible();

    const owner = await contexts[0].newPage();
    await owner.goto('/');
    await owner.getByRole('navigation').getByRole('button', { name: 'Equipe', exact: true }).click();
    await owner.getByRole('button', { name: 'Pessoas', exact: true }).click();
    owner.on('dialog', (dialog) => dialog.accept());
    await owner.getByLabel('Gerenciar Rafael').selectOption('ban');
    await expect(bob.getByRole('heading', { name: 'Atividade', exact: true })).toBeVisible();
    await expect(owner.getByLabel('Gerenciar Rafael')).toHaveCount(0);
    await carol.getByRole('button', { name: 'Sair da sala' }).click();
    await expect(carol.getByRole('heading', { name: 'Equipe', exact: true })).toBeVisible();
    expect(faults).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
