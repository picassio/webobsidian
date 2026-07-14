let disconnect: (deviceId: string, vaultId?: string) => void = () => {};

export function registerSyncWebSocketDisconnect(handler: (deviceId: string, vaultId?: string) => void): void {
  disconnect = handler;
}

export function disconnectSyncWebSockets(deviceId: string, vaultId?: string): void {
  disconnect(deviceId, vaultId);
}
