import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { Repo, ObjType } from './store.ts';
import { getObject, putObject, parseTree, parseCommit, treeOfCommit } from './store.ts';

// git.ts — pkt-line framing, packfile read/write, smart HTTP
// (upload-pack v0 + v2, receive-pack v0).

export function pktLine(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');

export interface PktItem {
  flush: boolean;
  data: Buffer | null;
}

// Parse pkt-lines from buf starting at `start`. Stops at the first
// malformed line or at the end of the buffer. Returns the items and the
// offset just past the last complete line.
export function parsePktLines(buf: Buffer, start = 0): { items: PktItem[]; end: number } {
  const items: PktItem[] = [];
  let i = start;
  while (i + 4 <= buf.length) {
    const lenText = buf.subarray(i, i + 4).toString('ascii');
    const len = parseInt(lenText, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      items.push({ flush: true, data: null });
      i += 4;
      continue;
    }
    if (len < 4 || i + len > buf.length) break;
    items.push({ flush: false, data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { items, end: i };
}

// OPT-1: inflate a deflate stream exactly once and read how many input
// bytes the inflater consumed (inflateSync with {info:true} exposes the
// engine's bytesWritten, which is the consumed input length). Falls back
// to the probe-and-search method if that capability is unavailable.
export function inflateOnce(buf: Buffer, start: number): { data: Buffer; end: number } {
  const slice = buf.subarray(start);
  try {
    const res = inflateSync(slice, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const consumed = res.engine && res.engine.bytesWritten;
    if (typeof consumed === 'number' && consumed > 0) return { data: res.buffer, end: start + consumed };
  } catch {
    // fall through to the probe method
  }
  let lo = 1;
  let hi = 1;
  while (hi <= slice.length) {
    try {
      inflateSync(slice.subarray(0, hi));
      break;
    } catch {
      hi *= 2;
    }
  }
  if (hi > slice.length) hi = slice.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(slice.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(slice.subarray(0, lo)), end: start + lo };
}

function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = off;
  for (;;) {
    const b = buf[i];
    value |= (b & 0x7f) << shift;
    shift += 7;
    i += 1;
    if ((b & 0x80) === 0) break;
  }
  return { value, next: i };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const src = readVarint(delta, off);
  off = src.next;
  const tgt = readVarint(delta, off);
  off = tgt.next;
  if (src.value !== base.length) throw new Error('delta source size mismatch');
  const out = Buffer.alloc(tgt.value);
  let outPos = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          cpOff |= delta[off] << (bit * 8);
          off += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          cpSize |= delta[off] << (bit * 8);
          off += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, outPos, cpOff, cpOff + cpSize);
      outPos += cpSize;
    } else if (op !== 0) {
      delta.copy(out, outPos, off, off + op);
      outPos += op;
      off += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  if (outPos !== tgt.value) throw new Error('delta target size mismatch');
  return out;
}

const TYPE_CODES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_NUMBERS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

interface PackEntry {
  offset: number;
  type: ObjType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset: number | null;
  baseOid: string | null;
}

// Read a packfile, resolve deltas, store every object (uncompressed, per
// OPT-2) and return the oids of the objects it contained.
export function readPack(repo: Repo, buf: Buffer): string[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = buf.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let off = 12;
  for (let n = 0; n < count; n += 1) {
    const entryOffset = off;
    let b = buf[off];
    off += 1;
    const typeNum = (b >> 4) & 7;
    let size = b & 15;
    let shift = 4;
    while (b & 0x80) {
      b = buf[off];
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | null = null;
    let baseOid: string | null = null;
    let type: ObjType | 'ofs-delta' | 'ref-delta';
    if (typeNum === 6) {
      type = 'ofs-delta';
      b = buf[off];
      off += 1;
      let deltaOff = b & 0x7f;
      while (b & 0x80) {
        b = buf[off];
        off += 1;
        deltaOff = ((deltaOff + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryOffset - deltaOff;
    } else if (typeNum === 7) {
      type = 'ref-delta';
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    } else {
      type = TYPE_CODES[typeNum];
      if (!type) throw new Error('unknown pack object type ' + typeNum);
    }
    const inflated = inflateOnce(buf, off);
    off = inflated.end;
    const entry: PackEntry = { offset: entryOffset, type, data: inflated.data, baseOffset, baseOid };
    entries.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolved = new Map<number, string>();
  const resolve = (entry: PackEntry, depth: number): string => {
    if (resolved.has(entry.offset)) return resolved.get(entry.offset) as string;
    if (depth > 1000) throw new Error('delta chain too deep');
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let baseRec: { type: ObjType; data: Buffer } | null = null;
      let baseType: ObjType;
      if (entry.baseOffset !== null) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (!baseEntry) throw new Error('delta base offset missing');
        const baseOid = resolve(baseEntry, depth + 1);
        baseRec = getObject(repo, baseOid);
        if (!baseRec) throw new Error('delta base not stored');
        baseType = baseRec.type;
      } else {
        baseRec = getObject(repo, entry.baseOid as string);
        if (!baseRec) throw new Error('thin pack base not in store: ' + entry.baseOid);
        baseType = baseRec.type;
      }
      const target = applyDelta(baseRec.data, entry.data);
      const oid = putObject(repo, baseType, target);
      resolved.set(entry.offset, oid);
      return oid;
    }
    const oid = putObject(repo, entry.type as ObjType, entry.data);
    resolved.set(entry.offset, oid);
    return oid;
  };
  const oids: string[] = [];
  for (const entry of entries) oids.push(resolve(entry, 0));
  return oids;
}

function packObjectHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let b = (TYPE_NUMBERS[type] << 4) | (size & 15);
  size >>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------- fetch plan

export interface FetchPlan {
  objects: { oid: string; type: ObjType; data: Buffer }[];
  shallow: string[];
  unshallow: string[];
}

// Plan which objects a fetch sends. wants are commit oids the client asked
// for, haves are commits it already has, depth limits history depth,
// deepen extends history past the client's haves, clientShallow lists the
// client's current shallow boundary commits.
export function planFetch(
  repo: Repo,
  wants: string[],
  haves: Set<string>,
  depth: number | null,
  deepen: number | null,
  clientShallow: Set<string>,
): FetchPlan {
  // A deepen with no haves is a fresh shallow clone: depth = deepen.
  if (deepen !== null && haves.size === 0) {
    depth = deepen;
    deepen = null;
  }
  // Distance from any have commit following parent links (Infinity when
  // a commit is not reachable from any have).
  const haveDist = new Map<string, number>();
  {
    const queue: { oid: string; dist: number }[] = [];
    for (const have of haves) queue.push({ oid: have, dist: 0 });
    while (queue.length > 0) {
      const item = queue.shift() as { oid: string; dist: number };
      if (haveDist.has(item.oid)) continue;
      haveDist.set(item.oid, item.dist);
      const parsed = parseCommit(repo, item.oid);
      if (!parsed) continue;
      for (const parent of parsed.parents) queue.push({ oid: parent, dist: item.dist + 1 });
    }
  }
  // The set the client already holds: ancestors of its haves, stopping at
  // its shallow boundary commits (their parents are precisely what a
  // deepen fetch has to supply).
  const heldSet = new Set<string>();
  {
    const stack: string[] = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (heldSet.has(oid)) continue;
      heldSet.add(oid);
      if (clientShallow.has(oid)) continue;
      const parsed = parseCommit(repo, oid);
      if (!parsed) continue;
      for (const parent of parsed.parents) stack.push(parent);
    }
  }
  const included = new Map<string, number>();
  {
    // Traversal and inclusion are separate: parents of an excluded commit
    // may still be needed (e.g. the parent of a shallow have in a deepen
    // fetch), so every visited commit's parents are enqueued.
    const queue: { oid: string; dist: number }[] = [];
    for (const want of wants) queue.push({ oid: want, dist: 0 });
    const visited = new Set<string>();
    while (queue.length > 0) {
      const item = queue.shift() as { oid: string; dist: number };
      if (visited.has(item.oid)) continue;
      visited.add(item.oid);
      let include = false;
      if (deepen !== null) {
        const dist = haveDist.get(item.oid);
        include = dist === undefined || (dist >= 1 && dist <= deepen);
      } else {
        include = !heldSet.has(item.oid) && (depth === null || item.dist < depth);
      }
      if (include) included.set(item.oid, item.dist);
      if (depth !== null && deepen === null && item.dist >= depth) continue;
      const parsed = parseCommit(repo, item.oid);
      if (!parsed) continue;
      for (const parent of parsed.parents) queue.push({ oid: parent, dist: item.dist + 1 });
    }
  }
  // Shallow boundary: included commits whose parents are not included and
  // not already held by the client. The shallow file names the boundary
  // commit itself, not its missing parent.
  const shallow = new Set<string>();
  for (const oid of included.keys()) {
    const parsed = parseCommit(repo, oid);
    if (!parsed) continue;
    for (const parent of parsed.parents) {
      if (!included.has(parent) && !heldSet.has(parent)) {
        const rec = getObject(repo, parent);
        if (rec && rec.type === 'commit') shallow.add(oid);
      }
    }
  }
  // Unshallow: client-shallow commits whose parents are now all present
  // (in the pack or already held), with at least one parent newly supplied,
  // or root commits.
  const unshallow = new Set<string>();
  const checkUnshallow = (oid: string): void => {
    const parsed = parseCommit(repo, oid);
    if (!parsed) return;
    if (parsed.parents.length === 0) {
      unshallow.add(oid);
      return;
    }
    let newlySupplied = false;
    for (const parent of parsed.parents) {
      if (included.has(parent)) newlySupplied = true;
      else if (!haves.has(parent)) return;
    }
    if (newlySupplied) unshallow.add(oid);
  };
  for (const oid of clientShallow) checkUnshallow(oid);
  if (clientShallow.size === 0) {
    for (const oid of haves) {
      const parsed = parseCommit(repo, oid);
      if (!parsed || parsed.parents.length === 0) continue;
      let newlySupplied = false;
      let allPresent = true;
      for (const parent of parsed.parents) {
        if (included.has(parent)) newlySupplied = true;
        else if (!heldSet.has(parent)) allPresent = false;
      }
      if (newlySupplied && allPresent) unshallow.add(oid);
    }
  }
  // Collect objects. OPT-3: a tree already collected in this plan is
  // never walked again.
  const objects: { oid: string; type: ObjType; data: Buffer }[] = [];
  const seen = new Set<string>();
  const treeVisited = new Set<string>();
  const addObj = (oid: string): void => {
    if (seen.has(oid)) return;
    const rec = getObject(repo, oid);
    if (!rec) return;
    seen.add(oid);
    objects.push({ oid, type: rec.type, data: rec.data });
  };
  const walkTree = (treeOid: string): void => {
    if (treeVisited.has(treeOid)) return;
    treeVisited.add(treeOid);
    addObj(treeOid);
    const rec = getObject(repo, treeOid);
    if (!rec || rec.type !== 'tree') return;
    for (const entry of parseTree(rec.data)) {
      if (entry.mode === '40000') walkTree(entry.oid);
      else addObj(entry.oid);
    }
  };
  for (const oid of included.keys()) {
    addObj(oid);
    const tree = treeOfCommit(repo, oid);
    if (tree) walkTree(tree);
  }
  return { objects, shallow: [...shallow], unshallow: [...unshallow] };
}

// OPT-2: pack bytes are deflated at write time only, at level 1, from the
// raw in-memory records.
export function writePack(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(plan.objects.length, 8);
  parts.push(header);
  for (const obj of plan.objects) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  // A packfile ends with the SHA-1 of everything before it.
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- refs

import { Store, ancestorsSet, isAncestor, setRef, deleteRef } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

// OPT-9: the sorted ref list is cached per repository and reused while
// the ref version counter matches; every ref mutation bumps the counter.
export function sortedRefs(repo: Repo): { oid: string; name: string }[] {
  const cached = repo.sortedRefsCache;
  if (cached && cached.version === repo.refVersion) return cached.refs;
  const out = [...repo.refs.entries()].map(([name, oid]) => ({ oid, name }));
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  repo.sortedRefsCache = { version: repo.refVersion, refs: out };
  return out;
}

const UPLOAD_CAPS =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done symref=HEAD:refs/heads/main object-format=sha1 agent=forge/1.0';
const RECEIVE_CAPS = 'report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta agent=forge/1.0';

function v0Advert(service: string, repo: Repo, caps: string): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('# service=' + service + '\n'));
  parts.push(FLUSH);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(ZERO_OID + ' capabilities^{}\0' + caps + '\n'));
  } else {
    refs.forEach((ref, i) => {
      if (i === 0) parts.push(pktLine(ref.oid + ' ' + ref.name + '\0' + caps + '\n'));
      else parts.push(pktLine(ref.oid + ' ' + ref.name + '\n'));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advert(): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('version 2\n'));
  parts.push(pktLine('agent=forge/1.0\n'));
  parts.push(pktLine('ls-refs=unborn\n'));
  parts.push(pktLine('fetch=shallow wait-for-done filter\n'));
  parts.push(pktLine('server-option\n'));
  parts.push(pktLine('object-format=sha1\n'));
  parts.push(pktLine('object-info\n'));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const piece = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  return Buffer.concat(parts);
}

function rawPackLines(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65516;
  for (let i = 0; i < pack.length; i += CHUNK) {
    parts.push(pktLine(pack.subarray(i, Math.min(pack.length, i + CHUNK))));
  }
  return Buffer.concat(parts);
}

interface FetchRequest {
  wants: string[];
  haves: Set<string>;
  depth: number | null;
  deepen: number | null;
  clientShallow: Set<string>;
  caps: string;
}

function parseV0Fetch(body: Buffer): FetchRequest {
  const req: FetchRequest = { wants: [], haves: new Set(), depth: null, deepen: null, clientShallow: new Set(), caps: '' };
  const { items } = parsePktLines(body);
  for (const item of items) {
    if (item.flush) break;
    if (!item.data) continue;
    let line = item.data.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      if (req.caps === '') req.caps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    line = line.trim();
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('have ')) req.haves.add(line.slice(5).trim());
    else if (line.startsWith('deepen ')) req.deepen = parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('shallow ')) req.clientShallow.add(line.slice(8).trim());
    else if (line.startsWith('filter ')) {
      // filter is accepted and ignored: the full object set is sent
    }
  }
  return req;
}

function uploadPackV0(repo: Repo, body: Buffer): Buffer {
  const req = parseV0Fetch(body);
  if (req.wants.length === 0) return Buffer.concat([FLUSH]);
  const plan = planFetch(repo, req.wants, req.haves, null, req.deepen, req.clientShallow);
  const pack = writePack(plan);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine('shallow ' + oid + '\n'));
  for (const oid of plan.unshallow) parts.push(pktLine('unshallow ' + oid + '\n'));
  if (req.haves.size === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    const wantAncestors = new Set<string>();
    for (const want of req.wants) {
      for (const anc of ancestorsSet(repo, want)) wantAncestors.add(anc);
    }
    let acked = 0;
    for (const have of req.haves) {
      if (wantAncestors.has(have)) {
        parts.push(pktLine('ACK ' + have + '\n'));
        acked += 1;
      }
    }
    if (acked === 0) parts.push(pktLine('NAK\n'));
    else parts.push(pktLine('NAK\n'));
  }
  if (req.caps.includes('side-band-64k') || req.caps.includes('side-band')) {
    parts.push(sidebandPack(pack));
    parts.push(FLUSH);
  } else {
    parts.push(pack);
  }
  return Buffer.concat(parts);
}

function lsRefsV2(repo: Repo, args: string[]): Buffer {
  const prefixes: string[] = [];
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
  }
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (refs.length === 0) {
    if (unborn) parts.push(pktLine(ZERO_OID + ' HEAD symref-target:refs/heads/main unborn\n'));
  } else {
    const headTarget = repo.defaultBranch ? 'refs/heads/' + repo.defaultBranch : 'refs/heads/main';
    const headOid = repo.refs.get(headTarget);
    if (headOid && (symrefs || matches('HEAD'))) {
      parts.push(pktLine(headOid + ' HEAD symref-target:' + headTarget + '\n'));
    }
    for (const ref of refs) {
      if (matches(ref.name)) parts.push(pktLine(ref.oid + ' ' + ref.name + '\n'));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchV2(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves = new Set<string>();
  let deepen: number | null = null;
  const clientShallow = new Set<string>();
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.add(arg.slice(5).trim());
    else if (arg.startsWith('deepen ')) deepen = parseInt(arg.slice(7).trim(), 10);
    else if (arg.startsWith('shallow ')) clientShallow.add(arg.slice(8).trim());
  }
  if (wants.length === 0) return Buffer.concat([FLUSH]);
  const plan = planFetch(repo, wants, haves, null, deepen, clientShallow);
  const pack = writePack(plan);
  const parts: Buffer[] = [];
  if (haves.size > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const wantAncestors = new Set<string>();
    for (const want of wants) {
      for (const anc of ancestorsSet(repo, want)) wantAncestors.add(anc);
    }
    let acked = false;
    for (const have of haves) {
      if (wantAncestors.has(have)) {
        parts.push(pktLine('ACK ' + have + '\n'));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
    parts.push(pktLine('ready\n'));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine('shallow ' + oid + '\n'));
    for (const oid of plan.unshallow) parts.push(pktLine('unshallow ' + oid + '\n'));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function uploadPackV2(repo: Repo, body: Buffer): Buffer {
  const out: Buffer[] = [];
  let off = 0;
  while (off + 4 <= body.length) {
    const len = parseInt(body.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 4 || off + len > body.length) {
      // A 0001 delimiter line between sections: skip it.
      if (len === 1) {
        off += 4;
        continue;
      }
      break;
    }
    const line = body.subarray(off + 4, off + len).toString('utf8').trim();
    off += len;
    if (!line.startsWith('command=')) break;
    const command = line.slice('command='.length);
    const args: string[] = [];
    for (;;) {
      if (off + 4 > body.length) break;
      const alen = parseInt(body.subarray(off, off + 4).toString('ascii'), 16);
      if (Number.isNaN(alen)) {
        off = body.length;
        break;
      }
      if (alen === 1) {
        // delimiter: arguments follow it
        off += 4;
        continue;
      }
      if (alen === 0) {
        off += 4;
        break;
      }
      if (alen < 4 || off + alen > body.length) {
        off = body.length;
        break;
      }
      args.push(body.subarray(off + 4, off + alen).toString('utf8').trim());
      off += alen;
    }
    if (command === 'ls-refs') out.push(lsRefsV2(repo, args));
    else if (command === 'fetch') out.push(fetchV2(repo, args));
    else out.push(Buffer.concat([FLUSH]));
  }
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parseReceiveCommands(body: Buffer): { commands: PushCommand[]; caps: string; packStart: number } {
  const commands: PushCommand[] = [];
  let caps = '';
  let off = 0;
  for (;;) {
    if (off + 4 > body.length) break;
    const lenText = body.subarray(off, off + 4).toString('ascii');
    const len = parseInt(lenText, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      off += 4;
      break;
    }
    if (len < 4 || off + len > body.length) break;
    let line = body.subarray(off + 4, off + len).toString('utf8');
    off += len;
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      if (caps === '') caps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    line = line.trim();
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  return { commands, caps, packStart: off };
}

function receivePack(repo: Repo, body: Buffer): Buffer {
  const { commands, caps, packStart } = parseReceiveCommands(body);
  let unpackError: string | null = null;
  if (packStart < body.length) {
    try {
      readPack(repo, body.subarray(packStart));
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const lines: string[] = [];
  if (unpackError) lines.push('unpack ' + unpackError + '\n');
  else lines.push('unpack ok\n');
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref) ?? null;
    if (unpackError) {
      lines.push('ng ' + cmd.ref + ' unpack failed\n');
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      if (!current) lines.push('ng ' + cmd.ref + ' remote ref does not exist\n');
      else {
        deleteRef(repo, cmd.ref);
        lines.push('ok ' + cmd.ref + '\n');
      }
      continue;
    }
    const newRec = getObject(repo, cmd.newOid);
    if (!newRec || (newRec.type !== 'commit' && newRec.type !== 'tag')) {
      lines.push('ng ' + cmd.ref + ' unable to find commit\n');
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      if (current) lines.push('ng ' + cmd.ref + ' already exists\n');
      else {
        setRef(repo, cmd.ref, cmd.newOid);
        lines.push('ok ' + cmd.ref + '\n');
      }
      continue;
    }
    if (current !== cmd.oldOid) {
      lines.push('ng ' + cmd.ref + ' non-fast-forward\n');
      continue;
    }
    if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      lines.push('ng ' + cmd.ref + ' non-fast-forward\n');
      continue;
    }
    setRef(repo, cmd.ref, cmd.newOid);
    lines.push('ok ' + cmd.ref + '\n');
  }
  const useSideband = caps.includes('side-band-64k') || caps.includes('side-band');
  // The status report is itself pkt-line framed; when side-band-64k is in
  // effect the whole framed block rides inside sideband packets (channel
  // byte 1), so the demultiplexed stream parses as pkt-lines again.
  const blockParts: Buffer[] = [];
  for (const line of lines) blockParts.push(pktLine(line));
  blockParts.push(FLUSH);
  const block = Buffer.concat(blockParts);
  if (!useSideband) return block;
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < block.length; i += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), block.subarray(i, Math.min(block.length, i + CHUNK))])));
  }
  // A flush pkt-line after the sideband packet ends the sideband stream.
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- dispatcher

export interface GitResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function jsonResult(status: number, message: string): GitResult {
  return { status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

export function handleGit(
  store: Store,
  method: string,
  owner: string,
  repoName: string,
  rest: string[],
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
): GitResult {
  const repo = store.findRepo(owner, repoName);
  if (!repo) return jsonResult(404, 'Repository not found');
  if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const v2 = (headers['git-protocol'] ?? '') === 'version=2';
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
        body: v2 ? v2Advert() : v0Advert('git-upload-pack', repo, UPLOAD_CAPS),
      };
    }
    if (service === 'git-receive-pack') {
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-receive-pack-advertisement' },
        body: v0Advert('git-receive-pack', repo, RECEIVE_CAPS),
      };
    }
    return jsonResult(404, 'Not Found');
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    const v2 = (headers['git-protocol'] ?? '') === 'version=2';
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
      body: v2 ? uploadPackV2(repo, body) : uploadPackV0(repo, body),
    };
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-receive-pack-result' },
      body: receivePack(repo, body),
    };
  }
  return jsonResult(404, 'Not Found');
}
