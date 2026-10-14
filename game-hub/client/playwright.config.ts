import { defineConfig, devices } from '@playwright/test';

/**
 * Browser smoke tests. Boots the real server and the Vite dev server.
 * Run with `npm run e2e` from the repo root.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  // Software-rendered WebGL in headless CI occasionally stalls frames for seconds;
  // one retry keeps the suite meaningful (flaky tests are still reported as "flaky").
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    launchOptions: {
      // Headless Chromium renders WebGL through SwiftShader. Without --disable-gpu-vsync its
      // frame scheduler sometimes stalls requestAnimationFrame for seconds in CI sandboxes.
      // (Don't add --disable-frame-rate-limit: uncapped pages starve each other's GPU time.)
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--disable-gpu-vsync',
        // Multiplayer tests drive two windows at once; keep the unfocused one running.
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-background-timer-throttling',
      ],
    },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'tablet',
      use: {
        viewport: { width: 1180, height: 820 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
        userAgent:
          'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      },
    },
  ],
  webServer: [
    {
      command: 'npx tsx src/index.ts',
      cwd: '../server',
      port: 2567,
      reuseExistingServer: true,
      env: { LOG_LEVEL: 'warn' },
    },
    {
      command: 'npx vite --port 5173 --strictPort --host 127.0.0.1',
      cwd: '.',
      port: 5173,
      reuseExistingServer: true,
    },
  ],
});
