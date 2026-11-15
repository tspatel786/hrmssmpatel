import { defineConfig, devices } from '@playwright/test';

// Two targets:
//  - "desktop"/"mobile": demo build (in-browser Postgres, mock email) on :4173 — no credentials needed
//  - "supabase": Supabase-mode build on :4174 against the configured project (set SUPABASE_LIVE=1)
const live = process.env.SUPABASE_LIVE === '1';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', testIgnore: /communication\.spec|compat\.spec|responsive\.spec/, use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4173', viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', testMatch: /responsive\.spec/, use: { ...devices['Pixel 7'], baseURL: 'http://localhost:4173' } },
    ...(live ? [{ name: 'supabase', testMatch: /communication\.spec|compat\.spec/, use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4174' } }] : []),
  ],
  webServer: [
    { command: 'npm run build:demo && npm run preview:demo', url: 'http://localhost:4173', reuseExistingServer: false, timeout: 300_000 },
    ...(live ? [{ command: 'npx vite build --outDir dist-live && npx vite preview --outDir dist-live --port 4174 --strictPort', url: 'http://localhost:4174', reuseExistingServer: false, timeout: 300_000 }] : []),
  ],
});
