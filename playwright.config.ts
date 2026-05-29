import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: path.resolve(__dirname, './tests/global-setup.ts'),
  use: {
    storageState: path.resolve(__dirname, './tests/.auth/user.json'),
    headless: false,
    baseURL: process.env.BASE_URL,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
  },
  reporter: [['html', { outputFolder: 'docs/test-reports' }]],
  projects: [
    {
      name: 'edge-extension',
      use: {
        browserName: 'chromium',
        channel: 'msedge',
      },
    },
  ],
});
