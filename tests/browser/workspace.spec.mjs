import { test, expect } from '@playwright/test';

async function account(page, name, username, bootstrap = false) {
  await page.getByLabel('Nome', { exact: true }).fill(name);
  await page.getByLabel('Usuário').fill(username);
  await page.getByLabel('Senha').fill('senha-para-teste-e2e');
  if (bootstrap) await page.getByLabel('Código de instalação').fill('local-browser-test-bootstrap-key');
  await page.getByRole('button', { name: 'Criar conta', exact: true }).click();
}
async function invite(owner, visitor, name, username, role) {
  await owner.getByRole('button', { name: 'Convidar' }).click();
  await owner.getByLabel('Papel').selectOption(role);
  await owner.getByRole('button', { name: 'Gerar convite' }).click();
  const invite = owner.getByLabel('Link de convite');
  await expect(invite).toHaveValue(/#invite=/);
  const link = await invite.inputValue();
  await owner.getByRole('dialog').getByRole('button', { name: 'Fechar' }).click();
  await visitor.goto(link);
  await account(visitor, name, username);
  await expect(visitor.getByRole('heading', { name: 'Aguardando aprovação' })).toBeVisible();
  await owner.getByRole('button', { name: /^Pessoas/ }).click();
  await owner.getByRole('button', { name: 'Aprovar' }).click();
  await expect(visitor.getByRole('button', { name: 'Chat do grupo' })).toBeVisible();
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

test('convite MLS, reunião P2P, troca de host, live e banimento', async ({ browser }, testInfo) => {
  const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext()));
  try {
    const [alice, bob, carol] = await Promise.all(contexts.map((ctx) => ctx.newPage()));
    const faults = [];
    for (const page of [alice, bob, carol]) page.on('pageerror', (error) => faults.push(error.message));
    await alice.goto('/');
    await account(alice, 'Marina', 'marina', true);
    await alice.getByRole('button', { name: 'Novo grupo', exact: true }).last().click();
    await alice.getByRole('dialog').getByLabel('Nome').fill('Equipe');
    await alice.getByRole('dialog').getByRole('button', { name: 'Criar', exact: true }).click();
    await expect(alice.getByRole('button', { name: 'Chat do grupo' })).toBeVisible();
    await send(alice, 'Mensagem anterior ao convite');
    await invite(alice, bob, 'Rafael', 'rafael', 'member');
    await invite(alice, carol, 'Carolina', 'carolina', 'moderator');
    await alice.getByRole('button', { name: 'Chat do grupo' }).click();
    await send(alice, 'Recado privado para a equipe');
    await expect(bob.getByText('Recado privado para a equipe')).toBeVisible();
    await expect(bob.getByText('Mensagem anterior ao convite')).toHaveCount(0);
    await bob.reload();
    await expect(bob.getByText('Recado privado para a equipe')).toBeVisible();
    await newRoom(alice, 'Reunião semanal', 'meet');
    await navRoom(bob, 'Reunião semanal').click();
    await expect(bob.getByText('Direta', { exact: true })).toBeVisible({ timeout: 18_000 });
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
    await owner.getByRole('button', { name: /^Pessoas/ }).click();
    owner.on('dialog', (dialog) => dialog.accept());
    await owner.getByLabel('Gerenciar Rafael').selectOption('ban');
    await expect(bob.getByRole('heading', { name: 'Seus grupos' })).toBeVisible();
    await expect(owner.getByLabel('Gerenciar Rafael')).toHaveCount(0);
    await owner.getByRole('button', { name: 'Chat do grupo' }).click();
    await send(owner, 'Mensagem após o banimento');
    await carol.getByRole('button', { name: 'Sair da sala' }).click();
    await expect(carol.getByText('Mensagem após o banimento')).toBeVisible();
    expect(faults).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
