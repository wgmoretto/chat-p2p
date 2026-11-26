import { defineConfig } from '@playwright/test';

const origin = 'http://localhost:3190';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 90_000,
  workers: 1,
  use: {
    baseURL: origin,
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--auto-select-tab-capture-source-by-title=Chat P2P Capture Fixture',
      '--autoplay-policy=no-user-gesture-required',
    ] },
  },
  webServer: {
    command: 'node server/index.mjs',
    url: origin + '/healthz',
    reuseExistingServer: false,
    env: {
      PUBLIC_ORIGIN: origin, BOOTSTRAP_TOKEN: 'local-browser-test-bootstrap-key',
      DATABASE_PATH: ':memory:', PORT: '3190',
    },
  },
});
