import type { SyncEvent, SyncOperation } from './schemas.js';

export interface PendingOperation {
  operation: SyncOperation;
  status: 'queued' | 'sending' | 'conflict';
  attempts: number;
  lastErrorCode?: string;
}

export interface LocalApplyIntent {
  event: SyncEvent;
  expectedPreviousPath?: string;
  expectedPreviousHash?: string | null;
  status: 'prepared' | 'materialized';
}

export interface ClientSyncState {
  vaultId: string;
  deviceId: string;
  lastAppliedSequence: number;
  lastAcknowledgedSequence: number;
  nextClientSequence: number;
  pending: PendingOperation[];
  applyIntent: LocalApplyIntent | null;
}

export function createClientSyncState(vaultId: string, deviceId: string): ClientSyncState {
  return {
    vaultId,
    deviceId,
    lastAppliedSequence: 0,
    lastAcknowledgedSequence: 0,
    nextClientSequence: 1,
    pending: [],
    applyIntent: null,
  };
}

export function enqueueOperation(state: ClientSyncState, operation: SyncOperation): ClientSyncState {
  if (operation.clientSequence !== state.nextClientSequence) {
    throw new Error(`client sequence must be ${state.nextClientSequence}`);
  }
  if (state.pending.some((item) => item.operation.idempotencyKey === operation.idempotencyKey)) {
    throw new Error(`duplicate idempotency key ${operation.idempotencyKey}`);
  }
  return {
    ...state,
    nextClientSequence: state.nextClientSequence + 1,
    pending: [...state.pending, { operation, status: 'queued', attempts: 0 }],
  };
}

export function markSending(state: ClientSyncState, idempotencyKey: string): ClientSyncState {
  return updatePending(state, idempotencyKey, (item) => ({ ...item, status: 'sending', attempts: item.attempts + 1 }));
}

export function markOperationConflict(state: ClientSyncState, idempotencyKey: string, errorCode: string): ClientSyncState {
  return updatePending(state, idempotencyKey, (item) => ({ ...item, status: 'conflict', lastErrorCode: errorCode }));
}

export function completeOperation(state: ClientSyncState, idempotencyKey: string): ClientSyncState {
  if (!state.pending.some((item) => item.operation.idempotencyKey === idempotencyKey)) {
    throw new Error(`unknown operation ${idempotencyKey}`);
  }
  return { ...state, pending: state.pending.filter((item) => item.operation.idempotencyKey !== idempotencyKey) };
}

export function prepareLocalApply(
  state: ClientSyncState,
  event: SyncEvent,
  expected: { path?: string; hash?: string | null } = {},
): ClientSyncState {
  if (state.applyIntent) throw new Error('local apply intent already active');
  if (event.sequence !== state.lastAppliedSequence + 1) {
    throw new Error(`event sequence must be ${state.lastAppliedSequence + 1}`);
  }
  const intent: LocalApplyIntent = {
    event,
    status: 'prepared',
    ...(expected.path !== undefined ? { expectedPreviousPath: expected.path } : {}),
    ...(expected.hash !== undefined ? { expectedPreviousHash: expected.hash } : {}),
  };
  return { ...state, applyIntent: intent };
}

export function markLocalMaterialized(state: ClientSyncState): ClientSyncState {
  if (!state.applyIntent) throw new Error('no local apply intent');
  return { ...state, applyIntent: { ...state.applyIntent, status: 'materialized' } };
}

export function commitLocalApply(state: ClientSyncState): ClientSyncState {
  if (!state.applyIntent || state.applyIntent.status !== 'materialized') {
    throw new Error('local apply must be materialized before commit');
  }
  return { ...state, lastAppliedSequence: state.applyIntent.event.sequence, applyIntent: null };
}

export function acknowledgeApplied(state: ClientSyncState, sequence: number): ClientSyncState {
  if (sequence > state.lastAppliedSequence) throw new Error('cannot acknowledge an unapplied sequence');
  if (sequence < state.lastAcknowledgedSequence) throw new Error('acknowledgement cannot move backwards');
  return { ...state, lastAcknowledgedSequence: sequence };
}

function updatePending(
  state: ClientSyncState,
  idempotencyKey: string,
  update: (item: PendingOperation) => PendingOperation,
): ClientSyncState {
  let found = false;
  const pending = state.pending.map((item) => {
    if (item.operation.idempotencyKey !== idempotencyKey) return item;
    found = true;
    return update(item);
  });
  if (!found) throw new Error(`unknown operation ${idempotencyKey}`);
  return { ...state, pending };
}
