# Thiết kế archive: TTL, ZIP tự động, upload, Options

Ngày: 2026-11-06. Trạng thái: đã triển khai v1.3.0, test E2E pass.

## 1. Thời hạn lưu (đo từ code)

| Thứ | Nơi | TTL |
| --- | --- | --- |
| Tin đã bắt (chưa gỡ) | `fb_captured_messages_v2` | Không hết hạn, cắt 500 tin (FIFO) |
| Tin đã gỡ | `fb_unsent_messages_v2` | Không hết hạn, không cap |
| Bridge cứu hộ | localStorage FB `fb_unsend_orphaned_bridge_v1` | 500 recent + 200 unsent, quota 5–10MB |
| Ảnh | base64 trong record | Sống bằng tuổi record |
| Video/audio | Chỉ URL CDN | Chết theo chữ ký `oe=` (giờ–ngày) |
| Toàn bộ | `chrome.storage.local` | Mất khi gỡ extension / xoá profile |

Kết luận: chỉ ảnh là bền. Muốn giữ video/audio phải tải bytes trong vài giờ đầu.

## 2. Kiến trúc: SW + offscreen document

- `background.js`: queue, alarm mỗi phút + retention mỗi giờ, điều phối job.
- `offscreen.js`: fetch media, IndexedDB `fb_archive` (stores `media`, `urlmap`, `kv`),
  dựng ZIP bằng `CompressionStream('deflate-raw')` viết tay (không dependency),
  tải file, upload 4 đích.
- `content.js`: gửi `ARCHIVE_RECORD` (chỉ URL remote, không gửi base64),
  áp `media.imageMaxDim/imageQuality` từ settings, retention xoá record đã export quá hạn.
- `options.html/css/js`: form toàn bộ settings + trạng thái + log + test upload.
- `archive-defaults.js`: defaults dùng chung 3 nơi.

Offscreen chỉ có `chrome.runtime` (probe: `downloads`/`storage` đều `undefined`)
nên storage đi qua SW (`ARCHIVE_STORE_GET/SET`), tải file dùng thẻ `<a download>`.
Hệ quả: chế độ downloads luôn vào Downloads gốc, bỏ qua subdir.

## 3. Pipeline

1. Capture → SW enqueue `fetch-media` (nếu `cacheRemoteBytes`) → IDB dedupe theo sha256.
2. Đủ `batchSize` hoặc quá `idleMinutes` → `export` incremental (điều kiện `!exportedAt`).
3. ZIP: `manifest.json` + `chats/<slug>/<ngày>/messages.{json,txt}` + `media/<hash>.<ext>`.
   Ảnh data URL giải mã thẳng vào ZIP (không qua IDB). Media thiếu ghi URL + lý do, vẫn export.
4. Cắt phần theo `splitMB` (theo tin, `partNofM`, manifest riêng). Giới hạn 3.5GB/part.
5. `deliver`: ghi đĩa (`downloads`/`folder`/`none`) rồi upload từng đích đã cấu hình.
   Chỉ set `exportedAt` khi TẤT CẢ đích xong → retry tự nhiên, không trùng.
6. Retention (hourly + mỗi lần load settings): xoá blob mồ côi >7 ngày,
   xoá blob đã export khi vượt trần (không bao giờ xoá blob chưa export),
   xoá record đã export quá `maxAgeDays`.

## 4. Upload (4 đích, interface chung)

Telegram bot (`sendDocument`, ≤50MB) → GitHub contents API (≤100MB/file) →
WebDAV PUT (cần `optional_host_permissions` xin lúc nhập URL) →
Drive multipart upload (token dán tay, beta). `test-upload` gửi file text tới mọi đích đã cấu hình.

## 5. Test đã chạy (Playwright, profile thật)

- Options render, formats `[json,txt]`, status đọc được.
- Seed 1 tin + ảnh webp → export full → `exported:1, parts:1, media:1`.
- ZIP: `manifest.json`, `chats/nhom-a/2026-11-06/messages.{json,txt}`,
  `media/<hash>.webp`; counts `{messages:1, groups:1, media:1, missingMedia:0}`.
- 0 page error / 0 console error.

## 6. Giới hạn đã biết

- Record cũ thiếu `exportedAt` → đợt export đầu sẽ coi là "mới" (đúng ý đồ full snapshot).
- Ảnh trong ZIP là file gốc CDN khi fetch được, fallback canvas 2048px.
- `downloadSubdir` không có tác dụng ở chế độ downloads (giới hạn offscreen).
- Drive token hết hạn ~1h, phải dán lại.
- transfer.it/MEGA: không public API → thay bằng WebDAV generic.
