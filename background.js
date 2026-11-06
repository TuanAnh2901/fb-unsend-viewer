/**
 * FB Unsend Message Viewer — background.js
 * Copyright (c) 2026 binhake (https://github.com/binhake/fb-unsend-viewer)
 * Licensed under the Non-Commercial & Strict Attribution License.
 * Removing author attribution ("binhake") or unauthorized commercial use is strictly prohibited.
 */
// background.js - Service Worker quản lý Badge thông báo tin nhắn thu hồi & kiểm tra bản phát hành mới trên GitHub Releases

importScripts('archive-defaults.js');

const STORAGE_KEY_UNREAD_COUNT = 'fb_unread_unsent_count_v2';
const STORAGE_KEY_UPDATE_INFO = 'fb_unsend_update_info_v1';
const GITHUB_LATEST_RELEASE_API =
  'https://api.github.com/repos/binhake/fb-unsend-viewer/releases/latest';
const GITHUB_RELEASES_PAGE_URL = 'https://github.com/binhake/fb-unsend-viewer/releases';
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 giờ

function parseSemVer(verStr) {
  const clean = String(verStr || '')
    .trim()
    .replace(/^[vV]+/, '')
    .split('-')[0];
  if (!/^\d+(\.\d+)*$/.test(clean)) return null;
  return clean.split('.').map((n) => parseInt(n, 10) || 0);
}

function isNewerVersion(remoteVer, localVer) {
  const r = parseSemVer(remoteVer);
  const l = parseSemVer(localVer);
  if (!r || !l) return false;
  const maxLen = Math.max(r.length, l.length);
  for (let i = 0; i < maxLen; i++) {
    const rv = r[i] || 0;
    const lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

function refreshBadgeFromStorage() {
  chrome.storage.local.get([STORAGE_KEY_UNREAD_COUNT, STORAGE_KEY_UPDATE_INFO], (res) => {
    const unreadNum = Number(res[STORAGE_KEY_UNREAD_COUNT]) || 0;
    if (unreadNum > 0) {
      const text = unreadNum > 99 ? '99+' : String(unreadNum);
      chrome.action.setBadgeText({ text });
      chrome.action.setBadgeBackgroundColor({ color: '#ff4d4f' });
      return;
    }

    const updateInfo = res[STORAGE_KEY_UPDATE_INFO];
    const currentVer = chrome.runtime.getManifest().version;
    if (
      updateInfo &&
      updateInfo.latestVersion &&
      isNewerVersion(updateInfo.latestVersion, currentVer) &&
      updateInfo.dismissedVersion !== updateInfo.latestVersion
    ) {
      chrome.action.setBadgeText({ text: 'NEW' });
      chrome.action.setBadgeBackgroundColor({ color: '#0866ff' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  });
}

async function checkForGithubReleaseUpdate(force = false) {
  try {
    const currentVer = chrome.runtime.getManifest().version;
    const stored = await chrome.storage.local.get([STORAGE_KEY_UPDATE_INFO]);
    const prevInfo = stored[STORAGE_KEY_UPDATE_INFO] || {};

    if (
      !force &&
      prevInfo.checkedAt &&
      Date.now() - Number(prevInfo.checkedAt) < UPDATE_CHECK_INTERVAL_MS
    ) {
      refreshBadgeFromStorage();
      return prevInfo;
    }

    const resp = await fetch(GITHUB_LATEST_RELEASE_API, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store'
    });

    if (resp.status === 404) {
      const info = {
        checkedAt: Date.now(),
        latestVersion: currentVer,
        hasUpdate: false,
        releaseUrl: GITHUB_RELEASES_PAGE_URL,
        dismissedVersion: prevInfo.dismissedVersion || ''
      };
      await chrome.storage.local.set({ [STORAGE_KEY_UPDATE_INFO]: info });
      refreshBadgeFromStorage();
      return info;
    }

    if (!resp.ok) {
      return prevInfo;
    }

    const data = await resp.json();
    const rawTag = String(data?.tag_name || data?.name || '').trim();
    const cleanLatest = rawTag.replace(/^[vV]+/, '');
    const hasUpdate = isNewerVersion(cleanLatest, currentVer);
    const releaseUrl =
      typeof data?.html_url === 'string' && data.html_url.startsWith('https://github.com/')
        ? data.html_url
        : GITHUB_RELEASES_PAGE_URL;

    const info = {
      checkedAt: Date.now(),
      latestVersion: cleanLatest || currentVer,
      hasUpdate,
      releaseUrl,
      releaseName: String(data?.name || rawTag || '').trim(),
      dismissedVersion: prevInfo.dismissedVersion || ''
    };
    await chrome.storage.local.set({ [STORAGE_KEY_UPDATE_INFO]: info });
    refreshBadgeFromStorage();
    return info;
  } catch (_) {
    refreshBadgeFromStorage();
    return null;
  }
}

refreshBadgeFromStorage();
checkForGithubReleaseUpdate(false);

chrome.runtime.onInstalled.addListener(() => {
  checkForGithubReleaseUpdate(true);
});

chrome.runtime.onStartup.addListener(() => {
  checkForGithubReleaseUpdate(false);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === 'local' &&
    (changes[STORAGE_KEY_UNREAD_COUNT] || changes[STORAGE_KEY_UPDATE_INFO])
  ) {
    refreshBadgeFromStorage();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === 'INCREMENT_UNREAD_BADGE') {
    chrome.storage.local.get([STORAGE_KEY_UNREAD_COUNT], (res) => {
      const nextCount = (Number(res[STORAGE_KEY_UNREAD_COUNT]) || 0) + 1;
      chrome.storage.local.set({ [STORAGE_KEY_UNREAD_COUNT]: nextCount }, () => {
        refreshBadgeFromStorage();
        sendResponse({ ok: true, count: nextCount });
      });
    });
    return true;
  }

  if (message.type === 'CLEAR_UNREAD_BADGE') {
    chrome.storage.local.set({ [STORAGE_KEY_UNREAD_COUNT]: 0 }, () => {
      refreshBadgeFromStorage();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'CHECK_GITHUB_RELEASE_UPDATE') {
    checkForGithubReleaseUpdate(Boolean(message.force)).then((info) => {
      sendResponse({ ok: true, info });
    });
    return true;
  }
});

/* ========================================================================
 * Archive: media bytes, ZIP export, upload, retention.
 * Việc nặng nằm trong offscreen document (xem offscreen.js).
 * ===================================================================== */

const STORAGE_KEY_ARCHIVE_SETTINGS = 'fb_archive_settings_v1';
const STORAGE_KEY_ARCHIVE_LOG = 'fb_archive_log_v1';
const STORAGE_KEY_LAST_CAPTURE = 'fb_archive_last_capture_v1';
const STORAGE_KEY_ARCHIVE_QUEUE = 'fb_archive_queue_v1';
const UNSENT_LIST_KEY = 'fb_unsent_messages_v2';

const TICK_ALARM = 'fb_archive_tick';
const RETENTION_ALARM = 'fb_archive_retention';

let offscreenCreating = null;
let exportRunning = false;

async function getArchiveSettings() {
  const res = await chrome.storage.local.get(STORAGE_KEY_ARCHIVE_SETTINGS);
  return fbMergeArchiveSettings(res[STORAGE_KEY_ARCHIVE_SETTINGS] || {});
}

async function archiveLog(text, extra) {
  try {
    const res = await chrome.storage.local.get(STORAGE_KEY_ARCHIVE_LOG);
    const list = Array.isArray(res[STORAGE_KEY_ARCHIVE_LOG]) ? res[STORAGE_KEY_ARCHIVE_LOG] : [];
    list.unshift({ at: Date.now(), text: String(text).slice(0, 400), extra: extra || null });
    await chrome.storage.local.set({ [STORAGE_KEY_ARCHIVE_LOG]: list.slice(0, 80) });
  } catch (_) {}
}

async function ensureOffscreen() {
  if (chrome.offscreen?.hasDocument && (await chrome.offscreen.hasDocument())) return;
  if (offscreenCreating) return offscreenCreating;
  offscreenCreating = chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Dựng ZIP và tải media của archive'
    })
    .catch((err) => {
      if (!String(err?.message || err).includes('single offscreen')) throw err;
    })
    .finally(() => {
      offscreenCreating = null;
    });
  return offscreenCreating;
}

async function runArchiveJob(job) {
  await ensureOffscreen();
  // Offscreen vừa tạo có thể chưa kịp đăng ký listener → thử lại vài nhịp.
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'ARCHIVE_JOB', job });
    } catch (err) {
      // Chưa có receiver (offscreen chưa kịp đăng ký) → chờ rồi thử lại.
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 200));
      continue;
    }
    // Có phản hồi (kể cả báo lỗi job) → không retry, ném luôn để log 1 dòng.
    if (!resp) throw new Error('Offscreen không phản hồi');
    if (resp.ok === false) throw new Error(resp.error || 'Job thất bại');
    return resp.result;
  }
  throw lastError || new Error('Không gửi được job archive');
}

/* ------------------------------------------------------- telegram instant */

// Gửi thẳng từng tin gỡ vào bot Telegram: 1 tin nhắn chữ + từng media.
// URL remote để Telegram tự tải (không qua tay mình); data URL thì upload blob.
function escapeTelegramHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function instantMediaKind(url, mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'photo';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  const clean = String(url || '').split('?')[0].toLowerCase();
  if (/\.(jpg|jpeg|png|gif|bmp)$/.test(clean)) return 'photo';
  if (/\.webp$/.test(clean)) return 'photo';
  if (/\.(mp4|mov|webm)$/.test(clean)) return 'video';
  if (/\.(mp3|m4a|ogg|opus|wav)$/.test(clean)) return 'audio';
  return 'document';
}

function dataUrlToUploadBlob(url) {
  const comma = url.indexOf(',');
  const meta = /data:([^;,]+)/.exec(url.slice(0, comma));
  const mime = meta ? meta[1] : 'application/octet-stream';
  if (/;base64/i.test(url.slice(0, comma))) {
    const bin = atob(url.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { blob: new Blob([bytes], { type: mime }), mime };
  }
  return { blob: new Blob([decodeURIComponent(url.slice(comma + 1))], { type: mime }), mime };
}

async function telegramApi(tg, method, body, isForm) {
  const resp = await fetch(`https://api.telegram.org/bot${tg.botToken}/${method}`, {
    method: 'POST',
    body: isForm ? body : JSON.stringify(body),
    ...(isForm ? {} : { headers: { 'Content-Type': 'application/json' } })
  });
  if (!resp.ok) {
    throw new Error(`Telegram ${method} HTTP ` + resp.status + ' ' + (await resp.text()).slice(0, 120));
  }
  return resp.json().catch(() => ({}));
}

async function telegramInstantSendMedia(tg, url, kind) {
  const method = kind === 'photo' ? 'sendPhoto' : kind === 'video' ? 'sendVideo' : kind === 'audio' ? 'sendAudio' : 'sendDocument';
  const field = kind === 'photo' ? 'photo' : kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'document';
  // Thử đưa URL cho Telegram tự tải trước (nhanh, không tốn RAM).
  try {
    await telegramApi(tg, method, { chat_id: tg.chatId, [field]: url });
    return;
  } catch (err) {
    if (url.startsWith('data:')) throw err;
    // URL hết hạn/bị chặn → tải bytes về rồi upload (cần host_permissions của CDN).
    const fetched = await fetch(url, { credentials: 'omit' });
    if (!fetched.ok) throw err;
    const form = new FormData();
    form.append('chat_id', tg.chatId);
    form.append(field, await fetched.blob(), 'media');
    await telegramApi(tg, method, form, true);
  }
}

async function telegramInstant(record, tg) {
  const who = record.isSelf ? 'Bạn' : record.personName || record.senderName || 'Ai đó';
  const thread = record.threadName && record.threadName !== record.personName ? ` (nhóm ${record.threadName})` : '';
  const time = new Date(record.unsentAt || record.timestamp || Date.now()).toLocaleString('vi-VN');
  const lines = [`🗑 <b>${escapeTelegramHtml(who)}</b> đã thu hồi 1 tin nhắn${escapeTelegramHtml(thread)}`];
  const text = String(record.text || '').trim();
  lines.push(text ? escapeTelegramHtml(text.slice(0, 3500)) : '<i>(không có chữ)</i>');
  lines.push(`<i>${escapeTelegramHtml(time)}</i>`);
  await telegramApi(tg, 'sendMessage', {
    chat_id: tg.chatId,
    text: lines.join('\n'),
    parse_mode: 'HTML'
  });

  const attachments = Array.isArray(record.attachments) ? record.attachments.slice(0, 8) : [];
  for (const url of attachments) {
    if (typeof url !== 'string' || !url) continue;
    if (url.startsWith('data:')) {
      const { blob, mime } = dataUrlToUploadBlob(url);
      const kind = instantMediaKind(url, mime);
      const method = kind === 'photo' ? 'sendPhoto' : kind === 'video' ? 'sendVideo' : kind === 'audio' ? 'sendAudio' : 'sendDocument';
      const field = kind === 'photo' ? 'photo' : kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'document';
      const ext = mime === 'image/webp' ? 'webp' : mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : mime === 'image/gif' ? 'gif' : 'bin';
      const form = new FormData();
      form.append('chat_id', tg.chatId);
      form.append(field, blob, `photo.${ext}`);
      await telegramApi(tg, method, form, true);
    } else {
      await telegramInstantSendMedia(tg, url, instantMediaKind(url, ''));
    }
  }
}

async function pendingArchiveCount() {
  const res = await chrome.storage.local.get(UNSENT_LIST_KEY);
  const list = Array.isArray(res[UNSENT_LIST_KEY]) ? res[UNSENT_LIST_KEY] : [];
  return list.filter((r) => r && !r.exportedAt).length;
}

async function runExport(mode) {
  if (exportRunning) return { ok: false, error: 'Đang xuất, thử lại sau' };
  exportRunning = true;
  try {
    const result = await runArchiveJob({ type: 'export', mode: mode || 'incremental' });
    // Không có tin mới (exported === 0) → không ZIP, không upload, chỉ báo cho UI biết.
    if (!result.exported) {
      return { ok: true, result, isEmpty: true };
    }
    await archiveLog(
      `Export xong: ${result.exported} tin, ${result.parts} phần` +
        (result.media ? `, ${result.media} media` : '')
    );
    return { ok: true, result };
  } catch (err) {
    await archiveLog('Export lỗi: ' + String(err?.message || err));
    return { ok: false, error: String(err?.message || err) };
  } finally {
    exportRunning = false;
  }
}

async function archiveTick() {
  const settings = await getArchiveSettings();
  if (!settings.export.auto) return;
  const pending = await pendingArchiveCount();
  if (!pending) return;
  const res = await chrome.storage.local.get(STORAGE_KEY_LAST_CAPTURE);
  const lastCapture = Number(res[STORAGE_KEY_LAST_CAPTURE]) || 0;
  const idleMs = Math.max(1, Number(settings.export.idleMinutes) || 10) * 60000;
  const batchSize = Math.max(1, Number(settings.export.batchSize) || 5);
  if (pending >= batchSize || Date.now() - lastCapture >= idleMs) {
    await runExport('incremental');
  }
}

async function archiveRetention() {
  try {
    const result = await runArchiveJob({ type: 'retention' });
    if (result?.removed) await archiveLog(`Dọn media: ${result.removed} file, còn ${result.totalMB}MB`);
  } catch (_) {}
}

async function ensureArchiveAlarms() {
  const settings = await getArchiveSettings();
  chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(RETENTION_ALARM, { periodInMinutes: 60 });
  if (settings.export.auto) await chrome.storage.local.set({ [STORAGE_KEY_LAST_CAPTURE]: Date.now() });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(STORAGE_KEY_ARCHIVE_SETTINGS, (res) => {
    if (!res[STORAGE_KEY_ARCHIVE_SETTINGS]) {
      chrome.storage.local.set({
        [STORAGE_KEY_ARCHIVE_SETTINGS]: fbMergeArchiveSettings({})
      });
    }
  });
  ensureArchiveAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  ensureArchiveAlarms();
});

ensureArchiveAlarms();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) archiveTick();
  else if (alarm.name === RETENTION_ALARM) archiveRetention();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === 'ARCHIVE_RECORD') {
    const record = message.record || {};
    chrome.storage.local.set({ [STORAGE_KEY_LAST_CAPTURE]: Date.now() });
    (async () => {
      const settings = await getArchiveSettings();
      const tg = settings.upload?.telegram || {};
      // Push tức thì từng tin gỡ qua Telegram (chữ + media), không chờ gom lô ZIP.
      // ARCHIVE_RECORD chỉ được content script gửi khi tin gỡ là mới nên không lo trùng.
      if (settings.upload.enabled && tg.instant !== false && tg.botToken && tg.chatId) {
        try {
          await telegramInstant(record, tg);
        } catch (err) {
          await archiveLog('Telegram instant lỗi: ' + String(err?.message || err));
        }
      }
      if (!settings.media.cacheRemoteBytes) return;
      const items = (record.attachments || [])
        .filter((url) => typeof url === 'string' && !url.startsWith('data:'))
        .slice(0, 8)
        .map((url) => ({ url }));
      if (!items.length) return;
      try {
        await runArchiveJob({ type: 'fetch-media', messageId: record.messageId, items });
      } catch (err) {
        await archiveLog('Lưu media lỗi: ' + String(err?.message || err));
      }
    })();
    sendResponse({ ok: true });
    // Có tin/gỡ mới → kiểm tra ngưỡng xuất ngay, khỏi chờ alarm 1 phút.
    // archiveTick tự bỏ qua khi không có tin chưa export nên không spam ZIP.
    archiveTick();
    return true;
  }

  if (message.type === 'ARCHIVE_RUN_EXPORT') {
    runExport(message.mode === 'full' ? 'full' : 'incremental').then(sendResponse);
    return true;
  }

  if (message.type === 'ARCHIVE_STATUS') {
    runArchiveJob({ type: 'status' })
      .then(async (result) => {
        const pending = await pendingArchiveCount();
        sendResponse({ ok: true, result: Object.assign({}, result, { pending }) });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (message.type === 'ARCHIVE_TEST_UPLOAD') {
    runArchiveJob({ type: 'test-upload' })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (message.type === 'ARCHIVE_CLEAR') {
    runArchiveJob({ type: 'clear' })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (message.type === 'ARCHIVE_LOG_PROGRESS') {
    archiveLog(message.text || '');
    sendResponse({ ok: true });
    return true;
  }

  // Offscreen document chỉ có chrome.runtime → proxy storage qua SW.
  if (message.type === 'ARCHIVE_STORE_GET') {
    chrome.storage.local.get(message.keys, (result) => sendResponse({ ok: true, result }));
    return true;
  }

  if (message.type === 'ARCHIVE_STORE_SET') {
    chrome.storage.local.set(message.obj || {}, () => sendResponse({ ok: true }));
    return true;
  }
});

