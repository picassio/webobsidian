import { randomBytes } from 'node:crypto';
import { sha256Text } from '@picassio/sync-core';

interface Ticket { deviceId: string; expiresAt: number }

export class WsTicketStore {
  private readonly tickets = new Map<string, Ticket>();
  constructor(private readonly ttlMs = 60_000) {}

  issue(deviceId: string): { ticket: string; expiresAt: string } {
    this.prune();
    const ticket = `wst_${randomBytes(32).toString('base64url')}`;
    const expiresAt = Date.now() + this.ttlMs;
    this.tickets.set(sha256Text(ticket), { deviceId, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  consume(ticket: string): string | null {
    const key = sha256Text(ticket);
    const record = this.tickets.get(key);
    this.tickets.delete(key);
    if (!record || record.expiresAt <= Date.now()) return null;
    return record.deviceId;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, record] of this.tickets) if (record.expiresAt <= now) this.tickets.delete(key);
  }
}

export const wsTickets = new WsTicketStore();
