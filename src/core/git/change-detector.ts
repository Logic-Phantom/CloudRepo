import type { RefChanges, RefMap } from '../types.js';

/** 원격 ref 집합이 이전 스냅샷의 원격 ref와 동일한지 비교 */
export function refsEqual(a: RefMap, b: RefMap): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => b[k] === a[k]);
}

/** 단순 이름/해시 기반 변경 분류 (강제 푸시 여부는 Git 객체 확인 후 판단) */
export function diffRefs(prev: RefMap, next: RefMap): { added: string[]; updated: string[]; deleted: string[] } {
  const added: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];
  for (const [name, sha] of Object.entries(next)) {
    if (!(name in prev)) added.push(name);
    else if (prev[name] !== sha) updated.push(name);
  }
  for (const name of Object.keys(prev)) if (!(name in next)) deleted.push(name);
  return { added: added.sort(), updated: updated.sort(), deleted: deleted.sort() };
}

export function emptyChanges(): RefChanges {
  return { added: [], updated: [], deleted: [], forced: [] };
}
