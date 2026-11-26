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
  await expect(page.getByLabel(label)).toBeVisible();
  await expect.poll(() => page.getByLabel(label).evaluate((video) => video.videoWidth)).toBeGreaterThan(0);
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
    await alice.reload();
    await expect(alice.getByRole('heading', { name: 'Amigos', exact: true })).toBeVisible();
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
    await alice.screenshot({ path: testInfo.outputPath('amigos-desktop.png') });
    await bob.setViewportSize({ width: 390, height: 844 });
    expect(await bob.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(await bob.locator('.sidebar').evaluate((element) => element.offsetHeight)).toBeLessThan(230);
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
    await navRoom(bob, 'Reunião semanal').click();
    if (!blockedIce) await expect(bob.getByText(mediaPath, { exact: true })).toBeVisible({ timeout: 18_000 });
    await send(alice, 'Bom dia! Vamos começar a reunião?');
    await expect(bob.getByText('Bom dia! Vamos começar a reunião?')).toBeVisible();
    await send(bob, 'Bom dia! Podemos começar.');
    await expect(alice.getByText('Bom dia! Podemos começar.')).toBeVisible();
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
    await bob.getByRole('button', { name: 'Parar compartilhamento' }).click();
    await expect(alice.getByLabel('Tela de Rafael')).toHaveCount(0);
    await captureSource.close();
    const otherSource = await contexts[0].newPage();
    await otherSource.setContent('<title>Chat P2P Capture Fixture</title><h1>Segunda apresentação de teste</h1>');
    await alice.bringToFront();
    await alice.getByRole('button', { name: 'Compartilhar tela', exact: true }).click();
    await waitVideo(bob, 'Tela de Marina');
    await alice.getByRole('button', { name: 'Parar compartilhamento' }).click();
    await expect(bob.getByLabel('Tela de Marina')).toHaveCount(0);
    await otherSource.close();
    await navRoom(carol, 'Reunião semanal').click();
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
    await expect(carol.getByText('Ao vivo', { exact: true })).toBeVisible();
    await expect(carol.getByRole('button', { name: 'Iniciar live' })).toBeDisabled();
    await bob.getByRole('button', { name: 'Câmera', exact: true }).click();
    await waitVideo(carol, 'Câmera de Rafael');
    await bob.getByRole('button', { name: 'Encerrar live' }).click();
    await expect(carol.getByText('Aguardando uma transmissão')).toBeVisible();

    const owner = await contexts[0].newPage();
    await owner.goto('/');
    await owner.getByRole('navigation').getByRole('button', { name: 'Equipe', exact: true }).click();
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
