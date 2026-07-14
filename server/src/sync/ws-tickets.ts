import { randomBytes } from 'node:crypto';
import { sha256Text } from '@picassio/sync-core';

interface Ticket { deviceId: string; vaultId: string; expiresAt: number }
export interface ConsumedWsTicket { deviceId: string; vaultId: string }

export class WsTicketStore {
  private readonly tickets = new Map<string, Ticket>();
  constructor(private readonly ttlMs = 60_000) {}

  issue(deviceId: string, vaultId = ''): { ticket: string; expiresAt: string } {
    this.prune();
    const ticket = `wst_${randomBytes(32).toString('base64url')}`;
    const expiresAt = Date.now() + this.ttlMs;
    this.tickets.set(sha256Text(ticket), { deviceId, vaultId, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  consume(ticket: string): string | null {
    return this.consumeDetailed(ticket)?.deviceId ?? null;
  }

  consumeDetailed(ticket: string): ConsumedWsTicket | null {
    const key = sha256Text(ticket);
    const record = this.tickets.get(key);
    this.tickets.delete(key);
    if (!record || record.expiresAt <= Date.now()) return null;
    return { deviceId: record.deviceId, vaultId: record.vaultId };
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, record] of this.tickets) if (record.expiresAt <= now) this.tickets.delete(key);
  }
}

export const wsTickets = new WsTicketStore();
