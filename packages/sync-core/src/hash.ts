import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export function sha256Bytes(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function sha256Text(text: string): string {
  return sha256Bytes(new TextEncoder().encode(text));
}

/** Hash async chunks without buffering the whole attachment. */
export async function sha256Chunks(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<string> {
  const hash = sha256.create();
  for await (const chunk of chunks) hash.update(chunk);
  return bytesToHex(hash.digest());
}

export function timingSafeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right) || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
