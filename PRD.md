# PRD — WebObsidian

> Product Requirements Document
> Phiên bản: 1.10 · Cập nhật: 2026-07-14 · Trạng thái: Draft
> Changelog 1.10 (safe vault pairing + bootstrap traffic): mỗi local vault không liên quan phải map 1:1 vào một
> server vault đã tạo/register trước; code pairing bind server vault đang chọn và UI phải hiện rõ name/id/sequence,
> cảnh báo code không tự tạo vault và yêu cầu confirm trước khi hội tụ vào vault đã có dữ liệu. Device name không phải
> vault name vì nhiều desktop/mobile device có thể cố ý share cùng server vault. Rate limit tách control/test khỏi
> transfer bootstrap: handshake/Test có bucket riêng; data-plane mặc định 600 request/phút/device với Retry-After,
> trong khi pairing vẫn giới hạn chặt. Sync Protocol 1.0 request shape không đổi.
> Changelog 1.9 (first-class multi-vault): một process WebObsidian quản lý nhiều vault độc lập và đồng thời.
> Mỗi vault có stable `vaultId`, tên/path/config, SyncCoordinator+journal/device/blob/conflict riêng, search/link/file
> index, watcher, Git backup, plugin state, workspace và public-share namespace riêng. Auth người dùng vẫn global;
> web/session API chọn vault bằng `X-WebObsidian-Vault-Id` (thiếu header dùng default vault để tương thích), còn
> device token tự bind đúng một vault nên Sync Protocol 1.0 không đổi. UI có vault switcher và URL
> `/vault/<vaultId>/note/...`/`/vault/<vaultId>/graph`; URL cũ dùng default vault. Migration settings v3→v4 giữ
> nguyên vault/data sync hiện có làm default, không move/re-hash dữ liệu; vault mới dùng `data/vaults/<vaultId>/`.
> Unregister chỉ bỏ registry/runtime, tuyệt đối không xoá thư mục vault; root overlap/symlink escape bị từ chối.
> Changelog 1.8 (npm owner scope): theo quyết định trực tiếp của người dùng, shared package được publish dưới
> scope cá nhân `@picassio/sync-core` thay vì yêu cầu tạo npm organization `@webobsidian`. Server, browser,
> plugin và headless dùng cùng package name mới; `web-vault-sync` vẫn là package public unscoped. Thay đổi này
> chỉ đổi package distribution identity, không đổi Sync Protocol 1.0, runtime authority hay compatibility.
> Changelog 1.7 (container distribution): theo quyết định vận hành của người dùng, WebObsidian và headless
> client **không publish container lên GHCR/registry**. Dockerfiles vẫn là release artifacts được CI build/smoke
> cho amd64/arm64 với SBOM/provenance validation; operator clone source/tag đã kiểm chứng và tự build image.
> npm publication của `sync-core`/headless và Obsidian Community publication vẫn giữ nguyên phạm vi.
> Changelog 1.6 (stable-write hardening): mọi update/rename/delete/copy/Agent mutation của entry hiện có
> bắt buộc `baseRevision`/`If-Match`; compatibility fallback chọn revision hiện tại đã bị xoá để không còn
> cửa silent overwrite. Agent mutation cũng bắt buộc monotonic `clientSequence` + `idempotencyKey`. Settings
> schema v3 thêm `sync.bootstrapState`; vault hiện có fail closed ở `backup-required` cho tới full-backup
> migration. Browser credential là httpOnly device cookie không lộ cho JS; JSON revision projection đổi sang
> journal-rebuildable O(1) write path với checkpoint maintenance/shutdown để đạt scale gate.
> Changelog 1.5 (FR-13 — Central Sync, native Obsidian plugin & Linux headless client): WebObsidian
> trở thành **authoritative vault server** với protocol sync versioned dùng revision/hash, global event
> sequence, tombstone, idempotency và conflict-safe conditional write. Web browser, plugin Obsidian native
> và daemon Linux dùng cùng `sync-core`; WebSocket chỉ báo sequence mới, REST change-feed đảm bảo reconnect.
> Git chuyển vai trò sang backup/version history, không còn được mô tả là true/live sync. Roadmap chi tiết:
> `docs/SYNC_ROADMAP.md`.
> Changelog 1.4 (FR-2 — Audio/Video embed: phát được như Obsidian, theo yêu cầu người dùng): embed
> `![[clip.mp4]]` / `![[song.mp3]]` giờ render **trình phát HTML5 thật** (`<video controls>` / `<audio
> controls>`) ở **cả** Live Preview, Reading view và trang public share — trước đây chỉ hiện link xanh.
> Mở thẳng file media từ file tree cũng hiện player (như ảnh). Hỗ trợ video: `mp4/webm/ogv/mov/mkv`,
> audio: `mp3/wav/m4a/3gp/flac/ogg/oga/opus` (khớp bộ extension của Obsidian). Size param `![[clip.mp4|W]]`
> đặt chiều rộng video. **Quan trọng:** route serve binary (`GET /api/files/content`, raw share) nay
> **stream + hỗ trợ HTTP Range** (206 Partial Content) nên thanh tua/seek video hoạt động và Safari phát
> được — thay vì đọc cả file vào RAM. MIME map + bộ extension gom về `server/services/mime.ts` &
> `web/lib/media.ts`. Không thêm API mới.
> Changelog 1.3 (FR-1 — File explorer header toolbar parity Obsidian, theo yêu cầu người dùng): header sidebar
> **Files** bổ sung đủ nút như Obsidian: **New note**, **New canvas**, **New folder**, **Change sort order**
> (dropdown 6 kiểu: File name A→Z/Z→A, Modified time new↔old, Created time new↔old), **Auto reveal current
> file** (toggle: tự mở folder cha + cuộn tới file đang xem), **Collapse all / Expand all**. Sort theo thời gian
> nhanh nhờ **stat cache trong RAM** ở server (`listTree` fill 1 lần, watcher invalidate file đổi → 0 syscall
> ở steady-state); `TreeNode` thêm `ctime`. Không thêm API mới (tree cũ nay kèm `mtime`/`ctime`). Canvas (FR-12):
> fix Android Chrome double-tap edit không lưu được text (commit qua doc-level pointerdown + double-tap detect).
> Changelog 1.2 (FR-2 — Ảnh: resize + zoom, theo yêu cầu người dùng): ảnh nhúng trong note giờ **kéo để
> resize** (2 thanh handle trái/phải hiện khi hover trong Live Preview) — ghi lại kích thước vào source dưới
> dạng size param Obsidian: `![[img|W]]` cho wikilink embed, `![alt|W](url)` cho ảnh markdown chuẩn (giữ tỉ lệ,
> height auto). Size param `|300` / `|300x200` nay áp dụng **cả** ảnh markdown `![](…)` (trước chỉ `![[…]]`),
> ở cả Live lẫn Reading. **Click ảnh → lightbox toàn màn hình** (cả 2 mode): cuộn chuột/pinch để zoom (theo
> con trỏ/tâm 2 ngón), kéo/1-ngón để pan, double-click reset, Esc hoặc click nền để đóng. Không thêm API mới.
> Changelog 1.1 (FR-1 — Trash UI + chế độ xoá, theo yêu cầu người dùng): bổ sung **giao diện Trash** để xem,
> **khôi phục (Restore)** và **xoá vĩnh viễn** từng file đã xoá, cùng nút **Empty trash**. Mở Trash từ nút 🗑
> trên header sidebar Files hoặc command palette ("Open trash"). Thêm setting `vault.deleteMode`
> (`trash` = chuyển vào `.trash` khôi phục được [mặc định] · `permanent` = xoá vĩnh viễn ngay) trong
> Settings → Vault & Files. API mới: `GET /api/files/trash`, `POST /api/files/trash/restore`,
> `DELETE /api/files/trash/item`, `DELETE /api/files/trash`. Restore tự né trùng tên (suffix `.restored-<ts>`)
> và dọn thư mục rỗng trong `.trash`; mọi thao tác trash đều guard path traversal (chỉ tác động trong `.trash`).
> Changelog 1.0 (FR-12 — Canvas, theo yêu cầu người dùng): clone tính năng **Canvas** của Obsidian. Khung vẽ
> vô hạn (pan/zoom) chứa các node (text markdown, file embed/link tới note hoặc ảnh, link URL, group) và các
> edge nối cạnh node có mũi tên + nhãn. Đọc/ghi đúng định dạng mở **JSON Canvas** (`.canvas`, tương thích
> Obsidian). Tạo/di chuyển/resize/đổi màu/xóa node, nối edge bằng kéo từ chấm cạnh, multi-select + marquee,
> double-click nền tạo text node, double-click text node để sửa. Autosave debounce như editor (qua store
> `content`/`save`). Tạo canvas mới: context menu file tree + command palette. Không thêm API mới (dùng
> `/api/files/content`).
> Changelog 0.9 (FR-1 — Copy/Cut/Paste trong context menu file tree theo yêu cầu người dùng): menu chuột phải
> file/folder bổ sung **Copy**, **Cut**, **Paste** (clipboard session-local, không persist/broadcast). Cut dùng
> `rename` (move) cho cả file lẫn folder; Copy dùng endpoint mới **POST `/api/files/copy`** copy đệ quy file/folder
> (qua `fs.cp` recursive, reindex các `.md` mới). Paste vào folder đích (folder được click hoặc thư mục cha của file):
> tự đặt tên không trùng (`… copy`/`… copy N`), chặn dán folder vào chính nó/thư mục con, dán Cut vào đúng chỗ cũ là
> no-op; row bị Cut làm mờ chờ dán; mục **Paste** chỉ hiện khi clipboard có dữ liệu. Right-click vùng trống
> file tree cũng ra context menu của app (New note / New folder / Paste vào vault root) thay vì menu native trình duyệt.
> Changelog 0.8 (FR-2/FR-4 — menu ⋯ parity Obsidian theo yêu cầu người dùng): menu **More options (⋯)**
> dựng lại theo cấu trúc Obsidian Desktop và bổ sung: **Backlinks in document** + **Open linked view**
> (Backlinks/Outgoing links/Outline → mở right panel); **Open in new window** (mở deep-link `/note/<path>`
> ở tab mới); **Add file property** (chèn property rỗng vào frontmatter YAML); **Find…** trong note
> (`@codemirror/search`, ⌘F/⌘⇧F/⌘G); **Export to PDF…** (Reading view + `window.print()` qua CSS
> `@media print`); **Reveal file in navigation** (mở folder tổ tiên + scroll/flash row trong file tree);
> **Open version history** (FR-4): `git log`/`git show` cho từng file qua `/api/git/log|/show`, modal liệt
> kê commit + preview + Restore version. Bỏ "Reveal in Finder"/"Open in default app" (desktop-only).
> Changelog 0.7 (FR-10 UX theo phản hồi): menu "Copy public link" → "Share…" mở **Share dialog**
> per-note (tạo link, copy URL, toggle bật/tắt, đặt/đổi password, xoá link) ở cả context menu file
> tree lẫn menu ⋯ của pane; note đang share public có **icon globe** (màu accent) cạnh tên trong
> file tree; danh sách share cache trong store (đồng bộ giữa dialog, Settings → Sharing và badge).
> Changelog 0.6 (FR-9 deploy hardening cho open-source self-host): tham số deploy chuyển hết sang `.env`
> (`VAULT_HOST_PATH`/`HTTP_BIND`/`HTTP_PORT`/`WEBOBSIDIAN_WATCH`) nên `docker-compose.yml` không bị clobber
> khi redeploy; file watcher tự fallback polling khi đụng inotify limit; healthcheck `start_period=90s`.
> Changelog 0.5: Graph (FR-2) thêm tìm node theo keywords — ô search nổi trên Graph view, gõ keywords
> hiện danh sách note/tag khả dĩ (match label/path, tag luôn xếp trước, sau đó prefix > label > path + degree), click
> (hoặc Enter = kết quả đầu) bay camera (fly animation pan+zoom mượt) tới node và highlight node đó
> (node sáng màu accent, phần không liên kết mờ đi) tới khi di chuột; Esc đóng danh sách.
> Changelog 0.4: thêm FR-11 (Mobile / responsive UI cho smartphone màn hình cảm ứng) — sidebar trái/phải
> thành drawer overlay trượt (hamburger + edge-swipe + backdrop), workspace full-width, mobile editing
> toolbar trên bàn phím (bold/italic/heading/list/checkbox/link/…), touch target ≥44px, safe-area insets.
> Tham chiếu UX Obsidian Mobile app. Cập nhật NFR khả dụng.
> Changelog 0.3: mở rộng FR-2 theo phản hồi người dùng — (a) menu "More options" (⋯) trên header mỗi pane
> (Split right/Split down, Copy screenshot cho Graph, Bookmark, Copy public link, Make a copy, Rename/Move/
> Copy path/Delete, Close tab/Close others) giống Obsidian; (b) Right sidebar đại tu thành tab strip icon
> (Backlinks · Outgoing links · Tags · Outline) với Linked mentions + **Unlinked mentions** và **Outgoing
> links** (resolved/unresolved) — trước đó chỉ có 2 panel cố định.
> Changelog 0.2: thêm FR-10 (deep-link URL `/note/...` + public share link readonly + trang quản lý share tập trung), API `/api/shares` + `/public/shares`, data model `data/shares.json`.

---

## 1. Tổng quan

**WebObsidian** là một web app self-hosted clone toàn diện chức năng của [Obsidian](https://obsidian.md), chạy trên server (Docker), thao tác trực tiếp trên một thư mục Vault chứa các file Markdown. Mục tiêu là cho phép truy cập và chỉnh sửa "second brain" của người dùng từ bất kỳ trình duyệt nào, đồng thời mở API cho AI Agent tương tác.

### 1.1 Mục tiêu (Goals)
- Trải nghiệm soạn thảo/đọc Markdown tương đương Obsidian desktop (editor, live preview, wikilinks, graph, backlinks).
- Mỗi Vault là một thư mục thực trên server; một process có thể quản lý nhiều vault độc lập, đồng thời — tương thích 100% với vault Obsidian hiện có (kể cả `.obsidian/`).
- **Central Sync** an toàn giữa web, Obsidian native và Linux headless client qua revisioned protocol;
  phát hiện stale write/conflict, reconnect theo ordered change journal, hỗ trợ attachment lớn.
- Git/GitHub + Git LFS giữ vai trò **backup, version history và explicit import/export**, không phải live sync.
- **Login gate** đơn giản: một mật khẩu duy nhất bảo vệ toàn bộ app.
- Cấu hình lưu trong **file `.json` thuần** (không cần DB engine).
- **API Gate** với API key để AI Agent đọc/ghi/tìm kiếm vault qua REST.
- **QMD search engine** tích hợp sẵn: full-text + fielded search nhanh trên toàn vault.
- Hỗ trợ cài **Obsidian community plugins** giống app chuẩn (qua plugin loader + Obsidian API shim).
- Đóng gói **Docker stack** chạy 1 lệnh.

### 1.2 Ngoài phạm vi (Non-goals — v1)
- Realtime multi-user collaborative editing (CRDT). v1 là single-user (1 password).
- Obsidian Sync/Publish proprietary protocol (thay bằng FR-13 Central Sync tự host; Git chỉ backup).
- Mobile native app (chỉ responsive web).
- 100% tương thích mọi plugin dùng Electron/Node API nội bộ (chỉ hỗ trợ subset Obsidian API phổ biến).

### 1.3 Người dùng mục tiêu
- Cá nhân tự host knowledge base, muốn truy cập từ mọi thiết bị qua web.
- Người dùng muốn AI Agent đọc/ghi vault qua API an toàn.

---

## 2. Kiến trúc hệ thống

```
┌────────────────────── Clients dùng Sync Protocol v1 ──────────────────────┐
│ Browser SPA │ Native Obsidian plugin │ Linux headless daemon │ Agent API │
└───────────────▲───────────────────────────────┬───────────────────────────┘
                │ revisioned REST + authenticated WebSocket wake-up
┌───────────────┴───────────────────────────────▼───────────────────────────┐
│                    Server (Node + Express + TypeScript)                   │
│ Auth │ SyncCoordinator │ Vault FS │ Journal/Revisions │ QMD │ API │ Plugin│
└───┬──────────────┬──────────────┬───────────────┬────────────────────────┘
    │              │              │               │
 settings.json   Vault dir    data/sync/*.json   Git backup + LFS
 (JSON cfg)      (.md+attach) (revision/journal) (version history/export)
```

### 2.1 Tech stack
| Layer | Lựa chọn | Lý do |
|-------|----------|-------|
| Backend | Node 20+, Express, TypeScript | Đồng nhất ngôn ngữ, hệ sinh thái git/markdown phong phú |
| Frontend | React + Vite + TypeScript | Build nhanh, SPA |
| Editor | CodeMirror 6 | Engine soạn thảo của chính Obsidian |
| Markdown | unified/remark + rehype | Render an toàn, hỗ trợ plugin |
| Search | QMD (module nội bộ trên nền MiniSearch) | Full-text + fielded, in-process, không cần service ngoài |
| Central Sync | TypeScript `sync-core` + REST/WebSocket | Revision-safe, reconnect được, dùng chung web/plugin/headless |
| Backup | simple-git + git-lfs | Snapshot/version history và explicit import/export |
| Auth | Mật khẩu hash (scrypt) + JWT cookie | Đơn giản, không cần DB |
| Storage cfg | `data/settings.json` | Yêu cầu "JSON thuần" |
| Container | Docker + docker-compose | Deploy 1 lệnh |

### 2.2 Layout thư mục dự án
```
webobsidian/
├── packages/
│   └── sync-core/    # protocol types, hashing, conflict/offline queue engine dùng chung
├── clients/
│   └── headless/     # Linux CLI/daemon + systemd/Docker packaging
├── server/           # API backend
│   └── src/
│       ├── routes/       # auth, files, search, sync, api(agent), plugins
│       ├── services/     # vault, search(QMD), git, settings, auth, plugins
│       ├── middleware/   # auth guard, apikey guard, error handler
│       └── plugins/      # Obsidian API shim + loader
├── web/              # React SPA
│   └── src/
│       ├── components/   # FileTree, Editor, Preview, SearchPanel, Settings…
│       ├── lib/          # api client, store, markdown
│       └── styles/
├── data/             # runtime: settings.json, apikeys, sessions (gitignored)
├── docs/
├── docker-compose.yml
└── Dockerfile
```

---

## 3. Yêu cầu chức năng (Functional Requirements)

### FR-1 · Vault management
- Quản lý nhiều Vault trong một process: list/register/rename/unregister, chọn default và chuyển vault tức thời trong
  UI. Mỗi vault có stable `vaultId`, display name và path/config riêng. Migration giữ vault hiện có làm default.
  Unregister không bao giờ xoá file; không cho unregister vault cuối cùng; path phải nằm trong `allowedRoots`, là
  thư mục thật (không symlink root), và không được trùng/lồng/bao một vault đã đăng ký.
- Chọn/đổi thư mục Vault qua Settings (đường dẫn server-side, có folder browser an toàn trong allowed roots).
- CRUD file & folder: tạo, đọc, ghi, đổi tên, di chuyển, xoá. Chế độ xoá cấu hình qua
  `vault.deleteMode`: `trash` (→ `.trash`, khôi phục được — mặc định) hoặc `permanent` (xoá hẳn).
- **Trash**: giao diện xem các file đã xoá, **Restore** về vị trí gốc, **xoá vĩnh viễn** từng file, **Empty
  trash**. Trash ẩn khỏi file tree (dotfile) và khỏi watcher; mở qua nút 🗑 header Files hoặc command palette.
- **Copy/Cut/Paste** trên context menu file tree (file & folder): clipboard session-local; Cut = move (`rename`),
  Copy = copy đệ quy (`POST /api/files/copy`, `fs.cp` recursive); Paste vào folder đích, tự né trùng tên, chặn dán
  folder vào chính nó/thư mục con.
- Hỗ trợ attachments (ảnh/pdf/…); upload từ web. Thư mục đích upload resolve **case-insensitive** với folder
  sẵn có (`vault.resolveDirCaseInsensitive`) — tránh tạo thư mục trùng khác hoa-thường (vd `attachments` cạnh
  `Attachments` có sẵn) trên filesystem phân biệt hoa-thường (Linux).
- Watch filesystem (chokidar) để phản ánh thay đổi ngoài (git pull, sửa trực tiếp).
- Tương thích cấu trúc `.obsidian/` (config, plugins, themes).

### FR-2 · Editor & rendering
- CodeMirror 6: syntax highlight Markdown, keybindings cơ bản.
- Live preview / Reading view chuyển đổi.
- Wikilinks `[[note]]`, embeds `![[file]]`, tags `#tag`, callouts, tasks `- [ ]`.
- **Ảnh nhúng — resize & zoom**: kéo handle 2 cạnh (trái/phải) trên ảnh trong Live Preview để đổi rộng,
  ghi lại vào source dạng size param Obsidian `![[img|W]]` / `![alt|W](url)` (giữ tỉ lệ, height auto).
  Size param `|W` / `|WxH` áp dụng cho **cả** `![[…]]` và ảnh markdown `![](…)`, ở Live lẫn Reading.
  Click ảnh → **lightbox toàn màn hình**: wheel/pinch zoom (theo con trỏ/tâm), kéo/1-ngón pan,
  double-click reset, Esc/click nền đóng (xem §22 mobile: pinch-zoom ảnh trong reading).
- **Audio/Video nhúng**: `![[clip.mp4]]` → `<video controls>`, `![[song.mp3]]` → `<audio controls>`
  (Live Preview, Reading, public share). Video: `mp4/webm/ogv/mov/mkv`; audio: `mp3/wav/m4a/3gp/flac/ogg/
  oga/opus`. `![[clip.mp4|W]]` đặt chiều rộng video. Mở thẳng file media từ file tree → hiện player.
  Binary serve qua HTTP Range (206) để seek/Safari hoạt động; MIME + extension: `services/mime.ts` /
  `lib/media.ts`.
- Backlinks panel, outline, tag pane.
- Right sidebar dạng **tab strip icon** (giống Obsidian): Backlinks · Outgoing links · Tags · Outline.
  - Backlinks: "Linked mentions" (đếm + danh sách) **và** "Unlinked mentions" (note nhắc tên note hiện tại
    bằng plain text mà chưa link — tìm qua QMD search, loại trừ note đã link).
  - Outgoing links: mọi wikilink trong note hiện tại, phân biệt resolved/unresolved, click để mở/tạo.
- Menu **More options (⋯)** trên header mỗi pane (note lẫn Graph view), dựng theo cấu trúc Obsidian Desktop:
  - Note: Backlinks in document, Split right / Split down, Open in new window, Rename / Move file to / Make a
    copy, Bookmark, Add file property, Export to PDF…, Find…, Copy path, Open version history, Open linked view
    (Backlinks / Outgoing links / Outline), Reveal file in navigation, Share…, Close tab / Close other tabs, Delete.
  - Graph view: Copy screenshot (PNG vào clipboard), Close tab.
  - Split pane hỗ trợ 2 hướng: right (cạnh phải) và down (bên dưới); hướng split persist trong uistate.
  - **Find/Replace trong note**: tích hợp `@codemirror/search` (panel top, ⌘F mở Find, ⌘⇧F Replace, ⌘G next).
  - **Reveal file in navigation**: mở rộng folder tổ tiên + cuộn/nháy sáng row trong file tree.
  - **Add file property**: chèn property rỗng vào frontmatter YAML (tạo block nếu chưa có) → render trong Properties widget.
  - **Export to PDF**: chuyển Reading view rồi dùng print dialog của trình duyệt (CSS `@media print` chỉ in nội dung note).
  - **Open in new window**: mở deep-link `/note/<path>` ở tab/cửa sổ trình duyệt mới.
  - Lưu ý: "Reveal in Finder" / "Open in default app" của Obsidian Desktop không áp dụng cho web app nên không có.
- Graph view (lực đẩy, từ wikilinks).
  - Tìm node trên graph: ô search nổi (góc trên-trái), gõ keywords → danh sách node khả dĩ
    (note/tag/attachment đang hiển thị trên graph); click hoặc Enter → camera bay (pan+zoom mượt)
    tới node, node được highlight kiểu hover (accent + dim phần không liên kết) tới khi di chuột.

### FR-3 · Login gate
- **Mật khẩu mặc định khi cài đặt: `123456`** — không cần bước setup, đăng nhập ngay được
  bằng pass mặc định. settings.json mặc định **không** chứa mật khẩu nào.
- Người dùng đổi mật khẩu trong Settings → Account (nhập pass hiện tại + pass mới). Hash mới
  lưu ở `auth.userPasswordHash`. Khi field này rỗng nghĩa là đang dùng pass mặc định `123456`.
- **Mật khẩu override (khôi phục khi quên pass):** `auth.passwordHash` trong `data/settings.json`
  (sửa tay, dạng scrypt hash) **hoặc** biến môi trường `WEBOBSIDIAN_PASSWORD` (plaintext). Login
  chấp nhận pass override **bất kể** người dùng đã đổi pass hay chưa. Mặc định không có override.
- Đăng nhập 1 password → JWT trong httpOnly cookie.
- Mọi route web & file API yêu cầu auth (trừ `/login`, healthcheck).

### FR-4 · Git backup & version history (legacy Git sync chuyển tiếp)
- Cấu hình: repo URL, branch, token (PAT) hoặc deploy key, tên/email commit.
- Thao tác: init/clone, pull, commit-all, push; hiển thị status (ahead/behind/dirty).
- Auto-sync tuỳ chọn theo interval + on-save debounce.
- Git LFS: cấu hình `.gitattributes` cho pattern lớn; track/push LFS.
- **Version history per-file**: `git log` (commit chạm file, newest first) + `git show <hash>:<path>` qua
  `GET /api/git/log` & `/api/git/show`; UI modal liệt kê version, preview nội dung, "Restore this version"
  (ghi đè + reload). Rỗng khi vault chưa là git repo / chưa bật Git Sync.
- Conflict Git: phát hiện, báo người dùng, chiến lược merge cơ bản (ưu tiên hỏi).
- Khi FR-13 Central Sync bật, Git mặc định là **single-writer backup-only**: server commit/push snapshot;
  không tự pull remote vào live authoritative vault. Restore/import phải explicit, preview trước và đi qua
  Sync Coordinator để tạo revision/event bình thường. Legacy bidirectional Git là chế độ chuyển tiếp có cảnh báo.

### FR-5 · Settings (JSON db)
- Toàn bộ cấu hình trong `data/settings.json` (atomic write, có backup).
- Nhóm: vault, auth, git, search, api, ui, plugins.
- UI Settings để xem/sửa; validate bằng schema (zod).

### FR-6 · API Gate (AI Agent)
- Quản lý nhiều **API key** (tạo/thu hồi, scope: read / write / search).
- REST endpoints `/api/v1/*` xác thực bằng header `Authorization: Bearer <key>` hoặc `X-API-Key`.
- Năng lực: list notes, read note, create/update/delete note, search, get backlinks, append.
- Rate limit + audit log mỗi key.

### FR-7 · QMD Search engine
- Index toàn bộ `.md`: nội dung, tiêu đề, headings, tags, path, frontmatter.
- Truy vấn: full-text, prefix, fuzzy, fielded (`tag:`, `path:`, `title:`), boolean.
- Cập nhật incremental khi file thay đổi (qua watcher).
- Index lưu/khôi phục trên disk (`data/qmd-index.json`) để khởi động nhanh.

### FR-8 · Community plugins
- Đọc danh sách plugin từ `.obsidian/plugins/*` (manifest.json, main.js).
- Plugin loader nạp `main.js` trong sandbox với **Obsidian API shim** (App, Vault, Workspace, Plugin, Notice, Setting…).
- Browse & cài plugin từ community list (qua GitHub releases) — tải về thư mục plugins.
- Bật/tắt plugin; lưu trạng thái trong settings.

### FR-9 · Docker
- `Dockerfile` multi-stage (build web + server → image gọn).
- `docker-compose.yml`: mount vault volume, data volume, env cho password/secret.
- Healthcheck (`start_period` đủ dài cho index vault lớn lần đầu), restart policy.
- **Self-deploy không sửa file tracked**: mọi tham số deploy đặt qua `.env` (git-ignored) —
  `VAULT_HOST_PATH` (legacy/default host vault → `/vault`), `VAULTS_HOST_PATH` (optional parent → `/vaults`),
  `HTTP_BIND`/`HTTP_PORT` (publish), `WEBOBSIDIAN_PASSWORD`,
  `WEBOBSIDIAN_WATCH`. `docker-compose.yml` chỉ tham chiếu `${VAR:-default}` nên `git pull`/redeploy
  không clobber cấu hình của người tự host. `cp .env.example .env && docker compose up -d --build`.
- **File watcher chịu lỗi inotify**: VPS sạch thường có `fs.inotify.max_user_watches` thấp →
  native watch lỗi `ENOSPC/EMFILE`. Watcher tự degrade sang **polling** (`WEBOBSIDIAN_WATCH=auto`),
  log hướng dẫn nâng `sysctl` để giữ native (CPU thấp hơn).

### FR-10 · Deep-link URL & Public share
- **Deep-link**: URL trình duyệt phản ánh vault và note đang mở — `/vault/<vaultId>/note/<vault-relative-path>`
  (URL-encode từng segment); Graph view = `/vault/<vaultId>/graph`. URL cũ `/note/...` và `/graph` ánh xạ default
  vault để tương thích. Mở URL trực tiếp (sau login) sẽ chọn đúng vault/note; back/forward hoạt động.
- **Public share (readonly, không cần login)**:
  - Tạo share link cho một note `.md` **hoặc canvas `.canvas`** → token ngẫu nhiên (16 bytes, base64url),
    URL dạng `/share/<token>`.
  - **Canvas share**: `.canvas` được server render thành **HTML tĩnh** (snapshot): node đặt tuyệt đối theo
    toạ độ, edges vẽ SSR bằng SVG Bézier (cùng hình học với editor), text/embedded-note render qua pipeline
    markdown; trang full-width (bỏ cột markdown hẹp). Allowlist file public lấy từ ảnh trong file-node canvas
    (`rendercanvas.canvasEmbedTargets`). Non-interactive (không pan/zoom) ở v1.
  - Trang public render Reading view (markdown → HTML sanitize), **không** sidebar/editor,
    không yêu cầu auth. Wikilink trong note hiển thị như text tĩnh (không điều hướng).
  - **SEO / SSR**: `GET /share/{id}` được **server render thành HTML hoàn chỉnh** (không cần JS
    để đọc nội dung → Google indexable). Head gồm: `<title>` (tên note), meta description
    (~160 ký tự đầu của body, đã strip markdown), canonical, Open Graph
    (`og:title/description/type=article/url/site_name/image` — ảnh đầu tiên note nhúng hoặc URL
    ảnh web đầu tiên), Twitter card (`summary_large_image`/`summary`), `robots: index,follow`.
    Share có password → SSR trang nhập password (**noindex**, không kèm nội dung note, form unlock
    bằng inline JS); share disabled/không tồn tại → 404 (noindex). Render markdown phía server
    dùng cùng pipeline unified/remark/rehype + sanitize (port từ web, kèm CSS inline từ bundle).
  - File nhúng (ảnh/pdf/video) trong note được serve qua endpoint public **giới hạn đúng các
    file mà note đó nhúng** (`![[...]]` / `![](...)`) — không cho đọc tuỳ ý vault. Không serve
    file `.md` qua endpoint này (không transclusion ở trang public).
  - Share record: `{ id, path, enabled, createdAt, passwordHash? }` lưu ở `data/shares.json`
    (JSON, atomic write). Mỗi note tối đa 1 share record (tạo lại → trả record cũ + enable).
  - Disable (giữ token, có thể bật lại) hoặc xoá hẳn. Token bị disable/xoá → trang public trả 404.
  - **Password tuỳ chọn cho từng share**: đặt/xoá ở trang quản lý (hash scrypt, không bao giờ trả
    hash về client — chỉ `hasPassword`). Khi share có password: endpoint public trả 401
    `{passwordRequired: true}`; khách nhập password → `POST /public/shares/{id}/unlock` → JWT
    (ký bằng `jwtSecret`, TTL 12h, payload gắn share id) đặt trong httpOnly cookie scope đúng
    `/public/shares/{id}` — ảnh nhúng tự gửi cookie. Đổi/xoá password không vô hiệu cookie đã cấp
    (TTL ngắn chấp nhận được cho v1).
- **Share dialog per-note**: menu "Share…" (context menu file tree + menu ⋯ của pane, cho note `.md`
  **và canvas `.canvas`**) mở popup cài đặt share của note đó: tạo public link, ô URL + nút Copy, toggle
  bật/tắt link, đặt/đổi/xoá password, xoá link vĩnh viễn.
- **Badge nhận biết**: note đang share public (enabled) hiện **icon globe** màu accent cạnh tên
  trong file tree. Danh sách share cache trong store, load sau login và refresh sau mỗi thao tác
  (dialog lẫn Settings dùng chung) nên badge luôn đúng.
- **Quản lý tập trung**: Settings → tab "Sharing" liệt kê toàn bộ note đã share, có ô search
  lọc theo path, toggle enable/disable nhanh, copy link, xoá.

---

### FR-11 · Mobile / responsive UI (smartphone cảm ứng)
Mục tiêu: trải nghiệm **đọc note** và **soạn thảo note** thuận tiện trên điện thoại màn hình cảm ứng,
tham chiếu UX Obsidian Mobile. Kích hoạt theo breakpoint (`max-width: 768px`) — không phải app riêng,
cùng một codebase React.
- **Layout drawer**: ribbon + sidebar trái và right sidebar trở thành **drawer overlay** trượt đè lên
  nội dung (không đẩy layout). Mặc định đóng → editor chiếm trọn màn hình. Mở bằng: nút hamburger (☰)
  trên thanh tab, **vuốt từ mép trái/phải** (edge-swipe), hoặc các nút toggle panel. Có **backdrop** mờ;
  chạm backdrop hoặc chọn note → drawer tự đóng. Drawer trái gồm strip ribbon (chuyển panel Files/Search/
  Graph/Bookmarks/Tags/Settings) + panel nội dung.
- **Trạng thái drawer là cục bộ thiết bị** (không persist, không broadcast qua WebSocket) → mở/đóng drawer
  trên điện thoại không ảnh hưởng trạng thái sidebar của desktop đang đồng bộ chung `uistate`.
- **Touch targets**: hàng cây thư mục, nút công cụ, tab ≥ 44px; tăng padding chạm; bỏ hover-only affordance
  (nút close tab luôn hiện trên mobile).
- **Format toolbar**: thanh công cụ định dạng khi soạn thảo (Live/Source): bold, italic, heading, list,
  checklist, quote, link, internal link `[[`, code, tag, indent/outdent, undo/redo. Mỗi nút thao tác trực
  tiếp lên editor đang active. **Mobile**: nổi phía trên bàn phím (neo qua visualViewport) như Obsidian
  Mobile. **Desktop**: thanh in-flow ngay dưới view-header (theo yêu cầu người dùng).
- **Viewport & safe-area**: `viewport-fit=cover`; chừa `env(safe-area-inset-*)` cho notch/home-indicator;
  không cho double-tap zoom (app-like) nhưng giữ pinch-zoom ảnh trong reading.

### FR-12 · Canvas (khung vẽ vô hạn — JSON Canvas)
Mục tiêu: clone tính năng **Canvas** của Obsidian — một mặt phẳng vô hạn để sắp xếp card/note/ảnh/link và nối
chúng bằng đường có mũi tên, dùng cho brainstorm, moodboard, sơ đồ. Tham chiếu UX Obsidian Canvas.

- **Định dạng file `.canvas`**: tuân thủ chuẩn mở **JSON Canvas** (jsoncanvas.org) để tương thích hai chiều với
  Obsidian. File là JSON `{ "nodes": [...], "edges": [...] }`.
  - **Node** (chung): `id`, `type`, `x`, `y`, `width`, `height`, `color?`. `color` là preset `"1".."6"`
    (đỏ/cam/vàng/lục/lam/tím) hoặc hex `"#RRGGBB"`.
    - `type:"text"` → `text` (markdown).
    - `type:"file"` → `file` (đường dẫn vault-relative), `subpath?` (heading/block).
    - `type:"link"` → `url`.
    - `type:"group"` → `label?`, `background?`, `backgroundStyle?`.
  - **Edge**: `id`, `fromNode`, `fromSide?`(top/right/bottom/left), `fromEnd?`(none/arrow), `toNode`,
    `toSide?`, `toEnd?`(none/arrow, mặc định arrow), `color?`, `label?`.
- **Tương tác canvas**: **kéo chuột trái trên nền = pan**; **Shift+kéo = marquee chọn nhiều node**; pan cũng
  qua Space+kéo và kéo nút giữa/phải; cảm ứng 1 ngón pan. Zoom bằng cuộn chuột (con trỏ làm tâm), nút
  zoom in/out/fit/100%. Lưới chấm nền.
- **Node**: double-click nền → tạo **text node** và vào chế độ sửa ngay; double-click vào text node để sửa
  (textarea), Esc/blur để thoát. Kéo node để di chuyển; 8 handle để resize. Drop file note/ảnh từ cây (hoặc
  nút) → tạo **file node** render embed (note = preview markdown, ảnh = `<img>`). Đổi màu qua palette 6 màu +
  mặc định. Xóa (Delete/Backspace).
- **Edge**: hover node hiện 4 chấm cạnh; kéo từ một chấm sang node/cạnh khác → tạo edge. Edge vẽ bằng đường
  cong Bézier theo hướng cạnh, có mũi tên ở đầu `to`. Double-click giữa edge để thêm/sửa **label**. Chọn edge
  để đổi màu/xóa.
- **Select**: click chọn 1 node/edge; kéo marquee trên nền để chọn nhiều; Shift+click thêm/bớt; di chuyển/xóa
  theo nhóm. Thanh công cụ ngữ cảnh nổi khi có lựa chọn (đổi màu, xóa).
- **Alignment snap (đường gióng)**: khi kéo node, các cạnh/tâm node tự gióng vào cạnh/tâm các node khác và
  hiện **đường gióng** (port thuật toán `getSnapping/O3/P3` từ Obsidian: điểm snap = 4 góc + tâm, ngưỡng
  `ceil(15/scale)` đơn vị canvas). Giữ **Alt** (⌃ trên macOS) để kéo tự do (tắt snap); giữ **Shift** để khoá trục.
- **Format trong text card**: phím tắt như editor chính (`obsidianKeymap`) — ⌘B đậm, ⌘I nghiêng, ⌘K thêm link,
  ⌘L task, `⌘/` comment (toggle marker); menu chuột phải mở **đúng tại con trỏ** và tự dịch vào trong màn hình.
- **Căn lề text** (mở rộng ngoài JSON Canvas spec): `TextNode.textAlign` = `left|center|right`, chọn qua nút trong
  selection menu (khi chọn text node) hoặc submenu "Align" menu chuột phải; áp cho cả textarea lẫn nội dung render.
  *Lưu ý: Obsidian thật bỏ qua field này khi mở lại.*
- **Lưu**: autosave debounce (~900ms) như editor, ghi qua `PUT /api/files/content` (store `content`/`save`,
  `.canvas` đã nằm trong `TEXT_RE`). Không thêm endpoint mới.
- **Tạo canvas mới**: context menu cây thư mục ("New canvas") + command palette; tên `Untitled.canvas` không
  trùng, nội dung khởi tạo `{"nodes":[],"edges":[]}`.
- **Phạm vi v1 (non-goals)**: không có realtime collaborative cursor; không group auto-resize theo thành viên;
  không portal/embed canvas-trong-canvas; không liên kết backlink graph từ node file (giữ đơn giản).

### FR-13 · Central Sync — web · native Obsidian plugin · Linux headless client

Thiết kế chi tiết và thứ tự triển khai: [`docs/SYNC_ROADMAP.md`](docs/SYNC_ROADMAP.md).

- **Authoritative server:** Mỗi Vault trên WebObsidian server là một authority domain độc lập. Mọi mutation từ web, Agent API,
  plugin native, daemon headless, watcher filesystem và Git restore/import phải đi qua một `SyncCoordinator`.
  Coordinator/revision journal luôn bật; pairing chỉ mở khi record vault trong settings v4 có
  `sync.enabled=true` và `sync.bootstrapState=ready`. Gate này không được tắt stale-write protection cho web/agent.
- **Revision safety:** mỗi entry có stable `entryId` qua rename, `revision` tăng dần + SHA-256;
  create/modify/rename/delete/mkdir/rmdir gửi entry/base revision. Server chỉ nhận khi identity/base khớp;
  stale write hoặc path/case collision trả `409 Conflict`, tuyệt đối không silent overwrite.
- **Ordered catch-up:** mọi mutation đã commit nhận global `sequence`; client persist cursor và gọi
  `GET /api/sync/v1/changes?after=<sequence>` sau reconnect. WebSocket authenticated chỉ gửi
  `sync.changed/latestSequence` làm wake-up, không là nguồn dữ liệu duy nhất.
- **Event model:** journal có create/modify/rename/delete/mkdir/rmdir; rename giữ `oldPath`; delete/rmdir tạo
  tombstone có retention. Operation có `deviceId`, `clientSequence`, `idempotencyKey` để retry offline an toàn.
- **Conflict:** text dùng three-way merge chỉ khi sạch; nếu overlap thì giữ canonical server file và tạo conflict
  copy có device/timestamp. Binary, delete-vs-modify và merge không chắc chắn luôn conflict-copy; UI không tự mất data.
- **Attachment lớn:** content-addressed blob SHA-256, stream/range, resumable/bounded upload; Git LFS không nằm
  trong live sync protocol.
- **Phạm vi file v1:** sync note/canvas/attachment bất kỳ/folder rỗng; loại toàn bộ `.git/**`, `.trash/**`,
  `.obsidian/**`, temp/swap, OS metadata và sync state/credential. Client có thể exclude thêm nhưng không override
  server exclusions. `.obsidian` chỉ được xem xét ở PRD version tương lai; v1 không hiện allowlist gây hiểu nhầm.
- **Browser:** GET trả revision/ETag; save phải conditional; sửa autosave generation race; clean open note tự reload
  khi revision mới, dirty note vào merge/conflict; workspace/uistate mặc định per-device thay vì mirror toàn cục.
- **Native Obsidian community plugin:** desktop+mobile, dùng Vault events/API + `requestUrl` + SecretStorage,
  debounce modify, offline queue, echo suppression theo path/hash/revision, foreground catch-up trên mobile,
  status/conflict UI. Plugin repo riêng, manifest id không chứa `obsidian`; submit bản đầu qua Community directory.
- **Linux headless client:** CLI/daemon dùng chung `sync-core`, lệnh init/pair/sync/watch/status/conflicts/doctor,
  mode bidirectional/pull-only/push-only/one-shot, chạy systemd hoặc sidecar Docker amd64/arm64; cursor/token nằm
  ngoài vault và token file mode 0600/systemd credential.
- **Device auth:** pairing code random, hash, TTL ngắn, single-use → device token scope `sync`, bind đúng một
  `vaultId`; token hash server-side, list/revoke/last-seen theo vault; không dùng master password hay broad Agent key.
  Pairing workflow bắt buộc create/register + select server vault trước; UI tạo code hiện name/id/sequence target và
  xác nhận rõ rằng code không auto-create vault. Một local vault độc lập không được pair vào server vault của local
  vault khác; nhiều device chỉ share một server vault khi người dùng chủ ý sync cùng logical vault.
- **Storage JSON-only:** default vault giữ `data/sync/` để rollback-compatible; mỗi vault bổ sung dùng
  `data/vaults/<vaultId>/sync/`. Mỗi namespace gồm vault metadata, revision index, devices, idempotency cache, write-ahead
  transaction intents, segmented atomic JSON journal, retained merge bases/blobs, incomplete uploads và conflicts.
  Journal event là commit point; snapshot rebuild được. Có schema/checksum/fsync recovery, compaction, retention,
  doctor và degraded read-only khi corruption; không thêm DB engine ở v1.
- **Không thuộc FR-13 v1:** CRDT/OT, shared cursor/keystroke collaboration, background guarantee khi mobile app bị
  suspend, proprietary Obsidian Sync compatibility, E2EE server-blind (mâu thuẫn QMD server-side).

---

## 4. Yêu cầu phi chức năng (NFR)
- **Bảo mật**: password hash scrypt, JWT secret tự sinh, API key hash khi lưu, vault isolation guard (không cho
  cross-vault path/runtime/token/cache; không cho root overlap hoặc symlink root), path traversal guard
  (chặn `..`, segment `.git`, symlink thoát vault), CORS hạn chế, rate limiting (cả `/auth/login`:
  10 lần/15 phút/IP). Bắt buộc đổi mật khẩu mặc định (`123456`) ngay sau lần đăng nhập đầu
  (`mustChangePassword`). Security headers qua `helmet` + CSP. Web UI hiện hữu vẫn hỗ trợ self-host HTTP,
  nhưng FR-13 device sync bắt buộc HTTPS ngoài loopback; chỉ override explicit `WEBOBSIDIAN_SYNC_ALLOW_INSECURE=true`
  kèm cảnh báo. Token git/PAT được redact khỏi mọi thông báo lỗi trả client + log. WebSocket
  `/ws` yêu cầu phiên đăng nhập hợp lệ. Plugin `id` được validate trước khi thành path segment; đổi
  `vault.path` qua API bị giới hạn trong `allowedRoots`.
- **Hiệu năng**: search < 100ms cho vault ~10k notes; lazy load file tree lớn.
- **Tin cậy**: atomic writes cho settings & notes; backup trước ghi đè; git ops không mất dữ liệu.
  Central Sync không silent overwrite; journal crash-consistent, idempotent replay, cursor recovery, tombstone và
  conflict copy. Startup phát hiện journal hỏng phải vào degraded/read-only thay vì tự truncate.
- **Sync performance**: manifest paginate cho 10k note/50k file; no-change catch-up LAN <500ms sau kết nối;
  clean active client thấy text revision mới trong ≤2s điều kiện bình thường; stream file 1GB với bounded memory.
  Bootstrap transfer không bị throttle ở ngưỡng chỉ ~30 file: data-plane mặc định 600 request/phút/device; Test/
  handshake dùng bucket control riêng để vẫn chẩn đoán được trong lúc upload; 429 luôn có Retry-After và client backoff.
- **Sync compatibility**: protocol major version explicit; server hỗ trợ current + previous minor trong rolling
  upgrade; major mismatch fail-safe. Desktop/mobile/headless đều có conformance test chung.
- **Khả chuyển**: chạy được trên Linux/macOS, ARM & x86.
- **Khả dụng**: responsive (desktop/tablet/mobile), dark/light theme.

---

## 5. API surface (tóm tắt)

### Web/session API (cookie auth)
Mọi `/api/*` vault-scoped nhận `X-WebObsidian-Vault-Id`; thiếu header chọn default vault để giữ client cũ.
```
POST   /auth/setup            # (legacy) set password lần đầu — vô hiệu khi đã có pass mặc định
POST   /auth/login            # login → cookie
POST   /auth/logout
POST   /auth/change-password  # đổi pass: { currentPassword, newPassword } (yêu cầu auth)
GET    /auth/me
GET    /api/vaults           # list vault + default/current metadata
POST   /api/vaults           # register existing directory {name,path,...}
PATCH  /api/vaults/:vaultId  # rename/config/default
DELETE /api/vaults/:vaultId  # unregister only; never delete vault files
GET    /api/files            # cây thư mục của selected vault
GET    /api/files/*path      # đọc file (md/binary)
PUT    /api/files/*path      # ghi
POST   /api/files/*path      # tạo / upload
PATCH  /api/files            # rename/move
POST   /api/files/copy       # copy đệ quy file/folder {from,to} (Paste sau Copy)
DELETE /api/files/*path      # xoá → .trash hoặc xoá hẳn (theo vault.deleteMode)
GET    /api/files/trash      # liệt kê file trong .trash
POST   /api/files/trash/restore   # khôi phục {path} về vị trí gốc
DELETE /api/files/trash/item # xoá vĩnh viễn 1 item trong trash
DELETE /api/files/trash      # empty trash (xoá hẳn toàn bộ)
GET    /api/search?q=...
GET    /api/backlinks?path=...
GET    /api/git/status | POST /api/git/{pull,commit,push,sync}
GET/PUT /api/settings
GET/POST/DELETE /api/keys     # quản lý API key
GET    /api/plugins | POST /api/plugins/install | PATCH enable
GET    /api/shares            # list share (quản lý)
POST   /api/shares            # tạo share cho 1 note {path} → {id,...}
PATCH  /api/shares/{id}       # enable/disable {enabled}
DELETE /api/shares/{id}       # xoá share
```

### Central Sync API (device-token auth) — `/api/sync/v1`
```
POST   /pairing-codes                # web-admin: one-time code bound to explicitly displayed selected vault
POST   /pair                         # rate-limited code → bound device token
POST   /handshake | /ws-tickets      # protocol/limits/sequence | one-use WS ticket
GET    /manifest                     # snapshot-consistent paginated metadata
GET    /changes?after=&limit=        # ordered committed reconnect feed
POST   /ack                          # durable applied sequence
GET    /files?entryId=&revision=     # exact retained text/binary revision
HEAD   /blobs/:sha256
POST   /blob-uploads | PUT /blob-uploads/:id/:part | POST /blob-uploads/:id/complete
GET    /blobs/:sha256                # streamed/Range
POST   /operations                   # ordered idempotent batch + entryId/baseRevision
GET    /conflicts | POST /conflicts/:id/resolve
GET    /devices | DELETE /devices/:id | GET /health   # web-admin management
WS     /ws?ticket=… → {type:"sync.changed", latestSequence}
```

### Public share (không auth) — `/public` & `/share`
```
GET    /public/shares/{id}        # nội dung note đã share {title, content} (404 nếu disabled,
                                  # 401 {passwordRequired} nếu có password & chưa unlock)
POST   /public/shares/{id}/unlock # {password} → set httpOnly cookie unlock (JWT 12h)
GET    /public/shares/{id}/file?path=  # file nhúng trong note (chỉ file note đó tham chiếu)
GET    /share/{id}                # trang HTML public — SERVER-RENDERED (SEO meta + OG + nội dung
                                  # note trong HTML; locked → form password noindex)
```

### Agent API (API-key auth) — `/api/v1`
```
GET    /api/v1/notes                 # list (paginate)
GET    /api/v1/notes/{path}          # read
PUT    /api/v1/notes/{path}          # create/update
PATCH  /api/v1/notes/{path}          # append content
DELETE /api/v1/notes/{path}
GET    /api/v1/search?q=...&limit=
GET    /api/v1/backlinks?path=
GET    /api/v1/tags
```
Mutation bắt buộc positive monotonic `clientSequence` + `idempotencyKey`; update/append/delete entry hiện có
bắt buộc `baseRevision` lấy từ GET. Thiếu conditional metadata → 428; stale revision → 409, không overwrite.

---

## 6. Data model — `settings.json` v4
```jsonc
{
  "version": 4,
  "auth": { "userPasswordHash": "scrypt$...", "passwordHash": "", "jwtSecret": "..." },
  "vaults": {
    "defaultVaultId": "vault_...",
    "items": [
      { "id": "vault_...", "name": "Main", "storage": "legacy", "path": "/vault", "allowedRoots": ["/vault"],
        "trash": ".trash", "deleteMode": "trash", "attachmentDir": "attachments",
        "sync": { "enabled": true, "bootstrapState": "ready" },
        "git": { "enabled": false, "mode": "backup-only", "remote": "", "branch": "main",
                 "token": "", "authorName": "WebObsidian", "authorEmail": "webobsidian@localhost",
                 "autoSync": false, "autoCommitOnSave": false, "intervalSec": 300,
                 "lfsPatterns": ["*.png","*.jpg","*.pdf","*.mp4"] },
        "plugins": { "enabled": [], "installed": [] } }
    ],
    "detached": [] // unregister moves records here so re-registering the same real root restores identity/history
  },
  "search": { "fuzzy": 0.2, "prefix": true, "indexFrontmatter": true },
  "api": { "keys": [ { "id": "...", "name": "agent1", "hash": "...",
                         "scopes": ["read","search"], "vaultIds": ["vault_..."],
                         "createdAt": "...", "lastUsed": null } ], "rateLimitPerMin": 120 },
  "ui": { "theme": "obsidian-light", "defaultView": "live" }
}
```
API keys cũ bind default vault khi migrate; key mới có `vaultIds` explicit hoặc `*` do admin chọn. Runtime data:
```text
data/sync/                       # default vault, preserved in-place

├── vault.json          # vaultId, currentSequence, schemaVersion
├── revisions.json      # rebuildable path revision/hash+tombstone checkpoint
├── bootstrap.json      # resumable existing-vault hash checkpoint (temporary)
├── devices.json        # device metadata + token hashes (không raw token)
├── idempotency.json    # bounded recent operation results
├── transactions/       # fsynced write-ahead intents
├── journal/*.json      # ordered segmented committed-event journal
├── bases/              # retained text bases cho three-way merge
├── blobs/sha256/       # content-addressed current/event-retained blobs
├── uploads/            # incomplete resumable chunks, TTL 24h
└── conflicts.json      # unresolved/resolved conflict metadata
data/vaults/<vaultId>/           # every additional vault
├── sync/…                       # complete isolated sync namespace
├── qmd-index.json
├── shares.json
└── uistate.json
```

### Public share records (FR-10)
```jsonc
[
  { "id": "base64url-16-bytes", "path": "Folder/Note.md",
    "enabled": true, "createdAt": "2026-06-10T00:00:00.000Z",
    "passwordHash": "scrypt$...salt...$...hash..." } // optional — share không password thì bỏ field
]
```

---

## 7. Rủi ro & quyết định
- **Tương thích plugin**: nhiều plugin dùng API/DOM Electron riêng → chỉ đảm bảo subset. Quyết định: shim API phổ biến, fail mềm với API thiếu, log cảnh báo.
- **Bảo mật token git/API key**: lưu trong settings.json server-side (chmod 600), khuyến nghị mount qua secret/volume riêng.
- **File lớn**: live sync dùng resumable content-addressed blobs; Git backup dùng Git LFS và cảnh báo khi
  snapshot chứa file lớn chưa track LFS.
- **Central Sync conflict**: revision/base bắt buộc; chỉ auto three-way merge khi clean, còn lại conflict-copy.
  Quyết định ưu tiên không mất dữ liệu hơn last-writer-wins hoặc merge phỏng đoán.
- **JSON journal scale**: segmented atomic JSON giữ yêu cầu không DB nhưng phải benchmark/compaction/doctor; trước
  stable sẽ review lại nếu 50k file/high churn không đạt NFR, và phải cập nhật PRD trước khi đổi storage engine.
- **Mobile**: community plugin không chạy liên tục khi OS suspend; quyết định catch-up foreground, hiển thị stale/offline,
  không quảng cáo background guarantee.
- **E2EE**: defer server-blind encryption vì QMD cần plaintext trên trusted self-host server; bắt buộc HTTPS ngoài localhost.

---

## 8. Tiêu chí hoàn thành (Definition of Done) cho v1
1. Đăng nhập 1 password, mở vault, xem cây thư mục.
2. Mở/sửa/tạo/xoá note với editor + live preview + wikilinks/backlinks.
3. Search trả kết quả từ QMD < 100ms trên vault mẫu.
4. Cấu hình Git backup commit/push thành công kể cả file LFS; explicit fetch/preview/import đi qua coordinator.
5. Tạo API key, AI Agent gọi `/api/v1` đọc/ghi/search thành công.
6. Cài & bật ít nhất 1 community plugin đơn giản.
7. `docker compose up` chạy toàn bộ stack.
8. Hai browser edit concurrent không silent overwrite; stale save nhận 409 và conflict/merge flow bảo toàn cả hai bản.
9. Obsidian plugin desktop sync create/modify/rename/delete + attachment, offline rồi reconnect bắt kịp ordered feed.
10. Plugin mobile bắt kịp khi foreground và không mất pending operation sau suspend/restart.
11. Linux headless client chạy one-shot, watch, systemd và Docker sidecar; status/doctor/conflict commands hoạt động.
12. Revoke device cắt quyền; retry cùng idempotency key không tạo mutation trùng; traversal/symlink/blob hash test pass.
13. Git backup không tự pull mutate live vault trong Central Sync mode; explicit restore tạo normal revision/events.
14. Hai vault chạy đồng thời có tree/search/journal/device/blob/conflict/watcher/Git/share/workspace độc lập; token
    vault A không đọc/ghi/ack/ws vault B; migrate v3 giữ nguyên dữ liệu và client của default vault.
14. Plugin initial release qua review Community directory; headless npm được publish; Dockerfiles được CI
    build/smoke amd64+arm64 và tài liệu clone/tag + local build được kiểm chứng (không publish registry image).
