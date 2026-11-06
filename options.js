/**
 * options.js — form cài đặt archive.
 * Lưu toàn bộ vào chrome.storage.local (key fb_archive_settings_v1).
 */
/* global FB_ARCHIVE_DEFAULTS, fbMergeArchiveSettings */

const SETTINGS_KEY = 'fb_archive_settings_v1';
const LOG_KEY = 'fb_archive_log_v1';
const DB_NAME = 'fb_archive';

const dom = {
  saveState: document.getElementById('saveState'),
  status: document.getElementById('status'),
  log: document.getElementById('log'),
  folderState: document.getElementById('folderState'),
  pickFolder: document.getElementById('pickFolder'),
  exportAll: document.getElementById('exportAll'),
  testUpload: document.getElementById('testUpload'),
  refreshStatus: document.getElementById('refreshStatus'),
  clearArchive: document.getElementById('clearArchive'),
  grantWebdav: document.getElementById('grantWebdav'),
  browseWebdav: document.getElementById('browseWebdav'),
  webdavCwd: document.getElementById('webdavCwd'),
  webdavBrowser: document.getElementById('webdavBrowser')
};

let settings = fbMergeArchiveSettings({});
let saveTimer = null;

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function inputs() {
  return Array.from(document.querySelectorAll('[data-path]'));
}

function formatCheckboxes() {
  return Array.from(document.querySelectorAll('[data-format]'));
}

function fillForm() {
  for (const el of inputs()) {
    const value = getPath(settings, el.dataset.path);
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = value == null ? '' : value;
  }
  const formats = Array.isArray(settings.export.formats) ? settings.export.formats : ['json'];
  for (const box of formatCheckboxes()) box.checked = formats.includes(box.dataset.format);
}

function collectForm() {
  const next = fbMergeArchiveSettings(settings);
  for (const el of inputs()) {
    let value;
    if (el.type === 'checkbox') value = el.checked;
    else if (el.type === 'number') value = el.value === '' ? 0 : Number(el.value);
    else value = el.value.trim();
    setPath(next, el.dataset.path, value);
  }
  const formats = formatCheckboxes()
    .filter((box) => box.checked)
    .map((box) => box.dataset.format);
  next.export.formats = formats.length ? formats : ['json'];
  return next;
}

function markDirty() {
  dom.saveState.textContent = 'Đang lưu…';
  dom.saveState.classList.add('dirty');
}

function markSaved() {
  dom.saveState.textContent = 'Đã lưu';
  dom.saveState.classList.remove('dirty');
}

function scheduleSave() {
  settings = collectForm();
  markDirty();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    markSaved();
    refreshStatus();
  }, 400);
}

/* ------------------------------------------------------------------ folder */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media');
      if (!db.objectStoreNames.contains('urlmap')) db.createObjectStore('urlmap');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putKv(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getKv(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function showFolderState() {
  try {
    const handle = await getKv('dirHandle');
    dom.folderState.textContent = handle ? `Folder: ${handle.name}` : 'Chưa chọn folder.';
  } catch (_) {
    dom.folderState.textContent = '';
  }
}

dom.pickFolder.addEventListener('click', async () => {
  if (!window.showDirectoryPicker) {
    dom.folderState.textContent = 'Trình duyệt không hỗ trợ File System Access.';
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'fb-archive' });
    await putKv('dirHandle', handle);
    settings.export.downloadMode = 'folder';
    const modeSelect = document.querySelector('[data-path="export.downloadMode"]');
    if (modeSelect) modeSelect.value = 'folder';
    scheduleSave();
    await showFolderState();
  } catch (err) {
    if (String(err?.name) !== 'AbortError') {
      dom.folderState.textContent = 'Lỗi chọn folder: ' + String(err?.message || err);
    }
  }
});

/* ----------------------------------------------------------------- actions */

function send(type, payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (resp) => {
        resolve(resp || { ok: false, error: chrome.runtime.lastError?.message || 'Không có phản hồi' });
      });
    } catch (err) {
      resolve({ ok: false, error: String(err?.message || err) });
    }
  });
}

async function refreshStatus() {
  dom.status.textContent = 'Đang đọc…';
  const resp = await send('ARCHIVE_STATUS');
  if (!resp.ok) {
    dom.status.textContent = 'Không đọc được trạng thái: ' + (resp.error || 'lỗi');
    return;
  }
  const r = resp.result || {};
  dom.status.textContent =
    `Media đã lưu: ${(r.mediaCount || 0).toLocaleString('vi-VN')} file (~${r.mediaMB || 0} MB)\n` +
    `Tin đã ghi: ${(r.records || 0).toLocaleString('vi-VN')} | chưa export: ${r.pending || 0}`;
};

async function refreshLog() {
  const res = await chrome.storage.local.get(LOG_KEY);
  const list = Array.isArray(res[LOG_KEY]) ? res[LOG_KEY] : [];
  dom.log.textContent = list.length
    ? list
        .map((entry) => {
          const time = new Date(entry.at).toLocaleString('vi-VN');
          return `${time}  ${entry.text}`;
        })
        .join('\n')
    : '(chưa có gì)';
}

dom.exportAll.addEventListener('click', async () => {
  dom.exportAll.disabled = true;
  dom.exportAll.textContent = 'Đang xuất…';
  const resp = await send('ARCHIVE_RUN_EXPORT', { mode: 'full' });
  dom.exportAll.disabled = false;
  dom.exportAll.textContent = 'Xuất toàn bộ ngay';
  dom.status.textContent = resp.ok
    ? `Đã xuất ${resp.result?.exported || 0} tin, ${resp.result?.parts || 0} phần.`
    : 'Xuất lỗi: ' + (resp.error || 'không rõ');
  refreshLog();
  refreshStatus();
});

dom.testUpload.addEventListener('click', async () => {
  dom.testUpload.disabled = true;
  const resp = await send('ARCHIVE_TEST_UPLOAD');
  dom.testUpload.disabled = false;
  if (resp.ok) {
    const detail = resp.result?.detail;
    dom.status.textContent = Array.isArray(detail) && detail.length
      ? `Đã gửi test tới ${resp.result.sent} đích:\n` + detail.join('\n')
      : `Đã gửi file test tới ${resp.result?.sent || 0} đích.`;
  } else {
    dom.status.textContent = 'Gửi test lỗi: ' + (resp.error || 'không rõ');
  }
  refreshLog();
});

dom.clearArchive.addEventListener('click', async () => {
  if (!confirm('Xoá toàn bộ media bytes đã lưu (không xoá tin nhắn)?')) return;
  const resp = await send('ARCHIVE_CLEAR');
  dom.status.textContent = resp.ok ? 'Đã xoá media bytes.' : 'Lỗi: ' + (resp.error || '');
  refreshStatus();
});

dom.refreshStatus.addEventListener('click', () => {
  refreshStatus();
  refreshLog();
});

dom.grantWebdav.addEventListener('click', async () => {
  const urlInput = document.querySelector('[data-path="upload.webdav.url"]');
  let raw = (urlInput?.value || '').trim();
  if (!raw) {
    dom.status.textContent = 'Nhập URL WebDAV trước.';
    return;
  }
  // Tự thêm https:// khi người dùng chỉ dán hostname (vd dav.pikpak.ai).
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    raw = 'https://' + raw;
    urlInput.value = raw;
    scheduleSave();
  }
  try {
    const origin = new URL(raw).origin + '/*';
    const granted = await chrome.permissions.request({ origins: [origin] });
    dom.status.textContent = granted ? `Đã cấp quyền ${origin}` : 'Bạn chưa đồng ý cấp quyền.';
  } catch (err) {
    dom.status.textContent = 'Lỗi xin quyền: ' + String(err?.message || err);
  }
});

/* ------------------------------------------------------- webdav browser */

function webdavCreds() {
  const pick = (path) => {
    const el = document.querySelector(`[data-path="${path}"]`);
    return el ? el.value.trim() : '';
  };
  return {
    url: pick('upload.webdav.url'),
    username: pick('upload.webdav.username'),
    password: document.querySelector('[data-path="upload.webdav.password"]')?.value || ''
  };
}

function setWebdavUrl(url) {
  const el = document.querySelector('[data-path="upload.webdav.url"]');
  if (el) {
    el.value = url;
    scheduleSave();
  }
  renderWebdavBrowser({ cwd: url.replace(/\/+$/, '') + '/', folders: [] });
  browseWebdav(url);
}

async function browseWebdav(url) {
  const creds = webdavCreds();
  if (url) creds.url = url;
  if (!creds.url) {
    dom.status.textContent = 'Nhập URL WebDAV trước.';
    return;
  }
  dom.webdavCwd.textContent = 'Đang đọc…';
  dom.webdavBrowser.hidden = false;
  dom.webdavBrowser.innerHTML = '';
  const resp = await send('ARCHIVE_JOB', { job: Object.assign({ type: 'webdav-ls' }, creds) });
  if (!resp.ok) {
    dom.webdavCwd.textContent = '';
    dom.status.textContent = 'Không đọc được folder: ' + (resp.error || 'lỗi');
    return;
  }
  renderWebdavBrowser(resp.result);
}

function renderWebdavBrowser(result) {
  const cwd = result.cwd || '';
  dom.webdavCwd.textContent = cwd;
  const box = dom.webdavBrowser;
  box.innerHTML = '';
  const mk = (label, nextUrl) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (nextUrl) browseWebdav(nextUrl);
      else setWebdavUrl(cwd);
    });
    box.appendChild(btn);
  };
  // Lên 1 cấp (trừ khi đang ở root của host).
  try {
    const u = new URL(cwd);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length) {
      parts.pop();
      mk('⬆ .. (lên 1 cấp)', u.origin + '/' + parts.map(encodeURIComponent).join('/') + (parts.length ? '/' : ''));
    }
  } catch (_) {}
  for (const folder of result.folders || []) {
    mk('📁 ' + folder.name, folder.url + '/');
  }
  // Chọn chính folder đang xem.
  const choose = document.createElement('button');
  choose.type = 'button';
  choose.textContent = '✔ Lưu vào folder này';
  choose.addEventListener('click', () => {
    const el = document.querySelector('[data-path="upload.webdav.url"]');
    if (el) {
      el.value = cwd;
      scheduleSave();
    }
    dom.webdavCwd.textContent = 'Đã chọn: ' + cwd;
    box.hidden = true;
  });
  box.appendChild(choose);
}

dom.browseWebdav.addEventListener('click', () => browseWebdav(''));

for (const el of inputs()) {
  el.addEventListener('input', scheduleSave);
  el.addEventListener('change', scheduleSave);
}
for (const box of formatCheckboxes()) {
  box.addEventListener('change', scheduleSave);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'ARCHIVE_PROGRESS') {
    dom.status.textContent = message.text || '';
    refreshLog();
  }
});

(async function init() {
  const res = await chrome.storage.local.get(SETTINGS_KEY);
  settings = fbMergeArchiveSettings(res[SETTINGS_KEY] || {});
  fillForm();
  markSaved();
  await showFolderState();
  await refreshStatus();
  await refreshLog();
})();
