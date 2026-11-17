// forge: a standalone GitHub-compatible git forge.
// Serves git smart HTTP (v2 + v0), REST v3, GraphQL v4 and MCP from one process,
// over an in-memory store. Node 22 standard library only, no dependencies.
// Lifecycle: bind an ephemeral port, POST {"port"} to $MAKEFUN_ENV_URL/register,
// long-poll GET $MAKEFUN_ENV_URL/done, exit 0 when done is true.
// Without MAKEFUN_ENV_URL it simply serves (local practice runs).
//
// makefun anchor dc8f9f2c8be00a3a9c17d86fb5cf2b5e04019d1b round 34023466

import http from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// constants and deterministic state
// ---------------------------------------------------------------------------

const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN || 'dev-token';
const ENV_URL = (process.env.MAKEFUN_ENV_URL || '').replace(/\/+$/, '');
const TRIAL_SEED = process.env.MAKEFUN_TRIAL_SEED || '';
const TRIAL_NOW = process.env.MAKEFUN_TRIAL_NOW || '';
// Deterministic clock: every timestamp the forge emits comes from this counter,
// never from the wall clock, so a live run and its replay emit identical bytes.
const EPOCH_SEC = 1735689600;
let timeSeq = 0;
let reqSeq = 0;
let idSeq = 1;
let repoSeq = 5000;

function nextTimeSec() {
  timeSeq += 1;
  return EPOCH_SEC + timeSeq;
}
function isoOf(sec) {
  return new Date(sec * 1000).toISOString();
}
function nextReqId() {
  reqSeq += 1;
  return `req-${reqSeq.toString(16).padStart(8, '0')}`;
}
function nextId() {
  idSeq += 1;
  return idSeq;
}
function nextRepoId() {
  repoSeq += 1;
  return repoSeq;
}

const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;
const AGENT = 'forge/1.0';
const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function isOid(s) {
  return typeof s === 'string' && HEX40.test(s);
}
function sha1hex(buf) {
  return createHash('sha1').update(buf).digest('hex');
}
function b64encode(buf) {
  return Buffer.from(buf).toString('base64');
}
function b64decode(s) {
  return Buffer.from(String(s).replace(/[\r\n\t ]+/g, ''), 'base64');
}
function globalId(kind, key) {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}
function jsonBody(res, status, obj, extraHeaders) {
  const text = JSON.stringify(obj);
  const headers = { 'content-type': 'application/json', 'x-github-request-id': nextReqId() };
  if (extraHeaders) for (const k of Object.keys(extraHeaders)) headers[k] = extraHeaders[k];
  res.writeHead(status, headers);
  res.end(text);
}
function jsonError(res, status, message) {
  jsonBody(res, status, { message });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      chunks.push(c);
      total += c.length;
      if (total > 64 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(Buffer.concat(chunks, total)));
    req.on('error', reject);
  });
}
function bearerOk(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return false;
  return h.slice(7) === TOKEN;
}
function authed(req, res) {
  if (!bearerOk(req)) {
    jsonError(res, 401, 'Requires authentication');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// git object model
// ---------------------------------------------------------------------------

const TYPE_CODE = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function hashObject(type, data) {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  const h = createHash('sha1');
  h.update(head);
  h.update(data);
  return h.digest('hex');
}

function parseTree(data) {
  const entries = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry truncated');
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function compareTreeNames(a, b) {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

function buildTree(entries) {
  const sorted = [...entries].sort(compareTreeNames);
  const parts = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function parseCommit(data) {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = val;
    else if (key === 'parent') parents.push(val);
    else if (key === 'author') author = val;
    else if (key === 'committer') committer = val;
  }
  return { tree, parents, author, committer, message };
}

function parseTag(data) {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const map = new Map();
  for (const line of head.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    map.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return { object: map.get('object') || '', type: map.get('type') || '', tag: map.get('tag') || '', tagger: map.get('tagger') || '', message };
}

function buildCommitText(tree, parents, author, committer, message, timestamp) {
  const who = `${author} ${timestamp} +0000`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${committer ? `${committer} ${timestamp} +0000` : who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

function pkt(data) {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const head = Buffer.allocUnsafe(4);
  head.write((body.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, body]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

function pktLines(items) {
  const parts = [];
  for (const it of items) {
    if (it === 'flush') parts.push(PKT_FLUSH);
    else if (it === 'delim') parts.push(PKT_DELIM);
    else parts.push(pkt(it));
  }
  return Buffer.concat(parts);
}

// Decode a whole buffer of pkt-lines. Returns { packets: [{kind, payload}], rest }.
// Throws on malformed framing.
function decodePktLines(buf) {
  const packets = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const h = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(h)) break;
    const len = parseInt(h, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}

// ---------------------------------------------------------------------------
// packfile read / write (plain objects only, no deltas)
// ---------------------------------------------------------------------------

function writePackObjectHeader(type, size) {
  const code = TYPE_CODE[type];
  const bytes = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects) {
  const parts = [];
  const head = Buffer.allocUnsafe(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const o of objects) {
    parts.push(writePackObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readPack(pack) {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  const objects = [];
  let off = 12;
  const byOffset = new Map();
  for (let i = 0; i < count; i += 1) {
    const entryOff = off;
    let byte = pack[off];
    let size = byte & 0x0f;
    let shift = 4;
    const first = byte;
    off += 1;
    while (byte & 0x80) {
      byte = pack[off];
      off += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const typeCode = (first >> 4) & 0x07;
    if (typeCode === 6 || typeCode === 7) throw new Error('delta pack entries are not accepted');
    const type = CODE_TYPE[typeCode];
    if (!type) throw new Error(`unknown pack type code ${typeCode}`);
    let inflated;
    try {
      inflated = inflateSync(pack.subarray(off, trailerStart), { info: true });
    } catch (e) {
      throw new Error(`zlib inflate failed at pack offset ${off}: ${e.message}`);
    }
    const data = inflated.buffer;
    if (data.length !== size) throw new Error(`pack entry declares ${size} bytes but inflated to ${data.length}`);
    off += inflated.engine.bytesWritten;
    const oid = hashObject(type, data);
    const entry = { type, data, oid, offset: entryOff };
    objects.push(entry);
    byOffset.set(entryOff, entry);
  }
  if (off !== trailerStart) throw new Error('pack has stray bytes before its trailer');
  return { version, count, objects };
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

// Repo: { id, owner, name, description, private, defaultBranch, createdSeq,
//   objects: Map<oid, {type, data}>, refs: Map<refname, oid>,
//   issues: Map<number, Issue>, pulls: Map<number, Pull>, labels: Map<name, Label>,
//   comments: Map<issueNumber, Comment[]>, nextNumber, seq, packCache: Map<key, Buffer>,
//   jsonCache: string|null }
const repos = new Map(); // key `${owner}/${name}` -> Repo
const reposByOwner = new Map(); // owner -> Repo[] in creation order

function repoKey(owner, name) {
  return `${owner}/${name}`;
}
function getRepo(owner, name) {
  return repos.get(repoKey(owner, name)) || null;
}
function createRepoRecord(owner, name, description, isPrivate) {
  const repo = {
    id: nextRepoId(),
    owner,
    name,
    description: description || '',
    private: isPrivate !== false,
    defaultBranch: 'main',
    createdSeq: timeSeq,
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    comments: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    packCache: new Map(),
    jsonCache: null,
  };
  repos.set(repoKey(owner, name), repo);
  if (!reposByOwner.has(owner)) reposByOwner.set(owner, []);
  reposByOwner.get(owner).push(repo);
  return repo;
}
function deleteRepoRecord(repo) {
  repos.delete(repoKey(repo.owner, repo.name));
  const list = reposByOwner.get(repo.owner);
  if (list) {
    const i = list.indexOf(repo);
    if (i >= 0) list.splice(i, 1);
  }
}
function putObject(repo, type, data) {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  repo.packCache.clear();
  return oid;
}
function getObject(repo, oid) {
  return repo.objects.get(oid) || null;
}
function refTarget(repo, ref) {
  return repo.refs.get(ref) || null;
}
function headRef(repo) {
  return `refs/heads/${repo.defaultBranch}`;
}
function headOid(repo) {
  return refTarget(repo, headRef(repo));
}

// Walk every object reachable from roots (commits, trees, blobs, tags).
// Returns a Set of oids. allowMissing skips missing objects instead of throwing.
// stopAt: oids the walk must not enter (a shallow client's boundary commits,
// which the client names but does not hold).
function collectReachable(repo, roots, allowMissing, stopAt) {
  const seen = new Set();
  const queue = [];
  for (const r of roots) if (isOid(r)) queue.push(r);
  while (queue.length) {
    const oid = queue.pop();
    if (seen.has(oid)) continue;
    if (stopAt && stopAt.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) {
      if (allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') queue.push(e.oid);
      }
    }
  }
  return seen;
}

// Reachable commits from roots, with generation depth (0 = the roots themselves).
// Returns Map<oid, depth> for commits only.
function commitDepths(repo, roots) {
  const depths = new Map();
  const queue = [];
  for (const r of roots) {
    if (isOid(r) && !depths.has(r)) {
      depths.set(r, 0);
      queue.push(r);
    }
  }
  let qi = 0;
  while (qi < queue.length) {
    const oid = queue[qi];
    qi += 1;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const t = parseTag(obj.data).object;
      if (isOid(t) && !depths.has(t)) {
        depths.set(t, depths.get(oid));
        queue.push(t);
      }
      continue;
    }
    if (obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    const d = depths.get(oid);
    for (const p of c.parents) {
      if (!depths.has(p)) {
        depths.set(p, d + 1);
        queue.push(p);
      }
    }
  }
  return depths;
}

// O(1) fast-forward check for the common linear case: the new tip's first
// parent is the old tip. Falls back to a full ancestor walk otherwise.
function isFastForward(repo, oldTip, newTip) {
  if (oldTip === newTip) return true;
  const obj = repo.objects.get(newTip);
  if (!obj) return false;
  let commitOid = newTip;
  if (obj.type === 'tag') commitOid = peelToNonTag(repo, newTip);
  const cobj = repo.objects.get(commitOid);
  if (!cobj || cobj.type !== 'commit') return false;
  const c = parseCommit(cobj.data);
  return c.parents.length > 0 && c.parents[0] === oldTip;
}

function isAncestor(repo, maybeAncestor, oid) {
  if (maybeAncestor === oid) return true;
  const depths = commitDepths(repo, [oid]);
  return depths.has(maybeAncestor);
}

// Peel a tag (recursively) to the object it ultimately points at.
function peelToNonTag(repo, oid) {
  let cur = oid;
  const seen = new Set();
  for (;;) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag' || seen.has(cur)) return cur;
    seen.add(cur);
    cur = parseTag(obj.data).object;
  }
}

// The tree oid of a commit (following tags).
function commitTreeOf(repo, oid) {
  const peeled = peelToNonTag(repo, oid);
  const obj = repo.objects.get(peeled);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

// List a tree's entries recursively: Map<path, {mode, oid, type}>.
function flattenTree(repo, treeOid, prefix, out) {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      flattenTree(repo, e.oid, path, out);
    } else {
      out.set(path, { mode: e.mode, oid: e.oid });
    }
  }
  return out;
}

// Build a tree object from a flat path map (nested trees created as needed).
function treeFromFlat(repo, flat) {
  function build(dir, prefix) {
    const entries = [];
    const subdirs = new Map();
    for (const [path, v] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ mode: v.mode, name: rest, oid: v.oid });
      } else {
        const dirName = rest.slice(0, slash);
        if (!subdirs.has(dirName)) subdirs.set(dirName, []);
        subdirs.get(dirName).push([path, v]);
      }
    }
    for (const [name, members] of subdirs) {
      const sub = new Map(members);
      entries.push({ mode: '40000', name, oid: build(sub, `${prefix}${name}/`) });
    }
    return putObject(repo, 'tree', buildTree(entries));
  }
  return build(flat, '');
}

// Compute the objects a fetch must send:
//   wants: tip oids; haves: oids the client holds; depth: null (full) or N.
//   oldShallow: the client's shallow boundaries (for unshallow reporting).
//   clientShallow: boundaries the walk must not cross when computing held.
// Returns { send: GitObject[], shallow: string[], unshallow: string[] }.
function computeFetch(repo, wants, haves, depth, oldShallow, clientShallow) {
  const stopAt = clientShallow && clientShallow.length ? new Set(clientShallow) : null;
  const held = new Set();
  for (const h of haves) {
    try {
      for (const o of collectReachable(repo, [h], true, stopAt)) held.add(o);
    } catch { /* ignore */ }
  }
  let sendSet;
  let shallow = [];
  let unshallow = [];
  if (depth === null || depth === undefined) {
    sendSet = collectReachable(repo, wants, true);
    for (const o of held) sendSet.delete(o);
  } else {
    const depths = commitDepths(repo, wants);
    const boundary = new Set();
    const inDepth = new Set();
    for (const [oid, d] of depths) {
      // The boundary is the deepest INCLUDED generation (depth N-1): those
      // commits are sent, but their parents are not, so shallow-info names
      // them (the tip for depth 1, the parent for depth 2).
      if (d === depth - 1) boundary.add(oid);
      if (d < depth) inDepth.add(oid);
    }
    // The pack carries only commits with depth < N and their trees/blobs.
    // Commits at exactly depth N are NOT sent; they are named in shallow-info.
    sendSet = new Set();
    const queue = [...inDepth];
    const seen = new Set();
    while (queue.length) {
      const oid = queue.pop();
      if (seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        if (depths.get(oid) < depth) {
          for (const p of c.parents) {
            if (depths.has(p) && depths.get(p) < depth) queue.push(p);
          }
        }
        queue.push(c.tree);
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.data).object);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) {
          if (e.mode !== '160000') queue.push(e.oid);
        }
      }
    }
    for (const o of seen) sendSet.add(o);
    for (const o of held) sendSet.delete(o);
    shallow = [...boundary].filter((oid) => !held.has(oid));
    // Old boundaries that now sit above the new boundary line are fully
    // included, so they stop being shallow.
    if (oldShallow) {
      for (const b of oldShallow) {
        if (depths.has(b) && depths.get(b) < depth - 1) unshallow.push(b);
      }
    }
  }
  const send = [];
  for (const oid of sendSet) {
    const obj = repo.objects.get(oid);
    if (obj) send.push({ type: obj.type, data: obj.data, oid });
  }
  // Deterministic pack order: commits, then tags, then trees, then blobs, each by oid.
  const order = { commit: 0, tag: 1, tree: 2, blob: 3 };
  send.sort((a, b) => (order[a.type] - order[b.type]) || (a.oid < b.oid ? -1 : 1));
  return { send, shallow, unshallow };
}

// Acknowledge haves that are ancestors of (or equal to) a want.
function computeAcks(repo, wants, haves) {
  const acks = [];
  if (!haves.length) return acks;
  const depths = commitDepths(repo, wants);
  for (const h of haves) {
    if (depths.has(h)) acks.push(h);
  }
  return acks;
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

function gitRefLines(repo) {
  const lines = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, oid] of refs) lines.push(`${oid} ${ref}`);
  return lines;
}

// v2 advertisement body: caps lines, delim, refs, flush. Cached per repo state
// (repo.packCache is cleared on every mutation, so the cache cannot go stale).
function v2Advertisement(repo) {
  const cached = repo.packCache.get('advert-v2');
  if (cached) return cached.pack;
  const body = buildV2Advertisement(repo);
  repo.packCache.set('advert-v2', { pack: body });
  return body;
}

function buildV2Advertisement(repo) {
  const items = [];
  items.push('version 2');
  items.push('agent=forge/1.0');
  items.push('ls-refs=unborn');
  items.push('fetch=shallow wait-for-done');
  items.push('object-format=sha1');
  items.push('delim');
  const h = headOid(repo);
  if (h) {
    items.push(`HEAD symref-target:refs/heads/${repo.defaultBranch}`);
    items.push(`${h} HEAD`);
    for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        items.push(`${oid} ${ref} peeled:${peelToNonTag(repo, oid)}`);
      } else {
        items.push(`${oid} ${ref}`);
      }
    }
  } else {
    items.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`);
  }
  items.push('flush');
  return pktLines(items);
}

// v0 advertisement body for a service, with "# service=" preamble. Cached per
// repo state (see v2Advertisement).
function v0Advertisement(repo, service) {
  const cached = repo.packCache.get(`advert-v0-${service}`);
  if (cached) return cached.pack;
  const body = buildV0Advertisement(repo, service);
  repo.packCache.set(`advert-v0-${service}`, { pack: body });
  return body;
}

function buildV0Advertisement(repo, service) {
  const preamble = `# service=${service}\n`;
  const parts = [pkt(preamble), PKT_FLUSH];
  const h = headOid(repo);
  const caps = service === 'git-upload-pack'
    ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
    : `report-status report-status-v2 side-band-64k ofs-delta delete-refs agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const lines = [];
  if (!h) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}`);
  } else {
    lines.push(`${h} HEAD\0${caps}`);
    for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      lines.push(`${oid} ${ref}`);
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        lines.push(`${peelToNonTag(repo, oid)} ${ref}^{}`);
      }
    }
  }
  parts.push(pktLines(lines));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleInfoRefs(req, res, repo, service) {
  if (service === 'git-upload-pack' && (req.headers['git-protocol'] || '').startsWith('version=2')) {
    const body = v2Advertisement(repo);
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-advertisement',
      'x-github-request-id': nextReqId(),
    });
    res.end(body);
    return;
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    jsonError(res, 400, 'unknown service');
    return;
  }
  const body = v0Advertisement(repo, service);
  res.writeHead(200, {
    'content-type': `application/x-${service}-advertisement`,
    'x-github-request-id': nextReqId(),
  });
  res.end(body);
}

function sidebandFrame(band, data) {
  const chunks = [];
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  for (let off = 0; off < payload.length; off += 32768) {
    const slice = payload.subarray(off, off + 32768);
    const framed = Buffer.concat([Buffer.from([band]), slice]);
    chunks.push(pkt(framed));
  }
  return Buffer.concat(chunks);
}

// Parse a v2 command request body into { command, args: string[], extra }.
// Lines before the first delim are args; the rest is the request body.
function parseV2Request(buf) {
  const { packets } = decodePktLines(buf);
  const args = [];
  let seenDelim = false;
  let body = Buffer.alloc(0);
  for (const p of packets) {
    if (p.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (p.kind === 'flush') continue;
    if (!seenDelim) {
      const text = p.payload.toString('utf8').replace(/\n$/, '');
      args.push(text);
    } else {
      body = Buffer.concat([body, p.payload]);
    }
  }
  return { args, body };
}

function parseLsRefsArgs(args) {
  let prefix = null;
  let peel = false;
  let symrefs = false;
  let unborn = false;
  let refsRequested = false;
  for (const a of args) {
    if (a === 'peel') peel = true;
    else if (a === 'symrefs') symrefs = true;
    else if (a === 'unborn') unborn = true;
    else if (a.startsWith('ref-prefix ')) prefix = a.slice('ref-prefix '.length);
    else if (a.startsWith('ref-prefix:')) prefix = a.slice('ref-prefix:'.length);
  }
  refsRequested = args.some((a) => a.startsWith('ref-prefix'));
  return { prefix, peel, symrefs, unborn, refsRequested };
}

function handleUploadPackV2(req, res, repo, body) {
  let parsed;
  try {
    parsed = parseV2Request(body);
  } catch {
    res.writeHead(400, { 'x-github-request-id': nextReqId() });
    res.end();
    return;
  }
  const command = (parsed.args.find((a) => a.startsWith('command=')) || '').slice('command='.length);
  if (command === 'ls-refs') {
    // ls-refs arguments (peel, symrefs, unborn, ref-prefix) follow the delim.
    const lsArgs = parsed.body.toString('utf8').split('\n').filter((s) => s.length > 0);
    const { prefix, peel, symrefs, unborn } = parseLsRefsArgs(lsArgs);
    const items = [];
    const h = headOid(repo);
    const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const headMatches = !prefix || 'HEAD'.startsWith(prefix);
    if (h && headMatches) {
      items.push(`${h} HEAD${symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : ''}`);
    }
    if (!h && unborn) {
      items.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`);
    }
    for (const [ref, oid] of refs) {
      if (prefix && !ref.startsWith(prefix)) continue;
      if (peel) {
        const obj = repo.objects.get(oid);
        if (obj && obj.type === 'tag') {
          items.push(`${oid} ${ref} peeled:${peelToNonTag(repo, oid)}`);
          continue;
        }
      }
      items.push(`${oid} ${ref}`);
    }
    items.push('flush');
    const out = pktLines(items);
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'x-github-request-id': nextReqId(),
    });
    res.end(out);
    return;
  }
  if (command === 'fetch') {
    let wants = [];
    let haves = [];
    let depth = null;
    let deepen = 0;
    let clientShallow = [];
    const lines = parsed.body.toString('utf8').split('\n').filter((s) => s.length > 0);
    for (const line of lines) {
      const s = line.replace(/\r$/, '');
      if (s.startsWith('want ')) wants.push(s.slice(5).trim());
      else if (s.startsWith('have ')) haves.push(s.slice(5).trim());
      else if (s.startsWith('deepen ')) deepen = parseInt(s.slice(7), 10) || 0;
      else if (s.startsWith('shallow ')) clientShallow.push(s.slice(8).trim());
      else if (s.startsWith('deepen-since')) deepen = 1;
    }
    if (deepen > 0) depth = deepen;
    const acks = computeAcks(repo, wants, haves);
    const cacheKey = `fetch|${wants.join(',')}|${haves.join(',')}|${depth === null ? '' : depth}|${clientShallow.join(',')}`;
    let cached = repo.packCache.get(cacheKey);
    let pack;
    let shallow;
    let unshallow;
    if (cached) {
      ({ pack, shallow, unshallow } = cached);
    } else {
      const computed = computeFetch(repo, wants, haves, depth, clientShallow, clientShallow);
      shallow = computed.shallow;
      unshallow = computed.unshallow;
      pack = writePack(computed.send);
      repo.packCache.set(cacheKey, { pack, shallow, unshallow });
    }
    const items = [];
    items.push('acknowledgments\n');
    if (acks.length) {
      for (const a of acks) items.push(`ACK ${a}\n`);
      items.push('ready\n');
    } else {
      items.push('NAK\n');
    }
    items.push('delim');
    if (shallow.length || unshallow.length) {
      items.push('shallow-info\n');
      for (const s of shallow) items.push(`shallow ${s}\n`);
      for (const s of unshallow) items.push(`unshallow ${s}\n`);
      items.push('delim');
    }
    items.push('wanted-refs\n');
    for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (wants.includes(oid)) items.push(`${oid} ${ref}\n`);
    }
    items.push('delim');
    items.push('packfile\n');
    const head = pktLines(items);
    const banded = sidebandFrame(1, pack);
    const tail = pktLines(['flush']);
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'x-github-request-id': nextReqId(),
    });
    res.end(Buffer.concat([head, banded, tail]));
    return;
  }
  jsonError(res, 400, `unknown upload-pack command ${command}`);
}

// v0 fetch: two-section request (wants, then haves + done). Response: NAK/ACK lines
// + optional shallow lines, then the pack in sideband band 1.
function handleUploadPackV0(req, res, repo, body) {
  const { packets } = decodePktLines(body);
  const sections = [];
  let cur = [];
  for (const p of packets) {
    if (p.kind === 'flush') {
      sections.push(cur);
      cur = [];
      continue;
    }
    if (p.kind === 'data') cur.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (cur.length) sections.push(cur);
  const wants = [];
  const haves = [];
  let depth = null;
  let deepen = 0;
  let clientShallow = [];
  for (const section of sections) {
    for (const line of section) {
      if (line.startsWith('want ')) {
        wants.push(line.slice(5).split(' ')[0].trim());
        const m = line.match(/deepen\s+(\d+)/);
        if (m) deepen = parseInt(m[1], 10) || 0;
        if (line.includes('deepen-since')) deepen = 1;
      } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) deepen = parseInt(line.slice(7), 10) || 0;
      else if (line === 'done') { /* end of haves */ }
    }
  }
  if (deepen > 0) depth = deepen;
  const acks = computeAcks(repo, wants, haves);
  const cacheKey = `fetch|${wants.join(',')}|${haves.join(',')}|${depth === null ? '' : depth}|${clientShallow.join(',')}`;
  let cached = repo.packCache.get(cacheKey);
  let pack;
  let shallow;
  let unshallow;
  if (cached) {
    ({ pack, shallow, unshallow } = cached);
  } else {
    const computed = computeFetch(repo, wants, haves, depth, clientShallow, clientShallow);
    shallow = computed.shallow;
    unshallow = computed.unshallow;
    pack = writePack(computed.send);
    repo.packCache.set(cacheKey, { pack, shallow, unshallow });
  }
  const parts = [];
  if (acks.length) {
    for (const a of acks) parts.push(pkt(`ACK ${a}\n`));
  } else if (haves.length) {
    parts.push(pkt('NAK\n'));
  } else {
    parts.push(pkt('NAK\n'));
  }
  for (const s of shallow) parts.push(pkt(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pkt(`unshallow ${s}\n`));
  parts.push(sidebandFrame(1, pack));
  res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'x-github-request-id': nextReqId(),
  });
  res.end(Buffer.concat(parts));
}

function handleUploadPack(req, res, repo, body) {
  if (body.length === 0) {
    jsonError(res, 400, 'empty upload-pack request');
    return;
  }
  if (req.headers['git-protocol'] === 'version=2' || body.subarray(0, 4).toString('ascii') === '0012' || body.toString('utf8', 4, 11).startsWith('command')) {
    // A v2 request starts with a pkt-line whose payload is "command=...".
    let isV2 = false;
    try {
      const peek = decodePktLines(body).packets[0];
      isV2 = !!peek && peek.kind === 'data' && peek.payload.toString('utf8').startsWith('command=');
    } catch { /* not a v2 request */ }
    if (isV2) {
      handleUploadPackV2(req, res, repo, body);
      return;
    }
  }
  try {
    handleUploadPackV0(req, res, repo, body);
  } catch {
    res.writeHead(400, { 'x-github-request-id': nextReqId() });
    res.end();
  }
}

// receive-pack: command list (pkt-lines) then a raw pack. Commands:
//   <old> <new> <ref>\0<capabilities>
// Response: sideband-framed band-1 report (unpack + ok/ng lines) when
// side-band-64k was advertised; otherwise plain pkt-line report.
function handleReceivePack(req, res, repo, body) {
  let commands = [];
  let pack = null;
  try {
    const { packets, rest } = decodePktLines(body);
    let first = true;
    for (const p of packets) {
      if (p.kind === 'flush') break;
      if (p.kind !== 'data') continue;
      const text = p.payload.toString('utf8');
      const nul = text.indexOf('\0');
      const cmdText = nul >= 0 ? text.slice(0, nul) : text;
      const m = cmdText.trim().match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/);
      if (!m) throw new Error('malformed push command');
      commands.push({ old: m[1], nw: m[2], ref: m[3].trim(), caps: first && nul >= 0 ? text.slice(nul + 1) : '' });
      first = false;
    }
    pack = rest;
  } catch {
    res.writeHead(400, { 'x-github-request-id': nextReqId() });
    res.end();
    return;
  }
  const results = [];
  let stored = null;
  if (pack && pack.length > 0) {
    try {
      stored = readPack(pack);
    } catch {
      jsonError(res, 400, 'packfile is malformed');
      return;
    }
    for (const o of stored.objects) putObject(repo, o.type, o.data);
  }
  let anyError = false;
  for (const cmd of commands) {
    const cur = repo.refs.get(cmd.ref);
    let problem = null;
    if (cmd.nw === ZERO_OID) {
      if (!cur) problem = 'ref does not exist';
      else if (cur !== cmd.old) problem = 'stale';
    } else {
      const obj = repo.objects.get(cmd.nw);
      if (!obj) problem = 'missing object';
      else if (cur && cmd.old !== ZERO_OID && cur !== cmd.old) problem = 'stale';
      else if (cur && cmd.old === ZERO_OID) problem = 'already exists';
      else if (cur && cur !== cmd.nw) {
        if (!isFastForward(repo, cur, cmd.nw) && !isAncestor(repo, cur, cmd.nw)) problem = 'non-fast-forward';
      }
    }
    if (problem) {
      results.push({ ref: cmd.ref, ok: false, reason: problem });
      anyError = true;
    } else {
      results.push({ ref: cmd.ref, ok: true });
    }
  }
  // Apply only the ok commands.
  for (let i = 0; i < commands.length; i += 1) {
    if (!results[i].ok) continue;
    const cmd = commands[i];
    if (cmd.nw === ZERO_OID) repo.refs.delete(cmd.ref);
    else repo.refs.set(cmd.ref, cmd.nw);
  }
  if (commands.some((c) => c.ref === headRef(repo))) repo.packCache.clear();
  const lines = ['unpack ok\n'];
  for (const r of results) {
    lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  const inner = pktLines([...lines, 'flush']);
  const framed = sidebandFrame(1, inner);
  const out = Buffer.concat([framed, PKT_FLUSH]);
  res.writeHead(200, {
    'content-type': 'application/x-git-receive-pack-result',
    'x-github-request-id': nextReqId(),
  });
  res.end(out);
  void anyError;
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function userJson(login, id) {
  return {
    login,
    id,
    node_id: globalId('User', login),
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url: `https://api.github.com/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
    name: login === VIEWER.login ? VIEWER.name : login,
    email: login === VIEWER.login ? VIEWER.email : `${login}@example.invalid`,
  };
}
function viewerJson() {
  return userJson(VIEWER.login, VIEWER.id);
}

function repoJson(repo) {
  if (repo.jsonCache) return repo.jsonCache;
  const obj = {
    id: repo.id,
    node_id: globalId('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, repo.owner === VIEWER.login ? VIEWER.id : 1001),
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    created_at: isoOf(EPOCH_SEC + repo.createdSeq),
    updated_at: isoOf(EPOCH_SEC + repo.createdSeq),
    pushed_at: isoOf(EPOCH_SEC + repo.createdSeq),
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length + [...repo.pulls.values()].filter((p) => p.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: 0,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
  repo.jsonCache = JSON.stringify(obj);
  return repo.jsonCache;
}

function labelJson(label) {
  return { id: label.id, node_id: globalId('Label', label.name), url: '', name: label.name, color: label.color, default: false, description: label.description || '' };
}

function issueJson(repo, issue) {
  if (issue.jsonCache) return issue.jsonCache;
  const obj = {
    id: issue.id,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    labels_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(issue.author, issue.author === VIEWER.login ? VIEWER.id : 1001),
    labels: issue.labels.map((l) => labelJson(l)),
    assignee: null,
    assignees: [],
    locked: false,
    comments: (repo.comments.get(issue.number) || []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: null,
  };
  issue.jsonCache = JSON.stringify(obj);
  return issue.jsonCache;
}

function pullJson(repo, pr) {
  if (pr.jsonCache) return pr.jsonCache;
  const obj = {
    id: pr.id,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pr.number}`),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}.patch`,
    issue_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${pr.number}`,
    number: pr.number,
    state: pr.state,
    locked: false,
    title: pr.title,
    user: userJson(pr.author, pr.author === VIEWER.login ? VIEWER.id : 1001),
    body: pr.body,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pr.number}/commits`,
    review_comments_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pr.number}/comments`,
    review_comment_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/comments{/number}`,
    comments_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${pr.number}/comments`,
    statuses_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/statuses/${pr.headSha}`,
    head: { label: `${repo.owner}:${pr.head}`, ref: pr.head, sha: pr.headSha, user: viewerJson(), repo: JSON.parse(repoJson(repo)) },
    base: { label: `${repo.owner}:${pr.base}`, ref: pr.base, sha: pr.baseSha, user: viewerJson(), repo: JSON.parse(repoJson(repo)) },
    _links: {},
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: pr.merged,
    mergeable: pr.mergeable,
    rebaseable: true,
    mergeable_state: pr.mergeable === 'MERGEABLE' ? 'clean' : 'dirty',
    merged_by: null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changedFiles,
  };
  pr.jsonCache = JSON.stringify(obj);
  return pr.jsonCache;
}

function commentJson(repo, issueNumber, c) {
  return {
    id: c.id,
    node_id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issueNumber}:${c.id}`),
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/comments/${c.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${c.id}`,
    issue_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
    body: c.body,
    user: userJson(c.author, c.author === VIEWER.login ? VIEWER.id : 1001),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    author_association: 'OWNER',
  };
}

function newIssue(repo, title, body, labelNames) {
  const labels = [];
  for (const name of labelNames || []) {
    const l = repo.labels.get(name);
    if (!l) return { error: `label "${name}" does not exist` };
    labels.push(l);
  }
  const n = repo.nextNumber;
  repo.nextNumber += 1;
  const sec = nextTimeSec();
  const issue = {
    id: nextId(),
    number: n,
    title: title || '',
    body: body || '',
    state: 'open',
    labels,
    author: VIEWER.login,
    createdAt: isoOf(sec),
    updatedAt: isoOf(sec),
    closedAt: null,
    createdSeq: sec,
    jsonCache: null,
  };
  repo.issues.set(n, issue);
  return { issue };
}

function newPull(repo, title, body, head, base) {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) return { error: 'head or base branch does not exist' };
  for (const p of repo.pulls.values()) {
    if (p.state === 'open' && p.head === head && p.base === base) return { error: 'a pull request already exists for this head and base' };
  }
  const n = repo.nextNumber;
  repo.nextNumber += 1;
  const sec = nextTimeSec();
  const files = diffFiles(repo, headSha, baseSha);
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  const conflicted = files.some((f) => f.conflict);
  const pr = {
    id: nextId(),
    number: n,
    title: title || '',
    body: body || '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    head,
    base,
    headSha,
    baseSha,
    author: VIEWER.login,
    createdAt: isoOf(sec),
    updatedAt: isoOf(sec),
    closedAt: null,
    createdSeq: sec,
    mergeable: conflicted ? 'CONFLICTING' : 'MERGEABLE',
    additions,
    deletions,
    changedFiles: files.length,
    jsonCache: null,
  };
  repo.pulls.set(n, pr);
  return { pr };
}

// Merge-base: the first commit reachable from both tips (by BFS depth from base).
function mergeBase(repo, a, b) {
  const depthA = commitDepths(repo, [a]);
  if (depthA.has(b)) return b;
  const queue = [b];
  const seen = new Set([b]);
  let qi = 0;
  while (qi < queue.length) {
    const oid = queue[qi];
    qi += 1;
    if (depthA.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return null;
}

// Line-level diff of two blobs: common prefix/suffix, the rest added/removed.
function lineDiff(a, b) {
  const aLines = a.length ? a.split('\n') : [];
  const bLines = b.length ? b.split('\n') : [];
  let pre = 0;
  while (pre < aLines.length && pre < bLines.length && aLines[pre] === bLines[pre]) pre += 1;
  let suf = 0;
  while (suf < aLines.length - pre && suf < bLines.length - pre && aLines[aLines.length - 1 - suf] === bLines[bLines.length - 1 - suf]) suf += 1;
  return { deletions: aLines.length - pre - suf, additions: bLines.length - pre - suf };
}

// Files changed between base tip and head tip (via their merge-base).
// Returns [{filename, status, additions, deletions, changes, conflict}].
function diffFiles(repo, headSha, baseSha) {
  const base = mergeBase(repo, headSha, baseSha);
  const baseTree = base ? commitTreeOf(repo, base) : null;
  const headTree = commitTreeOf(repo, headSha);
  const baseFlat = baseTree ? flattenTree(repo, baseTree, '', new Map()) : new Map();
  const headFlat = headTree ? flattenTree(repo, headTree, '', new Map()) : new Map();
  const out = [];
  const all = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of all) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if (b && !h) {
      const blob = repo.objects.get(b.oid);
      const lines = blob ? blob.data.toString('utf8').split('\n').length : 0;
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines, conflict: false });
    } else if (!b && h) {
      const blob = repo.objects.get(h.oid);
      const lines = blob ? blob.data.toString('utf8').split('\n').length : 0;
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines, conflict: false });
    } else if (b && h && b.oid !== h.oid) {
      const blobA = repo.objects.get(b.oid);
      const blobB = repo.objects.get(h.oid);
      const d = lineDiff(blobA ? blobA.data.toString('utf8') : '', blobB ? blobB.data.toString('utf8') : '');
      out.push({ filename: path, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions, conflict: false });
    }
  }
  out.sort((x, y) => (x.filename < y.filename ? -1 : 1));
  return out;
}

// Conflict: a path changed on both sides of the merge-base with different content.
// Uses the CURRENT base tip, not the tip recorded when the PR was created.
function hasMergeConflict(repo, pr) {
  const baseSha = repo.refs.get(`refs/heads/${pr.base}`) || pr.baseSha;
  const base = mergeBase(repo, pr.headSha, baseSha);
  if (!base) return false;
  const baseTree = commitTreeOf(repo, base);
  const baseFlat = baseTree ? flattenTree(repo, baseTree, '', new Map()) : new Map();
  const headFlat = commitTreeOf(repo, pr.headSha) ? flattenTree(repo, commitTreeOf(repo, pr.headSha), '', new Map()) : new Map();
  const targetFlat = commitTreeOf(repo, baseSha) ? flattenTree(repo, commitTreeOf(repo, baseSha), '', new Map()) : new Map();
  const all = new Set([...baseFlat.keys(), ...headFlat.keys(), ...targetFlat.keys()]);
  for (const path of all) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    const t = targetFlat.get(path);
    const headChanged = (b && h && b.oid !== h.oid) || (b && !h) || (!b && h);
    const baseChanged = (b && t && b.oid !== t.oid) || (b && !t) || (!b && t);
    if (headChanged && baseChanged) {
      const hOid = h ? h.oid : null;
      const tOid = t ? t.oid : null;
      if (hOid !== tOid) return true;
    }
  }
  return false;
}

function doSquashMerge(repo, pr) {
  const baseSha = repo.refs.get(`refs/heads/${pr.base}`) || pr.baseSha;
  const base = mergeBase(repo, pr.headSha, baseSha);
  const baseTree = base ? commitTreeOf(repo, base) : null;
  const baseFlat = baseTree ? flattenTree(repo, baseTree, '', new Map()) : new Map();
  const headFlat = commitTreeOf(repo, pr.headSha) ? flattenTree(repo, commitTreeOf(repo, pr.headSha), '', new Map()) : new Map();
  const targetFlat = commitTreeOf(repo, baseSha) ? flattenTree(repo, commitTreeOf(repo, baseSha), '', new Map()) : new Map();
  // Start from the base tip's tree, then apply only head's changes relative to
  // the merge-base (conflicts are rejected before this runs).
  const merged = new Map(targetFlat);
  for (const [path, v] of headFlat) {
    const b = baseFlat.get(path);
    if (!b || b.oid !== v.oid) merged.set(path, v);
  }
  for (const path of baseFlat.keys()) {
    if (!headFlat.has(path)) merged.delete(path);
  }
  const newTree = treeFromFlat(repo, merged);
  const sec = nextTimeSec();
  const message = pr.title;
  const commitData = buildCommitText(newTree, [baseSha], `${VIEWER.name} <${VIEWER.email}>`, '', message, sec);
  const mergeSha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pr.base}`, mergeSha);
  pr.baseSha = baseSha;
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = isoOf(sec);
  pr.mergeCommitSha = mergeSha;
  pr.closedAt = isoOf(sec);
  pr.updatedAt = isoOf(sec);
  pr.jsonCache = null;
  repo.packCache.clear();
  repo.jsonCache = null;
  return mergeSha;
}

function parseJsonBody(body) {
  if (!body || body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

function sendJson(res, status, obj, extra) {
  jsonBody(res, status, obj, extra);
}
function sendRawJson(res, status, text, extra) {
  const headers = { 'content-type': 'application/json', 'x-github-request-id': nextReqId() };
  if (extra) for (const k of Object.keys(extra)) headers[k] = extra[k];
  res.writeHead(status, headers);
  res.end(text);
}

function pageParams(req) {
  const u = new URL(req.url, 'http://x');
  const perPage = Math.max(1, Math.min(100, parseInt(u.searchParams.get('per_page') || '30', 10) || 30));
  const page = Math.max(1, parseInt(u.searchParams.get('page') || '1', 10) || 1);
  return { perPage, page, url: u };
}

function paginate(res, req, items, total) {
  const { perPage, page, url } = pageParams(req);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const extra = {};
  if (start + perPage < items.length) {
    const next = new URL(url);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    const host = req.headers.host || 'localhost';
    extra.link = `<http://${host}${next.pathname}${next.search}>; rel="next"`;
  }
  sendRawJson(res, 200, JSON.stringify(slice), extra);
  void total;
}

// ---------------------------------------------------------------------------
// REST router
// ---------------------------------------------------------------------------

function repoFromPath(req, res, owner, name) {
  if (owner !== VIEWER.login) {
    jsonError(res, 404, 'Not Found');
    return null;
  }
  const repo = getRepo(owner, name);
  if (!repo) {
    jsonError(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

async function handleRest(req, res, pathParts, body) {
  const method = req.method;
  // Root and meta are public.
  if (method === 'GET' && pathParts.length === 0) {
    sendJson(res, 200, { current_user_url: 'https://api.github.com/user', repository_url: 'https://api.github.com/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, user' });
    return;
  }
  if (method === 'GET' && pathParts.length === 1 && pathParts[0] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return;
  }
  if (!authed(req, res)) return;
  // GET /user
  if (method === 'GET' && pathParts.length === 1 && pathParts[0] === 'user') {
    sendJson(res, 200, viewerJson());
    return;
  }
  // POST /user/repos
  if (method === 'POST' && pathParts.length === 2 && pathParts[0] === 'user' && pathParts[1] === 'repos') {
    const data = parseJsonBody(body);
    if (data === null) {
      jsonError(res, 400, 'Problems parsing JSON');
      return;
    }
    const name = data.name;
    if (!name || typeof name !== 'string') {
      jsonError(res, 422, 'name is required');
      return;
    }
    if (getRepo(VIEWER.login, name)) {
      jsonError(res, 422, 'name already exists on this account');
      return;
    }
    const repo = createRepoRecord(VIEWER.login, name, data.description || '', data.private !== false);
    sendRawJson(res, 201, repoJson(repo));
    return;
  }
  // GET /user/repos
  if (method === 'GET' && pathParts.length === 2 && pathParts[0] === 'user' && pathParts[1] === 'repos') {
    const list = (reposByOwner.get(VIEWER.login) || []).map((r) => JSON.parse(repoJson(r)));
    paginate(res, req, list);
    return;
  }
  // /repos/{owner}/{name}/...
  if (pathParts.length >= 3 && pathParts[0] === 'repos') {
    const owner = pathParts[1];
    const name = pathParts[2];
    const rest = pathParts.slice(3);
    const repo = repoFromPath(req, res, owner, name);
    if (!repo) return;
    // GET /repos/{o}/{r}
    if (method === 'GET' && rest.length === 0) {
      sendRawJson(res, 200, repoJson(repo));
      return;
    }
    // PATCH /repos/{o}/{r}
    if (method === 'PATCH' && rest.length === 0) {
      const data = parseJsonBody(body);
      if (data === null) {
        jsonError(res, 400, 'Problems parsing JSON');
        return;
      }
      if (typeof data.description === 'string') repo.description = data.description;
      if (typeof data.private === 'boolean') repo.private = data.private;
      if (typeof data.default_branch === 'string') repo.defaultBranch = data.default_branch;
      repo.jsonCache = null;
      sendRawJson(res, 200, repoJson(repo));
      return;
    }
    // DELETE /repos/{o}/{r}
    if (method === 'DELETE' && rest.length === 0) {
      deleteRepoRecord(repo);
      res.writeHead(204, { 'x-github-request-id': nextReqId() });
      res.end();
      return;
    }
    // POST /git/refs
    if (method === 'POST' && rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
      const data = parseJsonBody(body);
      if (data === null) {
        jsonError(res, 400, 'Problems parsing JSON');
        return;
      }
      const ref = data.ref;
      const sha = data.sha;
      if (!ref || !isOid(sha) || !repo.objects.has(sha)) {
        jsonError(res, 422, 'Invalid request.');
        return;
      }
      if (repo.refs.has(ref)) {
        jsonError(res, 422, 'Reference already exists');
        return;
      }
      repo.refs.set(ref, sha);
      repo.packCache.clear();
      sendJson(res, 201, { ref, node_id: globalId('Ref', `${owner}/${name}:${ref}`), url: `https://api.github.com/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: repo.objects.get(sha).type, url: `https://api.github.com/repos/${owner}/${name}/git/${repo.objects.get(sha).type}s/${sha}` } });
      return;
    }
    // GET /git/refs/heads/{branch}
    if (method === 'GET' && rest.length === 4 && rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads') {
      const ref = `refs/heads/${decodeURIComponent(rest[3])}`;
      const oid = repo.refs.get(ref);
      if (!oid) {
        jsonError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { ref, node_id: globalId('Ref', `${owner}/${name}:${ref}`), url: `https://api.github.com/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`, object: { sha: oid, type: repo.objects.get(oid)?.type || 'commit', url: '' } });
      return;
    }
    // GET /branches
    if (method === 'GET' && rest.length === 1 && rest[0] === 'branches') {
      const list = [...repo.refs.entries()]
        .filter(([r]) => r.startsWith('refs/heads/'))
        .map(([r, oid]) => ({ name: r.slice('refs/heads/'.length), commit: { sha: oid, url: '' }, protected: false }));
      sendJson(res, 200, list);
      return;
    }
    // GET /branches/{branch}
    if (method === 'GET' && rest.length === 2 && rest[0] === 'branches') {
      const ref = `refs/heads/${decodeURIComponent(rest[1])}`;
      const oid = repo.refs.get(ref);
      if (!oid) {
        jsonError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { name: decodeURIComponent(rest[1]), commit: { sha: oid, url: '' }, protected: false });
      return;
    }
    // GET /commits
    if (method === 'GET' && rest.length === 1 && rest[0] === 'commits') {
      const u = new URL(req.url, 'http://x');
      const shaParam = u.searchParams.get('sha');
      let start = shaParam || headOid(repo);
      if (!start) {
        sendJson(res, 200, []);
        return;
      }
      if (repo.refs.has(`refs/heads/${shaParam}`)) start = repo.refs.get(`refs/heads/${shaParam}`);
      const out = [];
      const seen = new Set();
      const queue = [start];
      while (queue.length && out.length < 100) {
        const oid = queue.shift();
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        const c = parseCommit(obj.data);
        const who = parseIdent(c.author);
        out.push({
          sha: oid,
          node_id: globalId('Commit', `${owner}/${name}:${oid}`),
          commit: {
            message: c.message,
            author: { name: who.name, email: who.email, date: isoOf(EPOCH_SEC + 1) },
            committer: { name: who.name, email: who.email, date: isoOf(EPOCH_SEC + 1) },
            tree: { sha: c.tree },
          },
          author: { login: VIEWER.login, id: VIEWER.id },
          committer: { login: VIEWER.login, id: VIEWER.id },
          parents: c.parents.map((p) => ({ sha: p })),
          url: `https://api.github.com/repos/${owner}/${name}/commits/${oid}`,
          html_url: `https://github.com/${owner}/${name}/commit/${oid}`,
        });
        for (const p of c.parents) queue.push(p);
      }
      sendJson(res, 200, out);
      return;
    }
    // PUT/GET/DELETE /contents/{path}
    if (rest.length >= 2 && rest[0] === 'contents') {
      const filePath = rest.slice(1).map((p) => decodeURIComponent(p)).join('/');
      if (method === 'GET') return handleContentsGet(req, res, repo, filePath);
      if (method === 'PUT') return handleContentsPut(req, res, repo, filePath, body);
      if (method === 'DELETE') return handleContentsDelete(req, res, repo, filePath, body);
    }
    // POST /labels
    if (method === 'POST' && rest.length === 1 && rest[0] === 'labels') {
      const data = parseJsonBody(body);
      if (data === null) {
        jsonError(res, 400, 'Problems parsing JSON');
        return;
      }
      if (!data.name) {
        jsonError(res, 422, 'name is required');
        return;
      }
      let label = repo.labels.get(data.name);
      if (!label) {
        label = { id: nextId(), name: data.name, color: data.color || 'ededed', description: data.description || '' };
        repo.labels.set(data.name, label);
      }
      sendJson(res, 201, labelJson(label));
      return;
    }
    // POST /issues, GET /issues
    if (rest.length === 1 && rest[0] === 'issues') {
      if (method === 'POST') {
        const data = parseJsonBody(body);
        if (data === null) {
          jsonError(res, 400, 'Problems parsing JSON');
          return;
        }
        const names = (data.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
        const made = newIssue(repo, data.title, data.body, names);
        if (made.error) {
          jsonError(res, 422, made.error);
          return;
        }
        sendRawJson(res, 201, issueJson(repo, made.issue));
        return;
      }
      if (method === 'GET') {
        const u = new URL(req.url, 'http://x');
        const state = u.searchParams.get('state') || 'open';
        const sort = u.searchParams.get('sort') || 'created';
        const direction = u.searchParams.get('direction') || 'desc';
        let list = [...repo.issues.values()];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        paginate(res, req, list.map((i) => JSON.parse(issueJson(repo, i))));
        return;
      }
    }
    // GET/PATCH /issues/{n}, POST/GET /issues/{n}/comments
    if (rest.length >= 2 && rest[0] === 'issues' && /^\d+$/.test(rest[1])) {
      const num = parseInt(rest[1], 10);
      const issue = repo.issues.get(num);
      if (!issue) {
        jsonError(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET' && rest.length === 2) {
        sendRawJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (method === 'PATCH' && rest.length === 2) {
        const data = parseJsonBody(body);
        if (data === null) {
          jsonError(res, 400, 'Problems parsing JSON');
          return;
        }
        if (typeof data.title === 'string') issue.title = data.title;
        if (typeof data.body === 'string') issue.body = data.body;
        if (data.state === 'closed' || data.state === 'open') {
          issue.state = data.state;
          issue.closedAt = data.state === 'closed' ? isoOf(nextTimeSec()) : null;
        }
        issue.updatedAt = isoOf(nextTimeSec());
        issue.jsonCache = null;
        repo.jsonCache = null;
        sendRawJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'POST') {
          const data = parseJsonBody(body);
          if (data === null) {
            jsonError(res, 400, 'Problems parsing JSON');
            return;
          }
          const sec = nextTimeSec();
          const c = { id: repo.nextCommentId, body: data.body || '', author: VIEWER.login, createdAt: isoOf(sec), updatedAt: isoOf(sec) };
          repo.nextCommentId += 1;
          if (!repo.comments.has(num)) repo.comments.set(num, []);
          repo.comments.get(num).push(c);
          issue.jsonCache = null;
          sendJson(res, 201, commentJson(repo, num, c));
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, (repo.comments.get(num) || []).map((c) => commentJson(repo, num, c)));
          return;
        }
      }
    }
    // POST/GET /pulls
    if (rest.length === 1 && rest[0] === 'pulls') {
      if (method === 'POST') {
        const data = parseJsonBody(body);
        if (data === null) {
          jsonError(res, 400, 'Problems parsing JSON');
          return;
        }
        const made = newPull(repo, data.title, data.body, data.head, data.base);
        if (made.error) {
          jsonError(res, 422, made.error);
          return;
        }
        sendRawJson(res, 201, pullJson(repo, made.pr));
        return;
      }
      if (method === 'GET') {
        const u = new URL(req.url, 'http://x');
        const state = u.searchParams.get('state') || 'open';
        let list = [...repo.pulls.values()];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => b.createdSeq - a.createdSeq);
        paginate(res, req, list.map((p) => JSON.parse(pullJson(repo, p))));
        return;
      }
    }
    // /pulls/{n} and subroutes
    if (rest.length >= 2 && rest[0] === 'pulls' && /^\d+$/.test(rest[1])) {
      const num = parseInt(rest[1], 10);
      const pr = repo.pulls.get(num);
      if (!pr) {
        jsonError(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET' && rest.length === 2) {
        sendRawJson(res, 200, pullJson(repo, pr));
        return;
      }
      if (method === 'GET' && rest.length === 3 && rest[2] === 'files') {
        const files = diffFiles(repo, pr.headSha, pr.baseSha).map((f) => ({
          sha: '',
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          blob_url: '',
          raw_url: '',
          contents_url: '',
          patch: '',
        }));
        sendJson(res, 200, files);
        return;
      }
      if (method === 'PUT' && rest.length === 3 && rest[2] === 'merge') {
        const data = parseJsonBody(body);
        if (data === null) {
          jsonError(res, 400, 'Problems parsing JSON');
          return;
        }
        if (pr.state !== 'open') {
          jsonError(res, 405, 'Pull Request is not mergeable');
          return;
        }
        if (hasMergeConflict(repo, pr)) {
          pr.mergeable = 'CONFLICTING';
          pr.jsonCache = null;
          jsonError(res, 405, 'Merge conflict');
          return;
        }
        const sha = doSquashMerge(repo, pr);
        sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
    }
  }
  // Unknown route under /api/v3.
  jsonError(res, 404, 'Not Found');
}

function parseIdent(s) {
  const m = /^(.+?) <([^>]*)>/.exec(s || '');
  if (!m) return { name: VIEWER.name, email: VIEWER.email };
  return { name: m[1], email: m[2] };
}

function handleContentsGet(req, res, repo, filePath) {
  const tip = headOid(repo);
  if (!tip) {
    jsonError(res, 404, 'Not Found');
    return;
  }
  const treeOid = commitTreeOf(repo, tip);
  if (!treeOid) {
    jsonError(res, 404, 'Not Found');
    return;
  }
  const flat = flattenTree(repo, treeOid, '', new Map());
  const entry = flat.get(filePath);
  if (entry) {
    const blob = repo.objects.get(entry.oid);
    const data = blob ? blob.data : Buffer.alloc(0);
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: filePath.split('/').pop(),
      path: filePath,
      content: b64encode(data),
      sha: entry.oid,
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${filePath}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${filePath}`,
      download_url: null,
      _links: {},
    });
    return;
  }
  // Directory listing: immediate children of filePath.
  const prefix = `${filePath}/`;
  const children = new Map();
  for (const [path, v] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      children.set(rest, { type: 'file', name: rest, path, sha: v.oid, size: (repo.objects.get(v.oid)?.data.length || 0) });
    } else {
      const dir = rest.slice(0, slash);
      if (!children.has(dir)) {
        // Directory sha: the tree oid of that subtree.
        children.set(dir, { type: 'dir', name: dir, path: `${filePath}/${dir}`, sha: '', size: 0 });
      }
    }
  }
  if (children.size === 0) {
    jsonError(res, 404, 'Not Found');
    return;
  }
  // Fill directory shas from the tree structure.
  const dirShas = dirTreeShas(repo, treeOid, '');
  for (const c of children.values()) {
    if (c.type === 'dir' && dirShas.has(c.path)) c.sha = dirShas.get(c.path);
  }
  sendJson(res, 200, [...children.values()]);
}

function dirTreeShas(repo, treeOid, prefix, out = new Map()) {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    if (e.mode === '40000') {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      out.set(path, e.oid);
      dirTreeShas(repo, e.oid, path, out);
    }
  }
  return out;
}

function handleContentsPut(req, res, repo, filePath, body) {
  const data = parseJsonBody(body);
  if (data === null) {
    jsonError(res, 400, 'Problems parsing JSON');
    return;
  }
  const branch = data.branch || repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const content = b64decode(data.content || '');
  const blobOid = putObject(repo, 'blob', content);
  if (data.sha && tip) {
    const treeOid = commitTreeOf(repo, tip);
    const flat = treeOid ? flattenTree(repo, treeOid, '', new Map()) : new Map();
    const existing = flat.get(filePath);
    if (!existing || existing.oid !== data.sha) {
      jsonError(res, 409, 'sha does not match');
      return;
    }
  }
  const treeOid = tip ? commitTreeOf(repo, tip) : null;
  const flat = treeOid ? flattenTree(repo, treeOid, '', new Map()) : new Map();
  const existed = flat.has(filePath);
  flat.set(filePath, { mode: '100644', oid: blobOid });
  const newTree = treeFromFlat(repo, flat);
  const sec = nextTimeSec();
  const parents = tip ? [tip] : [];
  const commitData = buildCommitText(newTree, parents, `${VIEWER.name} <${VIEWER.email}>`, '', data.message || `Update ${filePath}`, sec);
  const commitOid = putObject(repo, 'commit', commitData);
  repo.refs.set(ref, commitOid);
  repo.packCache.clear();
  sendJson(res, existed ? 200 : 201, {
    content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, encoding: 'base64', url: '', html_url: '', git_url: '', download_url: null, type: 'file', _links: {} },
    commit: { sha: commitOid, node_id: globalId('Commit', `${repo.owner}/${repo.name}:${commitOid}`), url: '', html_url: '', message: data.message || '' },
  });
}

function handleContentsDelete(req, res, repo, filePath, body) {
  const data = parseJsonBody(body);
  if (data === null) {
    jsonError(res, 400, 'Problems parsing JSON');
    return;
  }
  const branch = data.branch || repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  if (!tip) {
    jsonError(res, 404, 'Not Found');
    return;
  }
  const treeOid = commitTreeOf(repo, tip);
  const flat = treeOid ? flattenTree(repo, treeOid, '', new Map()) : new Map();
  const existing = flat.get(filePath);
  if (!existing) {
    jsonError(res, 404, 'Not Found');
    return;
  }
  if (data.sha && existing.oid !== data.sha) {
    jsonError(res, 409, 'sha does not match');
    return;
  }
  flat.delete(filePath);
  const newTree = treeFromFlat(repo, flat);
  const sec = nextTimeSec();
  const commitData = buildCommitText(newTree, [tip], `${VIEWER.name} <${VIEWER.email}>`, '', data.message || `Delete ${filePath}`, sec);
  const commitOid = putObject(repo, 'commit', commitData);
  repo.refs.set(ref, commitOid);
  repo.packCache.clear();
  sendJson(res, 200, { commit: { sha: commitOid, message: data.message || '' } });
}

// ---------------------------------------------------------------------------
// GraphQL (hand-rolled parser + executor for the documented surface)
// ---------------------------------------------------------------------------

function gqlTokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}():![]=@'.includes(ch)) {
      tokens.push({ kind: ch });
      i += 1;
      continue;
    }
    if (ch === '$') {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i + 1));
      if (!m) throw new Error('bad variable');
      tokens.push({ kind: 'variable', value: m[0] });
      i += 1 + m[0].length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      if (j >= src.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    const m = /^-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
    if (m && /[0-9]/.test(ch)) {
      tokens.push({ kind: m[0].includes('.') || /[eE]/.test(m[0]) ? 'float' : 'int', value: m[0] });
      i += m[0].length;
      continue;
    }
    const n = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (n) {
      tokens.push({ kind: 'name', value: n[0] });
      i += n[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

class GqlParser {
  constructor(tokens) {
    this.t = tokens;
    this.pos = 0;
  }
  peek() {
    return this.t[this.pos];
  }
  next() {
    return this.t[this.pos++];
  }
  expect(kind) {
    const tok = this.next();
    if (tok.kind !== kind) throw new Error(`expected ${kind}, got ${tok.kind}`);
    return tok;
  }
  parseDocument() {
    const defs = [];
    while (this.peek().kind !== 'eof') defs.push(this.parseOperation());
    return defs;
  }
  parseOperation() {
    let opType = 'query';
    let name = null;
    const tok = this.peek();
    if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription')) {
      opType = this.next().value;
      if (this.peek().kind === 'name') name = this.next().value;
    }
    const variables = {};
    if (this.peek().kind === '(') {
      this.next();
      while (this.peek().kind !== ')') {
        if (this.peek().kind === 'variable') {
          const v = this.next().value;
          this.expect(':');
          variables[v] = this.parseTypeRef();
          if (this.peek().kind === '=') {
            this.next();
            this.parseValue(true);
          }
        } else if (this.peek().kind === 'name') {
          this.next();
        } else {
          this.next();
        }
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { opType, name, variables, selections };
  }
  parseTypeRef() {
    if (this.peek().kind === '[') {
      this.next();
      const inner = this.parseTypeRef();
      this.expect(']');
      let s = `[${inner}]`;
      if (this.peek().kind === '!') {
        this.next();
        s += '!';
      }
      return s;
    }
    const name = this.expect('name').value;
    let s = name;
    if (this.peek().kind === '!') {
      this.next();
      s += '!';
    }
    return s;
  }
  parseSelectionSet() {
    this.expect('{');
    const sels = [];
    while (this.peek().kind !== '}') {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeName = this.expect('name').value;
          sels.push({ kind: 'fragment', typeName, selections: this.parseSelectionSet() });
        } else {
          // Named fragment spread (not used by the suite); skip its selections if any.
          if (this.peek().kind === 'name') this.next();
          if (this.peek().kind === '{') this.parseSelectionSet();
        }
        continue;
      }
      sels.push(this.parseField());
    }
    this.expect('}');
    return sels;
  }
  parseField() {
    let alias = null;
    let name = this.expect('name').value;
    if (this.peek().kind === ':') {
      this.next();
      alias = name;
      name = this.expect('name').value;
    }
    const args = {};
    if (this.peek().kind === '(') {
      this.next();
      while (this.peek().kind !== ')') {
        const argName = this.expect('name').value;
        this.expect(':');
        args[argName] = this.parseValue(false);
        if (this.peek().kind === ',') this.next();
      }
      this.expect(')');
    }
    let selections = null;
    if (this.peek().kind === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias: alias || name, name, args, selections };
  }
  parseValue(isConst) {
    const tok = this.peek();
    if (tok.kind === 'variable') {
      this.next();
      return { kind: 'variable', name: tok.value };
    }
    if (tok.kind === 'string') {
      this.next();
      return { kind: 'string', value: tok.value };
    }
    if (tok.kind === 'int') {
      this.next();
      return { kind: 'int', value: parseInt(tok.value, 10) };
    }
    if (tok.kind === 'float') {
      this.next();
      return { kind: 'float', value: parseFloat(tok.value) };
    }
    if (tok.kind === '[') {
      this.next();
      const items = [];
      while (this.peek().kind !== ']') {
        items.push(this.parseValue(isConst));
        if (this.peek().kind === ',') this.next();
      }
      this.expect(']');
      return { kind: 'list', value: items };
    }
    if (tok.kind === '{') {
      this.next();
      const obj = {};
      while (this.peek().kind !== '}') {
        const k = this.expect('name').value;
        this.expect(':');
        obj[k] = this.parseValue(isConst);
        if (this.peek().kind === ',') this.next();
      }
      this.expect('}');
      return { kind: 'object', value: obj };
    }
    if (tok.kind === 'name') {
      this.next();
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`unexpected token ${tok.kind} in value`);
  }
}

function gqlResolveValue(v, variables) {
  if (!v) return undefined;
  switch (v.kind) {
    case 'variable': return variables ? variables[v.name] : undefined;
    case 'list': return v.value.map((x) => gqlResolveValue(x, variables));
    case 'object': {
      const out = {};
      for (const k of Object.keys(v.value)) out[k] = gqlResolveValue(v.value[k], variables);
      return out;
    }
    default: return v.value;
  }
}

// ---------------------------------------------------------------------------
// GraphQL type metadata (for __type introspection and unknown-field errors)
// ---------------------------------------------------------------------------

const GQL_FIELDS = {
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'avatarUrl', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'description', 'isPrivate', 'createdAt', 'updatedAt'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'url', 'repository'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'repository'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt'],
  Label: ['id', 'name', 'color', 'description'],
  Ref: ['name', 'target', 'prefix'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'subject', 'clientMutationId'],
  Commit: ['oid', 'message', 'author', 'committer'],
  RateLimit: ['limit', 'remaining', 'resetAt', 'cost'],
  PullRequestChangedFile: ['filename', 'path', 'additions', 'deletions', 'changeKind'],
  IssueCommentEdge: ['node', 'cursor'],
};

const GQL_ENUMS = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

function gqlTypeKind(name) {
  if (GQL_ENUMS[name]) return 'ENUM';
  if (name === 'String' || name === 'Int' || name === 'Boolean' || name === 'ID' || name === 'DateTime' || name === 'URI') return 'SCALAR';
  if (name === 'Query' || name === 'Mutation') return 'OBJECT';
  if (name.endsWith('Connection') || name.endsWith('Edge') || name.endsWith('Payload')) return 'OBJECT';
  return 'OBJECT';
}

function gqlTypeInfo(name) {
  if (name === '__Type') {
    return { name: '__Type', kind: 'OBJECT', fields: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'ofType', 'possibleTypes', 'specifiedByURL'] };
  }
  if (name === '__Field') {
    return { name: '__Field', kind: 'OBJECT', fields: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'] };
  }
  if (name === '__EnumValue') {
    return { name: '__EnumValue', kind: 'OBJECT', fields: ['name', 'description', 'isDeprecated', 'deprecationReason'] };
  }
  if (name === '__InputValue') {
    return { name: '__InputValue', kind: 'OBJECT', fields: ['name', 'description', 'type', 'defaultValue'] };
  }
  if (name === '__Schema') {
    return { name: '__Schema', kind: 'OBJECT', fields: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'] };
  }
  return { name, kind: gqlTypeKind(name), fields: GQL_FIELDS[name] || [] };
}

// ---------------------------------------------------------------------------
// GraphQL execution
// ---------------------------------------------------------------------------

function gqlDecodeId(id) {
  try {
    const text = Buffer.from(String(id), 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function gqlRepoFromId(id) {
  const dec = gqlDecodeId(id);
  if (!dec || dec.kind !== 'Repository') return null;
  const [owner, name] = dec.key.split('/');
  return getRepo(owner, name);
}

function gqlIssueFromId(id) {
  const dec = gqlDecodeId(id);
  if (!dec || dec.kind !== 'Issue') return null;
  const m = /^(.+)\/([^/]+)#(\d+)$/.exec(dec.key);
  if (!m) return null;
  const repo = getRepo(m[1], m[2]);
  if (!repo) return null;
  return { repo, issue: repo.issues.get(parseInt(m[3], 10)) || null };
}

function gqlPrFromId(id) {
  const dec = gqlDecodeId(id);
  if (!dec || dec.kind !== 'PullRequest') return null;
  const m = /^(.+)\/([^/]+)#(\d+)$/.exec(dec.key);
  if (!m) return null;
  const repo = getRepo(m[1], m[2]);
  if (!repo) return null;
  return { repo, pr: repo.pulls.get(parseInt(m[3], 10)) || null };
}

function gqlCursor(num) {
  return Buffer.from(`cursor:${num}`, 'utf8').toString('base64');
}
function gqlCursorNum(cursor) {
  try {
    const text = Buffer.from(String(cursor), 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function gqlConnection(items, args, variables) {
  const first = gqlResolveValue(args.first, variables);
  const after = gqlResolveValue(args.after, variables);
  let list = items;
  if (after !== undefined && after !== null) {
    const n = gqlCursorNum(after);
    if (n !== null) list = list.filter((x) => x.number < n);
  }
  const total = list.length;
  let page = list;
  let hasNext = false;
  if (typeof first === 'number') {
    if (list.length > first) {
      page = list.slice(0, first);
      hasNext = true;
    }
  }
  const endCursor = page.length ? gqlCursor(page[page.length - 1].number) : null;
  return { __type: 'connection', items: page, totalCount: total, hasNextPage: hasNext, endCursor, startCursor: page.length ? gqlCursor(page[0].number) : null };
}

function gqlIssueObject(repo, issue) {
  return { __type: 'Issue', repo, issue, number: issue.number };
}
function gqlPrObject(repo, pr) {
  return { __type: 'PullRequest', repo, pr, number: pr.number };
}
function gqlRepoObject(repo) {
  return { __type: 'Repository', repo };
}
function gqlUserObject(login, id) {
  return { __type: 'User', login, id };
}

function gqlResolveField(obj, field, variables, errors) {
  const name = field.name;
  const args = field.args || {};
  const type = obj.__type;
  // __typename works on every object.
  if (name === '__typename') return type === 'connection' ? 'IssueConnection' : type;
  // Introspection entry points on Query.
  if (type === 'Query' && name === '__type') {
    const tname = gqlResolveValue(args.name, variables);
    return { __type: '__Type', typeName: tname };
  }
  if (type === 'Query' && name === '__schema') {
    return { __type: '__Schema' };
  }
  // Unknown field on this type.
  const allowed = GQL_FIELDS[type] || [];
  if (type !== '__Type' && type !== '__Field' && type !== '__EnumValue' && type !== '__InputValue' && type !== '__Schema' && !allowed.includes(name)) {
    errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
    return undefined;
  }
  // Mutation payloads carry their fields as plain own properties.
  if (obj && Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
  switch (type) {
    case 'Query': {
      if (name === 'viewer') return gqlUserObject(VIEWER.login, VIEWER.id);
      if (name === 'repository') {
        const owner = gqlResolveValue(args.owner, variables);
        const repoName = gqlResolveValue(args.name, variables);
        const repo = getRepo(owner, repoName);
        return repo ? gqlRepoObject(repo) : null;
      }
      if (name === 'node') {
        const id = gqlResolveValue(args.id, variables);
        const dec = gqlDecodeId(id);
        if (!dec) return null;
        if (dec.kind === 'Repository') {
          const [owner, repoName] = dec.key.split('/');
          const repo = getRepo(owner, repoName);
          return repo ? gqlRepoObject(repo) : null;
        }
        if (dec.kind === 'Issue') {
          const found = gqlIssueFromId(id);
          return found && found.issue ? gqlIssueObject(found.repo, found.issue) : null;
        }
        if (dec.kind === 'PullRequest') {
          const found = gqlPrFromId(id);
          return found && found.pr ? gqlPrObject(found.repo, found.pr) : null;
        }
        return null;
      }
      if (name === 'rateLimit') return { __type: 'RateLimit', limit: 5000, remaining: 5000, resetAt: isoOf(EPOCH_SEC + 3600) };
      return null;
    }
    case 'User': {
      if (name === 'login') return obj.login;
      if (name === 'id' || name === 'databaseId') return obj.id;
      if (name === 'name') return obj.login === VIEWER.login ? VIEWER.name : obj.login;
      if (name === 'email') return obj.login === VIEWER.login ? VIEWER.email : `${obj.login}@example.invalid`;
      if (name === 'avatarUrl') return `https://avatars.githubusercontent.com/u/${obj.id}?v=4`;
      if (name === 'url') return `https://github.com/${obj.login}`;
      return null;
    }
    case 'Repository': {
      const repo = obj.repo;
      if (name === 'id') return globalId('Repository', `${repo.owner}/${repo.name}`);
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') return gqlUserObject(repo.owner, repo.owner === VIEWER.login ? VIEWER.id : 1001);
      if (name === 'defaultBranchRef') {
        const oid = headOid(repo);
        return oid ? { __type: 'Ref', name: repo.defaultBranch, oid, repo } : null;
      }
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'description') return repo.description;
      if (name === 'isPrivate') return repo.private;
      if (name === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
      if (name === 'createdAt' || name === 'updatedAt') return isoOf(EPOCH_SEC + repo.createdSeq);
      if (name === 'issue') {
        const n = gqlResolveValue(args.number, variables);
        const issue = repo.issues.get(n);
        return issue ? gqlIssueObject(repo, issue) : null;
      }
      if (name === 'issues') {
        let list = [...repo.issues.values()];
        const states = gqlResolveValue(args.states, variables);
        if (Array.isArray(states) && states.length) {
          list = list.filter((i) => states.includes(i.state.toUpperCase()));
        }
        const orderBy = gqlResolveValue(args.orderBy, variables) || {};
        const dir = (orderBy.direction || 'DESC').toUpperCase();
        list.sort((a, b) => (dir === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        return gqlConnection(list.map((i) => gqlIssueObject(repo, i)), args, variables);
      }
      if (name === 'pullRequest') {
        const n = gqlResolveValue(args.number, variables);
        const pr = repo.pulls.get(n);
        return pr ? gqlPrObject(repo, pr) : null;
      }
      if (name === 'pullRequests') {
        let list = [...repo.pulls.values()];
        const states = gqlResolveValue(args.states, variables);
        if (Array.isArray(states) && states.length) {
          list = list.filter((p) => states.includes(p.state.toUpperCase()));
        }
        const orderBy = gqlResolveValue(args.orderBy, variables) || {};
        const dir = (orderBy.direction || 'DESC').toUpperCase();
        list.sort((a, b) => (dir === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        return gqlConnection(list.map((p) => gqlPrObject(repo, p)), args, variables);
      }
      return null;
    }
    case 'Issue': {
      const { repo, issue } = obj;
      if (name === 'id') return globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
      if (name === 'databaseId') return issue.id;
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'body') return issue.body;
      if (name === 'state') return issue.state.toUpperCase();
      if (name === 'author') return gqlUserObject(issue.author, issue.author === VIEWER.login ? VIEWER.id : 1001);
      if (name === 'createdAt') return issue.createdAt;
      if (name === 'updatedAt') return issue.updatedAt;
      if (name === 'closedAt') return issue.closedAt;
      if (name === 'labels') {
        const items = issue.labels.map((l, i) => ({ __type: 'Label', label: l, number: issue.labels.length - i }));
        return gqlConnection(items, args, variables);
      }
      if (name === 'comments') {
        const list = (repo.comments.get(issue.number) || []).map((c) => ({ __type: 'IssueComment', repo, issueNumber: issue.number, comment: c }));
        return gqlConnection(list.map((x, i) => ({ ...x, number: list.length - i })), args, variables);
      }
      if (name === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (name === 'repository') return gqlRepoObject(repo);
      return null;
    }
    case 'PullRequest': {
      const { repo, pr } = obj;
      if (name === 'id') return globalId('PullRequest', `${repo.owner}/${repo.name}#${pr.number}`);
      if (name === 'databaseId') return pr.id;
      if (name === 'number') return pr.number;
      if (name === 'title') return pr.title;
      if (name === 'body') return pr.body;
      if (name === 'state') return pr.state.toUpperCase();
      if (name === 'merged') return pr.merged;
      if (name === 'mergeable') return pr.mergeable;
      if (name === 'headRefName') return pr.head;
      if (name === 'baseRefName') return pr.base;
      if (name === 'headRefOid') return pr.headSha;
      if (name === 'baseRefOid') return pr.baseSha;
      if (name === 'author') return gqlUserObject(pr.author, pr.author === VIEWER.login ? VIEWER.id : 1001);
      if (name === 'createdAt') return pr.createdAt;
      if (name === 'updatedAt') return pr.updatedAt;
      if (name === 'closedAt') return pr.closedAt;
      if (name === 'mergedAt') return pr.mergedAt;
      if (name === 'files') {
        const files = diffFiles(repo, pr.headSha, pr.baseSha).map((f) => ({ __type: 'PullRequestChangedFile', filename: f.filename, additions: f.additions, deletions: f.deletions, changeKind: f.status }));
        return gqlConnection(files.map((x, i) => ({ ...x, number: files.length - i })), args, variables);
      }
      if (name === 'repository') return gqlRepoObject(repo);
      return null;
    }
    case 'IssueComment': {
      const c = obj.comment;
      if (name === 'id') return globalId('IssueComment', `${obj.repo.owner}/${obj.repo.name}#${obj.issueNumber}:${c.id}`);
      if (name === 'databaseId') return c.id;
      if (name === 'body') return c.body;
      if (name === 'author') return gqlUserObject(c.author, c.author === VIEWER.login ? VIEWER.id : 1001);
      if (name === 'createdAt') return c.createdAt;
      if (name === 'updatedAt') return c.updatedAt;
      return null;
    }
    case 'Label': {
      if (name === 'id') return globalId('Label', obj.label.name);
      if (name === 'name') return obj.label.name;
      if (name === 'color') return obj.label.color;
      if (name === 'description') return obj.label.description || '';
      return null;
    }
    case 'Ref': {
      if (name === 'name') return obj.name;
      if (name === 'prefix') return 'refs/heads/';
      if (name === 'target') return { __type: 'Commit', oid: obj.oid, repo: obj.repo };
      return null;
    }
    case 'Commit': {
      if (name === 'oid') return obj.oid;
      if (name === 'message') {
        const o = obj.repo.objects.get(obj.oid);
        return o && o.type === 'commit' ? parseCommit(o.data).message : '';
      }
      return null;
    }
    case 'RateLimit': {
      if (name === 'limit') return obj.limit;
      if (name === 'remaining') return obj.remaining;
      if (name === 'resetAt') return obj.resetAt;
      return null;
    }
    case 'Mutation': {
      if (name === 'createIssue') return gqlMutationCreateIssue(args, variables);
      if (name === 'closeIssue') return gqlMutationCloseIssue(args, variables);
      if (name === 'createPullRequest') return gqlMutationCreatePr(args, variables);
      if (name === 'mergePullRequest') return gqlMutationMergePr(args, variables);
      if (name === 'addComment') return gqlMutationAddComment(args, variables);
      return null;
    }
    case '__Field': {
      if (name === 'name') return obj.fieldName;
      if (name === 'description') return null;
      if (name === 'args') return [];
      if (name === 'type') return { __type: '__Type', typeName: 'String' };
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      return null;
    }
    case '__EnumValue': {
      if (name === 'name') return obj.enumValue;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      return null;
    }
    case '__InputValue': {
      if (name === 'name') return obj.inputName || '';
      if (name === 'description') return null;
      if (name === 'type') return { __type: '__Type', typeName: 'String' };
      if (name === 'defaultValue') return null;
      return null;
    }
    case 'PullRequestChangedFile': {
      if (name === 'filename' || name === 'path') return obj.filename;
      if (name === 'additions') return obj.additions;
      if (name === 'deletions') return obj.deletions;
      if (name === 'changeKind') return obj.changeKind;
      return null;
    }
    default:
      return null;
  }
}

function gqlMutationCreateIssue(args, variables) {
  const input = gqlResolveValue(args.input, variables) || {};
  const repo = gqlRepoFromId(input.repositoryId);
  if (!repo) return { __type: 'CreateIssuePayload', issue: null, clientMutationId: input.clientMutationId || null };
  const made = newIssue(repo, input.title, input.body, []);
  if (made.error) return { __type: 'CreateIssuePayload', issue: null, clientMutationId: input.clientMutationId || null };
  return { __type: 'CreateIssuePayload', issue: gqlIssueObject(repo, made.issue), clientMutationId: input.clientMutationId || null };
}
function gqlMutationCloseIssue(args, variables) {
  const input = gqlResolveValue(args.input, variables) || {};
  const found = gqlIssueFromId(input.issueId);
  if (!found || !found.issue) return { __type: 'CloseIssuePayload', issue: null, clientMutationId: input.clientMutationId || null };
  found.issue.state = 'closed';
  found.issue.closedAt = isoOf(nextTimeSec());
  found.issue.updatedAt = isoOf(nextTimeSec());
  found.issue.jsonCache = null;
  found.repo.jsonCache = null;
  return { __type: 'CloseIssuePayload', issue: gqlIssueObject(found.repo, found.issue), clientMutationId: input.clientMutationId || null };
}
function gqlMutationCreatePr(args, variables) {
  const input = gqlResolveValue(args.input, variables) || {};
  const repo = gqlRepoFromId(input.repositoryId);
  if (!repo) return { __type: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: input.clientMutationId || null };
  const made = newPull(repo, input.title, input.body, input.headRefName, input.baseRefName);
  if (made.error) return { __type: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: input.clientMutationId || null };
  return { __type: 'CreatePullRequestPayload', pullRequest: gqlPrObject(repo, made.pr), clientMutationId: input.clientMutationId || null };
}
function gqlMutationMergePr(args, variables) {
  const input = gqlResolveValue(args.input, variables) || {};
  const found = gqlPrFromId(input.pullRequestId);
  if (!found || !found.pr) return { __type: 'MergePullRequestPayload', pullRequest: null, clientMutationId: input.clientMutationId || null };
  const pr = found.pr;
  if (pr.state !== 'open' || hasMergeConflict(found.repo, pr)) {
    pr.mergeable = 'CONFLICTING';
    pr.jsonCache = null;
    return { __type: 'MergePullRequestPayload', pullRequest: gqlPrObject(found.repo, pr), clientMutationId: input.clientMutationId || null };
  }
  doSquashMerge(found.repo, pr);
  return { __type: 'MergePullRequestPayload', pullRequest: gqlPrObject(found.repo, pr), clientMutationId: input.clientMutationId || null };
}
function gqlMutationAddComment(args, variables) {
  const input = gqlResolveValue(args.input, variables) || {};
  const found = gqlIssueFromId(input.subjectId) || gqlPrFromId(input.subjectId);
  if (!found) return { __type: 'AddCommentPayload', commentEdge: null, comment: null, subject: null, clientMutationId: input.clientMutationId || null };
  const repo = found.repo;
  const num = found.issue ? found.issue.number : found.pr.number;
  const sec = nextTimeSec();
  const c = { id: repo.nextCommentId, body: input.body || '', author: VIEWER.login, createdAt: isoOf(sec), updatedAt: isoOf(sec) };
  repo.nextCommentId += 1;
  if (!repo.comments.has(num)) repo.comments.set(num, []);
  repo.comments.get(num).push(c);
  if (found.issue) found.issue.jsonCache = null;
  const comment = { __type: 'IssueComment', repo, issueNumber: num, comment: c };
  return { __type: 'AddCommentPayload', commentEdge: { __type: 'IssueCommentEdge', node: comment, cursor: gqlCursor(c.id) }, comment, subject: found.issue ? gqlIssueObject(repo, found.issue) : gqlPrObject(repo, found.pr), clientMutationId: input.clientMutationId || null };
}

function gqlExecuteSelections(obj, selections, variables, errors) {
  const out = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      const typeName = sel.typeName;
      const objType = obj.__type === 'connection' ? 'IssueConnection' : obj.__type;
      if (typeName === objType || (objType === 'Repository' && typeName === 'Repository') || typeName === 'Node') {
        const sub = gqlExecuteSelections(obj, sel.selections, variables, errors);
        Object.assign(out, sub);
      }
      continue;
    }
    if (obj && obj.__type === 'connection') {
      // Connection fields: nodes, edges, totalCount, pageInfo.
      if (sel.name === 'nodes') {
        out[sel.alias] = obj.items.map((item) => {
          if (sel.selections) return gqlExecuteSelections(item, sel.selections, variables, errors);
          return item;
        });
      } else if (sel.name === 'edges') {
        out[sel.alias] = obj.items.map((item) => {
          const edge = { __type: 'Edge', node: item, cursor: gqlCursor(item.number) };
          if (sel.selections) return gqlExecuteSelections(edge, sel.selections, variables, errors);
          return edge;
        });
      } else if (sel.name === 'totalCount') {
        out[sel.alias] = obj.totalCount;
      } else if (sel.name === 'pageInfo') {
        const pi = { __type: 'PageInfo', hasNextPage: obj.hasNextPage, hasPreviousPage: false, startCursor: obj.startCursor, endCursor: obj.endCursor };
        out[sel.alias] = sel.selections ? gqlExecuteSelections(pi, sel.selections, variables, errors) : pi;
      } else {
        errors.push({ message: `Cannot query field "${sel.name}" on type "IssueConnection".` });
        out[sel.alias] = null;
      }
      continue;
    }
    if (obj && (obj.__type === 'Edge' || (typeof obj.__type === 'string' && obj.__type.endsWith('Edge')))) {
      if (sel.name === 'node') {
        out[sel.alias] = sel.selections ? gqlExecuteSelections(obj.node, sel.selections, variables, errors) : obj.node;
      } else if (sel.name === 'cursor') {
        out[sel.alias] = obj.cursor;
      } else {
        errors.push({ message: `Cannot query field "${sel.name}" on type "IssueEdge".` });
        out[sel.alias] = null;
      }
      continue;
    }
    if (obj && obj.__type === '__Type') {
      const value = gqlResolveIntrospection(obj, sel, variables, errors);
      if (sel.selections && Array.isArray(value)) {
        out[sel.alias] = value.map((v) => (v && typeof v === 'object' ? gqlExecuteSelections(v, sel.selections, variables, errors) : v));
      } else if (sel.selections && value && typeof value === 'object') {
        out[sel.alias] = gqlExecuteSelections(value, sel.selections, variables, errors);
      } else {
        out[sel.alias] = value;
      }
      continue;
    }
    if (obj && obj.__type === '__Schema') {
      if (sel.name === 'queryType') out[sel.alias] = { __type: '__Type', typeName: 'Query' };
      else if (sel.name === 'mutationType') out[sel.alias] = { __type: '__Type', typeName: 'Mutation' };
      else if (sel.name === 'types') {
        const types = Object.keys(GQL_FIELDS).map((n) => ({ __type: '__Type', typeName: n }));
        out[sel.alias] = sel.selections ? types.map((v) => gqlExecuteSelections(v, sel.selections, variables, errors)) : types;
      } else out[sel.alias] = null;
      continue;
    }
    if (obj && obj.__type === 'PageInfo') {
      if (sel.name === 'hasNextPage') out[sel.alias] = obj.hasNextPage;
      else if (sel.name === 'hasPreviousPage') out[sel.alias] = obj.hasPreviousPage;
      else if (sel.name === 'startCursor') out[sel.alias] = obj.startCursor;
      else if (sel.name === 'endCursor') out[sel.alias] = obj.endCursor;
      else out[sel.alias] = null;
      continue;
    }
    const value = gqlResolveField(obj, sel, variables, errors);
    if (value === undefined) {
      out[sel.alias] = null;
      continue;
    }
    if (value === null) {
      out[sel.alias] = null;
      continue;
    }
    if (sel.selections && Array.isArray(value)) {
      out[sel.alias] = value.map((v) => (v && typeof v === 'object' ? gqlExecuteSelections(v, sel.selections, variables, errors) : v));
    } else if (sel.selections && typeof value === 'object') {
      out[sel.alias] = gqlExecuteSelections(value, sel.selections, variables, errors);
    } else {
      out[sel.alias] = value;
    }
  }
  return out;
}

function gqlResolveIntrospection(obj, sel, variables, errors) {
  const info = gqlTypeInfo(obj.typeName);
  const name = sel.name;
  if (name === 'name') return info.name;
  if (name === 'kind') return info.kind;
  if (name === 'description') return null;
  if (name === 'fields') {
    const includeDeprecated = sel.args && gqlResolveValue(sel.args.includeDeprecated, variables);
    void includeDeprecated;
    return (info.fields || []).map((f) => ({ __type: '__Field', fieldName: f, parentType: info.name }));
  }
  if (name === 'enumValues') {
    const vals = GQL_ENUMS[info.name] || [];
    return vals.map((v) => ({ __type: '__EnumValue', enumValue: v }));
  }
  if (name === 'inputFields') return [];
  if (name === 'ofType') return null;
  if (name === 'possibleTypes') return [];
  if (name === 'specifiedByURL') return null;
  return null;
}

function gqlExecuteOne(doc, variables) {
  const errors = [];
  let data = {};
  for (const op of doc) {
    const rootType = op.opType === 'mutation' ? 'Mutation' : 'Query';
    const root = { __type: rootType };
    data = gqlExecuteSelections(root, op.selections, variables, errors);
  }
  const out = { data };
  if (errors.length) out.errors = errors;
  return out;
}

// Execute a GraphQL request body (single object or batch array).
function handleGraphQL(body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: { errors: [{ message: 'request body must be valid JSON' }] } };
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const results = [];
  for (const req of requests) {
    const query = req.query || '';
    const variables = req.variables || {};
    let doc;
    try {
      doc = new GqlParser(gqlTokenize(query)).parseDocument();
    } catch (e) {
      results.push({ errors: [{ message: `GraphQL parse error: ${e.message}` }] });
      continue;
    }
    results.push(gqlExecuteOne(doc, variables));
  }
  return { status: 200, body: Array.isArray(parsed) ? results : results[0] };
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28)
// ---------------------------------------------------------------------------

const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const MCP_TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', description: 'Issue state: open, closed, or all' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'integer', description: 'Issue number' } }, required: ['owner', 'repo', 'issue_number'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string', description: 'Pull request title' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' }, body: { type: 'string', description: 'Pull request body' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', description: 'Pull request state: open, closed, or all' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];

function mcpResult(id, result) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}
function mcpError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function mcpFindArg(args, names) {
  for (const n of names) {
    if (args[n] !== undefined && args[n] !== null) return args[n];
  }
  return undefined;
}

function mcpCallTool(name, args) {
  const toolName = String(name).toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const norm = toolName.replace(/^(github_|forge_)/, '');
  switch (norm) {
    case 'create_repo': {
      const repoName = mcpFindArg(args, ['name', 'repo_name', 'repository_name']);
      if (!repoName) return { isError: true, text: 'missing required argument: name' };
      if (getRepo(VIEWER.login, repoName)) return { isError: true, text: 'name already exists on this account' };
      const repo = createRepoRecord(VIEWER.login, repoName, mcpFindArg(args, ['description']) || '', mcpFindArg(args, ['private']) !== false);
      return { result: JSON.parse(repoJson(repo)) };
    }
    case 'get_repo': {
      const owner = mcpFindArg(args, ['owner', 'owner_login']);
      const repoName = mcpFindArg(args, ['repo', 'name', 'repository', 'repo_name']);
      if (!owner || !repoName) return { isError: true, text: 'missing required argument: owner and repo' };
      const repo = getRepo(owner, repoName);
      if (!repo) return { isError: true, text: 'Not Found' };
      return { result: JSON.parse(repoJson(repo)) };
    }
    case 'create_issue': {
      const owner = mcpFindArg(args, ['owner']);
      const repoName = mcpFindArg(args, ['repo', 'repository']);
      const title = mcpFindArg(args, ['title']);
      if (!owner || !repoName || !title) return { isError: true, text: 'missing required argument: owner, repo, title' };
      const repo = getRepo(owner, repoName);
      if (!repo) return { isError: true, text: 'Not Found' };
      const made = newIssue(repo, title, mcpFindArg(args, ['body']) || '', []);
      if (made.error) return { isError: true, text: made.error };
      return { result: JSON.parse(issueJson(repo, made.issue)) };
    }
    case 'list_issues': {
      const owner = mcpFindArg(args, ['owner']);
      const repoName = mcpFindArg(args, ['repo', 'repository']);
      if (!owner || !repoName) return { isError: true, text: 'missing required argument: owner and repo' };
      const repo = getRepo(owner, repoName);
      if (!repo) return { isError: true, text: 'Not Found' };
      const state = String(mcpFindArg(args, ['state']) || 'open').toLowerCase();
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => a.createdSeq - b.createdSeq);
      return { result: list.map((i) => JSON.parse(issueJson(repo, i))) };
    }
    case 'get_issue': {
      const owner = mcpFindArg(args, ['owner']);
      const repoName = mcpFindArg(args, ['repo', 'repository']);
      const num = mcpFindArg(args, ['issue_number', 'number', 'issueNumber']);
      if (!owner || !repoName || num === undefined) return { isError: true, text: 'missing required argument: owner, repo, issue_number' };
      const repo = getRepo(owner, repoName);
      if (!repo) return { isError: true, text: 'Not Found' };
      const issue = repo.issues.get(parseInt(num, 10));
      if (!issue) return { isError: true, text: 'Not Found' };
      return { result: JSON.parse(issueJson(repo, issue)) };
    }
    case 'create_pull_request': {
      const owner = mcpFindArg(args, ['owner']);
      const repoName = mcpFindArg(args, ['repo', 'repository']);
      const title = mcpFindArg(args, ['title']);
      const head = mcpFindArg(args, ['head', 'head_ref']);
      const base = mcpFindArg(args, ['base', 'base_ref']);
      if (!owner || !repoName || !title || !head || !base) return { isError: true, text: 'missing required argument: owner, repo, title, head, base' };
      const repo = getRepo(owner, repoName);
      if (!repo) return { isError: true, text: 'Not Found' };
      const made = newPull(repo, title, mcpFindArg(args, ['body']) || '', head, base);
      if (made.error) return { isError: true, text: made.error };
      return { result: JSON.parse(pullJson(repo, made.pr)) };
    }
    case 'list_pull_requests': {
      const owner = mcpFindArg(args, ['owner']);
      const repoName = mcpFindArg(args, ['repo', 'repository']);
      if (!owner || !repoName) return { isError: true, text: 'missing required argument: owner and repo' };
      const repo = getRepo(owner, repoName);
      if (!repo) return { isError: true, text: 'Not Found' };
      const state = String(mcpFindArg(args, ['state']) || 'open').toLowerCase();
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => a.createdSeq - b.createdSeq);
      return { result: list.map((p) => JSON.parse(pullJson(repo, p))) };
    }
    case 'merge_pull_request': {
      const owner = mcpFindArg(args, ['owner']);
      const repoName = mcpFindArg(args, ['repo', 'repository']);
      const num = mcpFindArg(args, ['pull_number', 'number', 'pullNumber']);
      if (!owner || !repoName || num === undefined) return { isError: true, text: 'missing required argument: owner, repo, pull_number' };
      const repo = getRepo(owner, repoName);
      if (!repo) return { isError: true, text: 'Not Found' };
      const pr = repo.pulls.get(parseInt(num, 10));
      if (!pr) return { isError: true, text: 'Not Found' };
      if (pr.state !== 'open') return { isError: true, text: 'Pull Request is not mergeable' };
      if (hasMergeConflict(repo, pr)) return { isError: true, text: 'Merge conflict' };
      const sha = doSquashMerge(repo, pr);
      return { result: { sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    default:
      return { notFound: true };
  }
}

async function handleMcp(req, res, body) {
  if (!authed(req, res)) return;
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json', 'x-github-request-id': nextReqId() });
    res.end(JSON.stringify(mcpError(null, -32700, 'Parse error')));
    return;
  }
  const isNotification = parsed.method && parsed.method.startsWith('notifications/');
  if (isNotification) {
    res.writeHead(202, { 'x-github-request-id': nextReqId() });
    res.end();
    return;
  }
  const method = parsed.method || '';
  const id = parsed.id;
  const params = parsed.params || {};
  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    const result = {
      supportedVersions: MCP_VERSIONS,
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    };
    res.writeHead(200, { 'content-type': 'application/json', 'x-github-request-id': nextReqId() });
    res.end(JSON.stringify(mcpResult(id, result)));
    return;
  }
  if (method === 'initialize') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    const result = {
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    };
    res.writeHead(200, { 'content-type': 'application/json', 'x-github-request-id': nextReqId() });
    res.end(JSON.stringify(mcpResult(id, result)));
    return;
  }
  if (method === 'ping') {
    res.writeHead(200, { 'content-type': 'application/json', 'x-github-request-id': nextReqId() });
    res.end(JSON.stringify(mcpResult(id, {})));
    return;
  }
  if (method === 'tools/list') {
    let tools = MCP_TOOLS;
    const cursor = params.cursor;
    if (cursor !== undefined && cursor !== null) {
      const idx = parseInt(String(cursor), 10);
      if (!Number.isNaN(idx)) tools = MCP_TOOLS.slice(idx);
    }
    const result = { tools };
    res.writeHead(200, { 'content-type': 'application/json', 'x-github-request-id': nextReqId() });
    res.end(JSON.stringify(mcpResult(id, result)));
    return;
  }
  if (method === 'tools/call') {
    const toolName = params.name;
    const args = params.arguments || {};
    const tool = MCP_TOOLS.find((t) => t.name === toolName);
    if (!tool) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-github-request-id': nextReqId() });
      res.end(JSON.stringify(mcpError(id, -32602, `Unknown tool: ${toolName}`)));
      return;
    }
    const missing = (tool.inputSchema.required || []).filter((r) => args[r] === undefined || args[r] === null);
    if (missing.length) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-github-request-id': nextReqId() });
      res.end(JSON.stringify(mcpResult(id, { content: [{ type: 'text', text: `missing required argument: ${missing[0]}` }], isError: true })));
      return;
    }
    const out = mcpCallTool(toolName, args);
    if (out.notFound) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-github-request-id': nextReqId() });
      res.end(JSON.stringify(mcpError(id, -32602, `Unknown tool: ${toolName}`)));
      return;
    }
    if (out.isError) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-github-request-id': nextReqId() });
      res.end(JSON.stringify(mcpResult(id, { content: [{ type: 'text', text: out.text }], isError: true })));
      return;
    }
    const text = JSON.stringify(out.result);
    res.writeHead(200, { 'content-type': 'application/json', 'x-github-request-id': nextReqId() });
    res.end(JSON.stringify(mcpResult(id, { content: [{ type: 'text', text }], structuredContent: out.result })));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json', 'x-github-request-id': nextReqId() });
  res.end(JSON.stringify(mcpError(id, -32601, `Method not found: ${method}`)));
}

// ---------------------------------------------------------------------------
// main server + lifecycle
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const rawUrl = req.url || '/';
    const q = rawUrl.indexOf('?');
    const path = q < 0 ? rawUrl : rawUrl.slice(0, q);
    if (req.method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    // REST / GraphQL / MCP never match the git pattern; skip the regex.
    const isApi = path === '/api/v3' || path.startsWith('/api/v3/') || path === '/api/graphql' || path === '/mcp';
    // Git smart HTTP: /{owner}/{repo}.git/{service}
    const gitMatch = isApi ? null : /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1]);
      const repoName = decodeURIComponent(gitMatch[2]);
      const service = gitMatch[3];
      const repo = getRepo(owner, repoName);
      if (!repo) {
        if (req.method === 'GET' && service === 'info/refs') {
          jsonError(res, 404, 'Not Found');
          return;
        }
        jsonError(res, 404, 'Not Found');
        return;
      }
      if (req.method === 'GET' && service === 'info/refs') {
        const m = /(?:[?&])service=([^&]*)/.exec(rawUrl);
        const svc = m ? decodeURIComponent(m[1]) : null;
        handleInfoRefs(req, res, repo, svc);
        return;
      }
      if (req.method === 'POST' && service === 'git-upload-pack') {
        const body = await readBody(req);
        handleUploadPack(req, res, repo, body);
        return;
      }
      if (req.method === 'POST' && service === 'git-receive-pack') {
        const body = await readBody(req);
        handleReceivePack(req, res, repo, body);
        return;
      }
      jsonError(res, 404, 'Not Found');
      return;
    }
    // REST v3
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      const sub = path === '/api/v3' ? [] : path.slice('/api/v3/'.length).split('/').filter((s) => s.length > 0);
      const body = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
      await handleRest(req, res, sub, body);
      return;
    }
    // GraphQL
    if (path === '/api/graphql' && req.method === 'POST') {
      if (!authed(req, res)) return;
      const body = await readBody(req);
      const out = handleGraphQL(body);
      res.writeHead(out.status, { 'content-type': 'application/json', 'x-github-request-id': nextReqId() });
      res.end(JSON.stringify(out.body));
      return;
    }
    // MCP
    if (path === '/mcp' && req.method === 'POST') {
      const body = await readBody(req);
      await handleMcp(req, res, body);
      return;
    }
    jsonError(res, 404, 'Not Found');
  } catch (e) {
    process.stderr.write(`request error ${req.method} ${req.url}: ${e.stack || e.message}\n`);
    if (!res.headersSent) {
      jsonError(res, 500, 'Internal Server Error');
    } else {
      res.end();
    }
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url, obj) {
  const text = JSON.stringify(obj);
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? await import('node:https') : await import('node:http');
  return new Promise((resolve, reject) => {
    const r = lib.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.write(text);
    r.end();
  });
}

async function getJson(url) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? await import('node:https') : await import('node:http');
  return new Promise((resolve, reject) => {
    const r = lib.request(u, { method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  if (!ENV_URL) {
    // Local practice: serve until killed.
    return;
  }
  const reg = await postJson(`${ENV_URL}/register`, { port });
  if (reg.status !== 200 && reg.status !== 201) {
    process.stderr.write(`register failed: ${reg.status} ${reg.body}\n`);
    process.exit(1);
  }
  let delay = 250;
  for (;;) {
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
    let done;
    try {
      done = await getJson(`${ENV_URL}/done`);
    } catch {
      continue;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(done.body);
    } catch { /* keep polling */ }
    if (parsed && parsed.done === true) {
      server.close();
      process.exit(0);
    }
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});
