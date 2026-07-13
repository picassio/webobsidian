import { IdSchema, SafeIntegerSchema } from './schemas.js';

declare const brand: unique symbol;
export type Brand<T, Name extends string> = T & { readonly [brand]: Name };
export type VaultId = Brand<string, 'VaultId'>;
export type DeviceId = Brand<string, 'DeviceId'>;
export type EntryId = Brand<string, 'EntryId'>;
export type EventId = Brand<string, 'EventId'>;
export type ConflictId = Brand<string, 'ConflictId'>;
export type Sequence = Brand<number, 'Sequence'>;
export type Revision = Brand<number, 'Revision'>;

export const asVaultId = (value: string): VaultId => IdSchema.parse(value) as VaultId;
export const asDeviceId = (value: string): DeviceId => IdSchema.parse(value) as DeviceId;
export const asEntryId = (value: string): EntryId => IdSchema.parse(value) as EntryId;
export const asEventId = (value: string): EventId => IdSchema.parse(value) as EventId;
export const asConflictId = (value: string): ConflictId => IdSchema.parse(value) as ConflictId;
export const asSequence = (value: number): Sequence => SafeIntegerSchema.parse(value) as Sequence;
export const asRevision = (value: number): Revision => SafeIntegerSchema.parse(value) as Revision;
