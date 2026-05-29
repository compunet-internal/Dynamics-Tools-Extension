import type { FullConfig } from '@playwright/test';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const authDir = path.resolve(__dirname, '.auth');
  const storageStatePath = path.join(authDir, 'user.json');

  await fs.mkdir(authDir, { recursive: true });
  await fs.writeFile(
    storageStatePath,
    JSON.stringify({ cookies: [], origins: [] }, null, 2),
    'utf-8'
  );
}
