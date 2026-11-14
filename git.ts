// git.ts — git objects over the wire: pkt-line framing, packfile read/write
// (full objects only; no delta encoding on write), delta application on
// read, and the smart-HTTP handlers for upload-pack (v0 + v2) and
// receive-pack (v0). All behaviour here was derived from the protocol and
// verified against the git 2.43 client.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Store, Repo, ObjectType } from './store.ts';
import { hashObject, parseTag, parseTree } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

// ---------------------------------------------------------------- pkt-line
export function pktLine(s: string): Buffer {
  const body = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface PktItem {
  kind: 'line' | 'flush' | 'delim' | 'end';
  text?: string;
}

export function parsePktLines(buf: Buffer): { items: PktItem[]; afterFirstFlush: number | null } {
  const items: PktItem[] = [];
  let off = 0;
  let afterFirstFlush: number | null = null;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) break;
    const n = parseInt(lenHex, 16);
    if (n === 0) {
      items.push({ kind: 'flush' });
      if (afterFirstFlush === null) afterFirstFlush = off + 4;
      off += 4;
      continue;
    }
    if (n === 1) {
      items.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (n === 2) {
      items.push({ kind: 'end' });
      off += 4;
      continue;
    }
    if (n < 4 || off + n > buf.length) break;
    items.push({ kind: 'line', text: buf.subarray(off + 4, off + n).toString('utf8') });
    off += n;
  }
  return { items, afterFirstFlush };
}

// Side-band-64k framing: each chunk is a pkt-line whose payload starts with
// the band byte 0x01 followed by raw data.
export function sideBand(data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const MAX = 65515;
  for (let off = 0; off < data.length; off += MAX) {
    const slice = data.subarray(off, Math.min(off + MAX, data.length));
    const payload = Buffer.concat([Buffer.from([0x01]), slice]);
    chunks.push(Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'ascii'), payload]));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- packfiles
const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Array<ObjectType | ''> = ['', 'commit', 'tree', 'blob', 'tag'];

export function writePack(objs: Array<{ type: ObjectType; content: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objs.length, 8);
  parts.push(head);
  for (const o of objs) {
    const deflated = deflateSync(o.content);
    const typeCode = TYPE_CODES[o.type];
    const size = o.content.length;
    const headerBytes: number[] = [];
    let b0 = (typeCode << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) b0 |= 0x80;
    headerBytes.push(b0);
    while (rest > 0) {
      let b = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflated);
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

// Inflate one deflate stream starting at `start`; returns the data and the
// exact end offset (found by exponential probe + binary search, since
// inflateSync ignores trailing bytes and reports no consumed length).
function inflateOne(buf: Buffer, start: number): { data: Buffer; end: number } {
  let failEnd = start;
  let hi = Math.min(buf.length, start + 16);
  for (;;) {
    try {
      inflateSync(buf.subarray(start, hi));
      break;
    } catch {
      failEnd = hi;
      if (hi >= buf.length) throw new Error('truncated deflate stream in pack');
      hi = Math.min(buf.length, hi * 2);
    }
  }
  let lo = failEnd + 1;
  let hiOk = hi;
  while (lo < hiOk) {
    const mid = (lo + hiOk) >> 1;
    try {
      inflateSync(buf.subarray(start, mid));
      hiOk = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(buf.subarray(start, hiOk)), end: hiOk };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVarint = (): number => {
    let v = 0;
    let s = 0;
    let b = 0;
    do {
      b = delta[p++];
      v |= (b & 0x7f) << s;
      s += 7;
    } while (b & 0x80);
    return v;
  };
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      if (op & 0x01) off = delta[p++];
      if (op & 0x02) off |= delta[p++] << 8;
      if (op & 0x04) off |= delta[p++] << 16;
      if (op & 0x08) off |= delta[p++] << 24;
      if (op & 0x10) size = delta[p++];
      if (op & 0x20) size |= delta[p++] << 8;
      if (op & 0x40) size |= delta[p++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(off, off + size));
    } else if (op !== 0) {
      out.push(delta.subarray(p, p + op));
      p += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  const res = Buffer.concat(out);
  if (res.length !== tgtSize) throw new Error('delta target size mismatch');
  return res;
}

export interface PackObject {
  oid: string;
  type: ObjectType;
  content: Buffer;
}

export function readPack(
  buf: Buffer,
  getObject: (oid: string) => { type: ObjectType; content: Buffer } | null,
): PackObject[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('bad pack header');
  }
  const version = buf.readUInt32BE(4);
  const count = buf.readUInt32BE(8);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  interface RawEntry {
    offset: number;
    type: number;
    data: Buffer;
    baseOid?: string;
    baseOffset?: number;
    resolved?: PackObject;
    resolving?: boolean;
  }
  const entries: RawEntry[] = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryStart = off;
    let b = buf[off++];
    const type = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[off++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    void size;
    const e: RawEntry = { offset: entryStart, type, data: Buffer.alloc(0) };
    if (type === 6) {
      let by = buf[off++];
      let offset = by & 0x7f;
      while (by & 0x80) {
        by = buf[off++];
        offset = ((offset + 1) << 7) | (by & 0x7f);
      }
      e.baseOffset = entryStart - offset;
    } else if (type === 7) {
      e.baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const inflated = inflateOne(buf, off);
    e.data = inflated.data;
    off = inflated.end;
    entries.push(e);
  }
  const byOffset = new Map<number, RawEntry>(entries.map((e) => [e.offset, e]));
  const byOid = new Map<string, RawEntry>();
  for (const e of entries) {
    if (e.type >= 1 && e.type <= 4) {
      const type = CODE_TYPES[e.type] as ObjectType;
      byOid.set(hashObject(type, e.data), e);
    }
  }
  const resolve = (e: RawEntry): PackObject => {
    if (e.resolved) return e.resolved;
    if (e.resolving) throw new Error('delta cycle in pack');
    e.resolving = true;
    try {
      if (e.type >= 1 && e.type <= 4) {
        const type = CODE_TYPES[e.type] as ObjectType;
        e.resolved = { oid: hashObject(type, e.data), type, content: e.data };
        return e.resolved;
      }
      let base: PackObject;
      if (e.type === 6) {
        const baseEntry = byOffset.get(e.baseOffset!);
        if (!baseEntry) throw new Error('ofs-delta base not found in pack');
        base = resolve(baseEntry);
      } else if (e.type === 7) {
        const baseEntry = byOid.get(e.baseOid!);
        if (baseEntry) {
          base = resolve(baseEntry);
        } else {
          const stored = getObject(e.baseOid!);
          if (!stored) throw new Error('ref-delta base not found');
          base = { oid: e.baseOid!, type: stored.type, content: stored.content };
        }
      } else {
        throw new Error(`unknown pack entry type ${e.type}`);
      }
      const content = applyDelta(base.content, e.data);
      e.resolved = { oid: hashObject(base.type, content), type: base.type, content };
      return e.resolved;
    } finally {
      e.resolving = false;
    }
  };
  return entries.map((e) => resolve(e));
}

// ---------------------------------------------------------------- fetch plan
export interface FetchPlan {
  objects: Array<{ type: ObjectType; content: Buffer }>;
  shallow: string[];
  unshallow: string[];
  commonHaves: string[];
}

function planFetch(
  store: Store,
  repo: Repo,
  opts: { wants: string[]; haves: string[]; shallowIn: string[]; deepen: number | null },
): FetchPlan {
  const wants = [...new Set(opts.wants)].filter((w) => w !== ZERO_OID);
  const held = new Set([...opts.haves, ...opts.shallowIn]);
  // A non-positive deepen makes no sense (git never sends one); treat it as no depth limit.
  const deepen = opts.deepen !== null && opts.deepen > 0 ? opts.deepen : null;

  // BFS from the wants, recording shortest depth. With no deepen, never
  // expand past a commit the client already has. With deepen, expand
  // through held commits so the walk can go below the shallow boundary.
  const cap = deepen !== null && opts.shallowIn.length === 0 ? deepen - 1 : Infinity;
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const w of wants) {
    if (!depth.has(w)) {
      depth.set(w, 0);
      queue.push(w);
    }
  }
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    const d = depth.get(cur)!;
    if (d >= cap) continue;
    if (deepen === null && held.has(cur)) continue;
    const c = store.getCommit(repo, cur);
    if (!c) continue;
    for (const p of c.parents) {
      if (!depth.has(p)) {
        depth.set(p, d + 1);
        queue.push(p);
      }
    }
  }

  let maxDepth: number | null = null;
  if (deepen !== null) {
    if (opts.shallowIn.length > 0) {
      let base = 0;
      for (const s of opts.shallowIn) {
        const d = depth.get(s);
        if (d !== undefined && d > base) base = d;
      }
      maxDepth = base + deepen;
    } else {
      maxDepth = deepen - 1;
    }
  }

  const included = new Set<string>();
  for (const [oid, d] of depth) {
    if (maxDepth !== null && d > maxDepth) continue;
    if (held.has(oid)) continue;
    included.add(oid);
  }

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (maxDepth !== null) {
    for (const oid of included) {
      if (depth.get(oid) !== maxDepth) continue;
      const c = store.getCommit(repo, oid);
      if (c && c.parents.length > 0) shallow.push(oid);
    }
    for (const s of opts.shallowIn) {
      if (included.has(s)) continue;
      const c = store.getCommit(repo, s);
      if (c && c.parents.some((p) => included.has(p))) unshallow.push(s);
    }
  }

  // Common haves: a have the server also has as an ancestor of a want.
  const ancestorSet = new Set<string>();
  for (const w of wants) {
    for (const a of store.commitAncestors(repo, w)) ancestorSet.add(a);
  }
  const commonHaves = opts.haves.filter((h) => wants.includes(h) || ancestorSet.has(h));

  // Collect the objects to send.
  const objects: Array<{ type: ObjectType; content: Buffer }> = [];
  const seen = new Set<string>();
  const addObject = (oid: string): void => {
    if (seen.has(oid)) return;
    const o = store.getObject(repo, oid);
    if (!o) return;
    seen.add(oid);
    objects.push(o);
  };
  const addTree = (treeOid: string): void => {
    const obj = store.getObject(repo, treeOid);
    if (!obj || obj.type !== 'tree') return;
    addObject(treeOid);
    for (const e of parseTree(obj.content)) {
      if (e.mode === '40000') addTree(e.oid);
      else addObject(e.oid);
    }
  };
  for (const oid of included) {
    addObject(oid);
    const c = store.getCommit(repo, oid);
    if (c) addTree(c.tree);
  }
  for (const w of wants) {
    const o = store.getObject(repo, w);
    if (!o || o.type === 'commit') continue;
    if (o.type === 'tree') addTree(w);
    else if (o.type === 'blob') addObject(w);
    else if (o.type === 'tag') {
      addObject(w);
      const t = parseTag(o.content);
      if (t.object) addObject(t.object);
    }
  }
  return { objects, shallow, unshallow, commonHaves };
}

// ---------------------------------------------------------------- adverts
function sortedRefs(repo: Repo): Array<{ oid: string; name: string }> {
  return [...repo.refs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, oid]) => ({ oid, name }));
}

function v0UploadAdvert(repo: Repo): Buffer {
  const caps =
    'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not ' +
    `deepen-relative no-progress include-tag multi_ack_detailed no-done symref=HEAD:refs/heads/${repo.defaultBranch} ` +
    'object-format=sha1 agent=forge/1.0';
  const chunks: Buffer[] = [pktLine('# service=git-upload-pack\n'), FLUSH];
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const refs = sortedRefs(repo);
  if (!head && refs.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const lines: Array<{ oid: string; name: string }> = [];
    if (head) lines.push({ oid: head, name: 'HEAD' });
    for (const r of refs) lines.push(r);
    lines.forEach((r, i) => {
      if (i === 0) chunks.push(pktLine(`${r.oid} ${r.name}\0${caps}\n`));
      else chunks.push(pktLine(`${r.oid} ${r.name}\n`));
    });
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

function v0ReceiveAdvert(repo: Repo): Buffer {
  const caps = 'report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta object-format=sha1 agent=forge/1.0';
  const chunks: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((r, i) => {
      if (i === 0) chunks.push(pktLine(`${r.oid} ${r.name}\0${caps}\n`));
      else chunks.push(pktLine(`${r.oid} ${r.name}\n`));
    });
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

function v2Advert(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('agent=forge/1.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('server-option\n'),
    pktLine('object-format=sha1\n'),
    pktLine('object-info\n'),
    FLUSH,
  ]);
}

// ---------------------------------------------------------------- handlers
export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function jsonResponse(status: number, obj: unknown): GitResponse {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify(obj), 'utf8') };
}

function resolveRepo(store: Store, ownerLogin: string, repoName: string): Repo | null {
  if (!store.ownerMatches(ownerLogin)) return null;
  return store.getRepo(repoName) ?? null;
}

export function gitInfoRefs(
  store: Store,
  ownerLogin: string,
  repoName: string,
  service: string,
  gitProtocol: string,
): GitResponse {
  const repo = resolveRepo(store, ownerLogin, repoName);
  if (!repo) return jsonResponse(404, { message: 'Repository not found' });
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advert() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0UploadAdvert(repo) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0ReceiveAdvert(repo) };
  }
  return jsonResponse(404, { message: 'Unknown service' });
}

function handleUploadPackV0(store: Store, repo: Repo, body: Buffer): Buffer {
  const { items } = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let deepen: number | null = null;
  let deepenRelative = false;
  let done = false;
  for (const it of items) {
    if (it.kind !== 'line' || !it.text) continue;
    const t = it.text.replace(/\n$/, '');
    if (t.startsWith('want ')) {
      const parts = t.split(' ');
      if (parts[1]) wants.push(parts[1]);
      if (parts.includes('deepen-relative')) deepenRelative = true;
    } else if (t.startsWith('have ')) {
      haves.push(t.slice(5).trim());
    } else if (t.startsWith('shallow ')) {
      shallowIn.push(t.slice(8).trim());
    } else if (t.startsWith('deepen ')) {
      const n = parseInt(t.slice(7).trim(), 10);
      if (!Number.isNaN(n)) deepen = n;
    } else if (t === 'done') {
      done = true;
    }
  }
  void deepenRelative;
  const plan = planFetch(store, repo, { wants, haves, shallowIn, deepen });
  const chunks: Buffer[] = [];
  if (!done) {
    // Negotiation round: shallow info + ACKs, no pack yet.
    for (const s of plan.shallow) chunks.push(pktLine(`shallow ${s}`));
    for (const s of plan.unshallow) chunks.push(pktLine(`unshallow ${s}`));
    for (const h of plan.commonHaves) chunks.push(pktLine(`ACK ${h} common\n`));
    if (haves.length > 0 && plan.commonHaves.length === 0) chunks.push(pktLine('NAK\n'));
    chunks.push(FLUSH);
    return Buffer.concat(chunks);
  }
  for (const s of plan.shallow) chunks.push(pktLine(`shallow ${s}`));
  for (const s of plan.unshallow) chunks.push(pktLine(`unshallow ${s}`));
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) chunks.push(FLUSH);
  if (plan.commonHaves.length === 0) chunks.push(pktLine('NAK\n'));
  else for (const h of plan.commonHaves) chunks.push(pktLine(`ACK ${h} common\n`));
  chunks.push(sideBand(writePack(plan.objects)));
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const { items } = parsePktLines(body);
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const it of items) {
    if (it.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (it.kind !== 'line' || !it.text) continue;
    const t = it.text.replace(/\n$/, '');
    if (!seenDelim && t.startsWith('command=')) {
      command = t.slice(8);
      continue;
    }
    args.push(t);
  }
  return { command, args };
}

function handleLsRefs(store: Store, repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const match = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const chunks: Buffer[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headOid && match('HEAD')) {
    let line = `${headOid} HEAD`;
    if (symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
    chunks.push(pktLine(`${line}\n`));
  } else if (!headOid && unborn && match('HEAD')) {
    chunks.push(pktLine(`${ZERO_OID} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const r of sortedRefs(repo)) {
    if (!match(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (peel) {
      const obj = store.getObject(repo, r.oid);
      if (obj && obj.type === 'tag') {
        const t = parseTag(obj.content);
        if (t.object) line += ` peeled:${t.object}`;
      }
    }
    chunks.push(pktLine(`${line}\n`));
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

function handleFetchV2(store: Store, repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let deepen: number | null = null;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallowIn.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) {
      const n = parseInt(a.slice(7).trim(), 10);
      if (!Number.isNaN(n)) deepen = n;
    }
  }
  const plan = planFetch(store, repo, { wants, haves, shallowIn, deepen });
  const chunks: Buffer[] = [];
  if (haves.length > 0) {
    chunks.push(pktLine('acknowledgments\n'));
    if (plan.commonHaves.length === 0) chunks.push(pktLine('NAK\n'));
    else for (const h of plan.commonHaves) chunks.push(pktLine(`ACK ${h}\n`));
    chunks.push(pktLine('ready\n'));
    chunks.push(DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    chunks.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) chunks.push(pktLine(`shallow ${s}`));
    for (const s of plan.unshallow) chunks.push(pktLine(`unshallow ${s}`));
    chunks.push(DELIM);
  }
  chunks.push(pktLine('packfile\n'));
  chunks.push(sideBand(writePack(plan.objects)));
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

export function gitUploadPack(
  store: Store,
  ownerLogin: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string,
): GitResponse {
  const repo = resolveRepo(store, ownerLogin, repoName);
  if (!repo) return jsonResponse(404, { message: 'Repository not found' });
  try {
    if (gitProtocol === 'version=2') {
      const { command, args } = parseV2Request(body);
      if (command === 'ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(store, repo, args) };
      }
      if (command === 'fetch') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV2(store, repo, args) };
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat([pktLine('version 2\n'), FLUSH]) };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleUploadPackV0(store, repo, body) };
  } catch (e) {
    // A malformed upload-pack request must not kill the server.
    console.error('upload-pack error:', (e as Error).message);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat([pktLine('NAK\n'), FLUSH]) };
  }
}

export function gitReceivePack(store: Store, ownerLogin: string, repoName: string, body: Buffer): GitResponse {
  const repo = resolveRepo(store, ownerLogin, repoName);
  if (!repo) return jsonResponse(404, { message: 'Repository not found' });
  const { items, afterFirstFlush } = parsePktLines(body);
  const updates: Array<{ old: string; nw: string; ref: string }> = [];
  for (const it of items) {
    if (it.kind === 'flush') break;
    if (it.kind !== 'line' || !it.text) continue;
    const t = it.text.replace(/\n$/, '');
    const nul = t.indexOf('\0');
    const main = nul === -1 ? t : t.slice(0, nul);
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(main);
    if (m) updates.push({ old: m[1], nw: m[2], ref: m[3] });
  }
  let unpackOk = true;
  let unpackErr = '';
  if (afterFirstFlush !== null && afterFirstFlush < body.length) {
    const packData = body.subarray(afterFirstFlush);
    if (packData.length > 0) {
      try {
        const objs = readPack(packData, (oid) => store.getObject(repo, oid));
        for (const o of objs) store.putObject(repo, o.type, o.content);
      } catch (e) {
        unpackOk = false;
        unpackErr = (e as Error).message;
      }
    }
  }
  const report: string[] = [];
  if (unpackOk) report.push('unpack ok\n');
  else report.push(`unpack ${unpackErr}\n`);
  for (const u of updates) {
    if (!unpackOk) {
      report.push(`ng ${u.ref} unpack failed\n`);
      continue;
    }
    if (u.nw === ZERO_OID) {
      if (repo.refs.has(u.ref)) {
        repo.refs.delete(u.ref);
        report.push(`ok ${u.ref}\n`);
      } else {
        report.push(`ng ${u.ref} remote ref does not exist\n`);
      }
      continue;
    }
    const current = repo.refs.get(u.ref);
    if (u.old === ZERO_OID) {
      if (current !== undefined) {
        report.push(`ng ${u.ref} already exists\n`);
        continue;
      }
    } else {
      if (current === undefined) {
        report.push(`ng ${u.ref} remote ref does not exist\n`);
        continue;
      }
      if (current !== u.old) {
        report.push(`ng ${u.ref} non-fast-forward\n`);
        continue;
      }
      if (!store.isAncestor(repo, u.old, u.nw)) {
        report.push(`ng ${u.ref} non-fast-forward\n`);
        continue;
      }
    }
    if (!store.hasObject(repo, u.nw)) {
      report.push(`ng ${u.ref} object not found\n`);
      continue;
    }
    repo.refs.set(u.ref, u.nw);
    report.push(`ok ${u.ref}\n`);
  }
  const inner = Buffer.concat([...report.map((r) => pktLine(r)), FLUSH]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat([sideBand(inner), FLUSH]) };
}
