import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { currentVaultContext } from './vault-context.js';

/**
 * Persisted UI/workspace state (open tabs, active note, expanded folders, panel
 * layout, bookmarks, recents). Stored server-side as a plain JSON file so the
 * workspace is shared across browsers/devices — not tied to one browser's
 * localStorage. Single-user app → one shared state file.
 */

function uiStateFile(): string {
  return path.join(currentVaultContext()?.dataDir ?? config.dataDir, 'uistate.json');
}

export async function readUiState(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(uiStateFile(), 'utf8'));
  } catch {
    return {};
  }
}

export async function writeUiState(state: Record<string, unknown>): Promise<void> {
  const file = uiStateFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, file);
}
