// Deep-link URL sync (FR-10): the browser URL mirrors the open note as
// /vault/<vaultId>/note/<vault-relative-path> (Graph view = /vault/<vaultId>/graph). Legacy /note and /graph use the default vault. Opening such a URL after
// login opens the note; browser back/forward navigate via popstate.
import { useStore, GRAPH_PATH } from './store';
import { getActiveVaultId } from './vault-selection';

export function pathToUrl(path: string | null): string {
  const vaultId = getActiveVaultId();
  const prefix = vaultId ? `/vault/${encodeURIComponent(vaultId)}` : '';
  if (!path) return prefix || '/';
  if (path === GRAPH_PATH) return `${prefix}/graph`;
  return `${prefix}/note/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function urlToVaultId(pathname: string): string | null {
  const match = pathname.match(/^\/vault\/([^/]+)(?:\/|$)/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

/** Vault path encoded in a location pathname, or null if it isn't a deep link. */
export function urlToPath(pathname: string): string | null {
  const scoped = pathname.match(/^\/vault\/[^/]+(\/.*)?$/)?.[1] ?? pathname;
  if (scoped === '/graph') return GRAPH_PATH;
  if (scoped.startsWith('/note/')) {
    try {
      const rel = scoped.slice('/note/'.length).split('/').map(decodeURIComponent).join('/');
      return rel || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** True while we're applying a popstate — suppresses the pushState echo. */
let applyingPop = false;
let started = false;

/**
 * Start two-way sync. Call once after auth. Returns the deep-linked path that
 * was present in the URL at load time (to open after the workspace restores).
 */
export function initUrlSync(): string | null {
  const initial = urlToPath(window.location.pathname);
  if (started) return initial;
  started = true;

  // store → URL. The very first sync (workspace restore on load) replaces the
  // entry instead of pushing, so Back doesn't land on a stale '/'.
  let firstSync = true;
  useStore.subscribe((state, prev) => {
    if (state.activePath === prev.activePath && state.activeVaultId === prev.activeVaultId) return;
    const url = pathToUrl(state.activePath);
    if (window.location.pathname === url) return;
    if (applyingPop || firstSync) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
    firstSync = false;
  });

  // URL → store (browser back/forward)
  window.addEventListener('popstate', () => {
    const path = urlToPath(window.location.pathname);
    const state = useStore.getState();
    const legacyDeepLink = window.location.pathname === '/graph' || window.location.pathname.startsWith('/note/');
    const vaultId = urlToVaultId(window.location.pathname) ?? (legacyDeepLink ? state.defaultVaultId : null);
    if (!path && !vaultId) return;
    applyingPop = true;
    Promise.resolve(vaultId && vaultId !== state.activeVaultId ? state.switchVault(vaultId) : undefined)
      .then(() => path && path !== useStore.getState().activePath ? useStore.getState().openFile(path) : undefined)
      .catch(() => {})
      .finally(() => { applyingPop = false; });
  });

  return initial;
}
