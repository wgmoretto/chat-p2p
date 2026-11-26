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
const blockedIce = process.env.TEST_ICE_BLOCKED === '1';
const mediaPath = process.env.FORCE_TURN === '1' ? 'Relay TURN' : 'Direta';

test('login no segundo navegador, amigos, reunião P2P e moderação', async ({ browser }, testInfo) => {
  const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()));
  try {
    if (blockedIce) await Promise.all(contexts.map((context) => context.addInitScript(() => {
      const PeerConnection = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends PeerConnection {
        constructor(config) { super({ ...config, iceServers: [], iceTransportPolicy: 'relay' }); }
      };
    })));
    const [alice, bob, carol, serverBrowser] = await Promise.all(contexts.map((ctx) => ctx.newPage()));
    const relayed = [];
    alice.on('websocket', (socket) => {
      if (!new URL(socket.url()).pathname.endsWith('/signal')) return;
      socket.on('framesent', ({ payload }) => {
        if (typeof payload !== 'string') return;
        const frame = JSON.parse(payload);
        if (frame.type === 'chat') relayed.push(frame);
      });
    });
    const faults = [];
    for (const page of [alice, bob, carol]) page.on('pageerror', (error) => faults.push(error.message));
    await serverBrowser.goto('/');
    await account(serverBrowser, 'Marina', 'marina', true);
    await expect(serverBrowser.getByRole('heading', { name: 'Amigos', exact: true })).toBeVisible();

    await alice.goto('/');
    await alice.getByLabel('Usuário').fill('marina');
    await alice.getByLabel('Senha').fill('senha-para-teste-e2e');
    await alice.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(alice.getByRole('heading', { name: 'Amigos', exact: true })).toBeVisible();
    await alice.getByLabel('Tema').selectOption('dark');
    await expect(alice.locator('html')).toHaveCSS('color-scheme', 'dark');
    await alice.reload();
    await expect(alice.getByRole('heading', { name: 'Amigos', exact: true })).toBeVisible();
    await expect(alice.getByLabel('Tema')).toHaveValue('dark');
    await expect(alice.locator('html')).toHaveCSS('background-color', 'rgb(16, 19, 24)');
    await alice.screenshot({ path: testInfo.outputPath('amigos-escuro.png') });
    await alice.getByLabel('Tema').selectOption('light');
    await expect(alice.locator('html')).toHaveCSS('color-scheme', 'light');
    for (const [page, name, handle] of [[bob, 'Rafael', 'rafael'], [carol, 'Carolina', 'carolina']]) {
      await page.goto('/');
      await page.getByRole('button', { name: 'Criar conta', exact: true }).click();
      await account(page, name, handle);
      await expect(page.getByRole('heading', { name: 'Amigos', exact: true })).toBeVisible();
    }

    await alice.getByLabel('Adicionar pelo @usuário').fill('@rafael');
    await alice.getByRole('button', { name: 'Enviar pedido' }).click();
    await expect(alice.getByRole('heading', { name: 'Pedidos enviados' })).toBeVisible();
    await bob.getByRole('button', { name: 'Aceitar', exact: true }).click();
    await expect(alice.getByRole('button', { name: 'Conversar' })).toBeVisible();
    await alice.getByRole('searchbox', { name: 'Buscar amigos' }).fill('inexistente');
    await expect(alice.getByText('Nenhum amigo encontrado.')).toBeVisible();
    await alice.getByRole('searchbox', { name: 'Buscar amigos' }).fill('@rafael');
    await expect(alice.getByRole('button', { name: 'Conversar' })).toBeVisible();
    await alice.getByRole('searchbox', { name: 'Buscar amigos' }).clear();
    await alice.screenshot({ path: testInfo.outputPath('amigos-desktop.png') });
    await bob.setViewportSize({ width: 390, height: 844 });
    expect(await bob.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(await bob.locator('.sidebar').evaluate((element) => element.offsetHeight)).toBeLessThan(230);
    await expect(bob.getByRole('navigation')).toBeHidden();
    await bob.getByRole('button', { name: 'Abrir navegação' }).click();
    await expect(bob.getByRole('navigation')).toBeVisible();
    await bob.getByRole('navigation').getByRole('button', { name: 'Amigos', exact: true }).click();
    await expect(bob.getByRole('navigation')).toBeHidden();
    await bob.screenshot({ path: testInfo.outputPath('amigos-mobile.png'), fullPage: true });
    await bob.setViewportSize({ width: 1440, height: 900 });

    await alice.getByRole('button', { name: 'Conversar' }).click();
    await bob.getByRole('button', { name: 'Atender' }).click();
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
      return;
    }
    await alice.getByRole('button', { name: 'Sair da sala' }).click();
    await bob.getByRole('button', { name: 'Sair da sala' }).click();
    await expect(alice.getByRole('heading', { name: 'Amigos', exact: true })).toBeVisible();
    await alice.getByRole('button', { name: 'Novo grupo', exact: true }).last().click();
    await alice.getByRole('dialog').getByLabel('Nome').fill('Equipe');
    await alice.getByRole('dialog').getByRole('button', { name: 'Criar', exact: true }).click();
    await expect(alice.getByRole('heading', { name: 'Equipe', exact: true })).toBeVisible();
    await invite(alice, bob, 'member');
    await invite(alice, carol, 'moderator');
    await newRoom(alice, 'Reunião semanal', 'meet');
    await alice.getByRole('button', { name: 'Sair da sala' }).click();
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
    await alice.getByRole('button', { name: 'Mostrar painel' }).click();
    await expect(alice.getByRole('button', { name: 'Chat da sala' })).toBeVisible();
    await bob.getByLabel('Qualidade de envio').selectOption('1440');
    await expect(bob.getByLabel('Qualidade de envio')).toHaveValue('1440');
    await expect(bob.getByLabel('Qualidade de envio')).toBeEnabled();
    await waitVideo(alice, 'Tela de Rafael');
    await bob.getByRole('button', { name: 'Parar compartilhamento' }).click();
    await expect(alice.getByLabel('Tela de Rafael', { exact: true })).toHaveCount(0);
    await captureSource.close();
    const otherSource = await contexts[0].newPage();
    await otherSource.setContent('<title>Chat P2P Capture Fixture</title><h1>Segunda apresentação de teste</h1>');
    await alice.bringToFront();
    await alice.getByRole('button', { name: 'Compartilhar tela', exact: true }).click();
    await waitVideo(bob, 'Tela de Marina');
    await alice.getByRole('button', { name: 'Parar compartilhamento' }).click();
    await expect(bob.getByLabel('Tela de Marina', { exact: true })).toHaveCount(0);
    await otherSource.close();
    await navRoom(carol, 'Reunião da equipe').click();
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
    await expect(bob.getByRole('heading', { name: 'Amigos', exact: true })).toBeVisible();
    await expect(owner.getByLabel('Gerenciar Rafael')).toHaveCount(0);
    await carol.getByRole('button', { name: 'Sair da sala' }).click();
    await expect(carol.getByRole('heading', { name: 'Equipe', exact: true })).toBeVisible();
    expect(faults).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
