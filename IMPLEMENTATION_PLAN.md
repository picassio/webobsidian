# IMPLEMENTATION PLAN — WebObsidian

> Track tiến độ phát triển. Tham chiếu thiết kế: [PRD.md](PRD.md).
> Quy ước: `[ ]` chưa làm · `[~]` đang làm · `[x]` xong.
> Cập nhật file này **mỗi khi** một mục thay đổi trạng thái.

Cập nhật lần cuối: 2026-07-14 (M41.8 complete/deployed: explicit vault target confirmation, 600/min bootstrap budget, independent Test bucket, and plugin 0.1.15; M36.10 Community review pending)

---

## Phase 0 — Foundation & scaffolding
- [x] M0.1 Khởi tạo monorepo (root `package.json` + workspaces)
- [x] M0.2 Server scaffold: Express + TS, `tsconfig`, dev script (tsx), build (tsc)
- [x] M0.3 Web scaffold: Vite + React + TS
- [x] M0.4 Cấu trúc thư mục theo PRD §2.2
- [x] M0.5 `.gitignore`, `.env.example` (ESLint/Prettier: để sau, không chặn build)

## Phase 1 — Settings store (JSON db) — FR-5
- [x] M1.1 Module `settings` đọc/ghi `data/settings.json` (atomic write + backup)
- [x] M1.2 Schema validate bằng zod, default settings, migration `version`
- [x] M1.3 Route `GET/PUT /api/settings`

## Phase 2 — Auth gate — FR-3
- [x] M2.1 Hash password (scrypt), JWT secret tự sinh
- [x] M2.2 `POST /auth/setup`, `/auth/login`, `/auth/logout`, `GET /auth/me`
- [x] M2.3 Middleware auth guard (httpOnly cookie), bảo vệ route
- [x] M2.4 First-run setup flow (UI + env seed `WEBOBSIDIAN_PASSWORD`)
- [x] M2.5 Pass mặc định 123456 + đổi mật khẩu (Settings→Account) + override khôi phục (`auth.passwordHash`/`WEBOBSIDIAN_PASSWORD`); migration pass cũ → `userPasswordHash`

## Phase 3 — Vault filesystem — FR-1
- [x] M3.1 Service vault: list tree, read, write, create, rename/move, delete→trash
- [x] M3.2 Path traversal guard + allowedRoots
- [x] M3.3 Upload attachments (binary), serve binary với mime
- [x] M3.4 Folder browser an toàn để chọn vault path
- [x] M3.5 Filesystem watcher (chokidar) → events qua WebSocket
- [x] M3.6 Trash UI + chế độ xoá (FR-1): `vault.deleteMode` (trash/permanent) + Settings selector;
      service `listTrash/restoreFromTrash/deleteFromTrash/emptyTrash/remove`; routes `/api/files/trash*`;
      modal TrashView (Restore / xoá vĩnh viễn / Empty trash) mở từ header Files + command palette

## Phase 4 — QMD Search engine — FR-7
- [x] M4.1 Module QMD trên MiniSearch: index content/title/headings/tags/path/frontmatter
- [x] M4.2 Build index lúc khởi động + persist `data/qmd-index.json`
- [x] M4.3 Incremental update qua watcher + sau mỗi write
- [x] M4.4 Query: full-text, prefix, fuzzy, fielded (`tag:`,`path:`,`title:`)
- [x] M4.5 Route `GET /api/search`

## Phase 5 — Links graph — FR-2
- [x] M5.1 Parser wikilinks/embeds/tags → link index
- [x] M5.2 Backlinks `GET /api/backlinks`
- [x] M5.3 Graph data endpoint `GET /api/graph`

## Phase 6 — GitHub sync — FR-4
- [x] M6.1 Service git (simple-git): init/clone, status, pull, commit, push
- [x] M6.2 Git LFS: detect, `.gitattributes`, track patterns (verified lfsAvailable)
- [x] M6.3 Auth bằng PAT nhúng remote URL
- [x] M6.4 Auto-sync interval (service autosync)
- [x] M6.5 Conflict detection cơ bản + báo người dùng
- [x] M6.6 Routes `/api/git/{status,init,clone,pull,commit,push,sync}`

## Phase 7 — API Gate (Agent) — FR-6
- [x] M7.1 API key model: tạo/list/revoke, hash lưu trong settings, scopes
- [x] M7.2 Middleware apikey guard + scope check + rate limit + audit log
- [x] M7.3 `/api/v1`: notes list/read/write/append/delete, search, backlinks, tags
- [x] M7.4 Route quản lý key `GET/POST/DELETE /api/keys`
- [x] M7.5 Tài liệu agent API (`docs/AGENT_API.md`)

## Phase 8 — Community plugins — FR-8
- [x] M8.1 Đọc `.obsidian/plugins/*` (manifest + main.js)
- [x] M8.2 Obsidian API shim (App, Vault, Workspace, Plugin, Notice, Setting…)
- [x] M8.3 Plugin loader (eval main.js) + enable/disable
- [x] M8.4 Browse + install từ community (GitHub releases)

## Phase 9 — Web frontend — FR-2
- [x] M9.1 API client + auth flow + app shell (ribbon/sidebar/tabs/statusbar)
- [x] M9.2 File tree (context menu CRUD, new note/folder)
- [x] M9.3 CodeMirror 6 editor (markdown, keymap, autosave)
- [x] M9.4 Reading view (remark/rehype, wikilinks, embeds, callouts, tasks, properties)
- [x] M9.5 Search panel + command palette
- [x] M9.6 Backlinks/outline/tags panels
- [x] M9.7 Graph view (mở trong tab + panel Filters kiểu Obsidian)
- [x] M9.8 Settings UI (vault/git/api keys/plugins/theme)
- [x] M9.9 Theme Obsidian-like (dark/light)
- [x] M9.10 Navigation back/forward (toolbar ←/→ trên mọi view, history stack)
- [x] M9.11 Search: filter/sort (match case, collapse, more context, sort) + sticky query box

## Phase 10 — Docker & docs — FR-9
- [x] M10.1 Multi-stage `Dockerfile` (web build → server runtime, git+git-lfs)
- [x] M10.2 `docker-compose.yml` (vault + data volumes, env secrets, healthcheck)
- [x] M10.3 `README.md` quickstart + `docs/AGENT_API.md`
- [x] M10.4 Deploy hardening cho self-host: compose `.env`-driven (`VAULT_HOST_PATH`,
  `HTTP_BIND/HTTP_PORT`, `WEBOBSIDIAN_WATCH`) → không clobber khi redeploy; watcher tự
  fallback polling khi inotify `ENOSPC/EMFILE`; `start_period=90s`; README mục Deploy-to-VPS

## Phase 11 — QA & DoD
- [x] M11.1 Smoke test end-to-end (login → edit → search → backlinks → agent API CRUD)
- [x] M11.2 Seed vault mẫu để demo (`sample-vault/`)
- [x] M11.3 Kiểm tra Definition of Done (PRD §8) — verified qua curl + screenshot UI

## Phase 12 — Parity & UI fidelity (đợt 2)
- [x] M12.1 Live Preview WYSIWYG (CM6): ẩn dấu định dạng, scale heading, widget wikilink/checkbox/ảnh
- [x] M12.2 Frontmatter → Properties block trong cả Live preview (StateField) lẫn Reading
- [x] M12.3 Embeds/transclusion `![[note]]` + ảnh `![[img]]` trong Reading
- [x] M12.3b Embed audio/video `![[clip.mp4]]`/`![[song.mp3]]` → `<video>`/`<audio>` HTML5 (Live Preview `MediaWidget`, Reading `markdown.ts`, public share `renderhtml.ts`) + mở thẳng file media trong tree → player; binary serve qua HTTP Range (206) cho seek; MIME/extension gom về `services/mime.ts` & `lib/media.ts`
- [x] M12.4 Context menu chuột phải thật (new/rename/delete/open-to-side/bookmark)
- [x] M12.5 Kéo-thả di chuyển file trong tree + dán/drop ảnh → upload attachments + chèn embed
- [x] M12.6 Quick switcher (⌘O) + command palette commands + hotkeys (⌘P/⌘O/⌘N/⌘E/⌘⇧F/⌘\\/⌘S)
- [x] M12.7 Bookmarks + Recent panel; Daily note command; split pane (open to the right)
- [x] M12.8 Git auto-commit-on-save (debounced) + toggle trong Settings
- [x] M12.9 Code-split bundle (react/codemirror/markdown chunks)

## Phase 13 — Obsidian look & feel (theo phản hồi người dùng)
- [x] M13.1 Bộ icon Lucide flat (component `Icon`) thay toàn bộ emoji
- [x] M13.2 Theme mặc định = Light (đúng Obsidian), palette/spacing/borders bám Obsidian
- [x] M13.3 File tree chỉ chevron (markdown không icon), active highlight tinh tế
- [x] M13.4 Vault footer (tên vault + settings); status bar nhỏ góc phải
- [x] M13.5 Right sidebar "Linked mentions" + "Outline" giống ảnh tham chiếu
- [x] M13.6 Tab bar có toggle sidebar trái/phải + nút new tab

## Phase 14 — WYSIWYG editor & context menus (theo phản hồi người dùng)
- [x] M14.1 Live Preview render đúng kiểu Obsidian: heading sạch (ẩn `#`), bold→đậm,
      italic→nghiêng, `code`→nền mono, strikethrough, bullet→•, tag→pill
- [x] M14.2 Lộ raw syntax **theo từng token tại con trỏ** (không lộ cả đoạn) — soạn thảo mượt
- [x] M14.3 Sửa lỗi áp theme tối (oneDark) lên giao diện sáng → highlight theo theme
- [x] M14.4 Callout/blockquote render inline trong Live Preview
- [x] M14.5 Frontmatter → Properties widget (block) trong Live Preview
- [x] M14.6 Menu chuột phải editor: Format/Paragraph/Insert (submenu) + Cut/Copy/Paste/Select all + Search
- [x] M14.7 Menu chuột phải file tree mở rộng: Open/Open to right/Bookmark/Make a copy/Rename/Move/Copy path/Delete
- [x] M14.8 Menu chuột phải reading view: Copy/Search/Select all; ContextMenu hỗ trợ submenu + icon

### Còn lại / cải tiến tương lai (không chặn)
- [ ] Resolve conflict UI nâng cao cho git
- [ ] Lazy-load cây thư mục cực lớn; canvas/whiteboard
- [ ] ESLint/Prettier CI; live-preview render bảng/danh sách lồng sâu nhiều cấp
- [ ] Graph: port d3-force simulation sang web worker (như Obsidian app chạy worker + WASM)
      để UI không khựng lúc graph 5.9k node đang "nở" — physics/render đã parity, chỉ còn
      kiến trúc thread (xem sim.js trong obsidian.asar; web giữ nguyên tham số, chỉ chuyển chỗ chạy)

---

## Phase 15 — Persist & sync workspace state (theo yêu cầu người dùng)
- [x] M15.1 Lưu UI/workspace state **xuống file server** `data/uistate.json` (không dùng localStorage)
      — tab đang mở, note active, viewMode, folder mở, split, recent, bookmarks, layout panel
- [x] M15.2 Khôi phục state khi load (F5 không mất note; mở trình duyệt/thiết bị khác vẫn giữ)
- [x] M15.3 **Sync real-time** giữa các tab/thiết bị qua WebSocket: tab này đổi → broadcast →
      tab kia apply (bỏ echo theo `originId`, lưu nội dung đang sửa trước khi chuyển, re-hydrate)
- [x] M15.4 Click-to-edit heading 1 lần (posAtCoords precise=false); heading bỏ underline

## Phase 16 — Deep-link URL & Public share — FR-10 (theo yêu cầu người dùng)
- [x] M16.1 URL `/note/<path>` đồng bộ với note đang mở (pushState/popstate, mở deep-link sau login,
      Graph = `/graph`)
- [x] M16.2 Server: service `shares` (`data/shares.json`, atomic write) + routes `/api/shares`
      (list/create/toggle/delete, auth) + `/public/shares/:id{,/file}` (không auth, guard chỉ
      serve file note đó nhúng, không serve `.md`)
- [x] M16.3 Trang public `/share/<token>` readonly (render Reading view, không cần login)
- [x] M16.4 UI: context menu note "Copy public link"; Settings → tab "Sharing" quản lý tập trung
      (search, toggle enable/disable nhanh, copy link, xoá)
- [x] M16.5 Password tuỳ chọn cho từng share: đặt/xoá ở tab Sharing (scrypt hash, chỉ trả
      `hasPassword`); public 401 `{passwordRequired}` → form nhập password → unlock JWT cookie
      (httpOnly, scope `/public/shares/{id}`, 12h)
- [x] M16.6 SSR trang `/share/{id}`: server render HTML hoàn chỉnh (Google indexable) + SEO meta
      (title, description, canonical, Open Graph + og:image, Twitter card); locked → form password
      noindex; thay thế trang React /share (web bỏ PublicNote, dev proxy /share về server)
- [x] M16.7 Share dialog per-note + badge (theo phản hồi, PRD 0.7): menu "Share…" (file tree +
      menu ⋯ pane, thay "Copy public link") mở popup tạo link/copy URL/toggle bật-tắt/password/xoá;
      icon globe màu accent cạnh tên note đang share trong file tree; shares cache trong store
      dùng chung cho dialog + Settings → Sharing + badge

## Phase 17 — Pane menu (⋯) & Right sidebar tabs (theo phản hồi người dùng, PRD 0.3)
- [x] M17.1 Menu "More options" (⋯) trên view-header mọi pane: note (Split right/down, Bookmark,
      Copy public link, Make a copy, Rename/Move/Copy path/Delete, Close tab/Close others),
      Graph (Copy screenshot PNG → clipboard, Close tab)
- [x] M17.2 Split pane 2 hướng: right + down (persist `splitDirection` trong uistate)
- [x] M17.3 Right sidebar tab strip icon (Backlinks · Outgoing links · Tags · Outline),
      persist tab đang chọn (`rightPanel`)
- [x] M17.4 Unlinked mentions (search title + match **cả cụm** qua `/api/search/matches`
      `phrase:true`, loại note đã link) + Outgoing links (parse wikilinks, resolved/unresolved,
      lọc attachment khỏi unresolved, click mở/tạo)

---

## Phase 18 — Markdown editor parity Obsidian Desktop (docs/obsidian-desktop-internals.md)
- [x] M18.1 CSS design tokens theo app.css 1.12.7 (§19): accent HSL 258/88%/66% + accent-1/-2
      công thức light/dark, color-base ramp đúng giá trị, extended colors + `-rgb`, semantic
      tokens (`--background-*`, `--text-*`, `--interactive-*`), heading 1.618/1.462/1.318/
      1.188/1.076/1em + letter-spacing, `--bold-modifier: 200`, `--file-line-width: 700px`,
      callout slots RGB triplet (§21); giữ alias var cũ cho component hiện hữu
- [x] M18.2 DOM classes chuẩn (§20): root `markdown-source-view cm-s-obsidian mod-cm6
      is-live-preview is-readable-line-width`; line `HyperMD-header-1..6 / -list-line /
      -task-line[data-task] / -quote / -codeblock(-begin/-end/-bg) / -hr / -footnote`; span
      `cm-hashtag(-begin/-end), cm-strikethrough, cm-inline-code, cm-hmd-internal-link,
      cm-formatting(-header/-highlight), cm-comment, cm-math, cm-footref, cm-url, cm-blockid`
- [x] M18.3 Live Preview token mới (§7): `==highlight==` ẩn marker; `%%comment%%` faint;
      footref `[^id]` superscript + render dòng definition; block id `^abc-123` faint;
      HR widget; ẩn fence ``` khi caret ngoài block; ẩn escape `\.` (file Trilium export);
      task mọi ký tự non-space = done (x/X gạch + muted); callout regex
      `/^\[!([^\]]+)\]([+-]?)(?:\s|$)/` + đủ bảng màu/icon §21 + title mặc định + fold mark
- [x] M18.4 Wikilink đúng luật §7: alias sau `|` ĐẦU, loại `[[` lồng, NBSP→space + NFC;
      LP label giữ raw `Note#Head` (aria-label = `Note > Head` như Obsidian);
      size param ảnh `![[img|300]]` / `![[img|300x200]]`
- [x] M18.5 Tag regex chính xác §7 (charset unicode, loại thuần số, cần ≥1 chữ cái);
      pill 2 nửa cm-hashtag-begin/-end
- [x] M18.6 Hotkeys mặc định §4 (lib/editorCommands.ts): Mod+B/I/K/L/D, Mod+/ (%%), Mod+E
      (edit↔reading), Mod+S, Alt+Enter follow link; toggle pair thông minh (wrap/unwrap +
      word-at-caret); Enter/Backspace tiếp tục list markup
- [x] M18.7 Suggester `[[` (file) + `#` (tag) — port nguyên công thức điểm fuzzy §9
      (lib/fuzzy.ts: token pass → per-char pass, penalty mid-word/span/offset/length,
      basename trước path −1); dropdown `.suggestion-container` chuẩn §20, flip lên khi gần
      đáy; Enter/Tab/↑↓/Esc qua keymap Prec.highest (lib/suggest.ts)
- [x] M18.8 Math render KaTeX lazy-load (inline `$..$` + `$$..$$` 1 dòng); code block
      syntax highlight (@codemirror/language-data); GFM base (strikethrough/table/tasklist);
      checkbox style Obsidian (accent bg, radius 4px, size --font-text-size)
- [x] M18.9 Line spacing khớp app.css thật: `.HyperMD-header { padding-top: var(--p-spacing) }`,
      inline-title margin-bottom 0.5em, scroller line-height var(--line-height-normal)
- [x] M18.10 Đợt sửa theo 11 lỗi người dùng báo (đối chiếu side-by-side với app):
      (1) HighlightStyle riêng (lib/highlight.ts) màu token theo palette Obsidian — hết màu đỏ
      escape/bracket lạ từ defaultHighlightStyle; (2) Embed thật: `![[note]]` transclusion render
      qua api.resolve + renderMarkdown (NoteEmbedWidget, depth ≤3), ảnh/file thiếu → box
      "could not be found"; (3) indent guide dọc cho list lồng (cm-indent mỗi đơn vị tab/4-space);
      (4) blockquote lồng `> >` render nhiều thanh (data-quote-depth + layered gradient);
      (5) checkbox/bullet hoạt động TRONG callout/quote (xử lý body sau marker);
      (6) callout fold +/-: StateField (lưu toggle, trạng thái = default XOR toggle → bền với
      async load), chevron click, `-` gập mặc định; (7) code block màu đúng + nhãn ngôn ngữ
      góc phải (data-lang); (8) display math `$$` fix thứ tự escape-pass (chạy cuối, không
      chiếm range); (9) HR hết margin thừa; (10) dòng inline-HTML (`<u>…`) render như HTML,
      mermaid render thật (lazy mermaid.js, StateField block widget); (11) block comment `%%`
      nhiều dòng xám toàn khối
- [x] M18.12 Đợt sửa 3 (4 lỗi editor + Reading parity): (1) bảng trong HTML embed cùng metrics
      với reading table; (2) inline footnote `^[...]` superscript; (3) fenced code có padding
      trong nền (16px), indented code bỏ nền + có indent guide như app; (4) embed note thêm
      `markdown-embed-title` (tên file) + fix khoảng trắng thừa (reset `white-space: normal`
      trong widget — pre-wrap của cm-content biến \n giữa các block HTML thành dòng trống);
      (5) Reading mode đồng bộ Live: task custom state `[/] [-] [>]`… thành checkbox
      (remark plugin `remarkObsidianTasks`, data-task, chỉ gạch x/X), li bỏ bullet,
      Properties hiện list value dạng pill (tags/aliases)
- [x] M18.13 Reading mode đồng bộ hoàn toàn với Live (theo phản hồi "Reading khác Live"):
      tách lib/callouts.ts dùng chung; pipeline remark thêm: remark-breaks (newline = <br>, §7),
      ==highlight== → <mark>, %%comment%% inline + block bị drop, block id ẩn, tag pill cùng
      charset editor, math $/$$ → span[data-tex] render KaTeX post-sanitize, mermaid render
      sau sanitize, callout đúng DOM §20 (icon + title-inner + content, màu theo
      data-callout→slot CSS, fold +/- click toggle, `-` gập sẵn), wikilink hiển thị
      `Note > Head` (luật reading §7), ảnh size param. Sửa bug sanitize: defaultSchema ràng
      buộc a.className (chỉ cho footnote class) làm mất class internal-link/tag — filter bỏ
      entry mặc định; thêm mark/u vào tagNames
- [x] M18.14 Reading mode = CHÍNH Live Preview editor set readonly (theo yêu cầu người dùng,
      thay kiến trúc 2 pipeline): Workspace bỏ <Preview/> cho mode reading, Editor thêm
      compartment `EditorView.editable(false)` + `EditorState.readOnly` + StateField
      `livePreviewReadonly` tắt mọi reveal-syntax-theo-caret (touches/lineActive/htmlBlock/
      mermaid/calloutFold); CSS `.is-reading-mode` ẩn affordance edit (table handles, property
      add/del, contenteditable) — checkbox và link vẫn bấm được như Obsidian. Hai chế độ giờ
      đồng nhất theo cấu trúc, không thể lệch. (Pipeline remark của Preview vẫn dùng cho
      split-pane source + public share.)
- [ ] M18.11 Tương lai: MathJax thay KaTeX (glyph parity tuyệt đối), heading/block mode
      suggester (`#`/`#^`), `$$` block nhiều dòng, click tag → search, fold heading/indent,
      chevron fold đặt sau title (hiện đặt trước)

---

## Phase 19 — Mobile / responsive UI (FR-11, theo yêu cầu người dùng)
- [x] M19.1 Hook `useIsMobile` (matchMedia 768px) + state cục bộ `mobileDrawer` ('left'|'right'|null)
      trong store (KHÔNG persist, không broadcast) → drawer điện thoại không đụng `uistate` sync desktop
- [x] M19.2 CSS `@media (max-width: 768px)`: `.app` 1 cột (workspace full-width); ribbon + sidebar trái
      thành drawer overlay trượt (translateX) + right sidebar drawer phải; backdrop mờ; touch targets ≥44px
- [x] M19.3 App shell: render sidebars luôn trên mobile (drawer), thêm backdrop đóng drawer; auto-đóng
      drawer khi mở note; hamburger (☰) + nút panel-right trên tab-bar mở drawer thay vì toggle width;
      ẩn crumbs + nút split trên view-header mobile (chống tràn)
- [x] M19.4 Edge-swipe: vuốt từ mép trái mở drawer trái, mép phải mở drawer phải, vuốt ngược để đóng
- [x] M19.5 Format toolbar (component `FormatToolbar`, dùng chung): bold/italic/heading/list/checklist/
      quote/link/internal-link/code/tag/indent/outdent/undo/redo, thao tác lên editor active qua
      `lib/activeEditor`; chỉ hiện khi soạn (Live/Source) note .md. Mobile = fixed neo trên bàn phím qua
      visualViewport; **Desktop = thanh in-flow dưới view-header** (theo yêu cầu người dùng)
- [x] M19.6 Viewport `viewport-fit=cover` + `interactive-widget=resizes-content` + safe-area insets;
      verify trên Chrome device emulation 390×844
- [x] M19.7 Mobile parity vòng 2 (theo phản hồi người dùng): (a) menu "…" của note (ContextMenu) bị
      cắt → clamp vị trí trong viewport (top/left ≥8px, ước lượng cao chặn theo `innerHeight`) +
      `max-height: 100dvh` cuộn được, rows to hơn cho cảm ứng; (b) khoá pan ngang nội dung note
      (`overflow-x: hidden` trên `.cm-host`/`.markdown-preview`, chữ wrap `overflow-wrap: anywhere`,
      ảnh/code/bảng tự co/cuộn trong); (c) modal Settings + Version history full-screen trên mobile
      (`position: fixed; inset:0`), settings-nav thành strip cuộn ngang, `.setting-row` stack dọc,
      input full-width, version-history list xếp trên preview; share dialog full-width

## Phase 20 — Graph node search & jump (theo yêu cầu người dùng, PRD 0.5)
- [x] M20.1 Ô "Find node…" nổi trên Graph view: gõ keywords → danh sách node khả dĩ (match
      label/path mọi từ, rank tag trước hết > prefix > label > path + degree, top 50); click hoặc Enter (kết quả
      đầu) → camera bay (pan+zoom lerp 15%/frame, zoom tối thiểu 2×) tới node + highlight kiểu
      hover (accent + dim phần không liên kết) tới khi di chuột; Esc đóng; wheel/drag hủy fly

---

## Phase 21 — Pane ⋯ menu parity Obsidian (theo yêu cầu người dùng, PRD 0.6)
- [x] M21.1 Menu ⋯ dựng lại theo cấu trúc Obsidian Desktop: nhóm Backlinks in document →
      Split/Open in new window → Rename/Move/Make a copy/Bookmark/Add file property/Export to PDF →
      Find → Copy path/Version history/Open linked view → Reveal in navigation/Share → tabs → Delete
- [x] M21.2 Find/Replace trong note: tích hợp `@codemirror/search` (search panel top, ⌘F/⌘⇧F/⌘G);
      item "Find…" gọi `openSearchPanel` qua `editorFind()` (activeEditor handle)
- [x] M21.3 Reveal file in navigation: `store.revealInTree` mở rộng folder tổ tiên + mở panel Files,
      FileTree nghe event `wo-reveal-file` → scrollIntoView + flash highlight 1.2s (data-path lookup)
- [x] M21.4 Add file property: KHÔNG dùng prompt — `triggerAddProperty(view)` kích hoạt đúng nút
      "+ Add property" của Properties widget (focus ô key + mở dropdown gợi ý key như Obsidian); tạo
      block `---` rỗng nếu note chưa có frontmatter rồi poll tới khi widget mount; menu chuyển Live trước.
      Fix kèm trong widget: (a) dropdown giá trị list/tags bị treo sau khi chọn (dd mount trên theme
      wrapper, không bị widget rebuild gỡ → `choose()` luôn `cleanup()` trước `mutate()`); (b) menu
      Property type/Copy/Remove giật giật khi left-click icon (mở bằng `mousedown` rồi `click` kế tiếp
      đóng ngay) → đổi sang `click` (openPropMenu đã `stopPropagation`)
- [x] M21.5 Export to PDF: chuyển Reading view rồi `window.print()`; CSS `@media print` ẩn ribbon/
      sidebar/tab/header/toolbar/status, chỉ in nội dung note (màu đen nền trắng, `@page` margin 16mm)
- [x] M21.6 Open version history (FR-4): server `git.log(path)` + `git.showFile(hash, path)` →
      routes `GET /api/git/log|/show`; modal `VersionHistory.tsx` liệt kê commit chạm file, preview
      nội dung version, "Restore this version" ghi đè + reload; rỗng khi chưa bật Git Sync
- [x] M21.7 Open in new window: `window.open(pathToUrl(path))` mở deep-link `/note/<path>` ở tab mới;
      Open linked view submenu (Backlinks/Outgoing links/Outline → `setRightPanel`)

---

## Phase 22 — Folder picker "Move file to…" + context menu Bookmarks/Recent (theo yêu cầu người dùng)
- [x] M22.1 Modal folder-picker kiểu Obsidian suggester (`FolderPicker.tsx`): gõ lọc folder, ↑↓
      điều hướng, ↵ move vào folder chọn, ⇧↵ tạo folder mới theo tên gõ rồi move, esc đóng; footer
      gợi ý phím. Driven bởi `store.movePath`/`setMovePath`. Thay `prompt()` cũ ở menu ⋯ (Workspace)
      và menu chuột phải file tree (FileTree). Lọc bỏ folder hiện tại + chính nó/con khi move folder.
- [x] M22.2 Context menu chuột phải cho panel Bookmarks & Recent (`BookmarksPanel.tsx`):
      Open/Open to right/Reveal in navigation/Move file to…/Bookmark↔Remove bookmark/Copy path;
      mục Recent thêm "Remove from recent" (`store.removeRecent`). Trước đây right-click rơi vào
      menu native của trình duyệt vì panel chưa có `onContextMenu`.
- [x] M22.3 Kéo-thả hàng Bookmark/Recent vào folder ở file tree để move (dùng chung payload
      `text/wo-path` mà FileTree đã đọc) + nút hành động hiện khi hover trên mỗi hàng (📁 Move file
      to… và ✕ Remove bookmark / Remove from recent).

## Phase 23 — Render HTML trong ```html code block (theo yêu cầu người dùng)
- [x] M23.1 Nút "Render HTML" trên mỗi block ` ```html ` — `htmlPreviewField` (StateField block
      widget trong `livePreview.ts`, đăng ký ở `Editor.tsx`). Vì Reading/Live đều là CodeMirror
      (M18.14), nút phải nằm trong editor chứ không phải `Preview.tsx`. Widget đặt NGAY TRÊN dòng
      mở fence (`side: -1`) — block HTML có thể khổng lồ (cả trang lưu ~296KB), nếu đặt sau block
      thì nút lọt ngoài viewport (CodeMirror ảo hoá DOM) → không bấm được. Click toggle hiện/ẩn
      `<iframe sandbox="allow-scripts allow-popups allow-forms allow-modals">` (KHÔNG same-origin →
      script trang lưu chạy nhưng cô lập khỏi vault/cookie/localStorage app), source vẫn hiển thị
      bên dưới. CSS `.cm-html-preview` + iframe 70vh resize dọc. Cùng nút thêm vào `Preview.tsx`
      (`setupHtmlPreview`, bọc `.html-block`) cho trang public `/share`. Verify thực tế qua CDP:
      iframe render đúng trang ChatGPT đã lưu. Typecheck + build sạch.
- [x] M23.2 (theo phản hồi): khi render thì (a) ẩn luôn code block, (b) iframe full-width pane.
      Thêm state `htmlRenderedState` + effect `toggleHtmlRender` (giống callout fold) để biết block
      nào đang render → rendered thì `Decoration.replace` cả block (ẩn code + chèn iframe), collapsed
      thì chỉ chèn nút phía trên (code vẫn hiện). Full-width: content căn giữa cột `--file-line-width`
      700px nên `.is-rendered` dùng `left:50% + translateX(-50%)` + width = `view.scrollDOM.clientWidth`
      (JS, sync on resize) để trải hết bề rộng scroller. Verify CDP: iframe 992px khớp pane, code ẩn,
      toggle 2 chiều OK.

## Phase 24 — Copy/Cut/Paste trong context menu file tree (FR-1, theo yêu cầu người dùng)
- [x] M24.1 Clipboard state ở store: `clipboard: {path, mode:'copy'|'cut'} | null` + `setClipboard`
      (session-local, KHÔNG nằm trong `PERSIST_KEYS` nên không lưu server/broadcast). Menu chuột phải
      file thêm Copy/Cut, folder thêm Copy/Cut; mục Paste chỉ render khi clipboard có dữ liệu. Row bị
      Cut làm mờ (`opacity .5`).
- [x] M24.2 `doPaste` (FileTree): đích = folder click hoặc thư mục cha của file. Cut → `api.rename`
      (move file/folder; dán đúng chỗ cũ = no-op; chặn dán folder vào chính nó/thư mục con; xoá clipboard
      sau khi dán). Copy → `api.copy` đệ quy, `uniqueChildName` né trùng tên (`… copy`/`… copy N`), giữ
      clipboard để dán nhiều lần.
- [x] M24.3 Server: `vault.copy(from,to)` dùng `fs.cp` recursive (file + folder), trả danh sách file
      tạo ra để reindex; throw nếu đích tồn tại. Route `POST /api/files/copy` upsert search + link graph
      cho các `.md` mới rồi schedule auto-commit. Client `api.copy`. Typecheck server + web sạch.
- [x] M24.4 (theo phản hồi): right-click vùng trống file tree giờ ra context menu của app (trước rơi vào
      menu native trình duyệt). `onRootContext` trên div FileTree (`minHeight:100%` phủ hết `.sidebar-body`):
      New note / New folder (vault root) + Paste (chỉ khi có clipboard) → `pasteToRoot` dán vào vault root
      (Cut = `rename` về root, Copy = `api.copy` né trùng tên). Áp cả nhánh "Vault is empty.".

## Phase 25 — Canvas (FR-12, PRD 1.0, theo yêu cầu người dùng)
- [x] M25.1 `web/src/lib/canvas.ts`: types JSON Canvas (CanvasNode text/file/link/group, CanvasEdge),
      parse/serialize an toàn (`{nodes:[],edges:[]}` mặc định khi rỗng/hỏng), helpers id (genId),
      preset colors `1..6`→hex, hình học edge (anchor theo side + Bézier path), hit-test bbox.
- [x] M25.2 `web/src/components/CanvasView.tsx`: view tự quản (như GraphView) đọc store `content`,
      parse, render. Pan/zoom (wheel zoom tâm con trỏ, kéo nền pan, space+drag), lưới chấm nền. Nodes
      tuyệt đối trong container transform; SVG layer cho edges (dưới nodes). Toolbar zoom in/out/fit/100%.
- [x] M25.3 Node interactions: double-click nền → text node + edit; drag move; 8 resize handles;
      double-click text node → textarea edit (Esc/blur thoát); file node render embed (note=Preview,
      ảnh=`<img src=rawUrl>`); link node = `<a>` card; đổi màu palette; xóa Delete/Backspace.
- [x] M25.4 Edge interactions: hover hiện 4 chấm cạnh; kéo chấm→node khác tạo edge (mũi tên đầu `to`);
      double-click edge thêm/sửa label; chọn edge đổi màu/xóa. Select: click, marquee, Shift+click,
      di chuyển/xóa nhóm; context toolbar nổi (màu, xóa).
- [x] M25.5 Autosave debounce ~900ms qua `setContent`+`save` (mark dirty → ghi `.canvas`). Wire vào
      `Workspace.tsx` (render CanvasView khi path `.canvas`, không phải folder/graph). CSS `.canvas-*`.
- [x] M25.6 Tạo canvas mới: store `newCanvas(dir)` (Untitled.canvas né trùng, body `{"nodes":[],"edges":[]}`);
      "New canvas" vào context menu FileTree (file/folder/root) + command palette. Typecheck web sạch.
- [x] M25.7 **Marquee select (Shift+kéo) + alignment snap (parity Obsidian, reverse-engineer asar):** kéo trái
      trên nền = **pan** (giữ theo ý người dùng — bỏ thử nghiệm marquee-mặc-định), **Shift+kéo = marquee chọn**;
      pan cũng qua Space/giữa/phải-kéo, touch 1-ngón pan. Kéo node: snap cạnh/tâm vào các node khác (`snapMove`
      trong canvas.ts, port `getSnapping/O3/P3`,
      điểm snap = 4 góc + tâm, dist = `ceil(15/scale)`), vẽ **guide line** (`.canvas-snaps`); Alt (⌃ trên mac) tắt
      snap; Shift khi kéo = khoá trục. Verify CDP: marquee chọn 5 node, guide hiện khi căn rồi mất khi thả.
- [x] M25.8 **Phím tắt format trong text card** (mirror `obsidianKeymap`): ⌘B/I/K(add link)/L(task)/`⌘/`(comment)
      trên textarea; `toggleWrap` bật/tắt marker. **Text alignment**: `TextNode.textAlign` (left/center/right) —
      nút trong selection menu (khi chọn text node) + submenu "Align" trong menu chuột phải; áp CSS cho cả textarea
      lẫn body render. (Mở rộng ngoài JSON Canvas spec — Obsidian thật bỏ qua field này.)
- [x] M25.9 **Fix UX theo phản hồi:** (1) mũi tên edge to hơn (marker 14×14, refX 11). (2) menu chuột phải card
      mở **đúng tại con trỏ** + `position:fixed` + đo kích thước rồi dịch vào trong màn hình (không tràn).

## Phase 26 — Ảnh: resize + zoom lightbox (FR-2, PRD 1.2, theo yêu cầu người dùng)
- [x] M26.1 `web/src/lib/imageLightbox.ts`: lightbox toàn màn hình singleton (gắn `document.body`).
      Wheel zoom theo con trỏ + pinch 2-ngón theo tâm (transform-origin 0 0, công thức giữ điểm cố định),
      kéo chuột/1-ngón pan, double-click reset (fit ≤ natural), Esc/click nền/nút × để đóng; listener pan
      gắn theo từng lần kéo nên không rò.
- [x] M26.2 Live Preview `ImageWidget` (livePreview.ts): 2 handle cạnh trái/phải hiện khi hover, kéo đổi
      rộng (clamp 40..contentDOM width, giữ tỉ lệ). `writeImageWidth()` recover vị trí qua `posAtDOM`, tìm
      lại token embed phủ vị trí đó và ghi size param: `![[img|W]]` (wikilink) / `![alt|W](url)` (markdown) —
      thay segment số cuối nếu có, không thì append. Click ảnh (không kéo) → `openLightbox`.
- [x] M26.3 Size param cho ảnh markdown `![](…)`: alt mang `|W`/`|WxH` → width/height ở **cả** Live
      (livePreview.ts imgRe) lẫn Reading (markdown.ts) — trước chỉ wikilink `![[…]]` mới có size.
- [x] M26.4 Reading view (Preview.tsx) click `<img>` → `openLightbox(currentSrc, alt)`; CSS handle resize
      (`.cm-image-resize`) + `.image-lightbox*` + cursor `zoom-in`. Typecheck sạch.

## Phase 31 — Central Sync architecture & contract gate — FR-13
- [x] M31.1 Audit sync hiện tại: xác nhận Git chỉ là eventual repository replication; WebSocket `fs` chỉ
      reload tree, open note có thể stale; write không revision/ETag và autosave có generation race.
- [x] M31.2 Bump PRD 1.5, thêm FR-13 + NFR/API/data model/DoD; viết roadmap chi tiết
      `docs/SYNC_ROADMAP.md` cho server, web, native plugin, headless client, Git transition và release.
- [x] M31.3 Chốt decision record trong roadmap/PRD: all normal vault files nhưng exclude toàn bộ `.obsidian`
      v1; clean diff3 else conflict-copy; trusted HTTPS/no E2EE; plugin repo riêng; JSON journal + WAL intents;
      Git backup-only; workspace per-device; current+previous protocol minor; headless npm/systemd/Docker.
- [x] M31.4 Định nghĩa protocol `1.0` bằng shared TypeScript + JSON Schema/OpenAPI: auth matrix,
      handshake, snapshot manifest, changes/ack, exact revisions/resumable blobs, operations/conflicts/devices;
      current+previous minor negotiation, canonical HTTP/error/result fields và limits advertised.
- [x] M31.5 Viết conflict matrix đầy đủ trong roadmap: create collision, text/binary modify, delete/modify,
      tombstone, rename/modify/rename, directory subtree/rmdir, case-only rename + deterministic result.
- [x] M31.6 Threat model + abuse limits trong roadmap: trust boundary, pairing/token/replay, path/symlink/case,
      blob/quota, CSRF/WS ticket, journal tamper/crash, compromised device, DoS, HTTPS và redaction.
- [x] M31.7 Tạo protocol fixtures/conformance harness dùng chung: golden request/response, event replay,
      cross-version compatibility; CI chạy cho server, web adapter, plugin và headless.

## Phase 32 — Sync metadata store, ordered journal & recovery — FR-13
- [x] M32.1 Tạo `packages/sync-core`: branded protocol types, stable entryId, NFC/case-collision path policy,
      SHA-256 streaming, sequence/revision, diff3/conflict, idempotency, local apply-intent/offline queue engine,
      error/result types; platform adapters tách DOM/Node/Obsidian.
- [x] M32.2 Tạo `data/sync/vault.json` với stable `vaultId`, `currentSequence`, `schemaVersion`; migration
      idempotent, file mode an toàn, atomic write + backup/checksum.
- [x] M32.3 Revision store `revisions.json`: stable entryId qua rename, normalized path,
      file/directory revision/hash/size/mtime/sequence, tombstone/previousHash; bootstrap scan
      snapshot-consistent, incremental/bounded cho vault hiện có.
- [x] M32.4 Segmented JSON journal + write-ahead transaction intents: active segment atomic rewrite/fsync,
      sealed immutable; commit point = committed event; startup finish/rollback intent ở mọi crash boundary,
      rebuild snapshot/idempotency sau commit; corruption → degraded read-only, không silent truncate.
- [x] M32.5 Retained merge bases + blob store content-addressed; retention theo age/count/ref, streaming
      read/write, SHA-256 verify, dedupe, Range download và bounded memory cho file 1GB.
- [x] M32.6 Idempotency store bounded theo device/clientSequence/key; duplicate retry trả nguyên kết quả,
      out-of-order/reused key bị reject rõ ràng.
- [x] M32.7 Tombstone/base/blob retention + compaction chỉ khi không phá active cursor; cursor expired trả
      `410` buộc manifest reconcile; backup metadata trước compact.
- [x] M32.8 `sync doctor` server-side: verify journal continuity/checksum, revisions↔filesystem hashes,
      tombstone, orphan blob/base, schema; repair safe issues và degraded/read-only mode cho corruption.
- [x] M32.9 Unit/property/crash-injection tests cho sequence, revision, rotation, replay, migration,
      compaction, idempotency và interrupted process.

## Phase 33 — SyncCoordinator: một mutation authority cho toàn bộ vault — FR-13
- [x] M33.1 Implement coordinator với per-path/directory locks + global journal commit lock; canonical
      operations create/modify/rename/delete/mkdir/rmdir/copy/trash/restore/import.
- [x] M33.2 Conditional mutation: require `baseRevision`, stale trả 409 có base/current/submitted metadata;
      text clean three-way merge, overlap/binary/delete-vs-modify tạo conflict-copy, không silent overwrite.
- [x] M33.3 Commit pipeline crash-safe: lock/validate → stage previous+new + fsync WAL intent → materialize
      atomic/fsync → atomic journal event commit point → rebuildable snapshots/idempotency → publish/delete intent;
      recovery finish-or-rollback deterministic ở mỗi failure point, success chỉ sau commit point.
- [x] M33.4 Chuyển web file routes (write/create/upload/rename/copy/delete/trash/restore) qua coordinator;
      giữ response legacy tạm thời nhưng thêm revision/hash/ETag.
- [x] M33.5 Chuyển Agent API write/append/delete qua coordinator; thêm conditional write contract và
      compatibility warning/feature flag trước khi buộc base revision.
- [x] M33.6 Chuyển Git restore/import và mọi internal mutation path qua coordinator; code search/CI guard
      không cho route/service gọi `vault.write*/rename/remove` trực tiếp ngoài adapter được phép.
- [x] M33.7 Event subscribers thống nhất cho QMD, links graph, file index, shares rename, stat cache,
      tree/Sync WebSocket và Git backup scheduler; bỏ duplicate reindex logic trong route.
- [x] M33.8 Watcher reconcile external filesystem edit: stable write + hash compare; coordinator write
      suppression theo `(path,hash)`; periodic drift scan; inode/hash heuristic cho rename, fallback delete+create.
- [x] M33.9 E2E hai writer + direct filesystem: mọi create/modify/rename/delete chain tạo đúng revision/event;
      inject crash không mất accepted write và không publish phantom event.

## Phase 34 — Sync API, device auth, pairing & blob transport — FR-13
- [x] M34.1 Device model + dedicated `sync` scope: one-time pairing code random/hash/TTL/single-use,
      high-entropy token chỉ hiện một lần, hash at rest, list/revoke/lastSeen/audit.
- [x] M34.2 Routes `/api/sync/v1/pairing-codes|pair|handshake|ws-tickets`: auth matrix admin/device,
      protocol current+previous minor, vault identity/limits/latest sequence, one-use 60s WS ticket,
      incompatible-major/client-too-old errors.
- [x] M34.3 Snapshot-consistent paginated `/manifest`, ordered `/changes?after&limit` và `/ack`: bounded
      response, per-device durable cursor, retention/410 behavior, filtering policy và exact revision metadata.
- [x] M34.4 `/files` exact entryId/revision + ETag/Range; blob HEAD/download và resumable
      `/blob-uploads/{id}/{part}/complete`: 8MiB chunks, quota/size/hash, 24h incomplete cleanup, dedupe.
- [x] M34.5 `/operations` ordered non-atomic batch: token-bound device/client sequence, idempotency,
      stable entryId/base revisions, dependency links + 424, independent path continuation; canonical result
      map accepted/merged/conflict/rejected và destination/case collision.
- [x] M34.6 `/conflicts` list/show/resolve và `/devices` management; resolve options server/client/merged/copy,
      mọi resolve tự tạo normal revision/event.
- [x] M34.7 Extend authenticated `/ws` bằng `sync.changed {vaultId,latestSequence}`; backpressure/heartbeat/
      reconnect; content không truyền qua WS, REST feed vẫn là source of truth.
- [x] M34.8 Security middleware: HTTPS non-loopback policy, rate/body/stream limits, normalized UTF-8 path,
      reject internal/.git/traversal/symlink, token/signed URL redaction, audit metadata không log content.
- [x] M34.9 API integration/conformance tests: auth/revoke, expired pair, duplicate/reordered retry,
      malformed blob/path, traversal/symlink, cursor expiry, protocol rolling upgrade.

## Phase 35 — Web client revision-safe sync & conflict UX — FR-13
- [x] M35.1 Store per-document state theo path/tab (`content`, `revision`, `hash`, `dirtyGeneration`,
      `saveGeneration`, pending/error) thay global content/dirty duy nhất; migration workspace không mất tab.
- [x] M35.2 Sửa autosave race: serialize per-document saves, capture generation+base revision, chỉ clear dirty
      khi generation hiện tại khớp; test latency/out-of-order response/navigation/unmount.
- [x] M35.3 API client đọc revision/ETag và conditional save; 409 giữ nguyên local draft, không hydrate đè,
      fetch base/current cho merge flow.
- [x] M35.4 Sync connection engine: handshake/cursor, one-use WS ticket wake-up → ordered REST catch-up/ack,
      fallback poll + reconnect backoff; IndexedDB persist browser device/cursor/apply-intent/offline queue/draft;
      clean open file auto apply ≤2s, dirty file conflict state.
- [x] M35.5 Conflict UI: side-by-side/base-current-local diff, keep server/keep local/save merged/create copy;
      binary metadata/download; unresolved badge/toast không chặn file khác.
- [x] M35.6 Settings → Sync: pairing codes, device list/last seen/revoke, conflict center, journal/doctor health,
      scope/exclude policy và diagnostics export redacted. Real-use audit found and repaired the missing external-client
      pairing control; deployed UI generated one-use codes used by two published headless clients and real Obsidian.
- [x] M35.7 Status UI `Synced/Syncing/Offline/Conflict/Error` + sequence lag; tách hoàn toàn Git backup status.
- [x] M35.8 Đổi `uistate.json` sang per-device workspace mặc định; migration từ shared state; mobile drawer/
      clipboard vẫn local; không còn thiết bị A tự chuyển tab thiết bị B.
- [x] M35.9 Browser×browser E2E: same/different note concurrent edits, stale open note, offline queue,
      reconnect, rename/delete, 1GB attachment stream, crash/reload giữa save; không silent overwrite.

## Phase 36 — Native Obsidian community plugin — FR-13
- [x] M36.1 Tạo public repo riêng `central-vault-sync` từ sample plugin; manifest id unique không chứa
      `obsidian`, README/LICENSE/versions/privacy/network behavior; desktop+mobile (`isDesktopOnly:false`).
- [x] M36.2 Publish/version public `@picassio/sync-core@0.1.3` package + protocol conformance fixtures; plugin
      adapter dùng Obsidian Vault text/binary API, `requestUrl`, one-use-ticket WebSocket và lifecycle registerEvent.
      User explicitly selected the existing personal npm scope instead of creating `@webobsidian`; server/browser/
      headless imports migrated, core published first, plugin 0.1.12 consumes the public exact dependency without vendor tarball.
- [x] M36.3 Pair/settings: server URL test, SecretStorage token, device name, pair/unpair, stricter client
      excludes (không override `.obsidian/.git/.trash`), fallback poll, mobile confirm ≥100MiB; raw token
      không vào `data.json` hay vault.
- [x] M36.4 Local engine: durable cursor + apply intents + pending offline queue, per-path modify debounce,
      globally serialized mutation preparation (uploads cannot overtake client sequence), automatic offline cold-start
      and foreground-event retry, create/rename/delete/subtree resume (rename→modify giữ identity/order và rehash
      destination; rename→delete collapse về original-identity delete), binary chunk batches, idempotent push,
      ordered pull/ack; indexed projection lookup + unchanged-path reconciliation không persist marker/sequence và
      yield mỗi 100 paths; không advance cursor khi local apply còn uncertain.
- [x] M36.5 Remote apply echo suppression theo expected `(path,hash,revision)`; không dùng timing flag;
      handle Obsidian event burst, case-only rename, Unicode normalization và file đang mở. Remote write/rename/
      delete bị defer khi path/subtree có pending/queued local work hoặc editor buffer khác disk; startup đợi
      workspace layout restore để apply-intent recovery nhìn thấy open editors; overlap tạo exact conflict copy.
- [x] M36.6 Plugin UX: status bar, Notice/commands Sync now/Pause/Status/Conflicts/Reconnect/Reset state,
      conflict view/resolve và redacted diagnostics export; unresolved badge được refresh từ authoritative server
      sau startup, mỗi successful sync và mỗi modal resolution, không reset sai về 0 khi restart.
- [~] M36.7 Mobile lifecycle: catch-up on load/focus/resume, persist queue/cursor trước yield, bounded batch/memory,
      rõ ràng không hứa background khi suspended; Android/iOS interruption tests.
- [~] M36.8 Plugin test harness/mock Vault + protocol conformance; manual matrix Windows/macOS/Linux,
      Android/iOS; no Node/Electron API để qua mobile policy. Exact public 0.1.12 bytes complete the Linux matrix:
      deployed pair/pull/push, Markdown/binary, immediate rename→modify, delete, outage/hard restart, offline cold
      start/retry, unsaved-editor conflict copy, exact hashes and clean durable state; Windows/macOS/Android/iOS remain unavailable.
- [x] M36.9 CI/release: lint/typecheck/test/build/policy/secret scan; tag `x.y.z` = manifest version,
      attach `main.js`, `manifest.json`, optional `styles.css`; private alpha + public beta.
- [~] M36.10 Submit initial release tại `community.obsidian.md` (Plugins → New plugin), xử lý automated/reviewer
      feedback bằng version mới; verify cài/update trực tiếp từ Community Plugins. Entry đã live; automated review
      đang chạy trên 0.1.14, reviewer approval + in-app install/update vẫn pending.

## Phase 37 — Linux headless CLI/daemon & sidecar — FR-13
- [x] M37.1 Tạo `clients/headless` npm package có `bin: web-vault-sync`; filesystem adapter + shared sync-core,
      Node ≥20, config/state/credential nằm ngoài vault và mode file 0600.
- [x] M37.2 Commands `init/pair/sync/watch/pull/push/status --json/conflicts/doctor/reset`; stable exit codes,
      non-interactive flags, redacted logs và shell completion/help.
- [x] M37.3 Local watcher chokidar native + polling fallback, stable write/hash, echo suppression,
      per-vault single-instance lock, case/Unicode/symlink handling. Real multi-file use exposed and now fixes a
      concurrent flush race by serializing queue drains and conditionally clearing only the exact observed marker;
      regression proves one upload/operation and preservation of a newer same-path event.
- [x] M37.4 Daemon engine: ordered pull/ack, durable local apply intents + offline push queue, idempotent retry,
      reconnect exponential+jitter, graceful SIGTERM; exact modes bidirectional, pull-only restore/quarantine drift,
      push-only metadata/conflict without remote content apply, one-shot durable boundary.
- [x] M37.5 Conflict CLI list/show/resolve + conflict-copy mặc định; `doctor` verify local state/cursor/hash,
      server reachability/protocol/token và safe reset không xoá file.
- [x] M37.6 Tested systemd `Type=simple` unit/install docs: dedicated user, EnvironmentFile/systemd
      credentials, network-online, restart policy + CLI doctor (không claim sd_notify watchdog v1);
      test reboot/network outage/permission failure.
- [x] M37.7 Sidecar Docker image non-root: bind vault + state, read-only secret, healthcheck, graceful stop;
      verified local source builds for amd64/arm64 (no registry publication); compose/Kubernetes examples.
- [~] M37.8 Headless E2E Linux/macOS + amd64/arm64: two daemon clients, browser/plugin interop,
      offline/restart/crash, large binary bounded memory; npm package/signing/SBOM release. Linux two-client
      create/catch-up, clean stale diff3 merge, overlapping-edit conflict copy, convergence, and contiguous
      two-device journal were exercised against the production build; public npm install/systemd/sidecar/reinstall
      passed on Linux. Real macOS execution remains external.

## Phase 38 — Git transition: backup/version history, không live sync — FR-4/FR-13
- [x] M38.1 Rename Settings/Ribbon/status/docs từ “GitHub Sync” thành “Git Backup & Version History” khi
      Central Sync mode bật; migration không xoá remote/token/history.
- [x] M38.2 Backup-only single-writer mode: coordinator committed events debounce commit/push snapshot;
      không remote pull vào live vault, retry/backoff độc lập và không block sync acceptance.
- [x] M38.3 Explicit Git import/restore: fetch/preview changed paths/conflicts, admin confirm, apply qua coordinator
      thành normal revisions/events; rollback/recovery test.
- [x] M38.4 Legacy bidirectional Git mode được giữ cho installation không bật Central Sync, có warning và
      mutual exclusion cứng; migration assistant kiểm tra clean repo/backup rồi chuyển backup-only, không có
      hidden force-push/pull bypass trong stable FR-13.
- [x] M38.5 Giữ Git LFS cho backup storage nhưng live attachment đi blob protocol; status/log UI tách backup lag
      khỏi sync lag/conflict; secret redaction regression tests.

## Phase 39 — Hardening, scale, migration & operations — FR-13
- [x] M39.1 Migration first-start cho vault hiện có: full backup prompt, bootstrap hash/index resumable,
      no mutation until ready, rollback metadata without touching vault files.
- [x] M39.2 Scale benchmark 10k note/50k file/high churn, manifest pagination, catch-up <500ms LAN,
      clean update ≤2s, 1GB bounded-memory transfer; document hardware/results.
- [x] M39.3 JSON journal scalability review: segment/compaction/retention tune; nếu không đạt NFR thì dừng,
      cập nhật PRD/changelog trước khi cân nhắc storage engine khác.
- [x] M39.4 Fault-injection campaign: kill process/network/disk-full/permission at every commit boundary,
      malformed metadata, missed watcher, clock skew; prove recovery/read-only behavior.
- [x] M39.5 Security review: auth/pair/revoke/replay, traversal/symlink, malicious plugin/client, blob quota/hash,
      dependency/secret scan, privacy disclosure; fix mọi critical/high.
- [x] M39.6 Observability: sequence/device lag, accepted/dedup/reject/conflict ops, bytes/dedupe, drift repairs,
      journal/compaction/backup status; authenticated sync health + diagnostics format chung.
- [x] M39.7 Backup/restore drills: restore vault + `data/sync`, rebuild metadata từ vault, cursor expiry reconcile,
      lost device revoke, conflict recovery; operator runbook.

## Phase 40 — Alpha, beta, stable release & support — FR-13
- [x] M40.1 Server technical preview gate: revision/journal/coordinator/API/browser complete, simulated clients,
      no known silent overwrite, crash/conformance/security baseline pass.
- [ ] M40.2 Private alpha: native desktop plugin + headless daemon sync Markdown/attachments/offline/rename/delete;
      collect protocol/diagnostic feedback, migration tested on copied real vaults.
- [ ] M40.3 Public beta: mobile foreground catch-up, all client pair matrix, docs/systemd/Docker, Git transition,
      telemetry-free diagnostics, no open critical/high data-loss/security bug.
- [ ] M40.4 Stable server release: compatibility/migration/rollback docs, signed artifacts/SBOM, reproducible
      local amd64/arm64 Docker builds, upgrade preserves vault and Git history; recovery drills recorded.
- [x] M40.5 Publish headless npm package + local amd64/arm64 Docker build examples; verify clean Linux server
      install, systemd boot, sidecar health and unattended upgrade. Registry image publication is intentionally out.
      `web-vault-sync@0.1.0` + exact `@picassio/sync-core@0.1.2` are public; registry-origin dedicated-user
      pair/sync/status/doctor, hardened systemd active push, healthy non-root source-built sidecar, graceful stop,
      and reinstall preserving external token/state hashes all passed. Earlier pre-marker packed upgrade remains valid.
- [ ] M40.6 Community plugin approval/installability + support docs: pairing, mobile limitations, conflicts,
      privacy, troubleshooting, compatibility matrix and responsible disclosure.

## Phase 41 — First-class multi-vault in one process — FR-1/FR-13
- [x] M41.1 Contract/migration: PRD 1.9 + roadmap; settings v4 registry with stable `vaultId`, default vault,
      v3 in-place migration preserving existing `data/sync` plus immutable mode-0600 pre-v4 settings backup, roots
      allowed/non-overlapping/non-symlink, unregister never deletes files, rollback backup.
- [x] M41.2 Runtime isolation: per-vault coordinator/journal/revisions/devices/uploads/blobs/conflicts/retention,
      watcher, QMD/link/file indexes, Git queue/backup, shares, plugins and workspace; bounded parallel startup and
      graceful per-vault shutdown.
- [x] M41.3 Vault administration API: authenticated list/register/update/default/unregister with explicit safety
      confirmations, health summary and audit-safe errors; legacy API defaults to default vault.
- [x] M41.4 Request/auth routing: web/session/Agent `X-WebObsidian-Vault-Id`; API keys explicitly scoped to vaults;
      device token and WS ticket select exactly one vault and cannot be overridden; vault-specific browser cookie.
- [x] M41.5 Web UX: vault switcher, add/edit/unregister Settings UI, per-vault workspace/browser sync lifecycle,
      `/vault/<vaultId>/note/...` and graph deep links with legacy default redirects.
- [x] M41.6 Client compatibility: Protocol 1.0 plugin/headless unchanged after pair; pairing UI targets selected
      vault; device/conflict/doctor/metrics views scoped; docs and OpenAPI updated.
- [x] M41.7 Verification: v3 migration/rollback, two simultaneous vault E2E and cross-vault denial, restart/watch,
      duplicate/overlap/symlink path rejection, token/API-key isolation, browser switch, headless clients on both,
      backup/restore, typecheck/build/full CI and deployed no-data-loss upgrade. Commit `7ab4e4a` is deployed and pushed;
      CI [29300068248](https://github.com/picassio/webobsidian/actions/runs/29300068248) attempt 2 passed both jobs,
      including automated same-path isolation, forged token-header denial, API-key grant denial, restart persistence,
      amd64/arm64 attested builds and non-root smoke. Real production migration/rendered/auth/rollback/reboot/headless
      evidence also passes.
- [x] M41.8 Pairing safety follow-up (PRD 1.10): show selected target vault name/id/sequence and explicit
      no-auto-create/convergence warning before code issuance; expose paired vault ID in plugin settings; separate
      handshake/Test control throttling from a 600 request/minute/device bootstrap transfer budget; preserve tight
      pairing limits, Retry-After, Protocol 1.0 request shapes, and add regression coverage before deployment.

### Nhật ký tiến độ
- 2026-07-14 (pairing safety + bootstrap throttling): PRD advanced to 1.10. Server/Web commit `b9e6cae`
  displays exact selected vault name/id/sequence, states that codes never create vaults, distinguishes empty bootstrap
  from populated convergence, and requires confirmation before code issuance. Transfer/upload budget is now 600
  requests/minute/device with 1,800/minute shared-IP protection; handshake/Test retains an independent 120/minute
  control bucket and pairing remains 10/minute/IP with Retry-After. Added rate-bucket and target-copy tests; full local
  core/93-server/15-web/16-headless suite, typecheck/build/docs, browser E2E, and CI 29322711562 pass. A source-built
  production deployment preserved `/vault`, `/vaults`, `/data`, both healthy vault identities/sequences, and rendered
  `Desktop Obsidian` target sequence 0. Plugin source/tag `121e03b`/0.1.15 shows bound vault ID and retry delay; Node
  CI 29320411927 and release CI 29320413904 pass, and 0.1.15 is normal/non-prerelease/Latest.
- 2026-07-14 (isolated desktop vault onboarding): clarified that every unrelated local Obsidian vault must pair to a
  separately registered server vault; plugin pairing never auto-registers or merges vault identities. Backed up the live
  registry, registered an empty isolated `Desktop Obsidian` vault, and verified sequence 0, zero index lag, writable
  health, rendered selector switching, and one-use pairing-code creation through trusted HTTPS. A code generated while
  the default vault was still selected was then used by the desktop client: it committed 30 creates + 10 mkdirs before
  rate limiting exposed the wrong binding. The device was revoked; audit proved no modification/collision with existing
  entries; a stopped-service backup preceded normal revisioned 30-delete + 10-rmdir cleanup. Default server/Pi PARA
  canonical paths are clean at sequence/cursor 845, while the isolated desktop vault remains empty at sequence 0.
- 2026-07-14 (Community popout review response 0.1.14): automated review warned twice against global `document`
  in foreground lifecycle registration. Replaced visibility/focus handling with Obsidian `activeDocument` and
  `activeWindow`, bumped source/tag to `26cd75e`/0.1.14, and changed README/policy language from prerelease to
  **Community review release**. Published 0.1.14 as normal, non-draft, non-prerelease and Latest with release notes;
  public manifest/assets match and no forbidden global-document pattern remains. Release CI 29311542151 passed.
  Node CI 29311540042 attempt 1 failed only from npm registry `ECONNRESET`; clean attempt 2 passed Node 20/22/24.
- 2026-07-14 (Community automated review response 0.1.13): entry is live and pending automated/human review.
  Review warned that `authorUrl` pointed to the repository and recommended release notes plus explicit disclosure for
  vault enumeration and clipboard access. Published source/tag `ab77e27`/0.1.13 with organization-profile author URL;
  README now explains startup enumeration and that clipboard access is explicit write-only redacted diagnostics.
  Added release notes to 0.1.12 and published 0.1.13 as non-draft/non-prerelease/Latest with matching manifest plus
  unchanged runtime `main.js`/`styles.css`. Node 20/22/24 CI 29307701871 and release CI 29307703754 pass; automated
  review refresh and reviewer approval remain pending.
- 2026-07-14 (Community submission release discovery): the directory reported no release for manifest 0.1.12
  even though tag/assets matched because GitHub still marked the release as prerelease. Promoted the existing 0.1.12
  release in place to published, non-draft, non-prerelease and Latest without changing its tag or three verified asset
  digests. Public manifest download matches default-branch `manifest.json`; plugin README-only commit `32d8597`
  explains that 0.x remains beta software while the normal GitHub release flag is required for directory scanning.
- 2026-07-14 (M41 committed provenance + remote CI): committed first-class multi-vault as `7ab4e4a`, pushed `main`,
  replaced the production working-tree bundle with a clean detached checkout of that exact commit, and re-verified
  healthy sequence 708 plus clean permanent headless state. CI 29300068248 attempt 1 was cancelled after its first
  multi-architecture Buildx step stalled far beyond the established baseline; attempt 2 passed typecheck/build, all
  test suites, OpenAPI/docs/audit, browser/headless/multi-vault E2E, systemd verification, attested amd64/arm64
  server/headless builds and non-root smoke. Phase 41 is complete; Windows/macOS/mobile/Community/stable-publication
  gates remain in their existing Phase 36/37/40 rows.
- 2026-07-14 (M41 production deployment and recovery acceptance): created stopped-service vault/data/source backups,
  deployed the source-built multi-vault image, and verified v3→v4 retained the default `vaultId`, sequence 701 and
  byte-identical vault while creating mode-0600 immutable migration state. A mount invariant caught a deployment-local
  override omission before any client resumed; the process had temporarily booted against empty non-authoritative data,
  so no authoritative bytes changed. The correct persistent bind was restored and the unused empty volume removed.
  Authenticated API plus rendered Chromium registered/switched two vaults with isolated `index.md` content and scoped
  deep links; a paired token ignored a forged default-vault header; unregister/re-register retained files and identity,
  then the disposable vault/device were detached/revoked. A real old-build/v3 rollback followed by forward v4 restore
  passed at sequence 701, as did a full guest reboot, healthy restart, tailnet HTTPS, permanent pi-para one-shot/timer,
  and headless doctor (`checkedEntries=637`, no issues). `/api/vaults` now exposes per-vault health, and Compose supports
  optional `DATA_HOST_PATH` bind storage so backup-visible data does not depend on a private override. M41.7 remains
  `[~]` only because this working-tree deployment has no committed revision or remote CI run.
- 2026-07-13 (M41 final local hardening): serialized global settings and vault-registry transactions prevent lost
  concurrent registrations/updates; realpath-normalized requested allowlists cannot escape through symlinks; v3→v4
  writes immutable mode-0600 `settings.v3.pre-v4.json`; unregister/shutdown refuse new leases and wait for accepted
  HTTP/sync-ticket work before projection flush, with fail-safe runtime recovery. Added regressions for concurrent scoped
  updates/registrations, contested roots, allowlist symlink escape, future schema rejection and runtime drain. Final full
  92-server/13-web/16-headless tests, typecheck/build/lints, all three E2Es, systemd/Compose checks and latest source
  Docker build pass. Deployment gates remain unchanged.
- 2026-07-13 (First-class multi-vault local implementation): settings v4 migrates the existing vault identity/data
  in place and keeps detached records for identity-preserving re-registration. AsyncLocalStorage request context plus
  a runtime registry isolate coordinator/journal/revisions/devices/tokens/uploads/blobs/conflicts/retention, watchers,
  QMD/link/file indexes, Git queues/timers, plugins, shares, workspace and browser IndexedDB. Added vault CRUD/default
  API, header/API-key scoping, token-selected Protocol 1.0 routing, vault-bound WS tickets/manifest cursors/cookies,
  selector/settings UX and vault-aware deep links. Added Docker parent mount and systemd template profiles. Also fixed
  the deployed headless watcher flush race with a serialized lane and exact-marker removal. Full root tests (core,
  92 server, 13 web, 16 headless), typecheck/build, OpenAPI/docs lint, Compose validation, source Docker build, existing
  browser/headless E2E and the new automated multi-vault auth/isolation/restart E2E pass. Rendered UI
  registered/switched/reloaded two vaults with isolated same-path content; two real headless profiles paired
  to one URL and independently converged; forged vault headers could not override tokens, API key A received 403 on B,
  restart preserved both, and a copied 9.4 MiB real v3 data + 4.8 MiB vault migrated to v4 preserving vaultId and every
  vault byte. Production deployment/reboot and remote CI intentionally remain M41.7.
- 2026-07-13 (First-class multi-vault kickoff): user explicitly expanded scope from the documented one-vault-per-instance
  workaround to concurrent vaults in one process. PRD 1.9 and the Sync roadmap now preserve legacy default routes and
  Protocol 1.0 while requiring vault-scoped web requests, token-bound sync runtimes, isolated metadata/index/watch/Git/
  share/workspace state, non-overlapping real roots, in-place v3 migration and unregister-without-delete semantics.
- 2026-07-13 (Deployed real-use browser/headless/plugin acceptance): real UI pairing generated one-use credentials
  for two registry-origin `web-vault-sync@0.1.0` clients and exact public plugin 0.1.12 on Obsidian Linux 1.12.7.
  Browser note/link/backlink/search, first-directory PNG drop, two-headless catch-up/diff3/conflict/watch/status/doctor,
  browser conflict resolution, and plugin upgrade/pull/Markdown+binary/immediate rename→modify/delete all converged.
  Endpoint outage plus offline hard restart retained plugin work; an unsaved open-editor overlap preserved canonical
  remote bytes and an exact local conflict copy. Real use found and fixed the browser attachment-parent bug and a
  plugin wake/echo race; core 0.1.3 adds durable enqueue-before-publish and flush-before-pull wake/poll ordering, while
  plugin 0.1.12 safely advances already-materialized rename metadata without replacing later local bytes. Core/plugin
  regressions, 129 repository tests, CI 29264703837, plugin Node 20/22/24 CI 29265124982, and release CI 29265127275
  pass. Disposable files/conflicts were resolved/removed, all test devices revoked, and both headless doctors were clean.
- 2026-07-13 (Real-use browser attachment parent repair): dragging the first image into a newly paired real browser
  exposed that attachment upload submitted `attachments/<file>` before the explicit parent directory existed. The
  coordinator correctly refused materialization, but the optimistic editor embed made the failure non-obvious. Browser
  upload preparation now serializes sequence allocation, durably queues every missing parent `mkdir` before the file,
  reuses projected/queued/session-known directories, and preserves order across concurrent drops. A regression covers
  nested parent creation, duplicate suppression, existing projections, pending offline mkdirs, and sequence ordering;
  web tests/root typecheck pass; deployed drag/drop committed exact PNG bytes and cross-client pull succeeded.
- 2026-07-13 (Real-use external pairing UX audit): opening Settings → Central Sync as an operator exposed that
  browser self-pairing worked but the documented 10-minute one-use code for Obsidian/headless clients had no UI.
  Added a device-name hint, explicit Create pairing code action, read-only one-use code/expiry display and clipboard
  action without diagnostics persistence. Browser E2E now generates and schema-checks a real code through rendered
  Settings, and the standalone command now rebuilds the SPA before execution so stale `server/public` cannot mask UI
  regressions. Typecheck/E2E pass; deployed UI codes paired two headless clients and real Obsidian successfully.
- 2026-07-13 (Compose IPv4 health regression): a production-like source deployment exposed that Compose overrode
  the already-correct Dockerfile healthcheck with `localhost`; Alpine resolved it to IPv6 while Node listened on IPv4,
  producing false `unhealthy` state despite a healthy API. Changed Compose to `127.0.0.1`, added a CI contract
  assertion, and confirmed the recreated container immediately healthy. Environment-specific deployment inventory,
  addresses, paths, and credential references are intentionally kept out of this public repository.
- 2026-07-13 (Personal npm scope publication + registry-origin M40.5): user explicitly rejected creating an npm
  organization and selected personal scope `@picassio`. PRD bumped to 1.8; every server/browser/headless import,
  package manifest/lock, Docker build, workflow and current doc moved from `@webobsidian/sync-core` to
  `@picassio/sync-core` without changing Protocol 1.0. Full root typecheck, 126 tests (including 1 GiB), build,
  OpenAPI/Markdown lint and zero-vulnerability audit passed. Published public `@picassio/sync-core@0.1.2`
  (SHA-1 `6ebe86f6…8120`, integrity `sha512-X70Ok…`) then exact-dependent `web-vault-sync@0.1.0`
  (SHA-1 `d9469c96…dd33`, integrity `sha512-QCqCS…`). Clean registry installs imported Protocol 1.0, ran the CLI,
  resolved the exact core dependency and audited clean. A fresh production server plus dedicated system user proved
  registry-origin init/pair/push/status/doctor at cursor 1; the shipped hardened unit reached active and watcher-pushed
  cursor 2; a source-built scope-migrated non-root sidecar became Docker healthy, pushed exact bytes, and stopped with
  exit 0. Same-version unattended reinstall preserved external state/token hashes and restarted at cursor 2.
  `NPM_TOKEN` was configured from 1Password without exposure. Plugin removed its vendored 0.1.1 tarball, consumes
  public core 0.1.2, and published 0.1.10 (source/tag `e430b67`; CI 29252582130/release 29252583800). M36.2 and
  M40.5 are complete; M37.8 remains partial only for real macOS.
- 2026-07-13 (Rename-event burst ordering + exact plugin 0.1.9): queue audit found a destination upsert could
  replace a durable rename marker, while a pre-rename modify marker pointed at the now-missing old path. The result
  could create a second identity at the destination and leave stale server content. Pending markers now coalesce
  rename→upsert without losing `oldPath`, commit rename first, then durably rehash destination against either the
  new projection or prior identity/base. Rename→delete before flush collapses to deletion of the original identity.
  Regressions prove rename/modify operations use sequences 1/2 on one entry ID and immediate rename/delete emits
  only original-identity delete. Exact 0.1.9 bytes in real Obsidian 1.12.7 renamed `Burst.md`→`Final.md` and modified
  it before debounce: journal sequences 12/13 were rename then modify, both retained entry
  `entry_8KBpvgDn-wjEAn_NF8ILtfF2`, revisions 9→10→11, local/server final bytes matched, old path was absent,
  and cursor 13 had zero conflicts/queue/pending/apply intents. Public source/tag `244b062`/0.1.9; release CI
  29248410774 and Node 20/22/24 CI 29248409324 passed; `main.js` SHA-256 `c2e653b6…4eed`. External gates remain.
- 2026-07-13 (Authoritative conflict badge + exact plugin 0.1.8): restart after the open-editor drills exposed
  that two unresolved server conflicts remained durable/listable but the plugin status/diagnostics reset their
  in-memory count to zero, violating M36.6 visibility. Successful sync now refreshes the count from the authenticated
  authoritative conflict endpoint; modal resolution invokes the same refresh before re-rendering. Exact 0.1.8 bytes
  on real Obsidian 1.12.7 restored 2 conflicts after restart at cursor 7, changed immediately to 1 after **Keep
  server**, restored 1 across another restart, then reached 0/“No unresolved conflicts” after resolving the last
  record at cursor 9 with zero queue/pending/apply intents. Public source/tag `a533066`/0.1.8; release CI
  29247571867 and Node 20/22/24 CI 29247570394 passed; `main.js` SHA-256 is `7a3db095…49c0`. External gates remain.
- 2026-07-13 (Native plugin startup reconciliation scalability + exact 0.1.7): Community load-time audit found
  every startup path was persisted twice (queue marker then removal) even when kind/hash matched projection; each
  save serialized the full projection, while `entryByPath`/`entryById` linearly scanned it. Large-vault startup was
  therefore quadratic I/O/CPU despite correct bytes. `LocalMutationQueue.reconcile()` now hashes/checks existing
  paths without persisting unchanged work or allocating a sequence, reschedules existing durable markers, rejects
  path-kind divergence, and yields to the UI every 100 paths. `PluginStore` maintains O(1) path/ID/position indexes
  across load, manifest replacement, rename, and tombstone updates. Regressions prove unchanged reconciliation has
  zero writes/sequence use and 10,000-entry lookup bypasses array `find` while retaining exact cardinality through
  rename/tombstone. Exact 0.1.7 bytes in real Obsidian 1.12.7 completed an instrumented unchanged reconnect at
  cursor 7/next sequence 4 with zero queue/pending/apply intents and zero `Plugin.saveData` calls. Public source/tag
  `6f34852`/0.1.7; release CI 29246980083 and Node 20/22/24 CI 29246978388 passed; `main.js` SHA-256 is
  `29d98721…983e`. Remaining npm/Community/platform/independent-beta/stable gates are unchanged.
- 2026-07-13 (Unsaved open-editor overwrite repaired + exact plugin 0.1.6): direct M36.5 validation against real
  Obsidian 1.12.7 disproved the completed “file đang mở” claim in 0.1.5. With `Open.md` dirty only in CodeMirror,
  a racing web revision was applied through `Vault.modifyBinary` within 150 ms; Obsidian replaced the unsaved
  editor buffer, then the pending marker hashed remote bytes and silently discarded local text. The adapter now
  defers remote file replacement/rename/delete when an affected path/subtree has durable pending/queued work or
  when any open Markdown editor differs from disk. Paused clients also defer remote apply. Initial paired startup
  waits for workspace layout restoration, and concurrent start/reconnect requests share one initialization, so
  restored editors are visible before apply-intent recovery. Mock regressions prove pending-path and pre-Vault-event
  dirty-editor protection. In the exact 0.1.6 drill, local `local protected 0.1.6` survived while the remote event
  remained an apply intent/cursor 5; after normal autosave, the stale operation became a durable conflict copy and
  catch-up converged at cursor 7. Canonical held `remote 0.1.6`; both local/server conflict-copy hashes were
  `04d264a7…6cf`; queue/pending/apply intents were zero. A pause drill held cursor/disk unchanged until resume.
  Public source/tag `2ba5b03`/0.1.6; release CI 29246318823 and Node 20/22/24 CI 29246317400 passed; public
  `main.js` SHA-256 is `9a498bb9…41f2`. Linux M36.5 evidence is now real rather than inferred; other platform,
  npm, independent beta, Community, and stable gates remain open.
- 2026-07-13 (Foreground outage retry + Community-guideline preflight + plugin 0.1.5): follow-up review found
  that startup/manual sync failures armed a retry, but a normal foreground Vault event whose upload failed only
  retained its durable marker and displayed a Notice. The local queue now reports runtime failures to the plugin,
  which sets Offline, persists a redacted error, and schedules the same bounded retry. A regression proves failed
  upload consumes neither marker nor client sequence. Real Obsidian 1.12.7 exact release bytes were synchronized at
  cursor 12, the server was stopped, and a five-byte attachment was created without manual Sync now or restart;
  status became Offline with one marker and unchanged sequence. After server return, automatic retry reached cursor
  13, consumed exactly one sequence, matched local/server SHA-256 `0835f545…3d8`, cleared the stale error, and left
  zero conflict/queue/pending/apply intents. Community preflight also removed the redundant first settings heading,
  used Obsidian `Setting.setHeading()` in the conflict modal, and added a policy gate preventing README/manifest
  prerelease-version drift. Public source/tag `d7b5d80`/0.1.5; release CI 29245150078 and Node 20/22/24 CI
  29245148526 passed; public asset `main.js` SHA-256 is `08f7e3c3…df6e`. Submission still requires the owner's
  authenticated Obsidian account; acceptance and unavailable platforms remain open.
- 2026-07-13 (Native plugin ordering repair + exact 0.1.4 Linux lifecycle matrix): real Obsidian 1.12.7 exposed
  a release-blocking race absent from the mock suite: a slower Markdown upload reserved client sequence 2 while a
  later binary operation reached the server as sequence 3, permanently rejecting sequence 2 as reused. Plugin
  0.1.4 serializes all pending-path preparation, revalidates stale timers, and reserves sequence/idempotency only
  after an upload succeeds. A concurrency regression blocks the second upload while the first is unresolved.
  Startup/manual sync now remains loaded with explicit Offline status, redacted error, durable pending paths, and
  scheduled retry when the server is unavailable; successful recovery clears the stale error. Exact release bytes
  (`main.js` SHA-256 `fc64bd36…4e2`) ran the copied-vault matrix: simultaneous Markdown/binary create, modify,
  identity-preserving rename, attachment delete, outage plus hard restart, server-offline cold start plus automatic
  recovery, and concurrent 2 MiB/1-byte uploads. Local/server hashes matched; cursor/journal ended gaplessly at 12
  with zero conflicts/queue/pending/apply intents. Screenshot and full results are in `docs/sync/evidence/`.
  Plugin source/tag `a582605`/0.1.4; release CI 29244294191 and Node 20/22/24 CI 29244292517 passed. Linux M36.8
  evidence is complete; unavailable Windows/macOS/mobile, independent beta, npm, and Community gates remain open.
- 2026-07-13 (Explicit stable-acceptance audit map): added `docs/sync/ACCEPTANCE_EVIDENCE.md` as the durable
  FR-13 completion ledger. It maps every PRD DoD 8–14 row and phase 31–40 to current source/tests/CI/releases/
  screenshots, distinguishes PASS from PARTIAL/BLOCKED without scope waivers, records the source-build-only image
  policy, and lists exact npm/Community/platform/stable-tag prerequisites. DoD 8, 11, 12, and 13 plus phases
  31–35 and 38–39 are evidenced PASS; DoD 9/phase 36 and phase 37 are partial; mobile DoD 10, publication DoD 14,
  and phase 40 remain externally blocked. Roadmap and sync index link the ledger; completion is forbidden until
  every open row gains concrete artifact/review/platform evidence.
- 2026-07-13 (npm publication preflight + exact scope blocker): npm authentication now succeeds as `picassio`.
  Both packages pass clean public dry-run with no metadata auto-correction after normalizing repository URLs;
  core tarball SHA-1 `d8710e09...`/SHA-512 `3bFmgg...`, headless `f93d692e...`/`LIIBYA...`. Commit `3d27b5a`
  passed CI run 29240963980 with all 126 tests and the full dual-E2E/docs/API/audit/systemd/multi-arch matrix.
  Actual core 0.1.2 publication reached npm but returned `E404 Scope not found`; the user-owned `@webobsidian`
  organization/scope has not been created or authorized. Headless was deliberately not published because its exact
  core dependency would be unavailable. At that point the required action was creating/authorizing the org scope;
  this blocker was later superseded by the explicit PRD 1.8 decision to publish under `@picassio`, while the rule
  that credentials/tokens must not be shared in chat remains.
- 2026-07-13 (Installed headless upgrade + CLI failure-path repair): a real isolated global-prefix drill installed
  packed commit `4d45e88` (`sync-core` 0.1.1 + pre-marker `web-vault-sync`), paired/synced revision 1, replaced it
  with current packed core 0.1.2/headless bytes, then proved unchanged credential/device/cursor/vault, additive
  `mergedSources` state migration, accepted revision 2, empty queue, exact server bytes, and clean doctor. The first
  attempt exposed a release-blocking CLI TDZ: any early usage/startup error could make `exitCode()` reference
  `UsageError` before initialization and emit `ReferenceError`. Error classes now initialize before execution;
  `version`/`--version` reads the installed package metadata without state, and process-level regressions prove usage
  exit 2 plus uninitialized-state exit 6 with sanitized JSON. Headless 13/13 and full typecheck pass. Commit
  `81e9ba5` passed CI run 29240400322: all 126 tests, docs/API/audit, both production E2Es, systemd verification,
  attested amd64/arm64 source builds, and non-root smoke.
- 2026-07-13 (Final sync-source hygiene/type audit): no TODO/FIXME/HACK/TBD placeholders exist in core/server/
  browser/headless sync paths (the only “todo” matches are legitimate callout names), and no workflow/docs path
  can publish registry images. Replaced the Central Sync admin API/UI's remaining `any` contracts with explicit
  health, doctor, Device, Conflict, browser-device, and conflict-resolution types. Type narrowing also exposed a
  possible undefined binary download basename; it now has a deterministic `conflict.bin` fallback. Full typecheck,
  browser 11/11 tests, and production build pass; unrelated legacy app/plugin-loader `any` usage was not broadened.
  Commit `03a3909` passed CI run 29239495401: all 124 tests, docs/API/audit gates, both production E2Es,
  systemd verification, attested amd64/arm64 source builds, and non-root smoke.
- 2026-07-13 (Markdown/link integrity gate): scanned all 25 repository Markdown files outside generated/vendor
  trees. Every relative target and GitHub-style heading anchor resolves. Live HTTP probes found one stale external
  reference (`obsidianmd/obsidian-skills`, 404); the documented `npx skills` installer now points to its actual
  `vercel-labs/skills` repository, and all 30 cited external endpoints return an acceptable live response. Added
  deterministic `npm run lint:docs` validation and required it in both CI and stable publication workflows;
  README documents the command. External reachability remains a manual release probe to avoid flaky CI networking.
  A follow-up distribution-policy grep also corrected the compatibility table's stale “image publication pending”
  wording: npm is pending, while registry images are intentionally not offered and local source builds are verified.
  Commit `7524512` passed CI run 29238406643, including the new link gate and the complete 124-test, dual-E2E,
  type/build/API/audit, systemd, attested amd64/arm64 source-build, and non-root smoke matrix.
- 2026-07-13 (Stable workflow fail-closed publication): audit found the tag workflow could succeed and create
  a GitHub stable release while silently skipping npm publication when `NPM_TOKEN` was absent. Publication is now
  mandatory: the workflow fails before build without the secret, runs both browser and two-headless-client E2E,
  requires tag/root/core/headless version equality, publishes both npm packages with provenance, and creates the
  GitHub release only afterward. `docs/sync/README.md` records the operator prerequisite and source-build-only
  container policy. No stable tag was created and the currently absent repository secret remains an explicit gate.
  Commit `971d2d3` passed CI run 29237600099: 124 tests, both production E2Es, type/build/API/audit, systemd,
  attested amd64/arm64 source builds, and non-root smoke.
- 2026-07-13 (Two-headless-client merge/conflict drill): paired two independent Linux CLI profiles to a fresh
  production server and verified create/catch-up, clean stale diff3 convergence, overlapping stale-write conflict
  preservation, exit code 4/listing, contiguous sequences 1–5, and distinct device actors. The first drill exposed
  a false quarantine when applying the server result of a clean merge: the submitted local bytes legitimately
  differed from both the prior and merged hashes. Sync core 0.1.2 now notifies adapters of committed operations;
  the filesystem adapter durably records only the exact submitted merge source before queue removal (surviving a
  crash/restart), replaces it with canonical merged bytes, and still quarantines unrelated drift. Regression tests
  and the repeated real drill prove zero conflict/quarantine
  for clean merge and durable conflict behavior for overlap. Core 14/14, headless 11/11, full typecheck/build/audit
  pass; packed core 0.1.2 plus headless artifacts also clean-install together without workspace links. Commit
  `e783316` passed CI run 29234148411 (attempt 2): all 124 tests, type/build/OpenAPI/audit, production browser
  E2E, systemd verification, both attested amd64/arm64 source builds, and non-root image smoke. The exact
  production server/dist-CLI scenario is now `e2e/headless-pair.mjs` and a required CI step, not manual evidence only.
  Commit `3accb1b` passed CI run 29236947946 with the new two-headless-client step plus the full 124-test,
  browser E2E, systemd, attested multi-architecture source-build, and non-root smoke matrix.
- 2026-07-13 (systemd lifecycle claim correction): audit found shipped `ExecReload=SIGHUP` although the CLI only
  handles SIGTERM/SIGINT; SIGHUP would terminate/restart rather than reload configuration. Removed the unsupported
  directive and documented `systemctl restart` after changes. Added a regression test binding unit claims to the
  implemented Type=simple/watch/credential/stop/security behavior. Fresh headless 10/10 (including 1 GiB),
  typecheck, `systemd-analyze verify`, and diff-check pass. Public commit `4d45e88` then passed CI run
  29233056866: 123 tests, type/build/OpenAPI/audit, browser E2E, unit verification, both attested amd64/arm64
  source builds and non-root smoke.
- 2026-07-13 (Clean npm artifact install): packed current `@webobsidian/sync-core` 0.1.1 and
  `web-vault-sync` 0.1.0, then installed only those two tarballs into a fresh directory with no workspace links.
  The installed ESM core imports and reports Protocol 1.0; the package-local `web-vault-sync` bin runs `help`,
  exposes the full command set, and the clean dependency tree audits at zero vulnerabilities. This proves package
  contents/resolution/bin wiring; M36.2/M40.5 remain partial solely for registry authentication/publication and
  subsequent registry-origin clean install (`npm whoami` still 401).
- 2026-07-13 (Plugin settings review hardening + 0.1.3): removed the final four Obsidian lint warnings without
  raising the 1.11.4 minimum. `CentralSyncSettingTab` now has one canonical settings-definition source: Obsidian
  1.13+ receives searchable declarative settings, while 1.11–1.12 renders those same definitions through a narrow
  compatibility interpreter (no duplicated settings model). Added control normalization/search-definition test;
  plugin now passes zero-warning lint, typecheck, 9/9 tests, build and 33-file policy scan. A real Obsidian Linux
  1.12.7 load rendered both legacy groups. Commit/tag `6627954`/0.1.3 and release CI 29232796996 passed with no
  annotations; provenance assets are public at https://github.com/picassio/central-vault-sync/releases/tag/0.1.3.
  Beta issue 1 and root release/compatibility links now target 0.1.3. Community acceptance remains external.
- 2026-07-13 (External beta feedback channel): opened public plugin issue
  https://github.com/picassio/central-vault-sync/issues/1 with copied/backed-up-vault warning, Windows/macOS/Linux/
  Android/iOS matrix, pair/catch-up/resume/offline/restart/rename/delete/attachment/conflict checklist, redacted
  diagnostic template, and explicit secret/content prohibition. Plugin README corrected stale 0.1.0 preview text
  to 0.1.2 and links the checklist; full plugin check passed and docs commit `ddd2aa8` is public. M40.2/M40.3
  remain open until independent tester feedback and unavailable platform evidence actually arrive.
- 2026-07-13 (Exact plugin 0.1.2 release-asset acceptance): downloaded all three public GitHub assets and verified
  SHA-256 against release API (`main.js` `4d005b29...`, manifest `bd109090...`, styles `4759b965...`). Installed
  those exact bytes—not a local build—into a fresh isolated stable Obsidian Linux 1.12.7 vault. The app identified
  and enabled version 0.1.2, paired once to a fresh production server, pushed a Vault-created note as device
  sequence 1, then applied a web-authored revision back through Vault at cursor 2 with zero queue/apply intents and
  no token in plugin data. Screenshot: `docs/sync/evidence/obsidian-linux-1.12.7-plugin-0.1.2-release.png`.
  This closes release-byte/installability uncertainty on Linux; other real OS/mobile and Community gates remain.
- 2026-07-13 (Container distribution scope changed by user): user explicitly requested no GitHub/registry
  container publication; consumers clone and build locally. PRD bumped to 1.7 and roadmap/plan/docs/examples/release
  workflow changed in the same update: CI still proves non-root amd64/arm64 builds plus SBOM/provenance, while
  stable release publishes source/npm/GitHub artifacts only. A beta push had completed immediately before the
  instruction arrived (`web-vault-sync` digest `sha256:4573d9...`, `webobsidian` `sha256:bfe0c6...`); both GHCR
  packages are private. REST deletion and OCI manifest deletion were attempted but rejected because the current
  token lacks `delete:packages` (403/405). The owner explicitly chose to leave both private packages in place for
  now; they are inaccessible anonymously, undocumented, and not offered to users. Commit `24eca8a` removed future
  registry jobs/references. CI run 29229982547 passed all tests/E2E plus attested SBOM/provenance amd64+arm64 local
  builds for both server and headless Dockerfiles and the non-root smoke, proving clone/build distribution.
- 2026-07-13 (Main publication + CI): user explicitly authorized committing/pushing the complete working tree.
  Commit `e3c7435` is public on `picassio/webobsidian`; CI run 29228551700 passed both jobs: fresh npm install,
  typecheck, all 122 tests, OpenAPI, zero-vulnerability audit, build, real two-browser production E2E, systemd
  validation, server image build, QEMU amd64/arm64 headless build and non-root smoke. The only annotations were
  GitHub's Node 20 deprecation in action runtimes; CI/release workflows were immediately advanced to current
  checkout v7, setup-node v6 and Docker setup v4 majors. Follow-up commit `2136d45` and clean CI run 29228724738
  passed both complete jobs without annotations. Stable tag remains correctly withheld
  until npm authentication/scope setup, Community submission/review, and unavailable real-platform gates resolve.
- 2026-07-13 (M31.7 adapter/cross-version conformance complete): added browser-cookie and headless-bearer
  transport tests that consume the same Protocol 1.0 golden handshake/manifest/change/operation transcript and
  verify transport-specific credentials. Their initial future-version tests correctly exposed a real gap: shared
  response schemas accepted any numeric version even though server requests fail closed. ProtocolVersionSchema
  now requires exact `1.0`; 27 JSON Schemas regenerated and sync-core bumped coherently to 0.1.1 across server,
  web and headless. Browser 11/11, headless 9/9 (including 1 GiB), core 14/14 and all-workspace typecheck pass.
  Plugin updated its packed immutable 0.1.1 core artifact, added future-response rejection, fixed explicit bearer
  credential typing, and passes policy/build/8 tests. Plugin commit/tag `64dce06`/0.1.2, release CI 29226806432,
  provenance and public assets: https://github.com/picassio/central-vault-sync/releases/tag/0.1.2. Server route
  tests preserve canonical HTTP 426 negotiation by detecting a well-formed unsupported request version before
  exact schema parsing; plugin CI and root CI now cover every named adapter. The final packed core tarball is
  byte-identical (SHA-512) to the plugin vendor artifact. Fresh aggregate validation: core 14/14, server 88/88,
  browser 11/11, headless 9/9 including 1 GiB, typecheck/build, OpenAPI, audit zero and diff-check all pass. The
  final version-coherent server Docker image also rebuilt and reached healthy with writable initialized Sync.
  M31.7 complete.
- 2026-07-13 (Server container release-path repair): a clean root `docker build` exposed that the staged
  manifests omitted `clients/headless` and `packages/sync-core`, so npm installed an incomplete workspace and
  the image could not compile. Dockerfile now copies every workspace manifest before reproducible `npm ci`, and
  copies built sync-core runtime artifacts into the final image. The next smoke exposed `localhost` resolving to
  IPv6 while the server listens IPv4; healthcheck now targets `127.0.0.1`. A second clean build completed all four
  workspace builds with zero install vulnerabilities, and the mounted production container booted writable with
  Sync initialized and reached Docker `healthy` with a successful `/healthz` payload. At that point M40.4 still
  named GHCR publication; this historical gate was superseded by the explicit PRD 1.7 local-build decision.
- 2026-07-13 (Real Obsidian desktop + plugin 0.1.1): discovered that prerelease 0.1.0 required future
  Obsidian 1.13 APIs while latest stable is 1.12.7. Reworked settings/reset UI off 1.13-only APIs and set the
  SecretStorage-correct minimum 1.11.4; policy/type/lint/build and 8/8 mock/conformance tests pass. Installed the
  built plugin into a real isolated Obsidian Linux 1.12.7 vault, accepted trust, verified plugin/status/settings,
  paired to a fresh production server, pushed a Vault-created Markdown note (device actor sequence 1), applied a
  remote revision back through Vault, then killed server, created offline work, verified durable path state/no
  token in data.json, hard-killed Obsidian, restarted server/app, and converged queue/cursor to sequence 3. Evidence
  screenshot: `docs/sync/evidence/obsidian-linux-1.12.7-plugin.png`. Commit `e99a1dc` and tag 0.1.1 were pushed;
  release CI run 29226026213 succeeded with provenance and 0.1.1 assets are public prerelease at
  https://github.com/picassio/central-vault-sync/releases/tag/0.1.1. Xvfb host exposed Obsidian's no-keychain
  SecretStorage warning; README/SECURITY/root compatibility now explicitly disclose that platform encryption
  requires a working OS keychain (docs commit `6c90561`) rather than making a hidden guarantee. M36.9 complete;
  M36.7/M36.8 remain partial
  only for real Android/iOS/Windows/macOS matrices, M36.10 remains account/reviewer gated.
- 2026-07-13 (Headless arm64 execution evidence): built the final non-root image specifically for linux/arm64,
  registered binfmt/QEMU, and executed `help` plus persistent-volume `init --json` successfully under emulation;
  image inspection reports `arm64/linux` and user `node`. Multi-arch build is therefore not compile-only, though
  M37.8 remains `[~]` until real macOS and plugin/client-pair host matrices run.
- 2026-07-13 (M37.6 actual systemd host drill): beyond `systemd-analyze verify`, installed the built CLI into
  a disposable root-owned runtime, created the dedicated `web-vault-sync` system user/state/vault, paired it to
  a fresh production server, loaded its token through systemd `LoadCredential`, and started the shipped hardened
  Type=simple unit with vault `ReadWritePaths` drop-in. Unit reached `active` with a real MainPID and stopped
  cleanly on systemd SIGTERM (`Deactivated successfully`); service/runtime/user artifacts were removed afterward.
  M37.6 is complete.
- 2026-07-13 (M40.1 technical preview + release prep): removed every unrevisioned existing-entry compatibility
  fallback. Web rename/copy/delete/upload preflight exact revisions; plugin shim modify is conditional; Agent API
  always requires monotonic sequence/idempotency and base on existing note (428 missing, 409 stale). PRD v1.6,
  roadmap, Agent docs/skill synchronized. Fresh root tests 14 sync-core + 88 server + 9 web + 7 headless,
  full typecheck/build, OpenAPI/audit/diff, and two-browser E2E pass with no known silent overwrite or open
  critical/high. Added publishable sync-core README/LICENSE/metadata, compatibility/upgrade/rollback/mobile/privacy
  guide, and tag-gated release workflow with full gates, npm provenance, CycloneDX SBOM, checksums, GitHub
  attestations/releases, and (historically) multi-arch GHCR SBOM/provenance; registry publication was later removed
  by PRD 1.7 while CI build attestations remain. Thus M40.1 local technical-preview gate is complete;
  alpha/beta/stable external gates remain open.
- 2026-07-13 (Plugin/headless artifact evidence): published plugin 0.1.0 as an explicit GitHub prerelease (not
  draft) with downloadable `main.js`, `manifest.json`, `styles.css`; remote release and CI both verified, downloaded
  SHA-256 values match. Community submission now requires the user's linked Obsidian account at
  community.obsidian.md and reviewer acceptance. Headless non-root image rebuilt, user/CLI/init/healthcheck smoke
  passed; amd64+arm64 SBOM/provenance build completed while the then-required GHCR push was denied. That registry
  requirement was later superseded by PRD 1.7. npm `whoami` is 401, so sync-core/headless npm publication is
  credential-blocked. M37.7
  implementation gate is complete; M40.5 publication remains open.
- 2026-07-13 (M35.9 hoàn tất): added repeatable Playwright/real-Chromium `npm run test:e2e:browser` with two
  isolated browser contexts and production server. It verifies different-note concurrent acceptance, same-note
  stale-base durable conflict, an open overlapping local draft survives remote revision, resumable binary blob
  + attachment projection, durable offline queue across page destruction/reopen and reconnect, injected durable
  apply-intent recovery before cursor catch-up, stable-identity rename/delete convergence, and httpOnly identity
  (no token in IndexedDB or `document.cookie`). Shared 1GiB stream/hash and real 128-chunk HTTP transfer remain
  bounded below 128MiB. CI now runs unit/fault/scale/recovery tests, OpenAPI, audit, build, installs Chromium, and
  runs this E2E; local browser-pair run passes.
- 2026-07-13 (Phase 38 + Phase 39 local gates hoàn tất): settings schema v3 fails closed on corruption,
  existing-vault first start sets `backup-required` + Central disabled; empty installs are ready. Pairing remains
  blocked until confirmed full Git backup migration. Bootstrap now resumes from checksummed 5k-entry checkpoints,
  preserves IDs/reuses unchanged hashes, and never changes vault bytes. Real production drill used an existing
  vault + empty bare remote: preview clean, full snapshot commit/push succeeded, state atomically became
  `ready + backup-only`, remote commit verified, post-migration pull returned 409, graceful SIGTERM checkpointed.
  M38.4 old/new settings tests plus explicit local-only/remote/conflict guards and no force/pull complete.
- 2026-07-13 (Phase 39 scale/fault/security/ops): identified and removed the 50k-entry full projection rewrite
  from every write; journal remains authority while O(1) id/path projection is maintenance/shutdown checkpointed
  and replayed after crash. Reference results in `docs/sync/SCALABILITY.md`: 50k manifest 7.7ms, 50k projection
  update 1.4ms, 500 catch-ups 11.7ms, 1GiB hash +25.5MiB RSS and real 1GiB/128-chunk HTTP upload +86.9MiB.
  Daily acknowledgement+age-gated compaction now runs, checkpoints even when blocked, protects unresolved
  conflict base/current/client blobs, expires uploads, reports backup/journal/maintenance status. ENOSPC at all
  precommit boundaries rolls back and retries; post-commit ENOSPC converges before success; six hard-crash points,
  future clock skew, watcher miss, malformed metadata, permission/symlink escape and network/apply failure pass.
  Security review fixed raw browser token storage, exact cookie CSRF, pre-auth CPU rate limit/map bound, symlink
  ancestors, corrupt-settings replacement, Git credential disclosure, post-commit ambiguity, and immediate WS
  revoke/rotation; audit and secret scan clean. Authenticated health/Prometheus metrics expose sequence/device/index
  lag, op outcomes/dedup/conflicts/latency, bytes/dedupe/drift, journal/maintenance/Git status and alerts. Exact
  vault+data restore and vault-only rebuild drills pass; cursor/revoke/conflict recovery tests and full
  `docs/sync/OPERATIONS.md` runbook complete. Fresh server suite 87/87, web 9/9, headless 7/7, plugin 8/8,
  typechecks/build/OpenAPI/audit/diff checks pass.
- 2026-07-13 (Browser credential hardening + production smoke): browser no longer stores/reads a raw device
  token in JS/IndexedDB. Session+CSRF protected `/browser-devices` creates an httpOnly, SameSite=Strict,
  Secure-outside-loopback device cookie without returning its secret; cookie-auth mutations enforce exact
  same-origin/Fetch Metadata while bearer clients remain supported. Existing IndexedDB tokens use one-time
  authenticated rotation (old hash invalid immediately), then durable deletion; interrupted upgrade retains the
  only still-valid credential for retry. OpenAPI security alternatives corrected (device bearer/browser cookie,
  not admin session). Device rotation and cookie same/cross-origin tests pass. Fresh production Chromium smoke
  paired a browser, confirmed IndexedDB has identity/cursor but no token and `document.cookie` is empty, cookie
  handshake returned 200, UI save emitted sequence 1/revision 2 with `actor.type=device`; build/typecheck,
  server 75/75, web 9/9 and OpenAPI lint pass.
- 2026-07-13 (Git transition M38.1–M38.3/M38.5 hoàn tất; M38.4 đang verify): Settings/Ribbon/status/
  README đổi rõ “Git Backup & Version History”, Central Sync và Git lag/action tách riêng. Settings v2 migration
  giữ install v1 ở `sync.enabled=false + legacy-bidirectional`; install mới Central authority + backup-only. Pairing
  bị hard-block trước migration; settings không thể bật legacy khi Central active. Assistant preview/confirm yêu cầu
  conflict-free repo + remote backup (hoặc explicit local-only), commit/push full pre-migration snapshot rồi mới
  atomically switch Central+backup-only; không pull/force. Central mode clone/pull reject409, scheduled/manual/save
  chỉ init/commit/push với independent exponential retry và unfinished legacy merge fail-closed. Legacy pull chỉ khi
  cả sync disabled + legacy mode và route lập tức coordinator-reconcile; tests static authority cập nhật đúng gate.
  Remote import vẫn clone temp→preview→admin confirm→coordinator normal events; Version History restore nay đọc
  current revision rồi conditional coordinator write, không unrevisioned overwrite. LFS backup patterns giữ nguyên.
  Settings migration child-process tests pass cho old/new defaults; server fresh 75/75, web 9/9, full typecheck.
  M38.4 giữ `[~]` đến integration drill repo clean/conflict/push-failure/mutual exclusion hoàn chỉnh.
- 2026-07-13 (Central Sync headless M37.1–M37.5 hoàn tất; M37.6–M37.8 đang làm): thêm publishable
  workspace `clients/headless`/bin `web-vault-sync` Node≥20 dùng shared OrderedSyncClient. CLI đủ init/pair/
  sync/watch/pull/push/status JSON/conflicts list-show-resolve server-client-copy-merged/doctor/reset/completion,
  stable exit 0/2–7 và redacted structured logs. Checksummed canonical state atomic temp+file/dir fsync mode0600,
  token tách mode0600/env/systemd LoadCredential, config ngoài vault, monotonic sequence/cursor/apply-intent/blob-ref
  queue. Filesystem adapter streams download hash+size→fsync→rename, 8MiB resumable upload, stable hash before/after,
  traversal/internal/symlink/case/NFC guards, expected path/hash/revision echo, case rename, pull-only quarantine,
  push-only metadata và bidirectional local-first conflict safety. Chokidar native + polling fallback, 750ms rename
  correlation, single PID lock/stale recovery; SIGTERM polling-daemon smoke pushed file rồi exit0/remove lock.
  systemd hardened Type=simple unit `systemd-analyze verify` pass. Non-root `node` image build/help/init smoke pass;
  no-QEMU architecture-independent build stage produced OCI manifest amd64+arm64 successfully tại
  `/tmp/web-vault-sync-multi.oci`. Headless 7/7 tests gồm 1GiB sparse streaming hash RSS<128MiB (11.4s),
  atomic/token/symlink/hash-before-write/quarantine/lock. Real production-server drill pair→initial pull→local push,
  overlapping two-writer conflict created durable server copy + CLI exit4/list→resolve→cursor4 synced; watcher polling
  pushed `DaemonNew.md`. M37.6 còn real PID1 systemd install; M37.7 còn registry publish; M37.8 còn full native
  watcher/crash/all-client pairs. `npm pack --dry-run` 36 files/31.5kB pass nhưng npm auth hiện 401.
- 2026-07-13 (Central Sync native plugin M36.1/M36.3–M36.6 hoàn tất; M36.2/M36.7–M36.9 đang làm):
  tạo và publish repo public riêng https://github.com/picassio/central-vault-sync từ official sample, manifest
  `central-vault-sync`, `isDesktopOnly=false`, README/LICENSE/SECURITY/privacy/network/mobile caveats và
  root release artifacts policy. Plugin dùng shared `OrderedSyncClient` mới promote vào sync-core: offline push
  trước pull để stale edits đi conflict matrix, immutable manifest/cursor-expiry bootstrap, apply-intent trước
  Vault materialize, cursor/ack sau durable save, one-use WS wake + poll/backoff. Native `requestUrl`, Vault
  text/binary/folder/rename/trash APIs, SecretStorage-only token, pending path markers + blob-ref operation queue
  không lưu note body, 750ms per-path debounce, resumable 8MiB upload parts, expected path/hash/revision echo,
  focus/visibility/active-leaf resume và mobile ≥100MiB confirmation. Declarative Obsidian 1.13 settings có
  pair/test/unpair/pause/excludes/status/diagnostics; status bar + 6 commands; native conflict modal base/server/
  local/merged + all four resolves. Mock Vault verifies hash-before-write/rename/delete/tombstone/echo; store tests
  verify SecretStorage/no-content/restart/sequence/idempotency; published golden fixture conformance: plugin 8/8,
  lint/typecheck/build/policy/secret/mobile bundle scan pass. Public commit `572ee62`, CI run
  https://github.com/picassio/central-vault-sync/actions/runs/29220795188 queued lúc ghi log. M36.2 còn npm publish;
  M36.7/M36.8 còn real Android/iOS + desktop OS interruption matrix; M36.9 còn alpha/beta release evidence.
- 2026-07-13 (Central Sync Phase 35 M35.1–M35.8 hoàn tất, M35.9 đang làm): browser store nay
  per-document/path kể cả split tab, giữ base/content/entryId/revision/hash + dirty/save generation/pending/error;
  per-path serialized save và late-response/navigation/409 tests không bao giờ clear/đè draft mới. IndexedDB strict
  transactions giữ hashed device token state, monotonic client sequence, cursor, immutable local projection,
  apply-intent, operations, streamed attachment Blob, drafts và per-device workspace; one-time shared-workspace
  migration rồi bỏ hoàn toàn remote tab switching. `BrowserSyncEngine` initial immutable manifest, retained-cursor
  bootstrap, ordered REST catch-up/apply-intent-before-materialize/cursor-after-durable-apply/ack, one-use WS wake,
  poll/backoff/restart replay; local echo hash convergence, independent dirty diff3 merge, overlap/delete conflict.
  Text save và streamed large text/blob attachments dùng device operations/CAS queue; 1GB path không arrayBuffer.
  Settings có pair-this-browser, health + non-repairing sync doctor, redacted export, scope/exclusion explanation,
  device last-seen/cursor/revoke và conflict center base/server/client/merged + binary hashes/download + all 4 choices.
  Status bar tách Central Sync state/lag/conflict count khỏi Git Backup. Fresh web 9/9 tests, typecheck/build pass;
  manual Chromium production inspection paired browser, status `Synced`, edited Welcome.md và durable journal event
  actor=device sequence 1/revision 2; screenshots `/home/ubuntu/.agent-browser/tmp/screenshots/screenshot-1783909466851.png`.
  M35.9 giữ `[~]` đến khi automated two-real-browser offline/rename/delete/crash + 1GB stream matrix hoàn tất.
- 2026-07-13 (Central Sync Phase 34 hoàn tất): `DeviceStore` one-use random pairing TTL/hash, scrypt token
  hash-at-rest, dedicated bearer scope, revoke/lastSeen/monotonic ack/audit. Full `/api/sync/v1`: pair/handshake/
  one-use WS ticket, immutable paged manifest, retained ordered changes/410, ack, exact revision + ETag/Range,
  blob HEAD/Range, resumable owned chunk uploads/quota/hash/24h/dedupe, ordered dependency-aware operations,
  conflict list/show/all four resolutions with normal revision events + resolution idempotency, device/health admin.
  WS ticket upgrade only, sequence wakeups, 30s ping/pong, 1MiB backpressure terminate; REST remains authority.
  HTTPS non-loopback, device/pair/upload rate limit, CSRF origin/SameSite admin, body/path/internal/symlink guards,
  canonical errors and no raw secrets. Generated 27 schemas + OpenAPI lint pass. Full fresh suite: sync-core 12/12,
  server 73/73; includes 50k manifest, 1k-event journal + 500 reconnect clients under 128MiB delta, auth/revoke/
  expiry, batch continuation, range/upload, security and all prior fault/property/E2E tests. Audit 0 vulnerabilities.
- 2026-07-13 (Central Sync Phase 33 hoàn tất — M33.1/M33.6): coordinator có đủ canonical create/
  modify/rename/delete/mkdir/rmdir/copy/trash/restore/import. Explicit directory/Git import có dry-run plan,
  confirm, optional delete-missing, temp shallow clone/LFS fetch ngoài vault, sau đó mọi diff thành normal ordered
  coordinator events; kind conflict dừng trước mutation. Git clone vào empty vault synchronously drift-import;
  auto backup tuyệt đối không pull. Authority CI test scan toàn routes cấm legacy `vault.write*/rename/copy/remove/
  trash/restore` và assert Git sync không gọi pull + import/clone mediated. Local import integration verifies modify/
  create/mkdir/delete. Tất cả M33.1–M33.9 giờ `[x]` với tests; Phase 34 device auth/API tiếp theo.
- 2026-07-13 (Central Sync M33.7/M33.9 hoàn tất): checksummed durable `DerivedEventQueue` enqueue sau
  commit, chỉ advance appliedSequence khi aggregate QMD/link/file/share/stat/Git/WS subscriber thành công; failure
  giữ event + error/attempt và exponential retry, `/healthz` exposes latest/indexLag/queue nên không báo Synced giả.
  Unit test failure→retry + health lag. Two-writer E2E tạo stale conflict copy, direct filesystem modify và concurrent
  independent creates; journal sequence 1..6 gapless, canonical không overwrite. 6 crash-boundary matrix trước đó
  xác nhận không accepted-write loss/phantom. Git auto-sync đổi backup-only commit→push; pull bị 409, clone explicit
  được drift-import qua coordinator; generated `.gitattributes` synchronously reconcile thành event.
- 2026-07-13 (Central Sync M33.8 hoàn tất): Chokidar stable-write mọi add/change/unlink/dir đi qua
  coordinator `server-fs`; committed writes đăng ký `(path,exists,hash)` suppression 10s nên echo không duplicate.
  External modify giữ previous blob/base, delete tạo recoverable trash, empty-dir revisioned. Rename correlation dùng
  cached inode khi platform có + unique hash heuristic trong 750ms; ambiguous fallback ordered delete/create.
  60s bounded single-flight drift scan hash toàn vault, correlate stable-identity rename, reconcile missing/new/
  changed; startup scan bắt offline modifications trước nhận writes. 4 integration tests pass: full external chain,
  suppression, hash rename + restart/offline drift, directory lifecycle.
- 2026-07-13 (Central Sync M33.4/M33.5 hoàn tất): recursive coordinator copy mở rộng thành ordered mkdir/
  create events với identity mới. Durable `TrashStore`; delete/rmdir move vào internal trash + tombstone, restore
  reuse tombstoned entryId/revision khi original path trống hoặc unique restored path + identity mới khi collision;
  purge/empty trash không sync internal bytes. Toàn bộ web write/create/upload/rename/copy/delete/trash/restore
  routes qua coordinator và committed subscribers (không route-local reindex). Agent PUT/append/delete cũng qua
  coordinator, read trả revision/ETag, hỗ trợ clientSequence/idempotency/baseRevision; thời điểm này omission còn
  warning/optional strict env, nhưng compatibility path đã được xoá ở stable-write hardening 2026-07-13: nay luôn
  428/409 và không có env bypass. Coordinator tests 14/14 riêng, full server
  49/49 trước các test mới; typecheck pass.
- 2026-07-13 (Central Sync M33.2 hoàn tất): durable checksummed `ConflictStore` + conflict metadata trong
  WAL intent bảo đảm crash replay. Matrix verified: same create/hash convergence không event; clean text diff3;
  overlap/base-expired/non-UTF8/binary tạo unique server conflict copy giữ canonical; modify sau rename và rename
  sau only-modify rebase theo entryId; divergent rename/delete-vs-modify tạo unresolved conflict record; modify
  tombstone thành copy; delete tombstone converge; case-only rename qua deterministic recoverable temp; non-empty
  rmdir reject. Full results idempotent, conflict center giữ submitted/current/base refs. Server 49/49 tests pass.
- 2026-07-13 (Central Sync M33.2 clean-merge foundation): coordinator nay lưu mọi committed new bytes vào
  CAS và giữ exact previous revision trong `MergeBaseStore` trước khi xóa WAL. Stale text modify (allowlist,
  UTF-8, ≤10 MiB) tải exact base/current/submitted, deterministic diff3; independent hunks commit revision mới
  với status `merged` và exact idempotency retry, overlap/base-missing/binary không đụng canonical bytes. Tests mới
  xác nhận clean merge `rev1→server rev2→merged rev3`, retained rev1 và overlap giữ server + không tạo event.
  M33.2 vẫn `[~]` vì overlap/binary/delete conflicts phải tạo durable conflict-copy/center thay vì chỉ 409.
- 2026-07-13 (Central Sync M33.4/M33.7 + browser safety phần 1): server boot khởi tạo singleton
  `SyncCoordinator` trước khi nhận request; `/healthz` trả 503 khi sync degraded. Web routes content read trả
  entryId/revision/hash + ETag; text write, create folder, upload và rename đi qua coordinator, blob CAS và
  conditional baseRevision/If-Match (legacy omission có HTTP Warning rõ ràng). Committed-event subscriber thống
  nhất QMD/link/file/share/stat/Git scheduler và phát `syncChanged` sequence wake-up. Browser API giữ revision;
  active editor capture editGeneration+baseRevision khi save và chỉ clear dirty nếu generation/path không đổi,
  đóng autosave dirty-generation race cơ bản. Copy/delete/trash/restore, watcher suppression và per-tab durable
  sync state/conflict UI còn lại nên các milestone giữ `[~]`. Fresh root typecheck + 12 sync-core + 42 server
  tests pass.
- 2026-07-12 (Central Sync Phase 32 hoàn tất; M33.3 hoàn tất): content-addressed immutable `BlobStore`
  streaming + SHA/size/limit verify, atomic dedupe, mode 0600, exact Range và GC; `MergeBaseStore` age/count/
  protected-ref retention. Durable bounded per-device idempotency reject key/sequence reuse và exact retry; WAL
  recovery rebuilds idempotency. Ack/age-gated compaction backs up metadata + sealed segments trước khi xóa,
  prunes safe tombstone/base/blob refs và exposes cursor-expired. `sync:doctor` validates checksum/continuity,
  sequence projections, filesystem hashes, bases/blobs/intents/uploads; chỉ auto-repair expired upload/old orphan,
  corruption recommends read-only. Fault injector covers 6 crash boundaries từ intent đến idempotency snapshot;
  deterministic restart finish/rollback và exact retry verified. Property test replays 137 events qua 5 segment
  limits. Server tổng 42/42 tests pass. M33.1/M33.2 còn `[~]` đúng phần canonical adapters/conflict matrix.
- 2026-07-12 (Central Sync M32.4 hoàn tất; M33.1–M33.3 foundation): WAL transaction directories stage
  previous/new bytes bằng streaming, fsync content + full event/idempotency result intent, materialized marker và
  durable cleanup. Startup validates/replays journal, deterministically finishes matching materialized pre-commit
  intent, rolls back unmaterialized intent, rebuilds revision/vault snapshots; corruption vào read-only degraded.
  `SyncCoordinator` hiện có subtree/case-fold locks + journal mutex, conditional create/modify/rename/delete/
  mkdir/rmdir, hash/size validation, atomic content install, server trash, commit-point publish và no-overwrite
  direct-drift guard. 10 tests mới: WAL lifecycle/cleanup, full mutation chain, stale/collision/hash/direct drift,
  directory rule, 2 crash recovery boundaries, corruption degraded (server tổng 21/21 trước lock tests).
  M33.1 còn copy/trash/restore/import adapters; M33.2 còn merge/conflict matrix; M33.3 còn durable idempotency.
  Bắt đầu M32.5 content-addressed blob/base retention.
- 2026-07-12 (Central Sync M32.4 journal phần 1): `JournalStore` append qua async serial queue, bắt buộc
  contiguous global sequence, active segment checksummed atomic rewrite, bounded rotation + seal immutable segment,
  replay sau cursor/latest/seal, detect checksum/gap/missing segment. 4 journal tests pass gồm concurrent append,
  rotation, rejected gap không poison queue và tamper. M32.4 giữ `[~]`: write-ahead intent + startup finish/rollback
  sẽ hoàn tất cùng coordinator transaction ở M33.3.
- 2026-07-12 (Central Sync M32.3 hoàn tất, M32.4 bắt đầu): `RevisionStore` checksummed snapshot có
  stable random entryId, path/kind/revision/hash/size/mtime/sequence/tombstone; startup vault scan stream-hash
  từng file với before/after stat retry, skip symlink + server exclusions, giữ empty directory, reject Unicode/case
  collisions, persist identity idempotent. Apply committed event dùng shared deterministic replay, lookup id/path,
  rename/delete giữ identity. 4 tests mới (server tổng 7/7) pass. Tiếp theo segmented journal + WAL intents.
- 2026-07-12 (Central Sync M32.2 hoàn tất, M32.3 bắt đầu): server có `sync/storage.ts` tạo đầy đủ
  `data/sync/` mode 0700 và generic `AtomicJsonStore` envelope checksum, temp-file mode 0600 + file fsync +
  rename + parent-dir fsync, previous `.bak`, corruption typed error. `VaultStateStore` tạo stable random vaultId,
  schemaVersion/currentSequence, load/create idempotent và cấm sequence lùi. 3 server tests pass: layout/mode +
  identity bền, checksum tamper/backup, sequence persistence. M32.3 revision index tiếp theo.
- 2026-07-12 (Central Sync M32.1 hoàn tất): sync-core nay có branded IDs/sequence/revision, server path
  exclusions + NFC/case collision, cross-platform incremental SHA-256, timing-safe hex compare, deterministic
  line diff3 + conflict-copy naming, pure event replay và durable client queue/apply-intent state machine.
  Thêm 5 core tests (tổng 12/12 pass). Nâng Vite 5→8 + plugin-react 4→6 và chạy `npm audit fix` để xoá toàn bộ
  2 critical/2 high/3 moderate dependency advisories; `npm audit` = 0. M31.7 vẫn đang làm tới khi adapters tồn tại.
- 2026-07-12 (Central Sync M31.4 hoàn tất, M31.7/M32.1 đang làm): thêm workspace
  `packages/sync-core` với Zod runtime schemas + TypeScript types cho protocol 1.0, stable entry/event/operation,
  auth/pairing, manifest/change/ack, resumable blob, conflict/device/error envelopes; pure deterministic event
  replay (sequence gap, tombstone, subtree rename, folded path collision). Generator tạo 27 JSON Schema definitions
  ở `docs/sync/protocol-v1.schema.json`; OpenAPI 3.1 đầy đủ endpoint/auth ở `docs/sync/openapi-v1.yaml` + Redocly
  config; golden transcript/conformance tests 7/7 pass (schema, unsafe/NFD paths, UTF-8 byte cap, contiguous events,
  identity rename/tombstone/subtree replay). Root workspace build/typecheck/test đã wire sync-core. M31.7 chưa xong
  vì server/web/plugin/headless conformance adapters chưa tồn tại; M32.1 tiếp tục hashing/conflict/offline engine.
- 2026-07-12 (Roadmap Central Sync FR-13): audit xác nhận sync hiện tại chưa phải true sync (Git polling,
  WS chỉ refresh tree, no revision/ETag, stale browser có thể overwrite và autosave có generation race).
  Bump `PRD.md` 1.5, thêm FR-13/NFR/API/data model/DoD và đổi vai trò Git thành backup/version history.
  Tạo `docs/SYNC_ROADMAP.md`: authoritative SyncCoordinator, revision/hash + ordered journal/tombstone/
  idempotency/conflict-copy, browser migration, native Obsidian community plugin, Linux headless CLI/daemon,
  systemd/Docker, Git transition, security/test/operations/release gates. Thêm Phase 31–40; implementation
  chưa bắt đầu, mọi checkbox runtime giữ `[ ]` tới khi code được verify. Sau audit hoàn thiện, roadmap đổi
  sang implementation-ready baseline: chốt M31.3/M31.5/M31.6 (decision, conflict matrix, threat model), thêm
  stable entryId rename semantics, auth matrix + WS ticket, manifest snapshot/ack, resumable chunks, WAL intent
  commit/recovery, bounded legacy migration, exact v1 scope,
  phase 31–40 dependency/estimate duy nhất và traceability FR-13/DoD→milestone evidence.
- 2026-06-22 (Fix Graph view dưới CSP không cho `unsafe-eval`): trên host production (vd `360of.me`) Graph
  view trắng + lỗi `Current environment does not allow unsafe-eval, please use pixi.js/unsafe-eval module`.
  PixiJS v8 sinh code shader/UBO bằng `new Function()`, bị CSP chặn. Sửa: trong `GraphView.tsx` import
  `pixi.js/unsafe-eval` (module tự cài polyfill không-eval) trước `app.init()`; thêm `declare module` cho
  subpath trong `vite-env.d.ts` (Pixi không export `types` cho subpath này). Typecheck + build pass.
- 2026-06-19 (FR-2 — Audio/Video embed phát được như Obsidian, theo yêu cầu người dùng): note `.mp4`
  (Trilium export: frontmatter + `![[clip.mp4]]`) trước đây chỉ hiện link xanh, nay render **trình phát
  HTML5 thật**. Sửa 3 đường render — Live Preview (`MediaWidget` trong `livePreview.ts`, là view đang
  dùng cho cả Reading read-only), Reading/transclusion/canvas (`markdown.ts`), public share SSR
  (`renderhtml.ts`); cả 3 thêm `<video>/<audio>/<source>` vào allowlist `rehype-sanitize` (nếu không
  sanitizer xoá tag). Mở thẳng file media từ tree → player (`Workspace.tsx`, như ảnh). Bộ extension khớp
  Obsidian (video `mp4/webm/ogv/mov/mkv`, audio `mp3/wav/m4a/3gp/flac/ogg/oga/opus`) gom về
  `web/lib/media.ts` + `server/services/mime.ts`; size param `![[clip.mp4|W]]` đặt width video.
  **Mấu chốt:** route serve binary (`GET /api/files/content` + raw share) đổi từ `readFileBuffer`→`res.send`
  (đọc cả file vào RAM, không seek) sang **stream + HTTP Range** (`services/httpfile.ts` →
  `sendFileWithRange`): trả 206 Partial Content nên scrub/seek video & Safari phát được. Verify thật:
  login `access` → `GET …/8257903_hd (2).mp4` (resolve basename từ `Attachments/`, 17MB) trả 206
  (`Content-Range: bytes 0-1023/17758055`, `video/mp4`, `Accept-Ranges: bytes`), full GET 200, range
  vô lệ 416; sanitizer giữ nguyên `<video>/<audio>` (test `renderNoteHtml`). Visual screenshot trong app
  bị chặn (profile Chrome debug đang bị instance khác khoá — không tự ý kill) → xác minh qua bundle có
  `cm-embed-video`/`media-embed` + hợp đồng server/sanitizer.
- 2026-06-19 (Fix 2 bug Files panel — verify bằng Chrome DevTools end-to-end trên vault test):
  **(1) Nút Sort không hoạt động:** menu sort mở bằng **click trái** bị đóng ngay lập tức bởi chính cú click đó.
  `ContextMenu` gắn listener `window 'click'` để đóng khi click ra ngoài; với click trái, sau khi React commit effect,
  cú click vẫn đang bong-bóng tới `window` → listener bắt được → đóng menu. (Menu chuột phải không dính vì sự kiện
  `contextmenu` không phát ra `click`.) Fix: gắn listener đóng ở **tick kế tiếp** (`setTimeout(…, 0)`) trong
  `web/src/components/ContextMenu.tsx`. Verify: click nút Sort → menu hiện đủ 6 mục (đúng như Obsidian app: File name
  A→Z/Z→A, Modified new→old/old→new, Created new→old/old→new) → chọn "File name (Z to A)" → file đảo thứ tự (folder vẫn nhóm trước).
  **(2) Kéo-thả di chuyển file không ăn:** chỉ **hàng folder** mới nhận drop; thả file lên một **file khác** hoặc vào
  **vùng con của folder đang mở** thì sự kiện drop bong-bóng lên root handler → no-op (file gốc) hoặc chuyển nhầm về vault root.
  Fix: hàng file cũng là drop target (`onDragOver/onDragLeave/onDrop` + class `drop-target`), thả lên file = chuyển vào
  **thư mục cha của file đó** (đúng hành vi Obsidian) trong `web/src/components/FileTree.tsx`. Verify: kéo file root thả lên
  file nằm trong folder Alpha (đang mở) → file chuyển hẳn vào Alpha (trước đó đứng yên).
- 2026-06-18 (Phase 30 — Canvas nâng cấp tương tác + Canvas public share + chùm fix UX theo phản hồi liên tục):
  **Canvas (M25.7–25.9):** marquee kéo-chọn nhiều node + đường gióng (alignment snap-guides) port từ
  `getSnapping/O3/P3` của Obsidian asar (snap 4 góc + tâm, dist `ceil(15/scale)`, Alt tắt snap, Shift khoá trục);
  phím tắt format (⌘B/I/K/L/`⌘/`, `toggleWrap`) + căn lề text (`TextNode.textAlign`, nút selection-menu + submenu).
  **Canvas public share (FR-10 mở rộng):** `server/src/services/rendercanvas.ts` render `.canvas` ra HTML tĩnh
  (node tuyệt đối + edges SVG, text/embed qua `renderNoteHtml`, allowlist ảnh qua `canvasEmbedTargets`); `sharepage.ts`
  nhánh canvas (layout `bare`, og:meta), `shares.ts` cho phép `.canvas`; client mở "Share…" cho canvas (Workspace +
  FileTree). Verify CDP end-to-end: tạo share → `/share/:id` HTTP 200 render đủ node/edge/arrow + og:title.
  **Fix UX:** (a) mũi tên edge to hơn; (b) menu chuột phải card mở tại con trỏ + clamp trong màn hình (fixed + đo);
  (c) **thu panel trái không còn chừa khoảng trống phải** — `.app` grid đổi sang cột theo biến `--sidebar-width/--right-width`
  + pin `grid-column` từng cột (col editor luôn `1fr`); (d) **kéo resize sidebar trái** (`.sidebar-resizer`, clamp 180–560px,
  lưu `localStorage`); (e) bỏ nút **Refresh** thừa ở header Files (đã có Sync dưới); (f) **fix 2 thư mục Attachments/attachments**
  — upload resolve thư mục **case-insensitive** (`vault.resolveDirCaseInsensitive`) nên dùng lại folder sẵn có thay vì tạo trùng.
  Typecheck + build (server + web) sạch.
- 2026-06-15 (Phase 29 — Sort by modified/created time, nhanh nhờ stat cache): thêm 4 lựa chọn sort theo
  thời gian (Modified/Created · new→old / old→new) vào dropdown header Files. **Nhanh**: server giữ
  `statCache` (Map path→{mtime,ctime}) trong RAM — `listTree()` fill 1 lần (stat song song theo từng thư mục),
  steady-state đọc cache → 0 syscall; watcher gọi `invalidateStat(rel)` khi file add/change/unlink nên chỉ
  re-stat đúng file đổi. Tránh hẳn vấn đề 27k stat/lần-fetch mà comment cũ cảnh báo. `TreeNode` thêm `ctime`
  (server lấy `birthtimeMs || mtimeMs`). Sort client-side đệ quy per-folder (folder luôn nhóm trước, sort theo
  tên; file theo tiêu chí chọn) — đúng như Obsidian chỉ sort các item **đang hiện diện** trong panel (collapsed
  không render). `treeSort` mở rộng 6 giá trị, persist. Typecheck + build sạch.
- 2026-06-14 (Phase 28 — File tree header toolbar parity Obsidian theo yêu cầu người dùng): dựng lại header
  sidebar Files đủ nút như Obsidian: **New note** (icon `square-pen`), **New canvas** (`layout-dashboard`),
  **New folder** (`folder-plus`), **Change sort order** (dropdown: File name A→Z / Z→A, có ✓ ở mục đang
  chọn — `treeSort` persisted, sort đệ quy client-side, folder luôn trước), **Auto reveal current file**
  (toggle `autoReveal` persisted — tự expand ancestors + scroll tới file active khi đổi file), **Collapse all /
  Expand all** (1 nút đổi trạng thái theo `expanded.length`; expand-all gom mọi folder path qua
  `collectFolderPaths`), + giữ Refresh/Trash. Store: `setExpanded`, `treeSort/setTreeSort`,
  `autoReveal/toggleAutoReveal` (thêm vào PERSIST_KEYS + applyPersisted). CSS: `.nav-header` cho `flex-wrap`
  (8 nút không tràn trên mobile), `.nav-action.active` màu accent. LƯU Ý: sort theo modified/created time chưa
  làm vì server cố tình không stat mtime từng file (~27k file → 27k syscall mỗi lần fetch tree). Typecheck +
  build sạch; bundle chứa đủ chuỗi nút.
- 2026-06-14 (Phase 27 — Canvas mobile edit-save + nút New canvas theo phản hồi người dùng): (1) **fix
  Android Chrome không lưu được text khi double-tap edit node**: nguyên nhân là blur của `<textarea>`
  thường KHÔNG kích hoạt khi bàn phím mềm Android đóng → edit mất. Thêm `commitTextEdit()` (idempotent,
  guard qua `editingNodeRef`) gom mọi đường lưu, và **listener `pointerdown` capture-phase trên document**
  (chạy khi đang edit): chạm/click ra ngoài textarea (trừ `.canvas-textmenu/.canvas-linkpicker/.canvas-notepicker`)
  → commit. onBlur/linkPicker-dismiss nay cũng route qua `commitTextEdit`. (2) **double-tap touch tự nhận
  diện** trong `beginNodeDrag` (2 tap <350ms cùng node) → `activateNode` (text→edit, file→open, link→open)
  vì Android không sinh `dblclick` đáng tin. (3) **nút "New canvas"** (icon `layout-dashboard`) trên header
  sidebar Files cạnh New note/New folder — trước chỉ tạo được canvas qua right-click (không khả dụng trên
  mobile). Typecheck + build sạch; bundle chứa selector tap-outside + ngưỡng 350ms.
- 2026-06-14 (Phase 26 — Ảnh: resize + zoom lightbox theo yêu cầu người dùng): (1) **kéo để resize** ảnh
  nhúng — 2 thanh handle trái/phải hiện khi hover trong Live Preview, kéo đổi rộng (clamp 40..bề rộng content,
  giữ tỉ lệ height auto) và **ghi lại vào source** dạng size param Obsidian qua `writeImageWidth()`:
  `![[img|W]]` cho wikilink embed, `![alt|W](url)` cho ảnh markdown (recover vị trí widget qua `posAtDOM` rồi
  re-match token phủ vị trí). (2) **Size param cho ảnh markdown** `![](…)`: alt mang `|W`/`|WxH` nay áp dụng
  width/height ở cả Live (imgRe) lẫn Reading (markdown.ts) — trước chỉ `![[…]]`. (3) **Lightbox zoom**
  (`lib/imageLightbox.ts`): click ảnh ở cả 2 mode → overlay toàn màn hình; wheel zoom theo con trỏ, pinch
  2-ngón theo tâm, kéo/1-ngón pan, double-click reset, Esc/click nền/× đóng. Typecheck sạch. Build + deploy prod.
- 2026-06-13 (Phase 25s — Canvas drag handle + fix node lẹm trái trên mobile): (1) **drag handle** (grip
  chấm) nổi trên đỉnh mỗi node — tap/giữ-kéo để di chuyển node (tiện cho touch); hiện khi hover/selected và
  **luôn hiện trên mobile**; `onPointerDown→beginNodeDrag`, `touch-action:none`. (2) **fix node bị lẹm một
  miếng bên trái ở vài mức zoom trên mobile Safari**: `.canvas-world` đang `width:0;height:0` → Safari clip
  descendant scaled nằm trái/trên gốc → đổi thành `width:100%;height:100%;overflow:visible`. Smoke-test
  (viewport 390px): node render đủ viền trái; grip kéo node bằng touch +200/+150 và mouse −150/−100; pan nền
  vẫn +120; không lỗi console. Typecheck + build sạch. Deploy prod.
- 2026-06-12 (Phase 25r — Canvas mobile: pinch-zoom + toolbar không overlap): trên điện thoại canvas không
  pinch-zoom được (`touch-action:none` chặn gesture trình duyệt) và 2 toolbar dưới đè nhau. Fix: (1)
  **pinch-to-zoom + 2-ngón pan** qua listener pointer **capture-phase** trên viewport (ngón thứ 2 hủy drag
  1-ngón rồi pinch, chạy cả khi đặt trên node); 1-ngón pan vẫn dùng pointer drag cũ. (2) `@media
  (max-width:768px)`: tách **zoom toolbar (trái-dưới)** và **add toolbar (phải-dưới)**, target chạm to hơn.
  Smoke-test (viewport 390px, synthetic touch): pinch scale 1.5→4 và 4→0.8; 1-ngón pan Δx đúng; toolbar tách
  2 góc; không lỗi console. Typecheck + build sạch. Deploy prod.
- 2026-06-12 (M3.6 — Trash UI + deleteMode, theo yêu cầu người dùng): thêm setting `vault.deleteMode`
  (`trash` mặc định | `permanent`) — DELETE `/api/files/` rẽ nhánh trash vs `vault.remove()` xoá hẳn.
  Service vault: `listTrash/restoreFromTrash/deleteFromTrash/emptyTrash` (+ `pruneEmptyDirs`, guard
  `assertInTrash` chống thao tác ngoài `.trash`). Routes `/api/files/trash` (GET list · POST restore ·
  DELETE item · DELETE empty). Frontend: `api.listTrash/restoreTrash/deleteTrashItem/emptyTrash`, store
  `trashOpen/setTrash`, modal `TrashView` (Restore / xoá vĩnh viễn / Empty trash) mở từ nút 🗑 header Files,
  command palette "Open trash". Settings → Vault & Files thêm select chế độ xoá. Confirm/notify file tree +
  pane menu đổi sang generic "Delete" + báo "Moved to trash" / "Deleted permanently" theo response. Verified
  end-to-end qua curl trên vault tạm: trash list giữ cấu trúc thư mục, restore né trùng tên + prune dir rỗng,
  permanent mode xoá hẳn (không lưu bản sao), empty trash, guard "Not a trash item", PUT deleteMode giữ
  nguyên `vault.path`. Typecheck 2 workspace sạch.
- 2026-06-12 (Phase 25q — Canvas external link new-tab + open zoom-to-fit theo phản hồi): (1) **external
  link** (`http(s)://`) trong card → `onClickCapture` trên node `window.open(href,'_blank')` mở tab trình
  duyệt mới (wikilink href="#" vẫn rớt xuống openWikilink). (2) **Mở canvas tự Zoom-to-fit**: bỏ reset view
  cứng {60,60,1}; effect `fittedFor` gọi `zoomFit()` 1 lần/canvas (rAF sau khi data parse + viewport có kích
  thước). Smoke-test: canvas 2 node cách xa mở ở 53% fit cả 2; click external link → window.open _blank;
  không lỗi console. Typecheck + build sạch.
- 2026-06-12 (Phase 25p — fix click wikilink trong canvas card): click vào `[[link]]` trong text card không
  navigate được — do click thật bị jitter >1px → lazy `setPointerCapture` (node move) retarget click khỏi
  link. Fix: trong `beginNodeDrag`, nếu pointerdown rơi vào `[data-wikilink]`/`a` thì **return sớm** (không
  bắt đầu drag/capture, không stopPropagation) → để click đi tới Preview.onClick → `openWikilink`; viewport
  vẫn không pan (target nằm trong .canvas-node). Smoke-test: real CDP click link "NoteA" trong card →
  điều hướng `/note/NoteA.md`; không lỗi console. Build sạch.
- 2026-06-12 (Phase 25o — Canvas "Add link" dropdown search note như Obsidian): "Add link" giờ mở
  **dropdown search note** (tái dùng style notepicker) tại caret thay vì chỉ bọc `[[]]`. Lưu caret
  (`linkInsertPos`), guard `onBlur` khi dropdown mở (giữ card editing), chọn note → chèn `[[basename]]` tại
  caret rồi refocus; Esc/click nền → đóng + commit. Search lọc theo path; Enter chọn mục đầu; item
  `onMouseDown preventDefault`. Smoke-test: Add link → dropdown liệt kê note (K.canvas/NoteA/Task); gõ "task"
  → lọc còn Task; chọn → chèn `[[Task]]`; không lỗi console. Build sạch.
- 2026-06-12 (Phase 25n — Canvas text menu: Add link/external lên top-level): theo Obsidian, **Add link**
  (`[[…]]`) và **Add external link** (`[…](https://)`) là mục cấp 1 đầu menu (không nằm trong Insert) — đã
  chuyển ra top-level + bỏ khỏi submenu Insert. Smoke-test: menu top-level = Add link/Add external link/—/
  Format/Paragraph/Insert/—/Cut/Copy/Paste/Select all; Add link → `[[word]]`; không lỗi console. Build sạch.
- 2026-06-12 (Phase 25m — Canvas resize dễ hơn theo phản hồi): trước handle giữa-cạnh bị **port nối đè**
  (z) nên chỉ kéo được 4 góc nhỏ. Giống Obsidian: **4 handle góc rõ** (12px, nền trắng + viền accent, z8
  trên port) cho resize chéo + **dải kéo viền cạnh** (`.canvas-edge-resize` n/s/e/w, inset 12px khỏi góc,
  z6 dưới port nên chấm nối giữa cạnh vẫn để nối). Fix resize không lưu (commit dùng `dataRef` trễ 1 frame)
  → tách `resizeRect()` tính từ toạ độ event, commit ở pointerup từ event (robust). Smoke-test: chọn node →
  4 góc + 4 dải cạnh; kéo góc SE +120/+80 → 240×140 → 360×220, autosave đúng; không lỗi console. Typecheck +
  build sạch.
- 2026-06-12 (Phase 25l — Canvas text-card menu phân cấp clone Obsidian bundle): reverse-engineer
  `obsidian.asar` i18n lấy đúng cấu trúc editor menu → build menu **phân cấp** (`TextFormatMenu`,
  submenu mở sang phải khi hover) khớp y Obsidian: **Format›** (Bold/Italic/Strikethrough/Highlight/Code/
  Math/Comment/—/Clear formatting), **Paragraph›** (Bullet/Numbered/Task list/—/Heading 1-6/Body/—/Quote),
  **Insert›** (Add link/Add external link/—/Table/Callout/Code block/Math block/Horizontal rule/Footnote),
  —, Cut/Copy/Paste/Select all. Helpers: `setLinePrefix` (thay prefix heading/list/quote đầu dòng),
  `insertAtCaret`, `clearFormatting`, clipboard execCommand. Vẫn giữ focus textarea (mousedown
  preventDefault). Smoke-test: right-click card "hello world" → menu 3 submenu + clipboard; Paragraph›Heading
  2 → `## hello world`, blur render `<h2>`, không lỗi console. Typecheck + build sạch.
- 2026-06-12 (Phase 25k — Canvas text-card format menu theo phản hồi): right-click **bên trong text card
  đang edit** → menu định dạng markdown như Obsidian: Bold/Italic/Strikethrough/Highlight/Code (bọc selection
  `**`/`*`/`~~`/`==`/`` ` ``), Heading/Bullet list/Quote/Checkbox (prefix đầu dòng), Link/Wikilink. Menu
  `onMouseDown=preventDefault` để textarea **không blur** (giữ focus + selection); `applyFormat` chỉnh
  `textarea.value` trực tiếp (uncontrolled, blur commit). Đóng menu khi click nền / blur. Smoke-test: edit
  card "hello world", chọn all, right-click → menu đủ 11 mục; Bold → `**hello world**`, blur render
  `<strong>`, autosave đúng; không lỗi console. Typecheck + build sạch.
- 2026-06-12 (Phase 25j — Canvas colored-node styling + node right-click menu theo phản hồi): (1) node có
  màu giờ hiển thị **viền màu đều 3px quanh node + nền tint nhạt** (`color-mix --c 10%`) thay vì vạch trái —
  scope `:not(.canvas-group)` để không đè group. (2) **right-click node → context menu nhiều chức năng**
  (dùng store `openContextMenu`): Edit/Open/Open link (theo loại node), **Set color** (submenu Default+6 màu),
  **Duplicate** (copy node + edge nội bộ, lệch 40px, id mới), Zoom to selection, **Bring to front/Send to
  back** (đổi z-order = thứ tự mảng), **Align** (left/center-h/right/top/center-v/bottom — khi chọn nhiều),
  Remove. Thêm `selRef` (selection luôn mới) để callback menu/handler thao tác đúng selection (fix stale khi
  right-click node chưa chọn). Smoke-test: node màu có viền 3px + nền tint; menu hiện đủ mục; Duplicate 2→3
  node, autosave đúng; không lỗi console. Typecheck + build sạch.
- 2026-06-12 (Phase 25i — Canvas color picker chuẩn + custom theo Obsidian): palette màu giờ gồm **default
  (xám) + 6 màu preset + nút custom (vòng cầu vồng)** bọc `<input type=color>` để chọn màu tuỳ ý (lưu hex
  vào `color` — JSON Canvas hỗ trợ, Obsidian đọc được). Swatch đang chọn có **ring accent** (so khớp màu của
  node/edge đang chọn; hex → ring ở nút custom). Smoke-test: mở palette thấy 8 swatch + input color, ring ở
  "Color 2" (node màu 2); set custom `#1e90ff` → ghi đúng `color:"#1e90ff"`, card đổi màu xanh; không lỗi
  console. Typecheck + build sạch.
- 2026-06-12 (Phase 25h — Canvas fixes theo phản hồi): (1) nền canvas trắng (`--background-primary` thay
  `--background-secondary`). (2) label connector **bỏ border** (chỉ chữ trên line, vẫn nền mờ để dễ đọc).
  (3) **bug double-click card tạo card mới** thay vì edit: nguyên nhân `beginNodeDrag` gọi `setPointerCapture`
  ngay ở pointerdown → click/dblclick bị retarget về `.canvas-view` nên node `onDoubleClick` (edit) không
  chạy, handler nền tạo card mới. Fix: **capture lazy** — chỉ `setPointerCapture` ở lần move thật đầu tiên
  (mode 'move'), không capture ở pointerdown. Giữ nguyên double-click nền tạo node tại điểm click (như
  Obsidian app). Smoke-test: double-click card → edit, nodeCount giữ 1; double-click nền → tạo card mới +
  edit; label border=none; nền trắng; không lỗi console. Typecheck + build sạch.
- 2026-06-12 (Phase 25g — Canvas connect-to-anchor parity, reverse-engineer Obsidian): user phản ánh kéo
  từ anchor sang node khác "chỉ hiện đường gạch đứt". Test xác nhận edge VẪN tạo được, nhưng thiếu UX: node
  đích không hiện anchor + line không snap. Reverse-engineer `app.css`: Obsidian có trạng thái canvas
  **`is-connecting`** → mọi node hiện `canvas-node-connection-point`, anchor đích sáng lên. Clone: thêm state
  `connecting` (bật khi begin connect/reconnect) → **mọi node hiện 4 anchor** khi đang kéo; move tính
  `nearestSide` của node đích → preview line **snap vào anchor** đó + anchor đó nhận class `.active` (sáng +
  glow); drop nối đúng anchor gần con trỏ (connect & reconnect đều dùng `nearestSide(over, cursor)`). Bỏ
  `reconnectEdge` cũ (inline). Smoke-test: giữa lúc kéo có 8 anchor (2 node), B.left `.active`, preview snap;
  thả → edge `a:right→b:left` đúng anchor; không lỗi console. Typecheck + build sạch.
- 2026-06-12 (Phase 25f — Canvas bidirectional arrow + kéo endpoint reconnect theo phản hồi): (1) **mũi
  tên 2 đầu không hiện**: marker `orient="auto"` làm arrowhead đầu `from` quay sai chiều + nằm khuất dưới
  node → đổi `orient="auto-start-reverse"` (chuẩn SVG cho line 2 đầu) → bidirectional hiện mũi tên cả 2 đầu.
  (2) **kéo đầu mũi tên ra được** như Obsidian: edge đang chọn hiện 2 chấm endpoint (circle, vector-effect
  non-scaling-stroke); kéo endpoint → thả lên node khác = **reconnect** (đổi from/to-Node + nearest side);
  thả ra vùng trống = menu **Add card / Add note from vault** tạo node mới tại điểm thả và nối luôn (card vào
  edit ngay; note mở picker qua `pendingConnect`). Preview đường kéo realtime. Refactor pointerup connect/
  reconnect tính target từ toạ độ event (bỏ phụ thuộc state `connectTo` bị trễ 1 frame → robust). Menu drop
  clamp trong viewport. Smoke-test: zoom-fit thấy mũi tên 2 đầu; kéo endpoint→Other reconnect (toNode=c);
  kéo ra trống→menu→Add card tạo node nối (4 nodes, edge.toNode=node mới), autosave đúng; không lỗi console.
  Typecheck + build sạch.
- 2026-06-12 (Phase 25e — Canvas arrow-direction dropdown khớp Obsidian): nút hướng mũi tên trước bấm
  cycle → đổi thành **dropdown 3 lựa chọn** y như Obsidian: **Nondirectional** (— không mũi tên),
  **Unidirectional** (→ mũi tên đầu `to`), **Bidirectional** (⇄ 2 đầu), có dấu ✓ ở mục hiện tại; icon nút
  toolbar đổi theo trạng thái. Thêm icon `minus`. CSS `.canvas-dir-menu/.canvas-dir-item`. Smoke-test: chọn
  edge → mở dropdown thấy 3 mục + ✓ Unidirectional; chọn Bidirectional → 2 marker arrow, dropdown đóng,
  autosave `fromEnd/toEnd=arrow`; không lỗi console. Typecheck + build sạch.
- 2026-06-12 (Phase 25d — Canvas edge label/menu fix theo phản hồi): (1) **label nằm đúng giữa line**:
  trước dùng Bézier t=0.5 (lệch) → đổi sang **điểm giữa theo arc-length** (`bezierArcMidpoint`, sample 24
  đoạn, đi nửa độ dài cung); foreignObject 200×32 + wrapper flex center → chip nằm chính giữa trên đường
  cong (verify distToLine=0). (2) thêm nút **Remove label (X)** trong edge menu khi edge có label (khớp
  Obsidian: trash·palette·zoom·⇄·X·pencil). (3) nút hướng mũi tên đổi icon **⇄ (arrow-left-right)**; toggle
  cho ra cả 2 đầu mũi tên (verify marker-start+end). Click label = chọn edge, double-click = sửa. Smoke-test:
  label center=0px lệch, direction→bidirectional, remove label ẩn nút + xoá label, autosave đúng, không lỗi
  console. Typecheck + build sạch.
- 2026-06-12 (Phase 25c — Canvas parity sâu, reverse-engineer Obsidian app theo yêu cầu): extract
  `obsidian.asar` (`app.css`/`i18n.js`) lấy đúng vocabulary menu Canvas (`actionRemove`/`actionSetColor`/
  `actionZoomToSelection`/`actionEditLabel`/arrow ends `none|arrow`) + xác nhận 6 màu preset = red/orange/
  yellow/green/cyan/purple (đã khớp). **(1) Selection menu kiểu Obsidian** nổi trên selection, hoạt động cho
  cả node lẫn **edge** (trước edge không có nút xoá → "ko xoá dc connector"): Remove, Set color (palette mở
  hàng swatch), Zoom to selection; riêng edge thêm **Arrow direction** (cycle toEnd→both→fromEnd→none) và
  **Edit label**. Vị trí menu tính từ bbox selection gồm cả endpoint của edge. **(2) Undo/redo**: stack
  serialized (≤200), `commit` đẩy history + clear redo; `undo`/`redo` + phím **⌘Z/⌘⇧Z/⌘Y**, nút ↶↷ trong
  thanh zoom (disabled khi rỗng), clear khi đổi file. Thêm icon `palette`+`zoom-in` (Lucide) vào Icon.tsx.
  Smoke-test: chọn edge → menu hiện đủ nút; Remove xoá edge, Undo phục hồi, Redo xoá lại; không lỗi console.
  Typecheck + build web sạch.
- 2026-06-12 (Phase 25b — Canvas UX theo phản hồi người dùng): (1) thanh **add** giữa-dưới giống Obsidian
  với 3 nút **Add card / Add card from note / Add image** (tách khỏi cụm zoom góc trái-dưới). "Add card from
  note" mở popup search liệt kê file vault (note + ảnh) → chèn file node tại tâm view; "Add image" mở file
  dialog → `api.upload` → chèn image node. (2) **Kéo nền để pan viewport** (trước phải giữ Space): kéo nền
  trống = pan, **Shift+kéo** = marquee chọn nhiều, click nền (không kéo) = bỏ chọn; con trỏ `grab`/`grabbing`.
  `setPointerCapture` bọc try/catch (robust với synthetic/inactive pointer). Smoke-test trình duyệt: pan đổi
  transform đúng delta, Add note chèn embed, Add image render image node, autosave ghi đủ text+2 file node,
  không lỗi console. Typecheck + build web sạch.
- 2026-06-12 (Phase 25 — Canvas FR-12, clone Obsidian Canvas): thêm `web/src/lib/canvas.ts` (đọc/ghi
  định dạng mở **JSON Canvas** `.canvas`, tab-indent y như Obsidian, parse an toàn về `{nodes:[],edges:[]}`,
  preset 6 màu, hình học edge Bézier theo side + auto-side + nearest-side, bbox/fit) và
  `web/src/components/CanvasView.tsx` (~620 dòng): khung vô hạn pan/zoom (wheel zoom tâm con trỏ, kéo nền/
  space+drag pan), lưới chấm nền co theo zoom; nodes DOM tuyệt đối trong layer transform, edges vẽ SVG (lớp
  dưới) đường cong + mũi tên `marker`; node **text** (Preview markdown / textarea edit), **file** (note=Preview
  embed, ảnh=`<img>`), **link** (card), **group** (nền mờ sau cùng); tạo card double-click nền / nút +, drag
  move nhóm, 8 resize handle, 4 chấm cạnh kéo tạo edge, double-click edge sửa label, marquee + Shift multi-
  select, toolbar màu/xóa nổi, Delete/Backspace xóa. Autosave debounce 900ms qua store `content`/`save`
  (`.canvas` đã trong `TEXT_RE`), không thêm API. Wire `Workspace` render CanvasView cho `.canvas`; store
  `newCanvas`; "New canvas" vào context menu FileTree (file/folder/vault root) + command palette. CSS
  `.canvas-*` trong obsidian.css. Typecheck + build web sạch; smoke-test trình duyệt (vault tạm): render
  group/edge mũi tên/label/embed note đúng, zoom-to-fit, tạo card + đổi màu, autosave ghi đúng JSON Canvas
  round-trip (giữ nguyên node/edge cũ), không lỗi console. PRD lên 1.0 + FR-12.
- 2026-06-12 (Security hardening — audit toàn repo): không có secret lộ trong git (history + tracked
  files sạch; `data/`/`.env`/`.claude/skills/` gitignored). Sửa 9 điểm: **(1)** bắt đổi pass khi còn
  dùng mặc định `123456` — `/auth/login`+`/me`+`/status` trả `mustChangePassword`, web chặn bằng
  `ForceChangePassword` (vẫn bind 0.0.0.0). **(2)** redact git PAT (`https://<token>@…`) khỏi mọi
  error trả client + log (`lib/redact.ts`, dùng trong `errorHandler`, `git.ts` sync/autosync).
  **(3)** `helmet` + CSP (script-src 'self'+nonce; KHÔNG `upgrade-insecure-requests` để giữ HTTP
  self-host; nonce cho inline script trang `/share`). **(4)** rate-limit `/auth/login` 10 lần/15
  phút/IP (`middleware/ratelimit.ts`). **(5/6)** validate plugin `id` (`^[a-zA-Z0-9._-]+$`) ở install
  (manifest.id remote) + serve asset → chặn path traversal đọc/ghi. **(7)** `/ws` yêu cầu cookie
  auth ở bước upgrade. **(8)** `resolveInVault` chặn segment `.git` (RCE qua hooks) + realpath guard
  chống symlink thoát vault. **(9)** đổi `vault.path` qua API phải nằm trong allowedRoots + là thư mục
  tồn tại. Typecheck + build sạch; smoke-test xác minh tất cả. PRD §Bảo mật cập nhật.
- 2026-06-12 (Phase 24 — Copy/Cut/Paste file & folder trong context menu file tree): store thêm
  `clipboard {path, mode}` + `setClipboard` (session-local). FileTree: `doClipboard('copy'|'cut')`
  set clipboard + toast; `doPaste` dán vào folder đích — Cut = `api.rename` (move, hỗ trợ folder,
  chặn dán vào chính nó/thư mục con, dán chỗ cũ = no-op), Copy = `api.copy` đệ quy với `uniqueChildName`
  né trùng tên. Menu file: Copy/Cut/Paste; menu folder: Copy/Cut/Paste. Row bị Cut mờ đi, Paste chỉ
  hiện khi có clipboard. Server: `vault.copy` (`fs.cp` recursive trả list file tạo ra) + route
  `POST /api/files/copy` (reindex `.md` mới, auto-commit); client `api.copy`. PRD 0.9 (FR-1 + API row).
  Bổ sung (M24.4): right-click vùng trống file tree ra menu app (New note/New folder/Paste vào vault root)
  thay vì menu native trình duyệt. Typecheck server + web sạch.
- 2026-06-12 (New folder không prompt + inline rename trong cây thư mục): action store
  `newFolder(dir?)` tạo thẳng folder "Untitled" (tự tăng "Untitled 1/2…" nếu trùng), expand
  ancestor + mở panel Files rồi đặt `renamingPath` = path mới. FileTree thêm component
  `RenameInput` (ô input bo viền accent thay cho `.name`): autofocus + chọn sẵn phần tên (giữ
  đuôi file), Enter/blur → `api.rename`, Escape → huỷ; stopPropagation để click/pointerdown
  không toggle/mở row. Store thêm state `renamingPath` + `setRenamingPath`. Menu "New folder"
  (FileTree) và nút New folder (Sidebar) gọi `newFolder()`, bỏ `prompt('Folder name')`. Tiện thể
  chuyển "Rename…" của file/folder sang inline rename (bỏ prompt path); giữ "Move to…" cho việc
  đổi thư mục. CSS `.tree-rename`. Typecheck + build web sạch.
- 2026-06-12 (New note không prompt + tab-bar controls không bị scrollbar che): (1) thêm action
  store `newNote(dir?)` tạo thẳng note "Untitled.md" (tự tăng "Untitled 1/2…" nếu trùng trong
  folder đích), body rỗng → inline-title hiện tên file như Obsidian, không còn `prompt('Note name')`.
  Thay mọi điểm gọi: ⌘N (App.tsx), Command palette, tab-bar "+", Sidebar Files header, context menu
  FileTree (New note trong folder → `newNote(node.path)`), FolderView header. Giữ prompt cho New
  folder và auto-create theo tên khi click wikilink chưa tồn tại. (2) Tab-bar: bọc danh sách tab
  vào `.tab-scroll` (overflow-x:auto, ẩn scrollbar `scrollbar-width:none`), các nút điều khiển
  (toggle trái/phải, "+" new note) gắn class `tab-ctl` flex-shrink:0 nằm ngoài vùng cuộn → không
  bị scrollbar nuốt chiều cao hay cuộn mất khi nhiều tab. Typecheck web sạch.
- 2026-06-12 (Phase 23 — Render HTML block): note import từ Trilium chứa full trang HTML (SingleFile)
  trong ` ```html ` fence. Yêu cầu nút render block. Lần đầu sửa nhầm `Preview.tsx` (component này
  giờ CHỈ dùng cho trang share — Reading mode thật là CodeMirror editor readonly, M18.14). Fix đúng:
  thêm `htmlPreviewField` (StateField widget) vào `livePreview.ts` + đăng ký ở `Editor.tsx`. Đặt nút
  trên đầu block (side:-1) vì CodeMirror ảo hoá DOM — nút sau block khổng lồ sẽ ngoài viewport. iframe
  sandbox `allow-scripts` không same-origin (cô lập). Giữ luôn nút ở `Preview.tsx` cho `/share`. Verify
  end-to-end bằng chrome-devtools (login pw 123456): nút hiện, click → iframe render đúng trang. Build sạch.
- 2026-06-12 (Folder deep-link → Folder view): mở URL trỏ folder (`/note/<folder>`) trước đây bị
  render như note rỗng (Editor) tên folder. Thêm `lib/tree.ts` (`findNode`/`isFolderPath`) + component
  `FolderView.tsx` liệt kê nội dung folder (folder con + note, sort folder trước; thumbnail ảnh; kéo-thả
  được; nút + tạo note trong folder). `store.openFile` phát hiện folder qua tree → bỏ qua `api.read` và
  không thêm vào Recent. Workspace render FolderView khi `isFolderPath(tree, activePath)`, ẩn nút ⋯
  (menu file không áp dụng cho folder). Typecheck + build sạch.
- 2026-06-12 (Phase 22 — Move file to… + context menu Bookmarks/Recent): tính năng "Move file to…"
  trước đây là `prompt()` gõ tay đường dẫn — thay bằng modal folder-picker kiểu Obsidian
  (`FolderPicker.tsx`, mount ở App cạnh ContextMenu): gõ lọc folder, ↑↓ chọn, ↵ move, ⇧↵ tạo folder
  mới theo tên gõ rồi move (vault.rename tự tạo thư mục cha), esc đóng. State qua `store.movePath`/
  `setMovePath` (không persist). Menu ⋯ (Workspace) và menu chuột phải file tree (FileTree) giờ chỉ
  gọi `setMovePath(path)`. Panel Bookmarks/Recent (`BookmarksPanel.tsx`) thêm `onContextMenu` →
  `openContextMenu` (trước đây right-click rơi vào menu native trình duyệt): Open/Open to right/
  Reveal/Move file to…/Bookmark/Copy path; Recent có thêm "Remove from recent" (`store.removeRecent`).
  Bổ sung: hàng Bookmark/Recent `draggable` (kéo vào folder file tree để move, dùng chung payload
  `text/wo-path`) + nút hover trên mỗi hàng (📁 Move / ✕ Remove). Typecheck + build web sạch.
- 2026-06-12 (Copy path → Copy URL path): menu chuột phải file (FileTree), menu ⋯ (Workspace) và
  panel Bookmarks/Recent đổi "Copy path" → "Copy URL path", copy deep-link đầy đủ
  `${location.origin}${pathToUrl(path)}` (vd `http://localhost:8787/note/...`) thay vì path vault.
  Menu chuột phải folder vẫn giữ "Copy path" (folder không có URL note). Typecheck + build sạch.
- 2026-06-12 (Toast cho "Rebuild search index"): lệnh reindex (~12s với vault 6000+ note) trước
  đây chạy im, không phản hồi UI. `notify()` (store.ts) thêm tham số `ms` (mặc định 2500, `0` =
  giữ tới khi bị thay). CommandPalette: hiện "Rebuilding search index…" (persistent) lúc bắt đầu,
  đổi thành "Search index rebuilt" khi xong (hoặc "Failed to rebuild…" nếu lỗi). Typecheck + build
  web sạch; output vào server/public nên chỉ cần reload, không restart server.
- 2026-06-11 (Fix "Path outside allowed roots" khi Browse vault): folder browser
  (`/api/settings/browse`) chỉ cho đi trong `vault.allowedRoots`, nhưng mặc định roots suy ra từ
  `sample-vault` nên vault ngoài đó (vd `~/ObsidianVault-Trilium`) bị 403. Sửa gốc: thêm
  `ensureVaultBrowsable()` (services/settings.ts) tự thêm thư mục cha của vault vào `allowedRoots`
  khi chưa được phủ — gọi lúc lưu vault path (routes/settings.ts) và backfill khi `loadSettings`
  để chữa file cũ. Đã rebuild + restart server, settings tự heal (`allowedRoots` thêm `/Users/xnohat`).
- 2026-06-11 (Fix search trả 0 kết quả): server/data/qmd-index.json bị persist rỗng
  (`documentCount: 0`, có thể do build chạy lúc vault tạm không đọc được). `QmdEngine.restore()`
  load index rỗng đó rồi set `ready=true` → mọi truy vấn trả 0 và không bao giờ rebuild. Sửa: `restore()`
  coi index 0-doc là cache miss (`return false`) để `initSearch()` build lại từ vault. Đã reindex live
  (6048 docs). Typecheck server sạch.
- 2026-06-11 (M2.5 — Đổi mật khẩu + pass mặc định + override): mô hình auth mới. Pass đăng nhập
  mặc định `123456` (không cần bước setup); pass đã đổi lưu ở `auth.userPasswordHash` (rỗng = mặc
  định). `auth.passwordHash` (settings.json, sửa tay) và env `WEBOBSIDIAN_PASSWORD` giờ là pass
  override khôi phục, login luôn chấp nhận. Server: `checkPassword` kiểm tra pass hiệu dụng + 2 nguồn
  override (`auth.ts`); endpoint `POST /auth/change-password` (requireAuth, verify pass cũ); bootstrap
  không seed pass nữa; `redactSettings` trả `hasCustomPassword`/`hasOverridePassword`. Migration trong
  `loadSettings`: file cũ có `passwordHash` → chuyển sang `userPasswordHash` (tránh backdoor 123456),
  persist lại. Web: `api.changePassword`, tab Settings→Account form đổi pass + cảnh báo đang dùng pass
  mặc định. Typecheck 2 workspace sạch. PRD FR-3 + data model cập nhật.
- 2026-06-11 (M19.7 — Mobile parity vòng 2): vá 3 lỗi mobile người dùng báo. (1) Menu "…" của note bị
  cắt dưới màn hình: `ContextMenu.tsx` clamp `x/y ≥ 8px` + ước lượng chiều cao chặn theo viewport (không
  còn đẩy top âm), CSS mobile thêm `max-height: 100dvh; overflow-y:auto` cho `.context-menu` (submenu
  hover desktop không ảnh hưởng vì media query) + rows 9px dễ chạm. (2) Nội dung note kéo ngang được
  (pan/lệch layout): khoá `overflow-x:hidden` + `max-width:100vw` trên `.cm-host`/`.markdown-preview`,
  chữ wrap `overflow-wrap:anywhere`, ảnh `max-width:100%`, bảng `display:block; overflow-x:auto`, code
  giữ cuộn trong; `.prop-key` min-width 92px + prop-row wrap. (3) Modal Settings & Version history tràn
  mép phải: `position:fixed; inset:0` full-screen, settings-nav thành strip cuộn ngang, `.setting-row`
  stack dọc + input full-width (override inline width 260/120), version-history list xếp trên preview,
  share dialog full-width; safe-area top cho nav/head. Build web sạch (7.4s).
- 2026-06-11 (Commit message mô tả): commit vault tự sinh title nêu rõ note nào đổi thay vì
  "WebObsidian auto-sync" chung chung. `describeChanges(StatusResult)` gom file theo Added/Modified/
  Deleted/Renamed → subject 1 dòng (`Add <note>` / `Sync N notes (3 new, 2 edited): a, b, c +X more`)
  + body liệt kê từng path (cap 100). `commitAll()` dùng subject tự sinh khi không có message tay;
  bỏ message generic ở autosync/auto-commit-on-save/nút Commit. Phục vụ cả Version History UI.
- 2026-06-11 (Phase 21 — Pane ⋯ menu parity): bổ sung tính năng menu 3-chấm góc phải note cho khớp
  Obsidian app (theo yêu cầu người dùng). Mới: **Find/Replace** trong note (`@codemirror/search`,
  panel top, item "Find…" → `editorFind()`); **Reveal file in navigation** (`store.revealInTree`
  mở folder tổ tiên + scrollIntoView + flash, FileTree nghe `wo-reveal-file`, row có `data-path`);
  **Add file property** (chèn key rỗng vào frontmatter YAML, tạo block nếu chưa có); **Export to PDF**
  (Reading view → `window.print()` + CSS `@media print` chỉ in nội dung note); **Open version history**
  (server `git.log`/`git.showFile` + routes `/api/git/log|/show`, modal `VersionHistory.tsx` list
  commit + preview + Restore); **Open in new window** (`window.open(/note/<path>)`); **Backlinks in
  document** + **Open linked view** submenu (→ `setRightPanel`). Menu dựng lại theo thứ tự nhóm của
  Obsidian Desktop. Bỏ qua "Reveal in Finder"/"Open in default app" (desktop-only, không hợp web).
  Typecheck sạch cả 2 workspace. PRD bump 0.6 (FR-2/FR-4).
- 2026-06-11 (Deploy hardening cho open-source self-host): rà soát các điểm gãy khi deploy lên VPS
  sạch (gặp thực tế khi deploy lên Synology NAS). (1) `docker-compose.yml` hardcode `./sample-vault`
  + port → người tự host phải sửa file tracked, và mỗi lần redeploy clobber. Fix: chuyển sang
  `${VAULT_HOST_PATH:-./sample-vault}` / `${HTTP_BIND}:${HTTP_PORT}` / `${WEBOBSIDIAN_WATCH}`, tham số
  để ở `.env` (git-ignored) → redeploy không mất cấu hình. (2) Watcher `ENOSPC`: VPS sạch
  `fs.inotify.max_user_watches=8192` < số file vault lớn → native watch chết. Fix: tách `startWatcher()`,
  thêm `.on('error')`, đụng `ENOSPC/EMFILE` thì tự `close()` + restart ở chế độ `usePolling`, log hướng
  dẫn nâng sysctl; env `WEBOBSIDIAN_WATCH=polling` ép polling từ đầu. (3) `.env.example` viết lại theo
  luồng docker thật. (4) healthcheck `start_period=90s` cho index vault lớn lần đầu. README thêm mục
  "Deploy to a VPS" + lệnh sysctl. PRD ↑0.6, FR-9 mở rộng. typecheck server pass.
- 2026-06-15 (Git Sync fix — `index.lock` wedge / "phế hoàn toàn"): bug Git Sync chết hẳn → log lặp
  `fatal: Unable to create '/vault/.git/index.lock': File exists`. Root cause: **3 nguồn chạy git
  đồng thời trên CÙNG repo, không phối hợp**: autosync tick (30s), debounced commit-on-save (5s sau
  khi lưu), và route `/api/git/*` thủ công. Mỗi `git()` tạo **instance simple-git mới** nên task-queue
  per-instance không serialize chéo → 2 `git add .` đụng nhau trên `.git/index.lock`; 1 lệnh bị kill/
  crash giữa chừng để lại **stale lock** → mọi op sau đó chết vĩnh viễn. Fix (server/src/services/git.ts):
  (1) **`withGitLock`** — 1 async queue toàn cục, mọi op ghi (status/pull/push/commitAll/init/clone/sync)
  đi qua, không bao giờ overlap; op lỗi không "đầu độc" queue. Tách hàm public (wrap khoá) khỏi `*Impl`
  (chạy trong khoá, gọi nhau trực tiếp để khỏi deadlock). (2) **`clearStaleLocks`** ở đầu mỗi op — xoá
  `index.lock`/`HEAD.lock`/`config.lock` nếu mtime cũ ≥15s (đủ rộng để không giật lock của Obsidian-git
  ngoài đang chạy, đủ nhanh để tự lành sau crash). (3) **`timeout.block: 120s`** cho simple-git để op
  mạng chết không treo queue mãi. Prod (Synology): tìm thấy `index.lock` 0 byte, mtime cũ ~10h →
  xoá → `git status` chạy lại → `/api/git/sync` = `{ok:true, [Committed, Pulled, Pushed]}`. Deploy bản
  fix để không tái phát. Typecheck 2 workspace sạch.
- 2026-06-11 (Git Sync fix — `spawn EBADF`): bug "Git Sync ko chạy được" → lỗi `spawn EBADF`. Root
  cause KHÔNG ở git: **chokidar v4** trên macOS watch từng file qua kqueue → giữ **1 fd/file**, vault
  ~11k file làm process mở ~11k fd; khi `simple-git` spawn `git`, libuv hết fd dựng pipe stdio →
  `spawn EBADF` (repro: giữ 11k fd rồi spawn = đúng lỗi). Fix: hạ **chokidar ^3.6.0** (FSEvents trên
  mac = 1 fd cho cả cây; inotify per-dir trên Linux/Docker) → fd 11.003 → ~20. Thêm `--allow-unrelated-
  histories` vào `pull()` (vault init local vs remote có sẵn commit). Logging `[git]` ở routes + autosync
  (cho monitor). UI: log `<pre>` → **textarea cuộn, tích lũy, timestamp + Clear** (Settings ▸ GitHub Sync);
  nút **Sync now** trên Ribbon trái (chỉ hiện khi bật git sync, icon xoay khi sync, lỗi → notify).
  Reconcile 1 lần vault↔obsvault.git (lịch sử tách rời): union không mất dữ liệu (`merge -s ours
  --allow-unrelated-histories` nối lịch sử + restore 2.646 file chỉ-có-remote, local thắng khi trùng).
  Verify: `/api/git/sync` → `{ok:true, [Committed, Pulled, Pushed]}`, HEAD==origin/main, 0 file mất ở
  cả 2 phía. Backup refs `backup/pre-union-{local,remote}` trong vault (xóa được sau khi yên tâm).
- 2026-06-11 (Phase 19 — Mobile UI): làm mobile-friendly cho smartphone cảm ứng (tham chiếu Obsidian
  Mobile). `useIsMobile` (matchMedia 768px) + state cục bộ `mobileDrawer` (KHÔNG persist/broadcast →
  không đụng uistate sync desktop). CSS `@media ≤768px`: workspace full-width, ribbon+sidebar trái và
  right sidebar thành drawer overlay trượt (translateX) + backdrop mờ; hamburger (☰) trên tab-bar +
  edge-swipe mép trái/phải mở/đóng drawer; auto-đóng drawer khi mở note; touch targets ≥36–44px; ẩn
  crumbs+split để view-header không tràn; status bar ẩn nhường chỗ toolbar. Format toolbar `FormatToolbar`
  dùng chung qua `lib/activeEditor` (singleton EditorView): 14 nút bold/italic/heading/list/checklist/
  quote/link/[[ /code/tag/indent/outdent/undo/redo. Theo phản hồi người dùng: **bật cả trên desktop**
  (thanh in-flow dưới view-header); mobile neo trên bàn phím qua visualViewport. Viewport
  `viewport-fit=cover` + `interactive-widget=resizes-content` + safe-area insets. Verify Chrome
  390×844: drawer trái/phải trượt+backdrop, hamburger, toolbar Bold ghi `**` + Undo khôi phục, Reading
  ẩn toolbar; desktop 1440 không regression + toolbar Bold/Undo OK. typecheck + build web sạch.
- 2026-06-11 (đợt 5): đổi kiến trúc Reading mode theo yêu cầu — Reading = Live Preview editor
  readonly (một renderer duy nhất), kèm chevron fold callout + syntax highlight code (CM grammar)
  cho pipeline Preview còn lại. Verify: reading là .cm-editor contenteditable=false, callout/
  checkbox/fold/code/math/footnote/HTML render y hệt Live.
- 2026-06-11 (đợt 4): Reading mode parity với Live — dùng chung callout constants, KaTeX +
  mermaid + highlight + tag pill + comment strip + breaks:true + callout fold trong Reading.
  Debug sanitize bằng node repro: a.className bị defaultSchema giới hạn giá trị → filter entry.
  Verify Reading: 4 tag pill, 2 mark, 8 internal-link, 3 katex, 1 mermaid svg, 1 callout gập,
  17 icon callout.
- 2026-06-11 (đợt 3): sửa 4 lỗi editor (HTML table, inline footnote, code block padding +
  indented code guide, embed note title/khoảng trắng) + đồng bộ Reading mode với Live
  (task custom states, bullet, properties pill). Verify cả 2 chế độ bằng screenshot.
- 2026-06-11: Phase 18 đợt 2 — sửa 11 lỗi render người dùng báo khi đối chiếu note "Markdown Test"
  side-by-side với Obsidian app (M18.10): highlight style riêng hết màu đỏ escape; embed note
  transclusion thật + box "could not be found"; indent guides; quote lồng nhiều thanh; checkbox
  trong callout; callout fold +/- hoạt động (gập mặc định với -, toggle bằng chevron); code block
  màu palette Obsidian + nhãn ngôn ngữ; display math $$ render (KaTeX); HR hết margin thừa;
  inline-HTML line + mermaid render thật (lazy); block comment %% xám toàn khối. Thêm deps:
  katex, mermaid, @codemirror/language-data (đều lazy-load chunk riêng). Verify từng mục bằng
  screenshot Chrome trên vault thật; typecheck + build sạch.
- 2026-06-10: Phase 18 — sao chép markdown editor Obsidian Desktop theo docs/obsidian-desktop-internals.md.
  CSS token verbatim (accent HSL + ramp + heading sizes + bold-modifier 200 + callout RGB slots);
  DOM class chuẩn HyperMD-*/cm-*; LP thêm highlight/comment/math(KaTeX)/footref/blockid/HR/
  ẩn fence + escape; callout đủ 14 slot màu + icon lucide + title mặc định; wikilink luật §7
  (alias | đầu, NBSP+NFC, size param ảnh, label raw Note#Head); tag charset unicode chuẩn;
  hotkeys §4 (Mod+B/I/K/L/D, Mod+/, Mod+E, Alt+Enter, list continuation); suggester [[ + #
  với fuzzy scoring port nguyên công thức §9; line spacing đối chiếu app.css thật
  (heading padding-top --p-spacing, inline-title 0.5em). Verify Chrome vault thật side-by-side
  với Obsidian app: heading/highlight/tag pill/callout/task/code/footnote/math/suggester khớp;
  typecheck + build sạch; note test đã xoá.
- 2026-06-03: Khởi tạo PRD.md, IMPLEMENTATION_PLAN.md, CLAUDE.md.
- 2026-06-03: Hoàn tất Phase 0–10. Backend (auth, vault, QMD search, links/graph, git+LFS,
  API gate, plugins) + frontend Obsidian-like (ribbon/sidebar/tabs/editor/reading/search/
  backlinks/outline/graph/settings/command-palette). Build web+server sạch, typecheck pass.
- 2026-06-03: Smoke test pass — login, file tree, full-text + fielded search, backlinks,
  tags, agent API (list/read/write/append/search, 401 no-key, 403 sai scope), SPA served,
  git status (LFS available). Screenshot UI xác nhận editor + reading view + callout +
  properties + wikilinks render đúng.
- 2026-06-04: Phase 12 — Live Preview WYSIWYG, embeds/transclusion, context menu, drag&drop +
  paste image, quick switcher + hotkeys, bookmarks/recent/daily note, split pane,
  git auto-commit-on-save, code-split bundle.
- 2026-06-04: Phase 13 — đại tu UI theo phản hồi: bộ icon Lucide flat thay emoji, default Light
  theme, file tree chevron-only, vault footer, status bar góc phải, "Linked mentions". Screenshot
  đối chiếu ảnh Obsidian thật: editor light + properties block + linked mentions khớp.
- 2026-06-04: Resolve attachment/ảnh kiểu Obsidian: thêm file index toàn vault (basename→path,
  shortest-path); route /content fallback theo basename khi path không khớp. Image generic theo
  protocol — URL trình duyệt load được (http(s)/data/blob/file) load thẳng, còn lại (path tương đối
  hoặc bất kỳ scheme nào) resolve theo basename qua file index. Áp cho cả Live preview lẫn Reading.
  Verify: ảnh hiển thị inline (naturalWidth>0). Watcher cập nhật index khi add/unlink.
- 2026-06-04: Khắc phục OOM trên vault lớn (5.9k note): build index không giữ toàn bộ doc, cap body
  100k, debounce link-graph + loadTree, NODE_OPTIONS=--max-old-space-size=4096 (Dockerfile).
- 2026-06-04: Live Preview render Markdown chuẩn còn thiếu: link `[text](url)` (ẩn URL, click mở
  external/internal), ảnh `![alt](url)` (http/relative → <img>, scheme lạ như trilium-att:// →
  placeholder "🖼 tên"), URL có dấu cách. Thêm overlap-guard cho replace decoration (chống crash).
- 2026-06-04: Viết lại Graph view: canvas 2D + d3-force (Barnes-Hut), pan/zoom, hover/zoom mới hiện
  label, click mở note, mặc định ẩn orphan (689/5929 node có liên kết) + toggle. Hết lag. Sửa layout
  full-height (theme wrapper) + status bar neo vào đáy workspace (không đè right sidebar).
- 2026-06-04: Trỏ WebObsidian vào vault Obsidian thật `/Users/xnohat/ObsidianVault-Trilium`
  (5928 md, 27k files, 5.5GB). Ẩn dotfiles trong tree, folder mặc định thu gọn, con trỏ khởi tạo
  sau frontmatter, Properties render YAML list thành pill. Screenshot khớp ảnh Obsidian thật.
- 2026-06-04: Phase 14 — viết lại Live Preview thành WYSIWYG thật (heading/bold/italic/code/tag/
  callout render, ẩn syntax, chỉ lộ token tại con trỏ; sửa lỗi oneDark trên light). Thêm menu
  chuột phải editor (Format/Paragraph/Insert submenu + clipboard + search), mở rộng menu file tree,
  menu reading view. Screenshot xác nhận: bold render đậm khi con trỏ ở đoạn khác, submenu Format hiện đúng.
- 2026-06-04: Sửa render Markdown lệch Obsidian: (1) syntax Obsidian/wikilink/embed nằm trong inline
  code/code block (vd `` `![[file]]` ``) bị biến thành link — nay giữ literal ở cả Live (skip regex khi
  trùng node InlineCode/FencedCode/CodeBlock từ syntaxTree) lẫn Reading (stash code span trước khi
  preprocess, restore sau). (2) Bảng Markdown chưa render ở Live — thêm scanTables + TableWidget qua
  StateField `tableField` (block widget như frontmatter), inline render trong cell (code/bold/italic/
  link), lộ raw khi con trỏ trong bảng; plugin skip dòng thuộc bảng đã render để tránh chồng decoration.
  Verify: typecheck + build sạch, scanTables nhận đúng bảng README (header Type/Count, 10 dòng).
- 2026-06-05: Live Preview khớp Obsidian thêm: (1) external link http(s) có icon ↗ (SVG lucide) +
  gạch dưới; internal link/wikilink gạch dưới; link widget `inline-block` để text dính sau `]]` vẫn
  wrap được như Obsidian. (2) List: thu gọn khoảng trắng thừa sau marker (`-   Item`→`• Item`,
  `1.  x`→`1. x`). (3) Blockquote dùng màu chữ normal (trước bị muted). (4) Render HTML block thô
  (bảng CKEditor/Trilium `<table>`) qua StateField `htmlBlockField` + sanitize (bỏ script/on*/js: URL),
  click link trong HTML mở external/internal; plugin skip dòng trong HTML block đã render. Verify bằng
  Chrome DevTools trên vault thật: icon ↗ + gạch dưới link, list 1-space, blockquote chữ đậm, bảng HTML
  "Điểm Mạnh/Điểm Yếu" render kèm bullet + link tiktok/Google. Lưu ý: app Obsidian đang mở trên cùng
  vault tự convert vài bảng HTML→markdown và xoá file scratch giữa session — không phải do WebObsidian
  (server read/write nguyên văn, code chỉ thêm decoration).
- 2026-06-05: Tinh chỉnh theo phản hồi: (1) Bảng markdown render `<br>` trong cell thành xuống dòng
  (appendInline thêm token `<br>`), header căn trái + valign top + style theo Obsidian table CSS vars
  (cả Live lẫn Reading). (2) Blockquote: viền trái màu tím `--interactive-accent` + padding-left 24px;
  fix bug padding bị CodeMirror `.cm-line` override bằng selector chuyên biệt `.cm-line.cm-blockquote`
  (tương tự `.cm-callout`) → chữ không còn dính vào viền. Verify Chrome DevTools: br=3 trong cell, th
  căn trái, blockquote border rgb(120,82,238) + padding 24px. Phải restart server 2 lần (minisearch
  vacuuming crash + OOM khi reindex lúc reload) — bug có sẵn, không liên quan thay đổi này.
- 2026-06-05: Table editor tương tác kiểu Obsidian (TableWidget viết lại). Cell click-to-edit
  (contenteditable lồng trong widget, focus hiện raw, blur/Enter commit; Escape huỷ), mỗi thao tác
  re-serialize model → replace range nguồn → tableField rebuild (DOM luôn đồng bộ). Hover hiện nút
  +column (cạnh phải) / +row (đáy). Chuột phải cell mở menu format (inject openContextMenu của store qua
  setLivePreviewMenuHandler): insert column trái/phải, insert row trên/dưới, move column/row, align
  column trái/giữa/phải (submenu), delete column/row. Bảng giờ LUÔN render widget (bỏ reveal-raw khi
  chọn) giống Obsidian — sửa nội dung qua cell, sửa raw qua Source mode. Verify Chrome DevTools trên
  note "Test Table": edit cell ghi đúng GFM ra file, +column 4→5, context menu đủ mục, delete column 5→4.
- 2026-06-05: Inline title (tên note) kiểu Obsidian hiện đầu thân note ở Live (block widget `inlineTitleField`
  ở pos 0, title bơm qua `setNoteTitle` từ Editor) lẫn Reading (Preview prepend `.inline-title`). Dedup:
  bỏ qua nếu note mở đầu bằng `# <tên>` trùng title (note Trilium lặp tiêu đề thành heading) → không hiện 2
  lần. Verify: "Test Table" (không heading) hiện title; "Trilium System Notes" (có `# Trilium System Notes`)
  KHÔNG hiện inline title (chỉ còn heading).
- 2026-06-05: Property editor tương tác kiểu Obsidian (FrontmatterWidget viết lại). Header "Properties",
  mỗi prop: icon theo kiểu (text=T / list=≣ / date=🗓 / number=# / checkbox=☑), key + value
  contenteditable (Enter/blur commit), list (tags/aliases/[...]) hiện pill có nút × xoá + nút "+" thêm
  item, nút × xoá prop khi hover, "+ Add property". Mỗi thao tác parse→serialize YAML→replace block
  frontmatter [0,blockEnd]. Frontmatter giờ LUÔN render widget (bỏ reveal-raw) giống Obsidian. Có quoting
  YAML khi value chứa ký tự đặc biệt. Verify Chrome DevTools: README hiện title/created icon đúng, Add
  property ghi `property:` ra file rồi xoá sạch, Trilium System Notes hiện aliases dạng pill + add.
- 2026-06-05: Property name suggester (dropdown) kiểu Obsidian khi Add property. Server: QmdEngine
  gom frontmatter key→type toàn vault (`propMeta` map, persist/restore cùng index), endpoint
  `GET /api/properties` trả {key,type,count} sort theo count; `inferPropType` phân loại
  text/list/number/checkbox/date/datetime, core props (tags/aliases/cssclasses) luôn = list và luôn
  có trong gợi ý. Web: `api.properties()` + inject `setLivePreviewPropertyProvider`; nút "+ Add property"
  mở input + dropdown lọc theo tên (loại key đã có), chọn gợi ý tạo prop đúng kiểu (list→pills). Fix:
  readProps loại trừ `.prop-newrow` (trước bị commit nhầm cả tên đang gõ). Verify Chrome DevTools:
  /api/properties trả 76 key (created 5938, aliases 5937…), dropdown lọc "tag"→tags/tag/taskTagNote,
  chọn "source" thêm đúng 1 prop ra file rồi xoá sạch. Phải xoá data/qmd-index.json + reindex để có propMeta.
- 2026-06-05: Hoàn thiện 3 mục còn lại. (1) Ổn định server: tắt minisearch `autoVacuum` (nguồn crash
  TreeIterator.dive khi discard/replace) ở newIndex + loadJSON; thêm guard process uncaughtException/
  unhandledRejection (log, không chết). (2) Table handle: thanh chọn cột (mép trên th) + hàng (mép trái
  ô đầu) — hover highlight cả cột/hàng (.cm-cell-hl), click mở menu format đúng phạm vi. (3) Property
  type registry kiểu Obsidian: service đọc/ghi `.obsidian/types.json` (format {types:{key:type}},
  text/multitext/number/checkbox/date/datetime/tags/aliases) + route GET/POST `/api/property-types`;
  web inject registry, chuột phải key/icon → menu "Property type" (6 kiểu, ✓ kiểu hiện tại) + Copy value
  + Remove; đổi kiểu persist types.json, nếu đổi list-ness thì convert YAML scalar↔list rồi commit, còn
  lại đổi icon tại chỗ. Verify Chrome DevTools: menu hiện đủ + ✓ Date&time cho created; đổi title→List ghi
  types.json {"title":"multitext"} + YAML thành list, revert→Text sạch; handle highlight 3 ô + mở menu.
- 2026-06-05: Value input theo property type (như Obsidian). `makeScalarField(dt,value)` dựng control
  đúng kiểu: text=span contenteditable, number=`<input type=number>`, checkbox=`<input type=checkbox>`,
  date=`<input type=date>`, datetime=`<input type=datetime-local>`. Mỗi field giữ `dataset.raw` =
  giá trị YAML chuẩn (readProps đọc raw → field không đụng tới không bị ghi đè, vd timestamp
  `…:48.273Z` giữ nguyên khi chỉ hiện `19:23`). Đổi kiểu scalar↔scalar swap control tại chỗ (fix: trước
  chỉ đổi icon). Verify Chrome DevTools: created→datetime picker (raw giữ giây/Z), dateNote (Obsidian set
  datetime trong types.json) cũng ra datetime picker — interop 2 chiều; cycle dateNote qua
  number/checkbox/date/text/datetime input đổi đúng; README sạch, types.json khớp.
- 2026-06-05: List property (tags…) sửa/thêm value kiểu Obsidian. Pill giờ contenteditable (click sửa,
  blur commit) + nút × xoá; nút "+" mở ô gõ + dropdown gợi ý value (tag vault qua `setLivePreviewTagProvider`
  → /api/tags, 1302 tag), lọc realtime, chọn hoặc Enter để thêm. Bỏ cap 12 ở Add-property suggester (giờ
  hiện hết ~72 key, cuộn được) — sửa khiếu nại "props ít". Dropdown value dùng position:fixed append body,
  anchor dưới input bằng getBoundingClientRect (sửa lỗi UI: trước bị đẩy xuống tạo khoảng trống + dropdown
  văng sang phải). flushActive trong mutate để không mất edit dở khi có thao tác khác. Verify Chrome
  DevTools: gap 0px, dropdown thẳng dưới input, lọc "linu"→linux/linuxjournal, chọn→`tags: - linux` ra
  file, sửa pill linux→linuxedit persist, xoá sạch; Add-property dropdown 72 mục.
- 2026-06-05: Graph view chuyển từ modal độc lập → mở trong workspace tab như Obsidian (sentinel
  path `graph://view`, render trong Workspace khi activePath là graph; setGraph/openGraph thêm-hoặc-
  kích-hoạt tab, lưu cùng workspace state). Thêm panel Filters overlay kiểu Obsidian (collapse từng
  section): Filters (search files, Tags/Attachments/Existing files only/Orphans toggle), Groups
  (New group: màu + query → tô node khớp), Display (Arrows, Text fade, Node size, Link thickness,
  Animate), Forces (Center/Repel/Link/Link distance slider 0..1 map sang d3-force). Backend mở rộng
  `graphData()`: trả node kèm `kind` (note/attachment/unresolved) + `tags`, sinh node attachment cho
  embed file đính kèm và node unresolved cho wikilink chưa có file → toggle hoạt động thật;
  buildLinkGraph lưu thêm rawLinks + tags. graphSettings persist qua /api/uistate. typecheck + build
  web sạch (414 modules).
- 2026-06-05: Fix Tags toggle gây trắng trang. Nguyên nhân: server 8787 đang chạy bản dist CŨ
  (chưa có tags) → `n.tags` = undefined; client làm `for (const tag of n.tags)` ném "undefined is not
  iterable" đồng bộ trong useEffect → React unmount cả cây (trắng, refresh không cứu vì tags:true đã
  persist). Sửa client: guard `n.tags ?? []` + bỏ qua node không tags, phân giải link sang tham chiếu
  node-object (loại bỏ khả năng forceLink ném "missing node"), bọc toàn bộ build trong try/catch →
  hiện overlay "Reset filters" thay vì trắng trang. Rebuild server (tsc) + restart `node
  server/dist/index.js` (PORT=8787 DATA_DIR=./data ALLOWED_ROOTS=/Users/xnohat; vault thật từ
  settings.json, log "sample-vault" là defaultVaultPath gây hiểu nhầm). Verify qua CDP (port 9223) trên
  vault thật: /api/graph trả 22718 node kèm kind+tags (3085 node có tag), bật Tags → tagsOn=true, KHÔNG
  lỗi/không crash, orphan 2533→1213 (note nối vào tag node). typecheck + build web+server sạch.
- 2026-06-05: Fix hiệu năng — server ghim ~88% CPU liên tục + Files panel kẹt "Loading...". 3 nguyên
  nhân O(toàn vault) chạy lặp: (1) chokidar KHÔNG ignore `.obsidian` → app Obsidian mở cùng vault ghi
  workspace.json/state liên tục → mỗi event broadcast `fs` → client refetch cả tree. (2) `listTree`
  `fs.stat()` từng file → 27k syscall mỗi lần fetch tree (UI không dùng size/mtime). (3) onChange + API
  reindex gọi `buildLinkGraph()` đọc+parse lại toàn bộ 5938 note mỗi lần 1 file đổi. Sửa: ignore
  `.obsidian` trong watcher; bỏ `fs.stat` trong listTree (chỉ dùng dirent); thêm
  `updateLinkGraphForFile(rel, removed)` cập nhật graph TĂNG TIẾN 1 file (watcher onChange + reindex
  của PUT content/rename/delete đều dùng; agent + /api/reindex vẫn full vì hiếm). Verify CDP trên vault
  thật: CPU 88%→0% idle, /api/files/ ~190ms, Files panel hết "Loading" (38 row). RSS ~1.1GB ổn định
  (MiniSearch + index, không tăng). typecheck + build server sạch.
- 2026-06-05: Graph nâng chất lượng + tương tác theo phản hồi (so Obsidian). (1) Click TAG node →
  search notes: store thêm `searchFor(q)` (set leftPanel=search + searchQuery), SearchPanel adopt
  searchQuery; GraphView onUp: note→openFile, tag→`searchFor('tag:'+name)`. Verify API: tag:license→50
  hits (note đầu "12min Lifetime License" khớp Obsidian), tag:Android→40. (2) Zoom mượt: bỏ React
  onWheel (passive, preventDefault bị bỏ qua) → native listener {passive:false}, scale liên tục
  `exp(-deltaY*speed)` thay vì bước cố định 1.1×; ctrlKey=pinch amplify. (3) Đồ hoạ sắc nét hơn: node
  radius đổi sang sqrt `(1.5+√deg*0.9)*(0.4+size)` (hết blob khổng lồ), thêm viền nền quanh node tách
  bạch, edges nhạt hairline (alpha 0.18+), label có halo nền (strokeText) dễ đọc. (4) Hiệu năng zoom:
  cull edge ngoài viewport (skip nếu 2 đầu cùng phía ngoài màn hình). typecheck + build web sạch.
- 2026-06-05: Graph layout & label fade theo phản hồi: (1) tăng lực đẩy (charge −66→−120), hub đẩy
  mạnh theo √deg, link dài hơn (67→100), distanceMax 480→1400, center nhẹ hơn, collide theo bán kính
  thật → graph nở thoáng, hết "hairball". (2) Line mảnh lại + đậm màu (đổi sang --text-faint, alpha
  ~0.7). (3) Label fade theo zoom (hub hiện trước, note nhỏ chỉ hiện khi zoom gần) thay vì hiện hết.
- 2026-06-05: Đổi renderer graph từ canvas-2D (CPU) sang **PixiJS WebGL (GPU)** như Obsidian (user
  chọn). Pixi v8 dynamic-import (chunk 246KB gzip, chỉ tải khi mở graph; bundle chính vẫn ~40KB).
  Kiến trúc: node = Sprite (texture tròn dùng chung, tint theo màu/nhóm, scale theo bán kính), edges =
  Graphics, label = lớp Text screen-space riêng (pool ≤400, halo nền, fade theo zoom). Pan/zoom = biến
  đổi camera trên world Container (world.position/scale) → KHÔNG vẽ lại hình học, mượt bất kể số node;
  chỉ vẽ lại geometry khi sim tick. Render on-demand (ticker.stop + app.render qua rAF batch). Giữ
  nguyên d3-force + panel Filters/Forces + click tag→search. Verify CDP vault thật: WebGL context sống
  (không lost), 0 lỗi console, scene rebuild đúng khi đổi filter (tags off→1258 node), screenshot xác
  nhận vẽ node/edge/label sắc nét. typecheck + build web sạch.
- 2026-06-06: Tinh chỉnh graph WebGL khớp Obsidian (qua nhiều vòng screenshot CDP): (1) Node size:
  sqrt CÓ CAP `(3+min(√deg,11))*(0.45+size)` → hub tag chỉ ~3.5× note (trước ~9×, blob khổng lồ),
  note có base nhìn rõ. (2) Label: ngưỡng theo bán kính màn hình hạ thấp + **greedy tránh chồng**
  (sort hover→deg, bỏ label nào đè label đã đặt, tối đa 220) → label sạch như Obsidian, hiện đúng tầm
  zoom thay vì hiện muộn/đè nhau. (3) Auto-fit theo VÙNG LÕI (median center + percentile 82% bán kính,
  bỏ outlier cụm orphan bay xa) → mức zoom mặc định hợp lý, không co graph thành chấm giữa màn hình;
  fit định kỳ khi đang dàn, dừng khi user pan/zoom. (4) Edge giữ ĐỘ DÀY CỐ ĐỊNH trên màn hình
  (width=base/k, vẽ lại khi zoom; pan vẫn thuần transform) → hết bị thành thanh xám to khi zoom sâu.
  Verify CDP nhiều mức zoom: line mảnh đều, label rõ không chồng (note+tag), node cân đối, tag cyan
  click→search. typecheck + build web sạch.
- 2026-06-06: Label theo phản hồi "hiện muộn + mờ": hạ ngưỡng rMin (1.1−fade) → label hiện ngay ở mức
  zoom fit mặc định; font 11→13 + fontWeight 600 + màu --text-normal (đậm/đen) + halo width 4 + ramp
  alpha nhanh → hết mờ. Verify CDP: ở cả mức fit lẫn zoom +2, label đậm-đen-to, không chồng (greedy
  vẫn tránh đè), hiện đầy đủ tag + tên note như Obsidian.
- 2026-06-06: Label fade mượt theo zoom như Obsidian: nới vùng ramp alpha (over ~4.5px bán kính màn
  hình) → label hiện mờ ở zoom xa rồi từ từ rõ dần khi zoom vào, hub rõ trước, note nhỏ rõ sau. Verify
  CDP: mức fit label mờ/đa cấp opacity, zoom +4 label rõ-đậm hoàn toàn.
- 2026-06-10: Navigation back/forward kiểu Obsidian (M9.10). Store thêm history stack (`history`/
  `histIndex`, cap 100) + `goBack`/`goForward`; openFile/openGraph push entry qua `pushHistory` (cắt
  nhánh forward, bỏ qua khi đang replay nhờ cờ `navByHistory`). View-header giờ render cho MỌI view
  (trước chỉ markdown) với 2 nút ←/→ góc trái, disabled+mờ khi hết chỗ lùi/tới; Graph view cũng có
  toolbar. Icon thêm arrow-left/arrow-right. typecheck cả 2 workspace + build web sạch.
- 2026-06-10: Search panel thêm filter/sort + sticky (M9.11). Khung query (input + nút match-case
  "Aa" + clear + options) gộp 1 box bo viền, `.search-head` `position: sticky; top:0` trong
  `.sidebar-body` → KHÔNG trôi khi cuộn kết quả (fix khiếu nại). Options panel (toggle qua nút
  sliders): Collapse results (ẩn snippet), Show more context (bỏ line-clamp). Dropdown Sort:
  Relevance (mặc định = thứ tự server) / File name A→Z / Z→A / Path — sort client-side. Match case
  lọc client theo free-text (bỏ operator tag:/path:). Nâng limit 50→100. Lưu ý: sort theo Modified/
  Created time CHƯA làm — search index không lưu mtime/ctime, cần thêm field server + reindex.
  typecheck + build web sạch. Chưa verify live (browser profile CDP đang bị chiếm).
- 2026-06-10: Bỏ cap cứng 100 kết quả search (phản hồi "tại sao luôn 100?"). Server: route bỏ
  Math.min(...,100), `limit<=0`/omitted → trả MỌI match; QmdEngine.search slice chỉ khi limit>0
  (agent API vẫn truyền limit nên không đổi). Client: api.search bỏ default 100 (gọi không limit),
  SearchPanel render TĂNG DẦN 50/lần qua IntersectionObserver (sentinel + rootMargin 300px), reset
  về 50 khi đổi query/sort/match-case, hiện "Showing X of Y…". Đếm giờ đúng tổng thật. Verify API
  trên vault thật: q=nginx → 166 hit (trước cắt 100), limit=100 vẫn cap 100. Restart server dist mới.
  typecheck + build web+server sạch.
- 2026-06-10: Fix khe hở phía trên khung search (kết quả lú ra trên ô tìm). Bỏ `position: sticky`
  trên `.search-head` (sticky trong `.sidebar-body` có padding-top → khe). Thay bằng layout cố định:
  `.search-panel` height 100% flex-column, `.search-head` flex-shrink:0 (đứng yên), `.search-results`
  flex:1 + overflow-y:auto tự cuộn riêng → đầu danh sách không thể đè lên khung. IntersectionObserver
  đổi root sang `.search-results` (ref) thay vì viewport. typecheck + build web sạch.
- 2026-06-10: Phase 16 (FR-10) — deep-link URL + public share. URL `/note/<path>` sync 2 chiều
  với tab đang mở (module `web/src/lib/urlsync.ts`: pushState khi đổi note, popstate → openFile,
  lần sync đầu replaceState; deep-link thắng workspace restore). Share public: `data/shares.json`
  (1 record/note, token 16-byte base64url), `/api/shares` CRUD + toggle enabled, `/public/shares/:id`
  trả {title, content} không lộ path, `/public/shares/:id/file` chỉ serve đúng file note nhúng
  (`![[...]]`/`![](...)`, resolve theo basename như files API, chặn `.md`). Trang `/share/<id>`
  render Reading view standalone (main.tsx branch trước App, không auth), wikilink trơ. UI: context
  menu "Copy public link" (FileTree), Settings → tab Sharing (search, Copy link, Disable/Enable,
  Delete; click path mở note). Rename note tự cập nhật share path. Verify end-to-end qua curl
  (401 file API vs 200 public, allowlist 404, disable→404, re-enable→200) + Chrome (trang share
  render ảnh nhúng trong context cô lập không cookie; deep-link mở đúng note; browser Back đổi note;
  tab Sharing hiển thị đủ controls). Typecheck + build sạch.
- 2026-06-10: M16.5 — password riêng cho từng share link. Server: `ShareRecord.passwordHash`
  (scrypt, tái dùng hash/verify của auth service; không bao giờ trả hash — API trả `hasPassword`),
  PATCH /api/shares/:id nhận {password: string|null} (set/xoá), POST /public/shares/:id/unlock
  đổi password lấy JWT cookie httpOnly scope `/public/shares/:id` TTL 12h (ảnh nhúng tự gửi cookie);
  GET content/file trả 401 {passwordRequired} khi chưa unlock. Web: PublicNote thêm form unlock
  (sai password báo lỗi, đúng → render); tab Sharing thêm nút "Password…/Password ✓" (prompt đặt/
  đổi/xoá) + badge "password-protected". Verify curl (set→401→unlock sai 401→unlock đúng→cookie
  →200 content+file, xoá password→200 lại, shares.json mode 600 chứa scrypt hash) + Chrome context
  cô lập (form hiện, sai báo lỗi, đúng mở note + ảnh load, tab Sharing đúng trạng thái).
- 2026-06-10: M16.6 — SSR + SEO cho trang share public. Server render `GET /share/:id` thành HTML
  hoàn chỉnh (route `sharepage.ts` mount trước static): nội dung note nằm ngay trong HTML (Google
  indexable, không cần JS), head đủ title / meta description (strip markdown ~160 ký tự) / canonical /
  og:type=article + og:site_name + og:title/description/url/image (ảnh đầu tiên note nhúng — URL
  tuyệt đối qua endpoint public, hoặc ảnh web đầu tiên) / twitter:card summary_large_image. Render
  bằng service `renderhtml.ts` — port pipeline unified/remark/rehype+sanitize từ web (giữ sync),
  deps thêm vào server workspace; CSS bundle của SPA được inline nên giao diện khớp Reading view.
  Share có password → SSR form unlock (noindex, không lộ nội dung/metadata; inline JS POST unlock
  rồi reload); cookie unlock đổi path '/' để cả /share/:id lẫn /public/shares/:id đều nhận. Bỏ trang
  React PublicNote (SSR thay thế), vite proxy thêm /share. Verify curl: locked → noindex + không leak,
  mở khoá → đủ meta + content + img + CSS inline, id sai → 404 noindex; Chrome context cô lập: form
  unlock sai báo lỗi, đúng → reload ra note y hệt Reading view. Typecheck + build sạch.
- 2026-06-10: Graph view — sửa layout lệch xa Obsidian (đồ thị bị tãi thành sợi, cụm rời bay
  tứ tán, hub tag thành "bồ công anh" gai): (1) thay `forceCenter` (chỉ tịnh tiến trọng tâm,
  không hút) bằng gravity thật `forceX`+`forceY` map theo slider Center force; (2) link strength
  chuyển sang adaptive kiểu d3 mặc định `slider/min(deg)` để cụm quanh hub nén thành đĩa đặc;
  (3) cap hệ số repel theo bậc (hub ~2× leaf thay vì ~8×) + distanceMax 900; (4) khởi tạo vị trí
  bằng xoắn ốc phyllotaxis thay vì cả 5.4k node trên một vòng tròn r=250; (5) link distance mặc
  định 100→50, alphaDecay 0.02; (6) node tag đổi màu xanh lá kiểu Obsidian. Verify Chrome trên
  vault thật 5.9k note: đồ thị tụ thành khối cầu liên kết với tag xanh phân bố đều, label/zoom
  ổn, console sạch. Typecheck + build sạch.
- 2026-06-10: Phase 17 (PRD 0.3) — pane menu (⋯) + đại tu Right sidebar theo phản hồi "thiếu menu
  3 chấm + thiếu chức năng sidebar phải". (1) Nút ⋯ "More options" trên view-header MỌI view:
  note = Split right/Split down + Bookmark + Copy public link + Make a copy + Rename/Move/Copy
  path/Delete + Close tab/Close other tabs; Graph = Copy screenshot (extract Pixi stage → PNG
  composite nền theme → clipboard; cần render lại vì WebGL không preserveDrawingBuffer) + Close
  tab. (2) Split pane 2 hướng: `splitDirection` right/down persist trong uistate, `.editor-area.
  split-down` flex-column. (3) Right sidebar thành tab strip icon kiểu Obsidian: Backlinks
  (Linked mentions + **Unlinked mentions**) · Outgoing links (resolved/unresolved, lọc attachment
  khỏi unresolved để không tạo nhầm note .md) · Tags (tái dùng TagsPanel, click → search tag:x
  đúng query) · Outline; `rightPanel` persist + sync. (4) Server: `/api/search/matches` thêm
  `phrase:true` → match cả cụm (unlinked mentions chính xác như Obsidian thay vì OR từng từ —
  verify curl: phrase=0 hit vs word-based=1679 trên cùng note). Icon mới: more-horizontal/rows/
  list/arrow-up-right/camera. Verify CDP trên vault thật: menu ⋯ note đủ 11 mục, Split down ra
  pane dưới có header+close, Copy screenshot → clipboard chứa image/png, tab strip đổi panel,
  unlinked mentions 30→0 sau phrase fix (title dài không xuất hiện verbatim), rightPanel khôi
  phục sau reload. Typecheck + build web+server sạch; restart server dist mới. Lưu ý môi trường:
  client cũ (bundle trước) của user đang mở /graph liên tục đẩy uistate ghi đè khi test — không
  phải bug code mới.
- 2026-06-10: Graph view — đồng bộ slider với đơn vị/mặc định gốc của Obsidian app: Text fade
  -3..3=0, Node size 0.1..5=1, Link thickness 0.1..5=1, Center force 0..1=0.52, Repel force
  0..20=10, Link force 0..1=1, Link distance 30..500=250 (map nội bộ về tham số d3 đã calibrate
  để mặc định cho ra layout như bản tune). Panel Filters mặc định collapsed — chỉ hiện cog icon
  như Obsidian. Migration: graphSettings cũ (thang 0..1) persist server-side được detect qua
  linkDistance ≤ 1 → reset display/forces về mặc định mới, giữ filters/groups. Verify Chrome:
  panel đóng + cog, mở panel slider đúng min/max/value, layout giữ khối cầu. Typecheck + build sạch.
- 2026-06-10: Graph view — port CHÍNH XÁC physics của Obsidian app bằng cách reverse-engineer
  obsidian.asar cài trên máy (sim.js = d3-force chạy trong worker + WASM, app.js = panel/renderer):
  charge = -repelSlider³ (mặc định 10 → -1000, distanceMin 30, theta .9, KHÔNG distanceMax);
  link distance = slider nguyên gốc (250); link strength = slider × 1/min(deg) (adaptive d3);
  gravity forceX/Y với strength = MJ easing (0.01^(1-e)-0.01)/0.99 → 0.52 ⇒ 0.1; collide bán kính
  cố định 60 strength 0.5; alphaDecay 1-0.001^(1/300); velocityDecay 0.4. Node radius theo
  getSize() của Obsidian: nodeSize × clamp(3√(deg+1), 8, 30). Cạnh vẽ độ dày cố định theo màn hình
  (lineSizeMult/scale) màu nhạt; node note màu xám (không phải accent). Kết quả: đồ thị co thành
  hình cầu một khối như app. Verify Chrome vault 5.9k note + typecheck/build sạch.
- 2026-06-10: Graph view — hoàn tất parity render với Obsidian app (đào tiếp renderer trong
  app.js): (1) node vẽ theo luật nodeScale = √(1/zoom) của Obsidian — bán kính màn hình =
  getSize()·√k nên zoom out node vẫn to gần chạm nhau thành đĩa tổ ong đặc, cạnh chìm phía sau
  (trước đó node co tuyến tính theo zoom → teo mất, chỉ còn thấy cạnh thành chùm "pháo hoa");
  (2) label dùng fade toàn cục textAlpha = clamp(log₂(zoom) − textFade, 0, 1) như app (mặc định:
  bắt đầu hiện sau zoom 1×, rõ hẳn ở 2×) thay vì ngưỡng theo bán kính từng node; (3) hit-test
  hover/click + mũi tên + nhân scale hover đồng bộ theo bán kính màn hình mới. Không copy code
  Obsidian — chỉ trích hằng số/công thức và viết lại trên d3-force (BSD). Verify Chrome side-by-side
  với app trên cùng vault: khối cầu cụm đặc tương đồng. Typecheck + build sạch.
- 2026-06-10: Reverse engineering toàn diện Obsidian Desktop 1.12.7 (extract obsidian.asar:
  app.js 3.6MB, app.css 588KB, main.js, worker.js, sim.js) bằng 4 agent song song. Ghi tri thức
  vào docs/obsidian-desktop-internals.md (22 mục): regex chính xác Markdown dialect (wikilink/
  callout/tag/block-id/footnote), luật link resolution 6 bước, schema đầy đủ .obsidian/* +
  workspace.json + graph.json + .canvas + .base, grammar search operators, thuật toán fuzzy có
  công thức điểm, hằng số d3-force graph (velocityDecay 0.6, repel −slider³, slider curve),
  cơ chế Live Preview/reading view (DOMPurify config, embed depth ≤5), 196 command id + hotkey
  mặc định, registry 31 core plugins, toàn bộ CSS design tokens 2 theme + DOM class + bảng
  14 nhóm callout. Dùng làm tài liệu gốc khi clone tính năng về sau.
- 2026-06-10: Graph view — sao chép hành vi viewport của Obsidian app: khởi tạo scale = 1 theo
  DEVICE pixel (CSS k = 1/devicePixelRatio), tâm spawn đặt giữa khung, KHÔNG auto zoom-to-fit
  (bỏ fitView chạy theo tick — chính nó làm mức zoom hai bên lệch nhau nên cùng một node thấy
  mật độ/khoảng cách khác nhau); node spawn "big bang" từ đĩa phyllotaxis nhỏ ở tâm và nở ra
  như app. Bật lại Orphans trong uistate đã lưu (mặc định Obsidian = on; 2.289 orphan lấp đầy
  khoảng trống giữa các cụm — thiếu chúng nên trước đó nhìn "rỗng" hơn app). Sau sửa: cùng mức
  zoom, khoảng cách node/cỡ node trùng app vì physics + luật render + viewport đều giống nhau.
  Verify Chrome zoom vào hub #FRT so với app. Typecheck + build sạch.
- 2026-06-10 (tiếp): Graph view — hoàn tất parity zoom/spacing/typography với Obsidian app
  (đào tiếp app.js + đọc toàn bộ sim.js): (1) mọi luật scale chuyển sang DEVICE pixel như app
  (bán kính node màn hình = getSize·√scale_device → trên Retina node nhỏ lại √dpr, khoảng cách
  cụm khớp app); (2) wheel zoom đúng công thức app: target ×= 1.5^(−ΔY/120), clamp [1/128, 8],
  zoom-in neo cursor / zoom-out neo tâm, scale lerp 15%/frame (mượt như app); (3) label theo
  đúng renderer app: fontSize 14 + getSize()/4, font stack ui-sans-serif…, scale = nodeScale
  (co theo √zoom như node), offset (getSize+5)·nodeScale, hover không nhỏ hơn 1/scale;
  textAlpha = clamp(log₂(scale_device) + 1 − fade, 0, 1) (trước thiếu +1 và dpr → label hiện
  muộn 4×); bỏ greedy declutter tự chế (app không có); (4) cạnh dày đúng lineSizeMult DEVICE px
  (trước dày gấp dpr lần), mũi tên fade theo clamp(2·(scale−0.3),0,1), size 2√mult/scale;
  (5) hover fade kiểu app: node/cạnh không nối với node hover mờ dần về alpha 0.2 (lerp 0.9/frame),
  cạnh nối đổi màu highlight; bỏ phóng to 1.25 khi hover (app không phóng); (6) sim.alpha(0.3)
  khi đổi forces (app post alpha .3); thêm hook window.__graphCam cho automated UI test.
  Verify trên Chrome vault thật 5.9k notes: khối cầu + vòng orphan tổ ong, label hiện đúng
  ngưỡng scale ~0.5–1, hover dim chuẩn, console sạch, typecheck + build sạch.
- 2026-06-11: Phase 20 (PRD 0.5) — Graph "Find node": ô search nổi góc trên-trái canvas, keyword
  match trên node đang hiển thị (label/path, AND mọi từ, rank tag-first>prefix>label>path+degree, top 50,
  kind tô màu tag xanh/attachment vàng/unresolved mờ + path phụ); click/Enter → flyTo: camera
  lerp pan+zoom 15%/frame (chung nhịp updateZoom Obsidian) về node ở scale ≥2, setHover highlight
  accent + dim không-liên-kết tới khi di chuột; wheel/drag hủy fly; Esc/clear đóng list. Verify
  CDP vault thật: gõ "docker" 50 kết quả đúng rank, click bay tới node centered scale 2.0, query
  tự xoá, console sạch. Typecheck + build sạch. PRD bump 0.5 (FR-2).
- 2026-06-11: M16.7 — Share dialog per-note + globe badge (phản hồi: "Copy public link" không cho
  biết note đã share). Component `ShareDialog.tsx` (modal): chưa share → nút Create public link;
  đã share → toggle pill bật/tắt, ô URL + Copy, Set/Change password, Delete link. Store thêm
  `shares` cache + `loadShares()` + `shareDialogPath` (load sau login, refresh sau mỗi thao tác);
  Settings → Sharing chuyển sang dùng store nên badge đồng bộ mọi nơi. Context menu file tree và
  menu ⋯ pane đổi item thành "Share…" (icon globe) mở dialog. File tree: note có share enabled hiện
  icon globe màu accent cạnh tên. Icon `globe` thêm vào bộ Lucide. Verify headless Chrome qua CDP
  (MCP bị phiên khác giữ): badge hiện đúng note share + màu accent, menu có "Share…", dialog mở đủ
  controls (URL đúng token, toggle on, Set password…, Delete). Typecheck + build sạch.
