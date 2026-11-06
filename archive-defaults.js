/**
 * archive-defaults.js — settings mặc định dùng chung cho background, offscreen, options.
 * Nạp bằng importScripts() (SW) và <script> (trang extension).
 */
(function () {
  const DEFAULTS = {
    version: 1,
    media: {
      // Tải bytes gốc (ảnh/video/audio) từ CDN ngay khi bắt được tin.
      // Ảnh base64 trong record vẫn giữ để render chat; bytes gốc dùng cho ZIP.
      cacheRemoteBytes: true,
      maxFileMB: 200,
      imageMaxDim: 2048,
      imageQuality: 0.92,
      imageFormat: 'image/webp'
    },
    retention: {
      maxAgeDays: 30,
      maxTotalMB: 2048
    },
    export: {
      auto: true,
      batchSize: 5,
      idleMinutes: 10,
      formats: ['json', 'txt'],
      compression: 'deflate',
      downloadMode: 'downloads',
      downloadSubdir: 'fb-unsend-archive',
      splitMB: 45
    },
    upload: {
      enabled: false,
      telegram: { botToken: '', chatId: '' },
      github: { token: '', repo: '', branch: 'main', basePath: 'fb-unsend-archive/' },
      webdav: { url: '', username: '', password: '' },
      gdrive: { token: '', folderId: '' }
    }
  };

  function isPlainObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v);
  }

  function merge(base, patch) {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!isPlainObject(patch)) return out;
    for (const key of Object.keys(patch)) {
      const bv = out[key];
      const pv = patch[key];
      out[key] = isPlainObject(bv) && isPlainObject(pv) ? merge(bv, pv) : pv;
    }
    return out;
  }

  self.FB_ARCHIVE_DEFAULTS = DEFAULTS;
  self.fbMergeArchiveSettings = (patch) => merge(DEFAULTS, patch || {});
})();
