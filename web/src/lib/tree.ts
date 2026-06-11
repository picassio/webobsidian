import type { TreeNode } from './api';

/** Find a node by its vault-relative path anywhere in the tree (null if absent). */
export function findNode(root: TreeNode | null, path: string): TreeNode | null {
  if (!root || !path) return null;
  const stack: TreeNode[] = [...(root.children ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.path === path) return n;
    if (n.children) stack.push(...n.children);
  }
  return null;
}

/** True if the path resolves to a folder node in the tree. */
export function isFolderPath(root: TreeNode | null, path: string | null): boolean {
  return !!path && findNode(root, path)?.type === 'folder';
}
