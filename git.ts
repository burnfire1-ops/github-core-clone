// git.ts — git smart HTTP: pkt-line framing, packfile read/write,
// protocol v0 and v2 upload-pack, v0 receive-pack, ls-refs.
// Objects live uncompressed in the store (OPT-2); pack objects are
// inflated exactly once each (OPT-1); fetch planning never re-walks a
// tree it already collected (OPT-3); the sorted ref list is cached
// per ref version (OPT-9).

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { Store, Repo } from './store.ts';
import {
  putObject,
  getObject,
  parseCommit,
  parseTree,
  isAncestor,
  ancestorsSet,
  setRef,
  deleteRef,
} from './store.ts';

export interface GitResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const ZERO_OID = '0000000000000000000000000000000000000000';
const AGENT = 'forge/1.0';

// ---------------------------------------------------------------- pkt-line

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

// Parse pkt-lines starting at `start` until a flush line (0000) or
// the end of the buffer. Returns the decoded lines (without the
// trailing newline) and the offset just past the flush, or past the
// last parsed line when the buffer ends without a flush. The v2
// delimiter packet (0001) is skipped, not treated as data; the v2
// response-end packet (0002) ends parsing like a flush. Malformed
// length fields stop parsing instead of throwing.
function parsePktLines(buf: Buffer, start: number): { lines: string[]; next: number } {
  const lines: string[] = [];
  let off = start;
  while (off + 4 <= buf.length) {
    const lenText = buf.subarray(off, off + 4).toString('ascii');
    if (lenText === '0000' || lenText === '0002') return { lines, next: off + 4 };
    if (lenText === '0001') {
      off += 4;
      continue;
    }
    const len = parseInt(lenText, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) break;
    let text = buf.subarray(off + 4, off + len).toString('utf8');
    if (text.endsWith('\n')) text = text.slice(0, -1);
    lines.push(text);
    off += len;
  }
  return { lines, next: off };
}

// Wrap payload bytes as sideband band-1 pkt-lines. The pkt-line
// maximum is 65520 bytes TOTAL including the 4-byte length prefix,
// so with the 1-byte band number a data chunk is at most 65515
// bytes; a larger chunk is rejected by the client as too long.
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  let off = 0;
  while (off < pack.length) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + 65515));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
    off += chunk.length;
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function sidebandLines(lines: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(line, 'utf8')])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function json404(message: string): GitResult {
  return {
    status: 404,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ message }), 'utf8'),
  };
}

// ---------------------------------------------------------------- zlib

// OPT-1: inflate a deflate stream exactly once and learn how many input
// bytes it consumed, so the next object's header starts at the right
// offset without re-inflating. Node's inflateSync with info:true hands
// back the engine, whose bytesWritten is the consumed input length.
function inflateOnce(buf: Buffer, start: number): { data: Buffer; end: number } {
  try {
    const result = inflateSync(buf.subarray(start), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (result && result.engine && typeof result.engine.bytesWritten === 'number') {
      return { data: result.buffer, end: start + result.engine.bytesWritten };
    }
  } catch {
    // fall through to the probe method below
  }
  // Fallback (probe-and-search): find the smallest end offset whose
  // bytes inflate cleanly.
  let lo = start + 1;
  let hi = buf.length;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(start, mid));
      found = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (found === -1) throw new Error('deflate stream does not terminate');
  return { data: inflateSync(buf.subarray(start, found)), end: found };
}

// ---------------------------------------------------------------- tags

interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

function parseTag(data: Buffer): TagInfo | null {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const out: TagInfo = { object: '', type: '', tag: '', tagger: '', message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  if (!out.object) return null;
  return out;
}

// ---------------------------------------------------------------- packfile

const TYPE_NUM: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// Read a git object header (type + size varint) at `off`.
function readObjectHeader(buf: Buffer, off: number): { typeNum: number; size: number; next: number } {
  const first = buf[off];
  let typeNum = (first >> 4) & 0x7;
  let size = first & 0x0f;
  let shift = 4;
  let pos = off + 1;
  while (buf[pos - 1] & 0x80) {
    const b = buf[pos];
    size |= (b & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { typeNum, size, next: pos };
}

// Read a git offset varint (OFS_DELTA base distance encoding).
function readOffsetVarint(buf: Buffer, off: number): { value: number; next: number } {
  let b = buf[off];
  let value = b & 0x7f;
  let pos = off + 1;
  while (b & 0x80) {
    b = buf[pos];
    value = ((value + 1) << 7) | (b & 0x7f);
    pos += 1;
  }
  return { value, next: pos };
}

// Read a delta size varint (7 bits per byte, little-endian groups).
function readDeltaVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = off;
  for (;;) {
    const b = buf[pos];
    value |= (b & 0x7f) << shift;
    shift += 7;
    pos += 1;
    if (!(b & 0x80)) break;
  }
  return { value, next: pos };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const baseSize = readDeltaVarint(delta, 0);
  let pos = baseSize.next;
  const resultSize = readDeltaVarint(delta, pos);
  pos = resultSize.next;
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff = delta[pos++];
      if (op & 0x02) cpOff |= delta[pos++] << 8;
      if (op & 0x04) cpOff |= delta[pos++] << 16;
      if (op & 0x08) cpOff |= delta[pos++] << 24;
      if (op & 0x10) cpSize = delta[pos++];
      if (op & 0x20) cpSize |= delta[pos++] << 8;
      if (op & 0x40) cpSize |= delta[pos++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      produced += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize.value || base.length !== baseSize.value) {
    throw new Error('delta size mismatch');
  }
  return result;
}

interface PendingDelta {
  baseOffset: number | null;
  baseOid: string | null;
  delta: Buffer;
  offset: number;
}

// Parse a packfile, store every object, and return the oids stored.
function readPack(repo: Repo, buf: Buffer): string[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = buf.readUInt32BE(8);
  const stored: string[] = [];
  const byOffset = new Map<number, { type: string; data: Buffer }>();
  const pending: PendingDelta[] = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const startOffset = off;
    const header = readObjectHeader(buf, off);
    off = header.next;
    if (header.typeNum === 6) {
      const base = readOffsetVarint(buf, off);
      off = base.next;
      const inflated = inflateOnce(buf, off);
      off = inflated.end;
      pending.push({ baseOffset: startOffset - base.value, baseOid: null, delta: inflated.data, offset: startOffset });
    } else if (header.typeNum === 7) {
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const inflated = inflateOnce(buf, off);
      off = inflated.end;
      pending.push({ baseOffset: null, baseOid, delta: inflated.data, offset: startOffset });
    } else {
      const type = NUM_TYPE[header.typeNum];
      if (!type) throw new Error('unknown pack object type ' + header.typeNum);
      const inflated = inflateOnce(buf, off);
      off = inflated.end;
      if (inflated.data.length !== header.size) throw new Error('object size mismatch');
      const oid = putObject(repo, type as 'commit' | 'tree' | 'blob' | 'tag', inflated.data);
      byOffset.set(startOffset, { type, data: inflated.data });
      stored.push(oid);
    }
  }
  // Resolve deltas, in dependency order; a delta base may itself be a
  // delta, so loop until no progress is made.
  let remaining = pending;
  while (remaining.length > 0) {
    const nextRound: PendingDelta[] = [];
    let progressed = false;
    for (const item of remaining) {
      let base: { type: string; data: Buffer } | null = null;
      if (item.baseOffset !== null) base = byOffset.get(item.baseOffset) ?? null;
      else if (item.baseOid !== null) {
        const rec = getObject(repo, item.baseOid);
        if (rec) base = { type: rec.type, data: rec.data };
      }
      if (!base) {
        nextRound.push(item);
        continue;
      }
      const data = applyDelta(base.data, item.delta);
      const oid = putObject(repo, base.type as 'commit' | 'tree' | 'blob' | 'tag', data);
      byOffset.set(item.offset, { type: base.type, data });
      stored.push(oid);
      progressed = true;
    }
    if (!progressed) throw new Error('unresolvable delta base');
    remaining = nextRound;
  }
  return stored;
}

function writeObjectHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

// OPT-2: objects are stored raw, so the pack writer deflates each one
// here, at level 1, once per clone/fetch. Full objects only; no deltas.
function writePack(repo: Repo, oids: string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const rec = getObject(repo, oid);
    if (!rec) continue;
    parts.push(writeObjectHeader(TYPE_NUM[rec.type], rec.data.length));
    parts.push(deflateSync(rec.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- fetch planning

interface FetchPlan {
  oids: string[];
  shallow: string[];
  lifted: string[];
}

// Walk one commit's tree, collecting tree and blob oids. OPT-3: a tree
// oid already collected in this plan is never walked again.
function collectTree(repo: Repo, rootOid: string, collected: Set<string>, seenTrees: Set<string>, out: string[]): void {
  const stack: string[] = [rootOid];
  while (stack.length > 0) {
    const treeOid = stack.pop() as string;
    if (seenTrees.has(treeOid)) continue;
    seenTrees.add(treeOid);
    if (!collected.has(treeOid)) {
      collected.add(treeOid);
      out.push(treeOid);
    }
    const rec = getObject(repo, treeOid);
    if (!rec || rec.type !== 'tree') continue;
    for (const entry of parseTree(rec.data)) {
      if (entry.mode === '40000') stack.push(entry.oid);
      else if (!collected.has(entry.oid)) {
        collected.add(entry.oid);
        out.push(entry.oid);
      }
    }
  }
}

function collectFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  deepen: number | null,
  oldBoundaries: Set<string>,
  deepenRelative: boolean,
): FetchPlan {
  // A shallow client's `have` is held WITHOUT its parents: the
  // ancestor set of a have stops at the old shallow boundaries (the
  // boundary itself is held, its parents are not).
  const haveAncestors = new Set<string>();
  for (const have of haves) {
    const stack: string[] = [have];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (haveAncestors.has(oid)) continue;
      haveAncestors.add(oid);
      if (oldBoundaries.has(oid)) continue;
      const parsedHave = parseCommit(repo, oid);
      if (!parsedHave) continue;
      for (const p of parsedHave.parents) stack.push(p);
    }
  }
  // Breadth-first over commits from the wants, tracking depth so a
  // deepen limit can cut the walk off at the shallow boundary. The
  // shallow lines name the deepest INCLUDED commits (the ones whose
  // parents were cut off), never the first excluded commit.
  const included: string[] = [];
  const boundary: string[] = [];
  const lifted: string[] = [];
  const seen = new Set<string>();
  const queue: { oid: string; depth: number; belowBoundary: boolean }[] = [];
  for (const want of wants) queue.push({ oid: want, depth: 0, belowBoundary: false });
  while (queue.length > 0) {
    const item = queue.shift() as { oid: string; depth: number; belowBoundary: boolean };
    if (seen.has(item.oid)) continue;
    seen.add(item.oid);
    const rec = getObject(repo, item.oid);
    if (!rec) continue;
    if (rec.type === 'tag') {
      // An annotated tag ref tip: the tag object itself travels, and
      // the walk continues at its target commit.
      included.push(item.oid);
      const tag = parseTag(rec.data);
      if (tag && !seen.has(tag.object)) {
        queue.push({ oid: tag.object, depth: item.depth, belowBoundary: item.belowBoundary });
      }
      continue;
    }
    if (rec.type !== 'commit') continue;
    if (oldBoundaries.has(item.oid) && deepen !== null && deepenRelative) {
      // A previous shallow boundary, already held by the client: walk
      // through it, counting generations below it for the deepen
      // window. Passing it lifts it: the client drops it from its
      // shallow file (it has parents below it now).
      const parsedHeld = parseCommit(repo, item.oid);
      if (parsedHeld && parsedHeld.parents.length > 0) lifted.push(item.oid);
      if (parsedHeld) {
        for (const p of parsedHeld.parents) queue.push({ oid: p, depth: 1, belowBoundary: true });
      }
      continue;
    }
    if (haveAncestors.has(item.oid) || oldBoundaries.has(item.oid)) continue;
    const parsed = parseCommit(repo, item.oid);
    if (deepen !== null) {
      if (item.belowBoundary) {
        // Deepening past the old boundary: include up to `deepen`
        // generations below it; the deepest included commits are the
        // new boundary.
        if (item.depth > deepen) continue;
        included.push(item.oid);
        if (item.depth === deepen) boundary.push(item.oid);
        if (parsed && item.depth < deepen) {
          for (const p of parsed.parents) queue.push({ oid: p, depth: item.depth + 1, belowBoundary: true });
        }
      } else {
        // Absolute depth from the want: include generations below the
        // want up to `deepen`; the deepest included commits are the
        // boundary (a root tip is a boundary too).
        if (item.depth >= deepen) continue;
        included.push(item.oid);
        if (item.depth === deepen - 1) boundary.push(item.oid);
        if (parsed && item.depth + 1 < deepen) {
          for (const p of parsed.parents) queue.push({ oid: p, depth: item.depth + 1, belowBoundary: false });
        }
      }
      continue;
    }
    included.push(item.oid);
    if (!parsed) continue;
    for (const parent of parsed.parents) queue.push({ oid: parent, depth: item.depth + 1, belowBoundary: false });
  }
  // Collect objects: commits first (in walk order), then their trees
  // and blobs (OPT-3 dedupes shared trees).
  const oids: string[] = [];
  const collected = new Set<string>();
  const seenTrees = new Set<string>();
  for (const oid of included) {
    if (!collected.has(oid)) {
      collected.add(oid);
      oids.push(oid);
    }
    const parsed = parseCommit(repo, oid);
    if (parsed) collectTree(repo, parsed.tree, collected, seenTrees, oids);
  }
  return { oids, shallow: boundary, lifted };
}

// ---------------------------------------------------------------- refs

// OPT-9: the sorted ref list is cached per ref version; any ref
// mutation bumps the version and invalidates it.
function sortedRefs(repo: Repo): { oid: string; name: string }[] {
  const cached = repo.sortedRefsCache;
  if (cached && cached.version === repo.refVersion) return cached.refs;
  const refs = [...repo.refs.entries()]
    .map(([name, oid]) => ({ oid, name }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  repo.sortedRefsCache = { version: repo.refVersion, refs };
  return refs;
}

function headOid(repo: Repo): string | null {
  return repo.refs.get('refs/heads/' + repo.defaultBranch) ?? null;
}

function headTarget(repo: Repo): string {
  return 'refs/heads/' + repo.defaultBranch;
}

// ---------------------------------------------------------------- ls-refs (v2)

// R4 fix 2.1 (peel) + 2.2 (prefix filter): `peel` is parsed and, when
// set and the ref's object is a tag, the line carries
// ` peeled:<target-oid>`. HEAD is emitted only when it matches the
// prefix filter; `symrefs` controls only whether the
// `symref-target:` attribute is attached. The same rule applies to
// the unborn HEAD line.
function lsRefsV2(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let unborn = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg.startsWith('ref-prefix')) prefixes.push('');
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const head = headOid(repo);
  if (head && matches('HEAD')) {
    // Attributes are space-separated after the ref name (git's wire
    // format: `<oid> HEAD symref-target:<target>`), never NUL-separated.
    let line = head + ' HEAD';
    if (symrefs) line += ' symref-target:' + headTarget(repo);
    parts.push(pktLine(line + '\n'));
  } else if (!head && unborn && matches('HEAD')) {
    let line = ZERO_OID + ' HEAD unborn';
    if (symrefs) line += ' symref-target:' + headTarget(repo);
    parts.push(pktLine(line + '\n'));
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = ref.oid + ' ' + ref.name;
    const attrs: string[] = [];
    if (peel) {
      const rec = getObject(repo, ref.oid);
      if (rec && rec.type === 'tag') {
        const tag = parseTag(rec.data);
        if (tag) attrs.push('peeled:' + tag.object);
      }
    }
    if (attrs.length > 0) line += ' ' + attrs.join(' ');
    parts.push(pktLine(line + '\n'));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('version 2\n'));
  parts.push(pktLine('agent=' + AGENT + '\n'));
  parts.push(pktLine('ls-refs=unborn\n'));
  parts.push(pktLine('fetch=shallow wait-for-done\n'));
  parts.push(pktLine('server-option\n'));
  parts.push(pktLine('object-format=sha1\n'));
  parts.push(pktLine('object-info\n'));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleUploadPackV2(repo: Repo, body: Buffer): GitResult {
  const parsed = parsePktLines(body, 0);
  const lines = parsed.lines;
  if (lines.length === 0 || !lines[0].startsWith('command=')) {
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: pktFlush() };
  }
  const command = lines[0].slice('command='.length).trim();
  const args = lines.slice(1);
  if (command === 'ls-refs') {
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: lsRefsV2(repo, args) };
  }
  if (command !== 'fetch') {
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: pktFlush() };
  }
  const wants: string[] = [];
  const haves: string[] = [];
  let deepen: number | null = null;
  const oldBoundaries = new Set<string>();
  let deepenRelative = false;
  let doneSeen = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('deepen ')) {
      const n = parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n)) deepen = n;
    } else if (arg.startsWith('shallow ')) oldBoundaries.add(arg.slice(8).trim());
    else if (arg === 'deepen-relative') deepenRelative = true;
    else if (arg === 'done') doneSeen = true;
  }
  const plan = collectFetch(repo, wants, haves, deepen, oldBoundaries, deepenRelative);
  const pack = writePack(repo, plan.oids);
  const parts: Buffer[] = [];
  // When the client sent haves but no `done` (stateless RPC with
  // wait-for-done), the response opens with an acknowledgments
  // section: one ACK per have that is common with the wants, then
  // `ready` (or `NAK` when nothing is common), then a delimiter.
  // A request that already carries `done` skips this section.
  // Verified against real git.
  if (haves.length > 0 && !doneSeen) {
    const acks: string[] = [];
    for (const have of haves) {
      if (!getObject(repo, have)) continue;
      if (wants.some((want) => have === want || isAncestor(repo, have, want))) acks.push(have);
    }
    parts.push(pktLine('acknowledgments\n'));
    for (const oid of acks) parts.push(pktLine('ACK ' + oid + '\n'));
    parts.push(pktLine(acks.length > 0 ? 'ready\n' : 'NAK\n'));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  // The shallow section is introduced by a `shallow-info` line, then
  // the shallow lines and the lifted (`unshallow`) lines, then a
  // delimiter packet — only then the `packfile` line. The section is
  // present whenever a deepen was requested, even when it carries no
  // lines. Verified against real git.
  if (deepen !== null) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine('shallow ' + oid + '\n'));
    for (const oid of plan.lifted) parts.push(pktLine('unshallow ' + oid + '\n'));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  parts.push(pktLine('packfile\n'));
  // In protocol v2 the packfile section is always sent sideband-framed
  // (band 1), whether or not the client asked for sideband-all: the
  // client reads it through its packet reader, so raw pack bytes
  // would be misread as pkt-line lengths. Verified against real git.
  parts.push(sidebandPack(pack));
  return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- v0 upload-pack

function v0Advertisement(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const serviceName = service === 'upload-pack' ? 'git-upload-pack' : 'git-receive-pack';
  const parts: Buffer[] = [];
  parts.push(pktLine('# service=' + serviceName + '\n'));
  parts.push(pktFlush());
  const caps =
    service === 'upload-pack'
      ? 'side-band-64k ofs-delta shallow no-progress allow-tip-sha1-in-want allow-reachable-sha1-in-want symref=HEAD:' + headTarget(repo) + ' agent=' + AGENT
      : 'report-status side-band-64k delete-refs ofs-delta agent=' + AGENT;
  const head = headOid(repo);
  const refs = sortedRefs(repo);
  if (head) {
    parts.push(pktLine(head + ' HEAD\0' + caps + '\n'));
  } else {
    parts.push(pktLine(ZERO_OID + ' capabilities^{}\0' + caps + '\n'));
  }
  for (const ref of refs) parts.push(pktLine(ref.oid + ' ' + ref.name + '\n'));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleUploadPackV0(repo: Repo, body: Buffer): GitResult {
  let wants: string[] = [];
  let haves: string[] = [];
  let deepen: number | null = null;
  const oldBoundaries = new Set<string>();
  let deepenRelative = false;
  let sideband = false;
  try {
    const parsed = parsePktLines(body, 0);
    for (const line of parsed.lines) {
      // Capabilities ride on the first want line, space-separated
      // after the oid (`want <oid> side-band-64k ...`); receive-pack
      // commands use a NUL separator instead. Accept both.
      let head = line;
      let caps = '';
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        head = line.slice(0, nul);
        caps = line.slice(nul + 1);
      } else if (head.startsWith('want ')) {
        const parts = head.split(' ');
        if (parts.length > 2) {
          caps = parts.slice(2).join(' ');
          head = 'want ' + parts[1];
        }
      }
      if (caps.includes('side-band-64k')) sideband = true;
      if (head.startsWith('want ')) wants.push(head.slice(5).trim());
      else if (head.startsWith('have ')) haves.push(head.slice(5).trim());
      else if (head.startsWith('deepen ')) {
        const n = parseInt(head.slice(7).trim(), 10);
        if (Number.isFinite(n)) deepen = n;
      } else if (head.startsWith('shallow ')) oldBoundaries.add(head.slice(8).trim());
      else if (head === 'deepen-relative') deepenRelative = true;
      else if (head === 'done') break;
    }
  } catch {
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: pktFlush() };
  }
  if (wants.length === 0) {
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: pktFlush() };
  }
  const plan = collectFetch(repo, wants, haves, deepen, oldBoundaries, deepenRelative);
  const pack = writePack(repo, plan.oids);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine('shallow ' + oid + '\n'));
  for (const oid of plan.lifted) parts.push(pktLine('unshallow ' + oid + '\n'));
  parts.push(pktLine('NAK\n'));
  if (sideband) parts.push(sidebandPack(pack));
  else parts.push(pack);
  return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- v0 receive-pack

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): GitResult {
  const headers = { 'content-type': 'application/x-git-receive-pack-result' };
  let commands: RefCommand[] = [];
  let packStart = 0;
  let sideband = false;
  try {
    const parsed = parsePktLines(body, 0);
    packStart = parsed.next;
    for (const line of parsed.lines) {
      const nul = line.indexOf('\0');
      const head = nul === -1 ? line : line.slice(0, nul);
      const caps = nul === -1 ? '' : line.slice(nul + 1);
      if (caps.includes('side-band-64k')) sideband = true;
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(head);
      if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
    }
  } catch {
    return { status: 200, headers, body: pktFlush() };
  }
  if (commands.length === 0) {
    return { status: 200, headers, body: pktFlush() };
  }
  // Unpack first (objects land in the store even for refused refs,
  // exactly like git), then validate and apply each command.
  let unpackError: string | null = null;
  const packBytes = body.subarray(packStart);
  if (packBytes.length > 0) {
    try {
      readPack(repo, packBytes);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const report: string[] = [];
  if (unpackError) report.push('unpack ' + unpackError);
  else report.push('unpack ok');
  for (const cmd of commands) {
    if (unpackError) {
      report.push('ng ' + cmd.ref + ' unpack failed');
      continue;
    }
    const current = repo.refs.get(cmd.ref) ?? null;
    if (cmd.oldOid !== ZERO_OID && current !== cmd.oldOid) {
      report.push('ng ' + cmd.ref + ' non-fast-forward');
      continue;
    }
    if (cmd.oldOid === ZERO_OID && current !== null) {
      report.push('ng ' + cmd.ref + ' already exists');
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      if (current === null) {
        report.push('ng ' + cmd.ref + ' no such ref');
        continue;
      }
      deleteRef(repo, cmd.ref);
      report.push('ok ' + cmd.ref);
      continue;
    }
    const rec = getObject(repo, cmd.newOid);
    if (!rec) {
      report.push('ng ' + cmd.ref + ' object not found');
      continue;
    }
    if (rec.type === 'commit' && cmd.oldOid !== ZERO_OID && !isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      report.push('ng ' + cmd.ref + ' non-fast-forward');
      continue;
    }
    setRef(repo, cmd.ref, cmd.newOid);
    report.push('ok ' + cmd.ref);
  }
  const lines = report.map((r) => r + '\n');
  // With side-band-64k the status report travels on band 1, but the
  // band-1 stream is itself read as pkt-lines by the client: the
  // payload must be the report framed as INNER pkt-lines (plus an
  // inner flush), not raw text. Verified against real git, whose
  // response is one band-1 packet holding `000eunpack ok\n`,
  // `0017ok <ref>\n`, `0000`, followed by an outer flush.
  const out = sideband
    ? sidebandPack(Buffer.concat([...lines.map((l) => pktLine(l)), pktFlush()]))
    : Buffer.concat([...lines.map((l) => pktLine(l)), pktFlush()]);
  return { status: 200, headers, body: out };
}

// ---------------------------------------------------------------- entry

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
  const m = method.toUpperCase();
  if (m === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    if (!repo) return json404('Not Found');
    const service = query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      if ((headers['git-protocol'] ?? '') === 'version=2') {
        return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' }, body: v2Advertisement() };
      }
      return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' }, body: v0Advertisement(repo, 'upload-pack') };
    }
    if (service === 'git-receive-pack') {
      return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-advertisement' }, body: v0Advertisement(repo, 'receive-pack') };
    }
    return json404('Not Found');
  }
  if (m === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    if (!repo) return json404('Not Found');
    try {
      const first = parsePktLines(body, 0);
      if (first.lines.length > 0 && first.lines[0].startsWith('command=')) {
        return handleUploadPackV2(repo, body);
      }
      return handleUploadPackV0(repo, body);
    } catch {
      return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: pktFlush() };
    }
  }
  if (m === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    if (!repo) return json404('Not Found');
    try {
      return handleReceivePack(repo, body);
    } catch {
      return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body: pktFlush() };
    }
  }
  return json404('Not Found');
}
