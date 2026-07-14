export interface PairingTarget {
  id: string;
  name: string;
}

export function pairingTargetDescription(target: PairingTarget, sequence: number | null): string {
  return `Target server vault: “${target.name}” (${target.id}), sequence ${sequence ?? 'checking'}. A code never creates a vault; it binds the device to this selected vault.`;
}

export function pairingConfirmation(target: PairingTarget, sequence: number): string {
  const convergence = sequence > 0
    ? `This vault already contains committed data at sequence ${sequence}; pairing will converge the local vault with it.`
    : 'This server vault is empty, so the first client will populate it.';
  return `Create a code for server vault “${target.name}” (${target.id})? The device name does not create a vault. ${convergence}`;
}
