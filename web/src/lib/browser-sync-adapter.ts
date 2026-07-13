import { mergeText, sha256Text, type OperationResult, type SyncEntry, type SyncEvent } from '@picassio/sync-core';
import { useStore, type DocumentState } from './store';
import type { LocalApplyIntent, SyncPersistence } from './sync-db';
import type { LocalSyncAdapter } from './sync-engine';

const TEXT_PATH = /\.(md|markdown|txt|json|css|js|ts|tsx|jsx|html|xml|yaml|yml|csv|svg)$/i;

export class BrowserLocalSyncAdapter implements LocalSyncAdapter {
  constructor(
    private readonly persistence: SyncPersistence,
    private readonly fetchText: (event: SyncEvent) => Promise<string | null>,
  ) {}

  async apply(event: SyncEvent): Promise<void> {
    await this.persistence.putEntry({
      entryId: event.entryId,
      path: event.path,
      revision: event.revision,
      hash: event.hash,
      size: event.size,
      deleted: event.operation === 'delete' || event.operation === 'rmdir',
    });
    const state = useStore.getState();
    const key = Object.keys(state.documents).find((path) =>
      state.documents[path]?.entryId === event.entryId || path === event.oldPath || path === event.path,
    );
    const document = key ? state.documents[key] : undefined;

    if (event.operation === 'delete' || event.operation === 'rmdir') {
      if (document && document.dirtyGeneration > document.saveGeneration) {
        this.flagConflict(key!, document, 'Remote delete conflicts with this unsaved draft');
        return;
      }
      useStore.setState((current) => {
        const documents = { ...current.documents };
        if (key) delete documents[key];
        const tabs = current.tabs.filter((tab) => tab.path !== key && tab.path !== event.path);
        return {
          documents,
          tabs,
          ...(current.activePath === key || current.activePath === event.path ? {
            activePath: tabs.at(-1)?.path ?? null,
            content: '', dirty: false, activeEntryId: null, activeRevision: null, activeHash: null,
          } : {}),
        };
      });
      await useStore.getState().loadTree();
      return;
    }

    if (event.operation === 'rename' && document && key && key !== event.path) {
      const dirty = document.dirtyGeneration > document.saveGeneration;
      const renamed: DocumentState = {
        ...document, path: event.path,
        ...(!dirty ? { revision: event.revision, hash: event.hash } : {}),
      };
      useStore.setState((current) => {
        const documents = { ...current.documents };
        delete documents[key];
        documents[event.path] = renamed;
        const tabs = current.tabs.map((tab) => tab.path === key ? { ...tab, path: event.path, title: event.path.split('/').at(-1) ?? event.path } : tab);
        return {
          documents, tabs,
          activePath: current.activePath === key ? event.path : current.activePath,
          splitPath: current.splitPath === key ? event.path : current.splitPath,
          ...(current.activePath === key && !dirty ? { activeRevision: event.revision, activeHash: event.hash } : {}),
        };
      });
      await useStore.getState().loadTree();
      return;
    }

    if (document && TEXT_PATH.test(event.path) && event.hash) {
      const remote = await this.fetchText(event);
      if (remote !== null) {
        const dirty = document.dirtyGeneration > document.saveGeneration;
        if (dirty) {
          if (sha256Text(document.content) === event.hash) {
            const converged: DocumentState = {
              ...document, path: event.path, baseContent: remote,
              revision: event.revision, hash: event.hash,
              saveGeneration: document.dirtyGeneration, pending: false, error: null,
            };
            this.updateDocument(key!, event.path, converged);
            await useStore.getState().loadTree();
            return;
          }
          const merged = mergeText(remote, document.baseContent, document.content);
          if (!merged.clean) {
            this.flagConflict(key!, document, `Remote revision ${event.revision} overlaps this draft`);
            return;
          }
          const updated: DocumentState = {
            ...document,
            path: event.path,
            content: merged.content,
            baseContent: remote,
            revision: event.revision,
            hash: event.hash,
            dirtyGeneration: document.dirtyGeneration + 1,
            error: null,
          };
          this.updateDocument(key!, event.path, updated);
        } else {
          const updated: DocumentState = {
            ...document, path: event.path, content: remote, baseContent: remote,
            revision: event.revision, hash: event.hash,
            saveGeneration: document.dirtyGeneration, pending: false, error: null,
          };
          this.updateDocument(key!, event.path, updated);
        }
      }
    }
    await useStore.getState().loadTree();
  }

  async recover(intent: LocalApplyIntent): Promise<void> { await this.apply(intent.event); }
  async bootstrap(entries: SyncEntry[]): Promise<void> {
    await this.persistence.replaceEntries(entries.map((entry) => ({
      entryId: entry.entryId, path: entry.path, revision: entry.revision,
      hash: entry.hash, size: entry.size, deleted: entry.deleted,
    })));
    await useStore.getState().loadTree();
  }
  async conflict(_result: OperationResult): Promise<void> {
    const state = useStore.getState();
    state.setSyncStatus('conflict', state.syncLag, state.syncConflictCount + 1);
  }

  private updateDocument(oldPath: string, path: string, document: DocumentState): void {
    useStore.setState((state) => {
      const documents = { ...state.documents };
      if (oldPath !== path) delete documents[oldPath];
      documents[path] = document;
      const active = state.activePath === oldPath || state.activePath === path;
      const split = state.splitPath === oldPath || state.splitPath === path;
      return {
        documents,
        ...(split ? { splitPath: path, splitContent: document.content } : {}),
        ...(active ? {
          activePath: path, content: document.content,
          dirty: document.dirtyGeneration > document.saveGeneration,
          activeEntryId: document.entryId, activeRevision: document.revision, activeHash: document.hash,
          editGeneration: document.dirtyGeneration,
        } : {}),
      };
    });
  }

  private flagConflict(path: string, document: DocumentState, message: string): void {
    useStore.setState((state) => ({
      documents: { ...state.documents, [path]: { ...document, pending: false, error: message } },
      ...(state.activePath === path ? { dirty: true } : {}),
      syncStatus: 'conflict',
      syncConflictCount: state.syncConflictCount + 1,
    }));
  }
}
