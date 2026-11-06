/**
 * offscreen.js — worker nặng của archive.
 * Việc ở đây: fetch bytes media từ CDN, lưu IndexedDB, dựng ZIP, ghi ra đĩa, upload.
 * Service worker không làm mấy việc này vì bị kill sau 30s và không có DOM/blob URL ổn định.
 */
/* global FB_ARCHIVE_DEFAULTS, fbMergeArchiveSettings */

const DB_NAME = 'fb_archive';
const DB_VERSION = 1;
const STORAGE_KEY_UNSENT = 'fb_unsent_messages_v2';
const STORAGE_KEY_SETTINGS = 'fb_archive_settings_v1';
const STORAGE_KEY_LOG = 'fb_archive_log_v1';

const MIME_BY_EXT = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  pdf: 'application/pdf'
};

/* ---------------------------------------------------------------- settings */

async function getSettings() {
  const res = await storeGet(STORAGE_KEY_SETTINGS);
  return fbMergeArchiveSettings(res[STORAGE_KEY_SETTINGS] || {});
}

// Offscreen document chỉ chắc chắn có chrome.runtime, nên storage đi qua SW khi cần.
function sendToSw(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(resp);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function storeGet(keys) {
  if (chrome.storage?.local) return chrome.storage.local.get(keys);
  const resp = await sendToSw({ type: 'ARCHIVE_STORE_GET', keys });
  return resp?.result || {};
}

async function storeSet(obj) {
  if (chrome.storage?.local) return chrome.storage.local.set(obj);
  await sendToSw({ type: 'ARCHIVE_STORE_SET', obj });
}

async function log(text, extra) {
  try {
    const res = await storeGet(STORAGE_KEY_LOG);
    const list = Array.isArray(res[STORAGE_KEY_LOG]) ? res[STORAGE_KEY_LOG] : [];
    list.unshift({ at: Date.now(), text: String(text).slice(0, 400), extra: extra || null });
    await storeSet({ [STORAGE_KEY_LOG]: list.slice(0, 80) });
  } catch (_) {}
}

function progress(text) {
  try {
    chrome.runtime.sendMessage({ type: 'ARCHIVE_PROGRESS', text }, () => void chrome.runtime.lastError);
  } catch (_) {}
}

/* --------------------------------------------------------------------- idb */

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media');
      if (!db.objectStoreNames.contains('urlmap')) db.createObjectStore('urlmap');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGet(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbEntries(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const out = [];
    const req = db.transaction(store, 'readonly').objectStore(store).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(out);
      out.push({ key: cur.key, value: cur.value });
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/* ------------------------------------------------------------------ helpers */

async function sha256Hex(data) {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

function dataUrlToBlob(url) {
  const comma = url.indexOf(',');
  const head = url.slice(0, comma);
  const meta = /data:([^;,]+)/.exec(head);
  const mime = meta ? meta[1] : 'application/octet-stream';
  if (/;base64/i.test(head)) {
    const bin = atob(url.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(url.slice(comma + 1))], { type: mime });
}

function guessKind(url, mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('image/')) return 'image';
  if (/\.(mp4|webm|mov)(\?|$)/i.test(url) || /video[^/]*\.fbcdn/i.test(url)) return 'video';
  if (/\.(mp3|m4a|ogg|opus|wav)(\?|$)/i.test(url)) return 'audio';
  return 'image';
}

function extFor(url, mime, kind) {
  const clean = String(mime || '').split(';')[0].trim().toLowerCase();
  const byMime = Object.keys(MIME_BY_EXT).find((ext) => MIME_BY_EXT[ext] === clean);
  if (byMime) return byMime;
  const urlMatch = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(String(url || '').split('?')[0]);
  if (urlMatch) {
    const ext = urlMatch[1].toLowerCase();
    if (MIME_BY_EXT[ext]) return ext;
  }
  return kind === 'video' ? 'mp4' : kind === 'audio' ? 'm4a' : 'webp';
}

function slug(text) {
  const base = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return (base || 'unknown').slice(0, 48).toLowerCase();
}

function ymd(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function hhmm(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(2000, ms || 15000));
  try {
    return await fetch(url, { credentials: 'omit', signal: ctrl.signal, cache: 'force-cache' });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------ media in idb */

async function storeMediaBlob({ blob, url, kind, messageId }) {
  const buf = await blob.arrayBuffer();
  const hash = await sha256Hex(buf);
  const existing = await idbGet('media', hash);
  const refs = new Set(existing?.refs || []);
  if (messageId) refs.add(String(messageId));
  const mime = blob.type || MIME_BY_EXT[extFor(url, blob.type, kind)] || 'application/octet-stream';
  await idbPut('media', hash, {
    hash,
    kind: kind || guessKind(url, mime),
    mime,
    size: blob.size,
    blob,
    firstSeenAt: existing?.firstSeenAt || Date.now(),
    exportedAt: existing?.exportedAt || 0,
    refs: Array.from(refs).slice(0, 200)
  });
  if (url && !String(url).startsWith('data:')) await idbPut('urlmap', url, hash);
  return { hash, size: blob.size, mime };
}

async function findMediaByUrl(url) {
  if (!url) return null;
  if (String(url).startsWith('data:')) {
    const blob = dataUrlToBlob(url);
    const hash = await sha256Hex(await blob.arrayBuffer());
    const hit = await idbGet('media', hash);
    return hit || null;
  }
  const hash = await idbGet('urlmap', url);
  return hash ? await idbGet('media', hash) : null;
}

async function fetchOneMedia(item, messageId, settings) {
  const url = item.url;
  if (String(url).startsWith('data:')) {
    const blob = dataUrlToBlob(url);
    const stored = await storeMediaBlob({ blob, url, kind: item.kind, messageId });
    return { url, ...stored };
  }
  const maxBytes = Math.max(1, Number(settings.media.maxFileMB) || 200) * 1024 * 1024;
  const resp = await fetchWithTimeout(url, settings.media.fetchTimeoutMs || 15000);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const declared = Number(resp.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`quá lớn (${Math.round(declared / 1048576)}MB)`);
  const blob = await resp.blob();
  if (blob.size > maxBytes) throw new Error(`quá lớn (${Math.round(blob.size / 1048576)}MB)`);
  const stored = await storeMediaBlob({ blob, url, kind: item.kind, messageId });
  return { url, ...stored };
}

async function jobFetchMedia(job) {
  const settings = await getSettings();
  const items = Array.isArray(job.items) ? job.items.slice(0, 20) : [];
  const results = [];
  for (const item of items) {
    if (!item || !item.url) continue;
    try {
      results.push({ ok: true, ...(await fetchOneMedia(item, job.messageId, settings)) });
    } catch (err) {
      results.push({ ok: false, url: item.url, error: String(err?.message || err) });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  if (okCount) progress(`Đã lưu ${okCount}/${items.length} media`);
  return { ok: true, results };
}

/* -------------------------------------------------------------- zip writer */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date || new Date();
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const day = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, day };
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream !== 'function') throw new Error('CompressionStream unavailable');
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

class ZipWriter {
  constructor() {
    this.chunks = [];
    this.central = [];
    this.offset = 0;
  }

  async add(name, data, options = {}) {
    const raw =
      typeof data === 'string'
        ? new TextEncoder().encode(data)
        : new Uint8Array(await data.arrayBuffer());
    const wantDeflate = options.compress !== false && raw.length > 512;
    let payload = raw;
    let method = 0;
    if (wantDeflate) {
      try {
        const deflated = await deflateRaw(raw);
        if (deflated.length < raw.length) {
          payload = deflated;
          method = 8;
        }
      } catch (_) {}
    }
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(raw);
    const { time, day } = dosDateTime(new Date());

    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 0x0800, true); // UTF-8 names
    header.setUint16(8, method, true);
    header.setUint16(10, time, true);
    header.setUint16(12, day, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, payload.length, true);
    header.setUint32(22, raw.length, true);
    header.setUint16(26, nameBytes.length, true);
    header.setUint16(28, 0, true);

    this.chunks.push(new Uint8Array(header.buffer), nameBytes, payload);
    this.central.push({
      nameBytes,
      crc,
      csize: payload.length,
      usize: raw.length,
      method,
      offset: this.offset,
      time,
      day
    });
    this.offset += 30 + nameBytes.length + payload.length;
  }

  finish() {
    const start = this.offset;
    for (const entry of this.central) {
      const header = new DataView(new ArrayBuffer(46));
      header.setUint32(0, 0x02014b50, true);
      header.setUint16(4, 20, true);
      header.setUint16(6, 20, true);
      header.setUint16(8, 0x0800, true);
      header.setUint16(10, entry.method, true);
      header.setUint16(12, entry.time, true);
      header.setUint16(14, entry.day, true);
      header.setUint32(16, entry.crc, true);
      header.setUint32(20, entry.csize, true);
      header.setUint32(24, entry.usize, true);
      header.setUint16(28, entry.nameBytes.length, true);
      header.setUint32(42, entry.offset, true);
      this.chunks.push(new Uint8Array(header.buffer), entry.nameBytes);
      this.offset += 46 + entry.nameBytes.length;
    }

    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, this.central.length, true);
    eocd.setUint16(10, this.central.length, true);
    eocd.setUint32(12, this.offset - start, true);
    eocd.setUint32(16, start, true);
    this.chunks.push(new Uint8Array(eocd.buffer));
    return new Blob(this.chunks, { type: 'application/zip' });
  }
}

/* ------------------------------------------------------------ export batch */

function choosePerson(record) {
  return record.threadName || record.personName || record.senderName || 'unknown';
}

async function prepareRecord(record, mediaFiles, missing) {
  const out = Object.assign({}, record);
  const refs = [];
  const attachments = Array.isArray(record.attachments) ? record.attachments : [];
  for (const url of attachments) {
    if (!url || typeof url !== 'string') continue;
    let media = await findMediaByUrl(url);
    if (!media && url.startsWith('data:')) {
      // Ảnh base64 nằm sẵn trong record: giải mã thẳng, không cần ghi lại vào IndexedDB.
      try {
        const blob = dataUrlToBlob(url);
        const hash = await sha256Hex(await blob.arrayBuffer());
        media = { hash, blob, size: blob.size, mime: blob.type, kind: guessKind(url, blob.type) };
      } catch (_) {
        media = null;
      }
    }
    if (!media && !url.startsWith('data:')) {
      try {
        const settings = await getSettings();
        const fetched = await fetchOneMedia({ url, kind: guessKind(url) }, record.messageId, settings);
        media = await idbGet('media', fetched.hash);
      } catch (_) {
        media = null;
      }
    }
    if (!media) {
      refs.push({ url, missing: true });
      missing.push({ messageId: record.messageId, url });
      continue;
    }
    const ext = extFor(url, media.mime, media.kind);
    const file = `media/${media.hash}.${ext}`;
    mediaFiles.set(media.hash, { file, blob: media.blob, mime: media.mime, hash: media.hash });
    refs.push({ file, mime: media.mime, size: media.size, kind: media.kind });
  }
  out.attachments = refs;
  out.mediaMissing = refs.filter((r) => r.missing).map((r) => r.url);
  return out;
}

function renderTxt(groupRecords, meta) {
  const lines = [];
  lines.push(`# ${meta.title} — ${meta.date}`);
  lines.push(`# Xuất lúc ${new Date(meta.exportedAt).toISOString()} | batch ${meta.batchId}`);
  lines.push('');
  for (const item of groupRecords) {
    const time = hhmm(item.unsentAt || item.timestamp);
    const who = item.isSelf ? 'Bạn' : item.personName || item.senderName || 'Người khác';
    lines.push(`[${time}] ${who}: ${item.text || ''}`);
    for (const att of item.attachments || []) {
      if (att.missing) lines.push(`    [media không tải được] ${att.url}`);
      else lines.push(`    [${att.kind || 'media'}] ${att.file}`);
    }
  }
  return lines.join('\n');
}

async function buildZip(records, meta, settings) {
  const zip = new ZipWriter();
  const mediaFiles = new Map();
  const missing = [];
  const groups = new Map();

  for (const record of records) {
    const prepared = await prepareRecord(record, mediaFiles, missing);
    const date = ymd(record.unsentAt || record.timestamp);
    const slugName = slug(choosePerson(record));
    const key = `${slugName}/${date}`;
    if (!groups.has(key)) {
      groups.set(key, { title: choosePerson(record), date, records: [] });
    }
    groups.get(key).records.push(prepared);
  }

  const formats = Array.isArray(settings.export.formats) ? settings.export.formats : ['json'];
  const compress = settings.export.compression !== 'store';
  const manifest = {
    app: 'fb-unsend-viewer-archive',
    schema: 1,
    batchId: meta.batchId,
    exportedAt: new Date(meta.exportedAt).toISOString(),
    part: meta.part,
    parts: meta.parts,
    mode: meta.mode,
    counts: { messages: records.length, groups: groups.size, media: mediaFiles.size, missingMedia: missing.length },
    groups: Array.from(groups.keys()),
    missingMedia: missing.slice(0, 500)
  };
  await zip.add('manifest.json', JSON.stringify(manifest, null, 2), { compress });

  for (const [key, group] of groups) {
    if (formats.includes('json')) {
      await zip.add(
        `chats/${key}/messages.json`,
        JSON.stringify({ title: group.title, date: group.date, messages: group.records }, null, 2),
        { compress }
      );
    }
    if (formats.includes('txt')) {
      await zip.add(
        `chats/${key}/messages.txt`,
        renderTxt(group.records, {
          title: group.title,
          date: group.date,
          batchId: meta.batchId,
          exportedAt: meta.exportedAt
        }),
        { compress }
      );
    }
  }

  for (const entry of mediaFiles.values()) {
    await zip.add(entry.file, entry.blob, { compress: false });
  }

  return { blob: zip.finish(), mediaHashes: Array.from(mediaFiles.keys()), missing };
}

async function estimateRecordBytes(record) {
  let total = JSON.stringify(record).length;
  for (const url of record.attachments || []) {
    if (typeof url !== 'string') continue;
    if (url.startsWith('data:')) {
      total += Math.round(url.length * 0.75);
    } else {
      const media = await findMediaByUrl(url);
      if (media?.size) total += media.size;
    }
  }
  return total;
}

async function planParts(records, settings) {
  const limit = Math.max(5, Number(settings.export.splitMB) || 45) * 1024 * 1024;
  const parts = [];
  let current = [];
  let currentBytes = 0;
  for (const record of records) {
    const size = await estimateRecordBytes(record);
    if (current.length && currentBytes + size > limit) {
      parts.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(record);
    currentBytes += size;
  }
  if (current.length) parts.push(current);
  return parts.length ? parts : [records];
}

/* ---------------------------------------------------------------- delivery */

function zipName(batchId, index, total, exportedAt) {
  // Tên file đọc được thời gian để tracking: fb-unsend-20261106-170839.zip
  const d = new Date(exportedAt || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const suffix = total > 1 ? `-part${index}of${total}` : '';
  return `fb-unsend-${stamp}${suffix}.zip`;
}

async function writeToFolder(blob, name) {
  const handle = await idbGet('kv', 'dirHandle');
  if (!handle) throw new Error('Chưa chọn folder lưu (Options → Nơi tải → Chọn folder lưu…)');
  // Offscreen không có user gesture nên KHÔNG gọi requestPermission ở đây
  // (gọi cũng bị từ chối). Quyền phải được cấp lúc người dùng bấm "Chọn folder lưu…".
  let perm = 'prompt';
  try {
    perm = await handle.queryPermission({ mode: 'readwrite' });
  } catch (_) {}
  if (perm !== 'granted') {
    throw new Error('Folder chưa được cấp quyền ghi — mở Options → bấm "Chọn folder lưu…" lại');
  }
  const fileHandle = await handle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function saveDownloads(blob, name, settings) {
  const url = URL.createObjectURL(blob);
  const subdir = String(settings.export.downloadSubdir || 'fb-unsend-archive').replace(/[\\/:*?"<>|]/g, '-');
  try {
    if (chrome.downloads?.download) {
      await chrome.downloads.download({
        url,
        filename: `${subdir}/${name}`,
        saveAs: false,
        conflictAction: 'uniquify'
      });
    } else {
// Offscreen document không có chrome.downloads → dùng thẻ <a download>.
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }
}

async function uploadTelegram(blob, name, cfg) {
  if (!cfg.botToken || !cfg.chatId) throw new Error('Thiếu bot token / chat id');
  const form = new FormData();
  form.append('chat_id', cfg.chatId);
  form.append('caption', name.replace(/\.zip$/, ''));
  form.append('document', blob, name);
  const resp = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendDocument`, {
    method: 'POST',
    body: form
  });
  if (!resp.ok) throw new Error('Telegram HTTP ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function uploadGithub(blob, name, cfg) {
  if (!cfg.token || !cfg.repo) throw new Error('Thiếu GitHub token / repo');
  const basePath = String(cfg.basePath || '').replace(/^\/+/, '').replace(/\/+$/, '');
  const path = basePath ? `${basePath}/${name}` : name;
  const api = `https://api.github.com/repos/${cfg.repo}/contents/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  const headers = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json'
  };
  let sha = '';
  const head = await fetch(`${api}?ref=${encodeURIComponent(cfg.branch || 'main')}`, { headers });
  if (head.ok) {
    const data = await head.json().catch(() => null);
    sha = data?.sha || '';
  }
  const body = {
    message: `archive: ${name}`,
    content: await blobToBase64(blob),
    branch: cfg.branch || 'main'
  };
  if (sha) body.sha = sha;
  const resp = await fetch(api, { method: 'PUT', headers, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error('GitHub HTTP ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
}

async function uploadWebdav(blob, name, cfg) {
  if (!cfg.url) throw new Error('Thiếu WebDAV URL');
  let base = String(cfg.url).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) base = 'https://' + base;
  base = base.replace(/\/+$/, '');
  const headers = {};
  if (cfg.username) {
    headers.Authorization =
      'Basic ' + btoa(unescape(encodeURIComponent(`${cfg.username}:${cfg.password || ''}`)));
  }
  // Tự tạo folder đích nếu chưa có (MKCOL). 201 = vừa tạo, 405 = đã có — đều OK.
  try {
    const { pathname } = new URL(base);
    if (pathname.replace(/\//g, '')) {
      await fetch(base, { method: 'MKCOL', headers });
    }
  } catch (_) {}
  const target = base + '/' + encodeURIComponent(name);
  const resp = await fetch(target, { method: 'PUT', headers, body: blob });
  if (!resp.ok) throw new Error('WebDAV HTTP ' + resp.status);
}

function webdavAuthHeaders(cfg) {
  const headers = {};
  if (cfg.username) {
    headers.Authorization =
      'Basic ' + btoa(unescape(encodeURIComponent(`${cfg.username}:${cfg.password || ''}`)));
  }
  return headers;
}

// Liệt kê folder con (PROPFIND Depth:1) để người dùng chọn nơi lưu trên PikPak/NAS.
async function jobWebdavLs(job) {
  let base = String(job.url || '').trim();
  if (!base) throw new Error('Chưa nhập URL WebDAV');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) base = 'https://' + base;
  base = base.replace(/\/+$/, '');
  const resp = await fetch(base + '/', {
    method: 'PROPFIND',
    headers: Object.assign({ Depth: '1' }, webdavAuthHeaders(job))
  });
  if (!resp.ok) throw new Error('WebDAV HTTP ' + resp.status);
  const xml = new DOMParser().parseFromString(await resp.text(), 'application/xml');
  const basePath = new URL(base + '/').pathname.replace(/\/+$/, '');
  const folders = [];
  for (const node of xml.getElementsByTagNameNS('*', 'response')) {
    const hrefEl = node.getElementsByTagNameNS('*', 'href')[0];
    if (!hrefEl) continue;
    let path;
    try {
      path = new URL(decodeURIComponent(hrefEl.textContent.trim()), base + '/').pathname.replace(/\/+$/, '');
    } catch (_) {
      continue;
    }
    if (path === basePath) continue;
    if (node.getElementsByTagNameNS('*', 'collection').length === 0) continue;
    const rel = path.startsWith(basePath) ? path.slice(basePath.length).replace(/^\//, '') : '';
    if (!rel || rel.includes('/')) continue;
    let name = rel;
    try {
      name = decodeURIComponent(rel);
    } catch (_) {}
    folders.push({ name, url: base + '/' + encodeURIComponent(name) });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, cwd: base + '/', folders };
}

async function uploadDrive(blob, name, cfg) {
  if (!cfg.token) throw new Error('Thiếu Drive access token');
  const boundary = 'fbarchive' + Date.now();
  const meta = { name };
  if (cfg.folderId) meta.parents = [cfg.folderId];
  const head =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/zip\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const body = new Blob([head, blob, tail], { type: `multipart/related; boundary=${boundary}` });
  const resp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}` },
      body
    }
  );
  if (!resp.ok) throw new Error('Drive HTTP ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
}

async function deliver(blob, name, settings) {
  const mode = settings.export.downloadMode;
  if (mode === 'downloads') await saveDownloads(blob, name, settings);
  else if (mode === 'folder') await writeToFolder(blob, name);

  if (!settings.upload.enabled) return;
  const up = settings.upload;
  if (up.telegram.botToken && up.telegram.chatId) await uploadTelegram(blob, name, up.telegram);
  if (up.github.token && up.github.repo) await uploadGithub(blob, name, up.github);
  if (up.webdav.url) await uploadWebdav(blob, name, up.webdav);
  if (up.gdrive.token) await uploadDrive(blob, name, up.gdrive);
}

async function markExported(ids, batchId) {
  const store = await storeGet(STORAGE_KEY_UNSENT);
  const list = Array.isArray(store[STORAGE_KEY_UNSENT]) ? store[STORAGE_KEY_UNSENT] : [];
  const wanted = new Set(ids.map(String));
  const now = Date.now();
  let changed = false;
  const next = list.map((record) => {
    if (!record || !wanted.has(String(record.messageId))) return record;
    if (record.exportedAt) return record;
    changed = true;
    return Object.assign({}, record, { exportedAt: now, exportBatchId: batchId });
  });
  if (changed) await storeSet({ [STORAGE_KEY_UNSENT]: next });
}

async function markMediaExported(hashes) {
  const now = Date.now();
  for (const hash of hashes) {
    const media = await idbGet('media', hash);
    if (media && !media.exportedAt) await idbPut('media', hash, Object.assign({}, media, { exportedAt: now }));
  }
}

async function jobExport(job) {
  const settings = await getSettings();
  const store = await storeGet(STORAGE_KEY_UNSENT);
  const all = Array.isArray(store[STORAGE_KEY_UNSENT]) ? store[STORAGE_KEY_UNSENT] : [];
  const mode = job.mode === 'full' ? 'full' : 'incremental';
  const records = (mode === 'full' ? all : all.filter((r) => r && !r.exportedAt)).slice(0, 2000);
  if (!records.length) return { ok: true, exported: 0, parts: 0, reason: 'no-new-records' };

  const parts = await planParts(records, settings);
  const batchId = 'b' + Date.now().toString(36);
  const exportedAt = Date.now();
  let mediaTotal = 0;

  for (let i = 0; i < parts.length; i++) {
    progress(`Đóng gói ${i + 1}/${parts.length} (${parts[i].length} tin)…`);
    const built = await buildZip(
      parts[i],
      { batchId, exportedAt, part: i + 1, parts: parts.length, mode },
      settings
    );
    const name = zipName(batchId, i + 1, parts.length, exportedAt);
    await deliver(built.blob, name, settings);
    await markMediaExported(built.mediaHashes);
    mediaTotal += built.mediaHashes.length;
    await log(`Xuất ${name} (${Math.round(built.blob.size / 1024)}KB, ${built.missing.length} media thiếu)`);
  }

  await markExported(records.map((r) => r.messageId), batchId);
  return { ok: true, exported: records.length, parts: parts.length, media: mediaTotal, batchId };
}

/* ------------------------------------------------------------------- misc */

async function jobRetention(job) {
  const settings = await getSettings();
  const capBytes = Math.max(50, Number(job.maxTotalMB || settings.retention.maxTotalMB) || 2048) * 1024 * 1024;
  const entries = await idbEntries('media');
  let total = entries.reduce((sum, e) => sum + (e.value?.size || 0), 0);
  const now = Date.now();
  const keepRecentMs = 7 * 24 * 3600 * 1000;
  let removed = 0;

  const byAge = entries
    .filter((e) => (e.value?.refs || []).length === 0 && now - (e.value?.firstSeenAt || 0) > keepRecentMs)
    .sort((a, b) => (a.value?.firstSeenAt || 0) - (b.value?.firstSeenAt || 0));
  for (const entry of byAge) {
    await idbDelete('media', entry.key);
    total -= entry.value?.size || 0;
    removed++;
  }

  if (total > capBytes) {
    const exportedOldest = entries
      .filter((e) => e.value?.exportedAt)
      .sort((a, b) => (a.value?.exportedAt || 0) - (b.value?.exportedAt || 0));
    for (const entry of exportedOldest) {
      if (total <= capBytes) break;
      const still = await idbGet('media', entry.key);
      if (!still) continue;
      await idbDelete('media', entry.key);
      total -= still.size || 0;
      removed++;
    }
  }

  if (removed) await log(`Dọn archive: xoá ${removed} media, còn ${Math.round(total / 1048576)}MB`);
  return { ok: true, removed, totalMB: Math.round(total / 1048576) };
}

async function jobPing() {
  return {
    ok: true,
    downloads: typeof chrome.downloads,
    storage: typeof chrome.storage,
    offscreen: document.visibilityState
  };
}

async function jobStatus() {  const entries = await idbEntries('media');
  const total = entries.reduce((sum, e) => sum + (e.value?.size || 0), 0);
  const store = await storeGet(STORAGE_KEY_UNSENT);
  const list = Array.isArray(store[STORAGE_KEY_UNSENT]) ? store[STORAGE_KEY_UNSENT] : [];
  return {
    ok: true,
    mediaCount: entries.length,
    mediaMB: Math.round((total / 1048576) * 10) / 10,
    records: list.length,
    pending: list.filter((r) => !r.exportedAt).length
  };
}

async function jobClear() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['media', 'urlmap'], 'readwrite');
    tx.objectStore('media').clear();
    tx.objectStore('urlmap').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return { ok: true };
}

async function jobTestUpload() {
  const settings = await getSettings();
  if (!settings.upload.enabled) throw new Error('Chưa bật upload');
  const blob = new Blob(['fb-unsend archive test ' + new Date().toISOString()], { type: 'text/plain' });
  const name = 'fb-unsend-test.txt';
  const up = settings.upload;
  const detail = [];
  // Chạy từng đích riêng, đích nào lỗi ghi rõ đích đó (kèm origin để dễ đoán nguyên nhân).
  const tryDest = async (label, origin, fn) => {
    try {
      await fn();
      detail.push(`${label}: OK`);
      return true;
    } catch (err) {
      detail.push(`${label} (${origin}): ${String(err?.message || err).slice(0, 160)}`);
      return false;
    }
  };
  let sent = 0;
  if (up.telegram.botToken && up.telegram.chatId) {
    if (await tryDest('Telegram', 'api.telegram.org', async () => {
      const form = new FormData();
      form.append('chat_id', up.telegram.chatId);
      form.append('caption', 'FB Unsend archive test');
      form.append('document', blob, name);
      const resp = await fetch(`https://api.telegram.org/bot${up.telegram.botToken}/sendDocument`, {
        method: 'POST',
        body: form
      });
      if (!resp.ok) throw new Error('Telegram HTTP ' + resp.status + ' ' + (await resp.text()).slice(0, 120));
    })) sent++;
  }
  if (up.github.token && up.github.repo) {
    if (await tryDest('GitHub', 'api.github.com', async () => uploadGithub(blob, name, up.github))) sent++;
  }
  if (up.webdav.url) {
    let origin = '';
    try {
      origin = new URL(up.webdav.url).origin;
    } catch (_) {}
    if (await tryDest('WebDAV', origin || up.webdav.url.slice(0, 60), async () => uploadWebdav(blob, name, up.webdav))) sent++;
  }
  if (up.gdrive.token) {
    if (await tryDest('Drive', 'www.googleapis.com', async () => uploadDrive(blob, name, up.gdrive))) sent++;
  }
  if (!detail.length) throw new Error('Chưa cấu hình đích nào');
  if (!sent) throw new Error(detail.join(' | '));
  return { ok: true, sent, detail };
}

/* --------------------------------------------------------------- dispatch */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'ARCHIVE_JOB') return;
  const job = message.job || {};
  const run = async () => {
    switch (job.type) {
      case 'fetch-media':
        return jobFetchMedia(job);
      case 'export':
        return jobExport(job);
      case 'retention':
        return jobRetention(job);
      case 'status':
        return jobStatus();
      case 'ping':
        return jobPing();
      case 'webdav-ls':
        return jobWebdavLs(job);
      case 'clear':
        return jobClear();
      case 'test-upload':
        return jobTestUpload();
      default:
        throw new Error('Job không hỗ trợ: ' + job.type);
    }
  };
  run()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => {
      const messageText = String(err?.message || err);
      log('Lỗi job ' + job.type + ': ' + messageText);
      sendResponse({ ok: false, error: messageText });
    });
  return true;
});

