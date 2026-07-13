import path from 'node:path';
import { z } from 'zod';
import { IdSchema, OperationResultSchema, Sha256Schema, type OperationResult } from '@picassio/sync-core';
import { AtomicJsonStore, ensureSyncStorage } from './storage.js';

const IDEMPOTENCY_SCHEMA_VERSION = 1;
const RecordSchema = z.object({
  clientSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  idempotencyKey: z.string().min(16).max(256),
  operationFingerprint: Sha256Schema,
  result: OperationResultSchema,
  committedAt: z.string().datetime({ offset: true }),
}).strict();
const DeviceStateSchema = z.object({
  deviceId: IdSchema,
  highestClientSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  records: z.array(RecordSchema),
}).strict();
const IdempotencyStateSchema = z.object({
  schemaVersion: z.literal(IDEMPOTENCY_SCHEMA_VERSION),
  devices: z.array(DeviceStateSchema),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
type IdempotencyState = z.infer<typeof IdempotencyStateSchema>;

export class IdempotencyConflictError extends Error {
  readonly code = 'client_sequence_reused';
  constructor(message: string, public readonly details: Record<string, unknown>) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export class IdempotencyStore {
  private state: IdempotencyState | null = null;
  private store: AtomicJsonStore<IdempotencyState> | null = null;

  constructor(private readonly dataDir: string, private readonly maxRecordsPerDevice = 10_000) {
    if (!Number.isInteger(maxRecordsPerDevice) || maxRecordsPerDevice < 1) throw new Error('invalid idempotency limit');
  }

  async highestClientSequence(deviceId: string): Promise<number> {
    return (await this.load()).devices.find((item) => item.deviceId === deviceId)?.highestClientSequence ?? 0;
  }

  async lookup(
    deviceId: string,
    clientSequence: number,
    idempotencyKey: string,
    operationFingerprint: string,
  ): Promise<OperationResult | null> {
    const state = await this.load();
    const device = state.devices.find((item) => item.deviceId === deviceId);
    if (!device) return null;
    const byKey = device.records.find((record) => record.idempotencyKey === idempotencyKey);
    if (byKey) {
      if (byKey.clientSequence === clientSequence && byKey.operationFingerprint === operationFingerprint) return byKey.result;
      throw new IdempotencyConflictError('idempotency key was reused for different input', {
        deviceId, clientSequence, idempotencyKey, recordedClientSequence: byKey.clientSequence,
      });
    }
    const bySequence = device.records.find((record) => record.clientSequence === clientSequence);
    if (bySequence || clientSequence <= device.highestClientSequence) {
      throw new IdempotencyConflictError('client sequence was already used or is out of order', {
        deviceId, clientSequence, highestClientSequence: device.highestClientSequence,
        recordedKey: bySequence?.idempotencyKey,
      });
    }
    return null;
  }

  async record(
    deviceId: string,
    clientSequence: number,
    idempotencyKey: string,
    operationFingerprint: string,
    result: OperationResult,
  ): Promise<OperationResult> {
    const duplicate = await this.lookup(deviceId, clientSequence, idempotencyKey, operationFingerprint);
    if (duplicate) return duplicate;
    const state = await this.load();
    const existing = state.devices.find((item) => item.deviceId === deviceId);
    const record = RecordSchema.parse({ clientSequence, idempotencyKey, operationFingerprint, result, committedAt: new Date().toISOString() });
    const records = [...(existing?.records ?? []), record]
      .sort((a, b) => a.clientSequence - b.clientSequence)
      .slice(-this.maxRecordsPerDevice);
    const device = DeviceStateSchema.parse({ deviceId, highestClientSequence: clientSequence, records });
    const devices = [...state.devices.filter((item) => item.deviceId !== deviceId), device]
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
    await this.write({ schemaVersion: IDEMPOTENCY_SCHEMA_VERSION, devices, updatedAt: new Date().toISOString() });
    return record.result;
  }

  async rebuildRecord(
    deviceId: string,
    clientSequence: number,
    idempotencyKey: string,
    operationFingerprint: string,
    result: OperationResult,
  ): Promise<void> {
    const state = await this.load();
    const device = state.devices.find((item) => item.deviceId === deviceId);
    const exact = device?.records.find((item) => item.idempotencyKey === idempotencyKey);
    if (exact) {
      if (exact.clientSequence !== clientSequence || exact.operationFingerprint !== operationFingerprint) {
        throw new IdempotencyConflictError('committed intent conflicts with idempotency state', { deviceId, idempotencyKey });
      }
      return;
    }
    // Recovery may rebuild an older committed record after newer operations.
    const record = RecordSchema.parse({ clientSequence, idempotencyKey, operationFingerprint, result, committedAt: new Date().toISOString() });
    const records = [...(device?.records ?? []), record]
      .sort((a, b) => a.clientSequence - b.clientSequence)
      .slice(-this.maxRecordsPerDevice);
    const rebuilt = DeviceStateSchema.parse({
      deviceId,
      highestClientSequence: Math.max(device?.highestClientSequence ?? 0, clientSequence),
      records,
    });
    await this.write({
      schemaVersion: IDEMPOTENCY_SCHEMA_VERSION,
      devices: [...state.devices.filter((item) => item.deviceId !== deviceId), rebuilt].sort((a, b) => a.deviceId.localeCompare(b.deviceId)),
      updatedAt: new Date().toISOString(),
    });
  }

  private async load(): Promise<IdempotencyState> {
    if (this.state) return this.state;
    const paths = await ensureSyncStorage(this.dataDir);
    this.store = new AtomicJsonStore(path.join(paths.root, 'idempotency.json'), IdempotencyStateSchema);
    this.state = await this.store.read() ?? { schemaVersion: IDEMPOTENCY_SCHEMA_VERSION, devices: [], updatedAt: new Date().toISOString() };
    return this.state;
  }

  private async write(state: IdempotencyState): Promise<void> {
    await this.load();
    await this.store!.write(state);
    this.state = state;
  }
}
