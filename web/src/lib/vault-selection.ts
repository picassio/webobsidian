const STORAGE_KEY = 'webobsidian.activeVaultId';
const DEFAULT_KEY = 'webobsidian.defaultVaultId';
const LEGACY_KEY = 'webobsidian.legacyVaultId';
let activeVaultId = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
let defaultVaultId = typeof localStorage === 'undefined' ? null : localStorage.getItem(DEFAULT_KEY);
let legacyVaultId = typeof localStorage === 'undefined' ? null : localStorage.getItem(LEGACY_KEY);

export function getActiveVaultId(): string | null {
  return activeVaultId;
}

export function getDefaultVaultId(): string | null {
  return defaultVaultId;
}

export function getLegacyVaultId(): string | null {
  return legacyVaultId;
}

export function setLegacyVaultId(vaultId: string): void {
  legacyVaultId = vaultId;
  if (typeof localStorage !== 'undefined') localStorage.setItem(LEGACY_KEY, vaultId);
}

export function setDefaultVaultId(vaultId: string): void {
  defaultVaultId = vaultId;
  if (typeof localStorage !== 'undefined') localStorage.setItem(DEFAULT_KEY, vaultId);
}

export function setActiveVaultId(vaultId: string): void {
  activeVaultId = vaultId;
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, vaultId);
}

export function vaultHeaders(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  if (activeVaultId) result.set('X-WebObsidian-Vault-Id', activeVaultId);
  return result;
}

export function withVaultQuery(url: string): string {
  if (!activeVaultId) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}vaultId=${encodeURIComponent(activeVaultId)}`;
}
