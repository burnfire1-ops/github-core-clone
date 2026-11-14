// git.ts — git plumbing: objects, packfiles, pkt-line framing, smart HTTP.
// Pure functions over the Store's object map; no I/O here.
// Packfiles are written with full objects only; delta encoding is optional
// and a pack of full objects is valid, so readers never need a delta base
// outside the pack except for thin packs sent by a pushing client.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Store } from './store.ts';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Content-addressed id of a git object: sha1("<type> <len>\0" + data). */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

// ------------------------------------------------------------ object parse/serialize
export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const splitAt = text.indexOf('\n\n');
  const headerText = splitAt === -1 ? text : text.slice(0, splitAt);
  const message = splitAt === -1 ? '' : text.slice(splitAt + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export function serializeCommit(c: CommitInfo): Buffer {
  let out = `tree ${c.tree}\n`;
  for (const p of c.parents) out += `parent ${p}\n`;
  out += `author ${c.author}\n`;
  out += `committer ${c.committer}\n`;
  out += `\n${c.message}`;
  return Buffer.from(out, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space === -1) break;
    const mode = data.subarray(off, space).toString('ascii');
    const nul = data.indexOf(0x00, space);
    if (nul === -1) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------ pkt-line
export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktItem {
  kind: 'line' | 'flush' | 'delim';
  data: Buffer;
}

/** Parse a whole pkt-line stream. Stops cleanly at the end of the buffer. */
export function parsePktLines(buf: Buffer): { items: PktItem[]; consumed: number } {
  const items: PktItem[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    if (lenHex === '0000') {
      items.push({ kind: 'flush', data: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (lenHex === '0001') {
      items.push({ kind: 'delim', data: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len) || len < 4 || off + len > buf.length) break;
    items.push({ kind: 'line', data: Buffer.from(buf.subarray(off + 4, off + len)) });
    off += len;
  }
  return { items, consumed: off };
}

// ------------------------------------------------------------ packfile
function encodeObjectHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (typeNum << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

export function writePack(objects: Array<{ type: ObjType; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);
  for (const obj of objects) {
    const compressed = deflateSync(obj.data, { level: 6 });
    chunks.push(Buffer.concat([encodeObjectHeader(TYPE_NUM[obj.type], obj.data.length), compressed]));
  }
  const body = Buffer.concat(chunks);
  const trailer = sha1Hex(body);
  return Buffer.concat([body, Buffer.from(trailer, 'hex')]);
}

/** Inflate one zlib stream and report exactly how many input bytes it consumed. */
function inflateWithLength(buf: Buffer): { data: Buffer; consumed: number } {
  // inflateSync ignores trailing bytes, so binary-search the smallest slice that inflates.
  let lo = 1;
  let hi = buf.length;
  let data: Buffer | null = null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      data = inflateSync(buf.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  if (data === null) data = inflateSync(buf.subarray(0, lo));
  return { data, consumed: lo };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    while (off < delta.length) {
      const b = delta[off];
      off += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if ((op & 0x80) !== 0) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          cpOff |= delta[off] << (8 * i);
          off += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          cpSize |= delta[off] << (8 * i);
          off += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(off, off + op));
      total += op;
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (total !== dstSize || result.length !== dstSize) throw new Error('delta result size mismatch');
  return result;
}

export interface PackEntry {
  type: ObjType;
  data: Buffer;
  sha: string;
}

/** Read a packfile. resolveBase finds a base object outside the pack (thin packs). */
export function readPack(buf: Buffer, resolveBase: (sha: string) => { type: ObjType; data: Buffer } | undefined): PackEntry[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = buf.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  const bySha = new Map<string, PackEntry>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryStart = off;
    let byte = buf[off];
    off += 1;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[off];
      off += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    void size;
    if (typeNum === 6) {
      // OFS_DELTA: negative offset varint.
      let b = buf[off];
      off += 1;
      let ofs = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = buf[off];
        off += 1;
        ofs = ((ofs + 1) << 7) | (b & 0x7f);
      }
      const baseEntry = byOffset.get(entryStart - ofs);
      if (!baseEntry) throw new Error('ofs-delta base not in pack');
      const { data: delta, consumed } = inflateWithLength(buf.subarray(off));
      off += consumed;
      const data = applyDelta(baseEntry.data, delta);
      const entry: PackEntry = { type: baseEntry.type, data, sha: hashObject(baseEntry.type, data) };
      entries.push(entry);
      byOffset.set(entryStart, entry);
      bySha.set(entry.sha, entry);
    } else if (typeNum === 7) {
      // REF_DELTA: 20-byte base sha.
      const baseSha = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const base = bySha.get(baseSha) ?? resolveBase(baseSha);
      if (!base) throw new Error(`ref-delta base ${baseSha} unknown`);
      const { data: delta, consumed } = inflateWithLength(buf.subarray(off));
      off += consumed;
      const data = applyDelta(base.data, delta);
      const entry: PackEntry = { type: base.type, data, sha: hashObject(base.type, data) };
      entries.push(entry);
      byOffset.set(entryStart, entry);
      bySha.set(entry.sha, entry);
    } else {
      const type = NUM_TYPE[typeNum];
      if (!type) throw new Error(`unknown pack object type ${typeNum}`);
      const { data, consumed } = inflateWithLength(buf.subarray(off));
      off += consumed;
      const entry: PackEntry = { type, data, sha: hashObject(type, data) };
      entries.push(entry);
      byOffset.set(entryStart, entry);
      bySha.set(entry.sha, entry);
    }
  }
  return entries;
}

// ------------------------------------------------------------ upload-pack helpers
interface UploadRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number;
  deepenRelative: boolean;
  waitForDone: boolean;
}

function parseUploadRequestV0(body: Buffer): UploadRequest {
  const { items } = parsePktLines(body);
  const req: UploadRequest = { wants: [], haves: [], shallow: [], deepen: 0, deepenRelative: false, waitForDone: false };
  let seenFlush = false;
  for (const item of items) {
    if (item.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (item.kind !== 'line') continue;
    const line = item.data.toString('utf8').trimEnd();
    if (!seenFlush) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const nul = rest.indexOf('\0');
        req.wants.push((nul === -1 ? rest : rest.slice(0, nul)).trim());
      } else if (line.startsWith('deepen ')) req.deepen = parseInt(line.slice(7), 10) || 0;
      else if (line === 'deepen-relative') req.deepenRelative = true;
      else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    } else {
      if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) req.deepen = parseInt(line.slice(7), 10) || 0;
      else if (line === 'deepen-relative') req.deepenRelative = true;
    }
  }
  return req;
}

function parseUploadRequestV2(body: Buffer): { command: string; args: string[] } {
  const { items } = parsePktLines(body);
  const args: string[] = [];
  let command = '';
  let inArgs = false;
  for (const item of items) {
    if (item.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (item.kind === 'flush') break;
    if (item.kind !== 'line') continue;
    const line = item.data.toString('utf8').trimEnd();
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice(8);
    } else {
      args.push(line);
    }
  }
  return { command, args };
}

/** Objects reachable from a commit set, excluding objects the client already has. */
function collectSendObjects(store: Store, sentCommits: Set<string>, hadObjects: Set<string>): Array<{ type: ObjType; data: Buffer }> {
  const out: Array<{ type: ObjType; data: Buffer }> = [];
  const seen = new Set<string>();
  const queue: string[] = [...sentCommits];
  const addObject = (sha: string): void => {
    if (seen.has(sha) || hadObjects.has(sha)) return;
    seen.add(sha);
    const obj = store.getObject(sha);
    if (!obj) return;
    out.push({ type: obj.type, data: obj.data });
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      queue.push(info.tree);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) queue.push(e.sha);
    }
  };
  // Walk commits first (parents of sent commits are not sent unless in the set).
  const commitQueue = [...sentCommits];
  const doneCommits = new Set<string>();
  while (commitQueue.length > 0) {
    const sha = commitQueue.pop() as string;
    if (doneCommits.has(sha)) continue;
    doneCommits.add(sha);
    addObject(sha);
  }
  while (queue.length > 0) {
    const sha = queue.pop() as string;
    addObject(sha);
  }
  return out;
}

/** Decide which commits a fetch sends, plus new shallow boundary lines. */
function planFetch(store: Store, repoRefs: Map<string, string>, req: UploadRequest): { sentCommits: Set<string>; newShallow: string[]; unshallow: string[]; hadObjects: Set<string> } {
  const wants = [...new Set(req.wants)];
  const shallowSet = new Set(req.shallow);
  const hadCommits = new Set<string>();
  const hadObjects = new Set<string>();
  // Objects the client already holds. A "have" is a commit the client has
  // with its full history — unless it is also listed as shallow, in which
  // case the client has only that commit and its tree, never its parents.
  const addHadCommit = (sha: string, includeAncestors: boolean): void => {
    const anc = includeAncestors ? store.ancestors(sha) : new Map([[sha, 0]]);
    for (const [c] of anc) {
      const obj = store.getObject(c);
      if (!obj || obj.type !== 'commit') continue;
      hadCommits.add(c);
      hadObjects.add(c);
      const treeSha = parseCommit(obj.data).tree;
      const walkTree = (t: string): void => {
        const tObj = store.getObject(t);
        if (!tObj) return;
        hadObjects.add(t);
        for (const e of parseTree(tObj.data)) {
          if (e.mode === '40000') walkTree(e.sha);
          else hadObjects.add(e.sha);
        }
      };
      walkTree(treeSha);
    }
  };
  for (const h of req.haves) if (!shallowSet.has(h)) addHadCommit(h, true);
  for (const h of req.haves) if (shallowSet.has(h)) addHadCommit(h, false);
  for (const s of req.shallow) addHadCommit(s, false);

  const candidates = new Set<string>();
  for (const w of wants) {
    for (const [c] of store.ancestors(w)) candidates.add(c);
  }

  const sentCommits = new Set<string>();
  if (req.deepen === 0) {
    for (const c of candidates) if (!hadCommits.has(c)) sentCommits.add(c);
  } else if (req.shallow.length > 0 || req.deepenRelative) {
    // Relative deepen: new commits beyond what the client has, plus D levels
    // deeper than the client's shallow boundary.
    for (const c of candidates) if (!hadCommits.has(c)) sentCommits.add(c);
    for (const s of req.shallow) {
      const anc = store.ancestors(s);
      for (const [c, d] of anc) {
        if (d >= 1 && d <= req.deepen && candidates.has(c) && !hadCommits.has(c)) sentCommits.add(c);
      }
    }
  } else {
    // Absolute deepen: commits within D of a want (want itself is depth 0).
    for (const w of wants) {
      const anc = store.ancestors(w);
      for (const [c, d] of anc) {
        if (d < req.deepen && candidates.has(c) && !hadCommits.has(c)) sentCommits.add(c);
      }
    }
  }

  const newShallow: string[] = [];
  for (const c of sentCommits) {
    const obj = store.getObject(c);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    const covered = parents.every((p) => sentCommits.has(p) || hadCommits.has(p));
    if (!covered) newShallow.push(c);
  }
  const unshallow: string[] = [];
  for (const s of req.shallow) {
    if (!candidates.has(s)) continue;
    const obj = store.getObject(s);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((p) => sentCommits.has(p) || hadCommits.has(p))) unshallow.push(s);
  }
  void repoRefs;
  return { sentCommits, newShallow, unshallow, hadObjects };
}

function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([0x01]), slice]);
    chunks.push(pktLine(payload));
  }
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

function packPktLines(pack: Buffer): Buffer {
  // Protocol v2 sends the packfile section as pkt-lines whose payload is a
  // side-band channel byte (0x01) followed by pack bytes; the client demuxes
  // them as side-band, so a bare "PACK..." chunk is a protocol error.
  const chunks: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    chunks.push(pktLine(Buffer.concat([Buffer.from([0x01]), slice])));
  }
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------ upload-pack entry points
export function handleUploadPackV0(store: Store, refs: Map<string, string>, body: Buffer, defaultBranch: string): Buffer {
  const req = parseUploadRequestV0(body);
  const plan = planFetch(store, refs, req);
  const objects = collectSendObjects(store, plan.sentCommits, plan.hadObjects);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  for (const s of plan.newShallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(sidebandPack(pack));
  void defaultBranch;
  return Buffer.concat(parts);
}

export function handleUploadPackV2(store: Store, refs: Map<string, string>, body: Buffer): Buffer {
  const { command, args } = parseUploadRequestV2(body);
  if (command === 'ls-refs') {
    const prefixes: string[] = [];
    let wantSymrefs = false;
    let wantUnborn = false;
    for (const a of args) {
      if (a.startsWith('ref-prefix ')) prefixes.push(a.slice(11));
      else if (a === 'symrefs') wantSymrefs = true;
      else if (a === 'unborn') wantUnborn = true;
    }
    const lines: Buffer[] = [];
    const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
    const allRefs = new Map<string, string>();
    const defaultBranch = [...refs.keys()].find((r) => r === 'refs/heads/main') ? 'refs/heads/main' : [...refs.keys()].sort()[0];
    if (defaultBranch && refs.get(defaultBranch) && matches('HEAD')) {
      const sha = refs.get(defaultBranch) as string;
      lines.push(pktLine(wantSymrefs ? `${sha} HEAD symref-target:${defaultBranch}\n` : `${sha} HEAD\n`));
    }
    for (const [ref, sha] of [...refs.entries()].sort()) {
      if (matches(ref)) lines.push(pktLine(`${sha} ${ref}\n`));
    }
    if (lines.length === 0 && wantUnborn) {
      lines.push(pktLine('0000000000000000000000000000000000000000 HEAD unborn\n'));
    }
    lines.push(PKT_FLUSH);
    return Buffer.concat(lines);
  }
  if (command !== 'fetch') {
    return Buffer.concat([pktLine(`ERR unknown command ${command}\n`), PKT_FLUSH]);
  }
  const req: UploadRequest = { wants: [], haves: [], shallow: [], deepen: 0, deepenRelative: false, waitForDone: false };
  for (const a of args) {
    if (a.startsWith('want ')) req.wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) req.haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) req.shallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) req.deepen = parseInt(a.slice(7), 10) || 0;
    else if (a === 'deepen-relative') req.deepenRelative = true;
    else if (a === 'wait-for-done') req.waitForDone = true;
  }
  // A want the server does not have is a protocol error.
  for (const w of req.wants) {
    if (!store.getObject(w)) return Buffer.concat([pktLine(`ERR upload-pack: not our ref ${w}\n`), PKT_FLUSH]);
  }
  const plan = planFetch(store, refs, req);
  const objects = collectSendObjects(store, plan.sentCommits, plan.hadObjects);
  const pack = writePack(objects);

  const parts: Buffer[] = [];
  // The acknowledgment section is sent when the client sent haves, or when
  // it asked the server to wait for done; with no haves it is just "ready".
  if (req.haves.length > 0 || req.waitForDone) {
    parts.push(pktLine('acknowledgments\n'));
    let anyKnown = false;
    for (const h of req.haves) {
      if (store.getObject(h)) {
        parts.push(pktLine(`ACK ${h}\n`));
        anyKnown = true;
      }
    }
    if (req.haves.length > 0 && !anyKnown) parts.push(pktLine('NAK\n'));
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  // The shallow-info section appears only when the client sent haves or
  // asked to deepen; a plain fetch goes straight to the packfile section.
  if (req.haves.length > 0 || req.deepen > 0 || req.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.newShallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(packPktLines(pack));
  return Buffer.concat(parts);
}

// ------------------------------------------------------------ advertisements
export function v0UploadAdvertisement(refs: Map<string, string>, defaultBranch: string): Buffer {
  const caps = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed symref=HEAD:refs/heads/main object-format=sha1 agent=forge/1.0';
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  const sorted = [...refs.entries()].sort();
  const headSha = refs.get(`refs/heads/${defaultBranch}`) ?? '0000000000000000000000000000000000000000';
  parts.push(pktLine(`${headSha} HEAD\0${caps}\n`));
  for (const [ref, sha] of sorted) parts.push(pktLine(`${sha} ${ref}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function v0ReceiveAdvertisement(refs: Map<string, string>, defaultBranch: string): Buffer {
  const caps = 'report-status side-band-64k delete-refs quiet object-format=sha1 agent=forge/1.0';
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  const sorted = [...refs.entries()].sort();
  const headSha = refs.get(`refs/heads/${defaultBranch}`) ?? '0000000000000000000000000000000000000000';
  parts.push(pktLine(`${headSha} HEAD\0${caps}\n`));
  for (const [ref, sha] of sorted) parts.push(pktLine(`${sha} ${ref}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function v2Advertisement(): Buffer {
  const lines = ['version 2\n', 'agent=forge/1.0\n', 'ls-refs=unborn\n', 'fetch=shallow wait-for-done\n', 'server-option\n', 'object-format=sha1\n', 'object-info\n'];
  return Buffer.concat([...lines.map((l) => pktLine(l)), PKT_FLUSH]);
}

// ------------------------------------------------------------ receive-pack
interface ReceiveCommand {
  oldSha: string;
  newSha: string;
  ref: string;
}

export function handleReceivePack(store: Store, refs: Map<string, string>, body: Buffer): Buffer {
  const { items, consumed } = parsePktLines(body);
  const commands: ReceiveCommand[] = [];
  let caps = '';
  for (const item of items) {
    if (item.kind === 'flush') break;
    if (item.kind !== 'line') continue;
    const line = item.data.toString('utf8').trimEnd();
    const nul = line.indexOf('\0');
    let cmdText = line;
    if (nul !== -1) {
      caps = line.slice(nul + 1);
      cmdText = line.slice(0, nul);
    }
    const parts = cmdText.split(' ');
    if (parts.length >= 3) commands.push({ oldSha: parts[0], newSha: parts[1], ref: parts.slice(2).join(' ') });
  }
  const wantSideband = caps.includes('side-band-64k');
  const wantReport = caps.includes('report-status');

  // The packfile follows the command flush packet.
  const packBytes = body.subarray(consumed);
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpackOk = true;
  let unpackError = '';
  if (packBytes.length > 0) {
    try {
      const entries = readPack(packBytes, (sha) => {
        const obj = store.getObject(sha);
        return obj ? { type: obj.type, data: obj.data } : undefined;
      });
      for (const e of entries) store.putObject(e.type, e.data);
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  for (const cmd of commands) {
    const current = refs.get(cmd.ref);
    const zero = '0000000000000000000000000000000000000000';
    if (!unpackOk) {
      results.push({ ref: cmd.ref, ok: false, reason: `unpack failed: ${unpackError}` });
      continue;
    }
    if (cmd.newSha === zero) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (cmd.oldSha !== zero && cmd.oldSha !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (cmd.oldSha === zero) {
      if (current !== undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
        continue;
      }
      if (!store.getObject(cmd.newSha)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        continue;
      }
      refs.set(cmd.ref, cmd.newSha);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (current === undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      continue;
    }
    if (cmd.oldSha !== current) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (cmd.newSha === current) {
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (!store.isAncestor(current, cmd.newSha)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    refs.set(cmd.ref, cmd.newSha);
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }

  // The status report is itself a pkt-line stream (one pkt-line per status
  // line, closed by a flush). When side-band-64k was negotiated, that whole
  // stream is wrapped in side-band channel 1 pkt-lines; the client demuxes
  // it and then reads the pkt-lines back out of the demuxed bytes.
  const out: Buffer[] = [];
  if (wantReport) {
    const reportParts: Buffer[] = [];
    reportParts.push(pktLine(unpackOk ? 'unpack ok\n' : `unpack error ${unpackError}\n`));
    for (const r of results) {
      reportParts.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
    }
    reportParts.push(PKT_FLUSH);
    const report = Buffer.concat(reportParts);
    if (wantSideband) {
      const CHUNK = 65515;
      for (let off = 0; off < report.length; off += CHUNK) {
        out.push(pktLine(Buffer.concat([Buffer.from([0x01]), report.subarray(off, Math.min(off + CHUNK, report.length))])));
      }
    } else {
      out.push(report);
    }
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}
