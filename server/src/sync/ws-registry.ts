let disconnect: (deviceId: string) => void = () => {};

export function registerSyncWebSocketDisconnect(handler: (deviceId: string) => void): void {
  disconnect = handler;
}

export function disconnectSyncWebSockets(deviceId: string): void {
  disconnect(deviceId);
}
