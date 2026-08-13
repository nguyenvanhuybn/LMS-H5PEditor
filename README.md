# H5P Studio — Nền tảng biên soạn & phát nội dung H5P tự host

Hệ thống tự host để **tạo, chỉnh sửa, chạy nội dung H5P**, ghi nhận kết quả xAPI,
và **xuất gói SCORM 1.2 / SCORM 2004 / xAPI** cho LMS bên ngoài. Giao diện và
editor hỗ trợ song ngữ Việt/Anh đầy đủ, kể cả bên trong iframe H5P.

> **Tài liệu này là bản bàn giao.** Nó được viết để một người mới — hoặc một AI
> agent — đọc xong là nắm được kiến trúc, bản đồ mã nguồn, cách chạy, cách deploy,
> và quan trọng nhất: các cạm bẫy đã tốn nhiều công sức mới tìm ra. **Đọc mục
> "Cạm bẫy đã gặp" trước khi sửa bất kỳ dòng nào.**

## Trạng thái bàn giao

| Hạng mục | Giá trị |
|---|---|
| Server production | `http://10.0.0.120:8081` (Ubuntu, Docker Compose) |
| Thư mục trên server | `/home/haivn/lms-h5p-editor` |
| Compose project | `lms-h5p` (đã ghim trong `deploy.sh` — **không được đổi**, xem Cạm bẫy #9) |
| SSH | user `haivn` — mật khẩu bàn giao riêng, **không có trong repo** |
| Git remote | `github.com/nguyenvanhuybn/LMS-H5PEditor`, nhánh `main` |
| Sao lưu gần nhất | `/home/haivn/h5p-backups/<timestamp>/` và `deploy/ubuntu/backups/<timestamp>/` |

**Việc đầu tiên nên làm khi nhận bàn giao:** cả máy dev lẫn server đang có nhiều
thay đổi **chưa commit** (đồng bộ với nhau bằng copy file, đã so checksum khớp).
Hãy `git add -A && git commit` ở một trong hai nơi rồi push, để từ đó deploy bằng
`git pull` thay vì chép tay.

## Kiến trúc

```text
Trình duyệt ── http://10.0.0.120:8081 (nginx, container `proxy`)
                 │  /            → web  (Next.js 16, port 3000 nội bộ)
                 │  /backend/    → api  (ASP.NET Core 8, port 8080 nội bộ)
                 │  /h5p-engine/ → h5p-engine (Node sidecar, port 3001 nội bộ)
                 ▼
   Next.js ──REST──▶ ASP.NET Core ──SQLite──▶ metadata + điểm (volume api-data)
                        │  HTTP                    ▲
                        ▼                          │ webhook + secret
                    H5P Engine (@lumieducation/h5p-server) ── volume h5p-data
```

- **ASP.NET Core** là backend nghiệp vụ: đăng ký nội dung, điều kiện hoàn thành,
  ghi kết quả, build gói SCORM/xAPI, API tích hợp cho LMS ngoài.
- **H5P Engine** là sidecar Node vì không có H5P Core/Editor chính thức cho .NET.
  Biên HTTP giữ mã GPL của engine tách khỏi ứng dụng LMS (xem License).
- **Next.js** phục vụ UI và giữ khoá tích hợp **phía server** (Route Handlers) —
  trình duyệt không bao giờ thấy `INTEGRATION_API_KEY`.

Luồng chính:

1. **Biên soạn**: web nhúng iframe `/h5p-engine/edit/:id?uiLanguage=vi` → engine
   render editor (đã Việt hoá) → lưu xong callback về web → web đăng ký metadata
   với API.
2. **Chạy trong Studio**: iframe `/h5p-engine/play/:id` → engine relay xAPI về
   API qua webhook (kèm secret) → API chấm theo Điều kiện hoàn thành → ghi SQLite
   (→ tuỳ chọn chuyển tiếp lên LRS ngoài).
3. **Chạy trong LMS ngoài**: gói zip (wrapper) nhúng player qua iframe, nhận xAPI
   qua `postMessage`, tự chấm theo quy tắc đã nhúng, rồi ghi vào **SCORM API của
   LMS** hoặc POST thẳng tới **LRS** — mặc định không gọi ngược về Studio.

## Bản đồ mã nguồn

| File | Vai trò |
|---|---|
| `services/h5p-engine/src/index.js` | **Trái tim engine** (~1.500 dòng): mọi route (`/play`, `/edit`, `/new`, `/h5p/ajax`, `/temp-files`, `/api/*`), middleware ajax (khử trùng lặp `language`, dịch response), `wrapEditorHtml` (Việt hoá + vá `ajaxPath`), `renderPlayerHtml`, script xAPI tiêm vào player, xử lý origin nhúng |
| `services/h5p-engine/src/localize-content.js` | Bộ dịch runtime: `localizeParams` (dịch chuỗi UI trong params nội dung), `localizeSemantics` (dịch semantics editor), `loadCatalog` |
| `services/h5p-engine/translations/runtime/vi.json` | **Catalog ~1.400 cặp Anh→Việt** — nguồn sự thật duy nhất của mọi bản dịch runtime. Thêm chuỗi vào đây là đủ, không sửa code |
| `services/h5p-engine/translations/metadata-semantics/vi.json` | Bản dịch form metadata (Tiêu đề, Giấy phép…) |
| `services/h5p-engine/h5p/editor/language/vi.js` | Bản dịch khung editor H5P (nút, thông báo chung) |
| `services/h5p-engine/scripts/` | `sync-libraries` / `pack-libraries` / `restore-libraries` — đóng gói content type theo phiên bản |
| `apps/api/Program.cs` | Toàn bộ endpoint Minimal API: contents, completion, webhook xAPI, integration (results/lms-origins/package) |
| `apps/api/Services/PackageBuilder.cs` | **Sinh gói SCORM/xAPI**: `imsmanifest.xml`/`tincan.xml`, `index.html`, `h5p-launcher.js` (vòng đời + chấm hoàn thành + suspend_data), 3 adapter (SCORM 1.2 / 2004 / xAPI) |
| `apps/api/Services/CompletionEvaluator.cs` | Chấm lại `completed`/`success` theo quy tắc — dùng chung cho webhook |
| `apps/api/Services/H5pEngineClient.cs` | Gọi engine server-to-server, dựng URL launch |
| `apps/api/Data/AppDatabase.cs` | SQLite + migration idempotent (`pragma_table_info` trước khi `ALTER TABLE`) |
| `apps/web/lib/i18n.ts` | Từ điển UI web (vi/en), cookie locale |
| `apps/web/lib/api.ts` | `apiFetch`, kiểu `ContentItem`, `saveCompletionRule` |
| `apps/web/components/H5pEditorFrame.tsx` | Nhúng iframe editor, truyền locale |
| `apps/web/components/CompletionRuleFields.tsx` | Editor quy tắc hoàn thành dùng chung + danh sách `POSITION_CAPABLE` (đã xác minh từ mã nguồn library) |
| `apps/web/components/PackageDownloadModal.tsx` | Hộp thoại xuất gói: định dạng + điều kiện hoàn thành + origin |
| `apps/web/app/api/packages/*` | Route phía server giữ `X-Api-Key` — trình duyệt không thấy khoá |
| `deploy/ubuntu/` | `docker-compose.yml`, `nginx.conf`, `deploy.sh`, `.env` (secret — không commit) |

## Chạy local

Yêu cầu: .NET SDK 8, Node.js 20+, npm 10+. Docker chỉ cần khi build image.

```powershell
npm run bootstrap    # lần đầu: cài dependency web + engine (hai cây tách biệt)
npm run dev          # chạy đồng thời API (5050) + engine (3001) + web (3000)
```

- Giao diện: http://localhost:3000 — API: http://localhost:5050/health — Engine: http://localhost:3001/health
- Trình duyệt luôn đi qua proxy cùng origin `http://localhost:3000/h5p-engine`;
  cổng 3001 chỉ để kiểm tra trực tiếp.
- Biến môi trường dev nằm ngay trong `package.json` (script `dev:h5p`, `dev:web`).
  Đổi biến của engine = sửa script đó và chạy lại `npm run dev`.
- Lần đầu tạo nội dung, editor lấy danh sách content type từ H5P Hub (cần
  Internet); catalog gần nhất được cache trong `h5p/cache.json`.

## Triển khai lên server

```bash
ssh haivn@10.0.0.120
cd /home/haivn/lms-h5p-editor
git pull                       # sau khi đã commit như khuyến nghị ở đầu
./deploy/ubuntu/deploy.sh
```

`deploy.sh` làm theo thứ tự: **sao lưu 2 volume** (`lms-h5p_api-data`,
`lms-h5p_h5p-data` → `deploy/ubuntu/backups/<timestamp>/`) → build 3 image →
`up -d` → chờ health → in `embed-origins` để xác nhận. Script từ chối chạy nếu
`.env` còn secret mẫu, và đã **ghim `COMPOSE_PROJECT_NAME=lms-h5p`**.

Deploy nhanh một service (ví dụ chỉ sửa engine):

```bash
cd deploy/ubuntu
docker compose -p lms-h5p build h5p-engine && docker compose -p lms-h5p up -d h5p-engine
```

Dữ liệu sống trong named volume nên rebuild **không mất** nội dung/điểm;
migration DB idempotent nên bản mới tự thêm cột còn thiếu. Khôi phục sự cố: giải
nén `backups/<stamp>/*.tar.gz` ngược vào volume bằng một container alpine.

`.env` trên server có: `PUBLIC_ORIGIN`, 3 secret, `LMS_ORIGINS=*`, `LRS_*`.
Trên server còn các stack **khác** đang chạy (`ba_copilot` cổng 8000,
`next-ai-draw-io` cổng 3001) — đừng đụng vào.

## Đa ngôn ngữ (hệ thống phức tạp nhất — đọc kỹ)

Vấn đề gốc: H5P **không** dịch tại runtime. Chuỗi UI của content type ("Check",
"Show solution"…) bị **chép cứng vào `content.json` của từng nội dung** lúc tạo,
và bản dịch tiếng Việt upstream của H5P gần như trống (đo thực tế: 6% chuỗi
runtime, 6% nhãn editor). Giải pháp là một **catalog trung tâm**
(`translations/runtime/vi.json`, ~1.400 cặp Anh→Việt) được áp tại 4 điểm chặn:

| Điểm chặn | Ở đâu | Dịch gì |
|---|---|---|
| Player | route `/play` → `localizePlayerModel` | Chuỗi UI trong params nội dung. **Chỉ thay giá trị còn đúng bằng mặc định tiếng Anh** — văn bản tác giả tự gõ không bao giờ bị đụng. Lọc theo schema (bỏ màu, enum, mã ngôn ngữ) |
| Editor semantics | override `h5pEditor.getLibraryData` | Nhãn/mô tả/placeholder form + `default` (nội dung mới tạo ra tiếng Việt luôn), và cả trường `language`/`defaultLanguage` vì client **merge đè** chúng lên semantics sau khi tải |
| AJAX middleware | `app.use('/h5p/ajax')` trong `index.js` | (a) khử trùng lặp tham số `language` — xem Cạm bẫy #1; (b) suy ra ngôn ngữ từ `uiLanguage` khi thiếu; (c) dịch response `content-type-cache` (mô tả loại nội dung) và `translations` (file ngôn ngữ thư viện con) |
| `wrapEditorHtml` | route `/edit`, `/new` | Chèn `language=vi` vào **mọi** bản `ajaxPath` (cờ `/g` — có HAI bản trong HTML), swap `language/en.js` → `vi.js`, chuỗi chrome |

Quy tắc vận hành:

- **Thêm/sửa bản dịch**: chỉ sửa `translations/runtime/vi.json` rồi restart
  engine. Key = chuỗi tiếng Anh nguyên văn (khớp từng byte — có chuỗi chứa
  non-breaking space ` `). Giữ nguyên placeholder `@x`, `:x`, `%x`, `{x}`.
- **Thêm ngôn ngữ mới**: tạo `translations/runtime/<mã>.json` + thêm mã vào
  `H5P_SUPPORTED_LANGUAGES` và `H5p__SupportedLanguages__n`.
- Cập nhật library từ Hub **không xoá** bản dịch (catalog nằm ngoài thư mục library).
- Độ phủ hiện tại: 100% chuỗi học viên thấy + 100% editor cho 7 loại chính
  (Interactive Video, Course Presentation, Multiple Choice, Question Set,
  Fill in the Blanks, Drag the Words, Drag and Drop); các loại ít dùng thấp hơn.
- Đo độ phủ một loại: gọi
  `/h5p-engine/h5p/ajax?language=vi&action=libraries&machineName=<X>&majorVersion=<a>&minorVersion=<b>`
  và đếm nhãn có dấu tiếng Việt.

## Điều kiện hoàn thành

Menu `⋯` của nội dung → **Điều kiện hoàn thành**, hoặc đặt ngay trong hộp thoại
xuất gói (lưu trước khi build). API:

```text
PUT /api/contents/{h5pContentId}/completion
{ "mode": "Default" | "Score" | "Position", "passRatio": 0.7, "minPosition": 8 }
```

| Chế độ | Hoàn thành khi | Áp dụng |
|---|---|---|
| Theo nội dung | Đúng như H5P báo | Mọi loại |
| Theo điểm | `score.scaled` ≥ ngưỡng | Mọi loại có chấm điểm |
| Theo vị trí | Tới bước/slide ≥ N | Chỉ loại phát vị trí (bên dưới) |

Chế độ **theo vị trí** dựa trên extension xAPI `ending-point`. Danh sách hỗ trợ
**đã xác minh từ mã nguồn library** (đừng tin tài liệu H5P): Course Presentation,
Question Set, Branching Scenario, Column, Documentation Tool, Game Map,
Questionnaire, Speak the Words Set. Summary phát `progressed` nhưng không kèm vị
trí; Interactive Book chỉ phát `answered`; Interactive Video ghi vị trí dạng
thời lượng (`PT123S`) không so sánh được — cả ba bị khoá trong UI kèm giải thích.
Danh sách nằm ở `POSITION_CAPABLE` trong `CompletionRuleFields.tsx`.

Quy tắc được chấm ở **hai nơi, cùng kết quả**: webhook xAPI (ghi bảng kết quả
Studio) và `h5p-launcher.js` nhúng trong gói (báo LMS/LRS). Ở chế độ vị trí,
các bước chưa đạt ngưỡng chỉ cập nhật bookmark, không sinh dòng kết quả rác.

## Ghép nhiều loại nội dung (kiểu Articulate)

Dùng loại tổng hợp: **Course Presentation** (slide chứa văn bản/video/quiz —
tương đương Storyline), **Interactive Book** (chương/trang), **Interactive
Video**, **Question Set**, **Branching Scenario**, **Column**. Một nội dung
tổng hợp vẫn xuất thành **một gói** với **một điểm tổng hợp**; Course
Presentation dùng được cả hoàn thành theo vị trí.

## Xuất gói SCORM / xAPI

Menu `⋯` → **Tải gói tích hợp** (định dạng + điều kiện hoàn thành + origin), hoặc:

```bash
curl -H "X-Api-Key: $INTEGRATION_API_KEY" \
  "http://10.0.0.120:8081/backend/api/integration/contents/<id>/package?format=scorm2004&lmsOrigin=*" -o goi.zip
```

Gói là **wrapper nhúng iframe** trỏ về H5P Studio (4 file: `index.html`,
`h5p-launcher.js`, `h5p-adapter.js`, manifest) — không phải gói tự chứa. Vì vậy
`H5p__PublicUrl` **phải** là địa chỉ trình duyệt học viên mở được (hiện là
`http://10.0.0.120:8081/h5p-engine`).

| Định dạng | Ghi vào |
|---|---|
| SCORM 1.2 | `cmi.core.score.raw` **thang 0–100** khớp `adlcp:masteryscore`, `lesson_status`, `session_time` `HHHH:MM:SS.SS` |
| SCORM 2004 4th Ed | `cmi.score.raw/min/max` thang gốc + `cmi.score.scaled` so với `imsss:minNormalizedMeasure`, `completion_status` + `success_status`, ISO 8601 |
| xAPI (Tin Can) | POST statement tới LRS bằng `endpoint`/`auth`/`actor`/`registration` của lần khởi chạy |

Vì H5P chỉ phát verb thao tác (`answered`…), gói **tự bổ sung statement kết
luận** theo bộ mà iSpring/Articulate sinh ra: `initialized` + `attempted` khi mở,
`passed`/`failed`/`completed` (score thang 0–100, `success`, `completion`,
`duration`) theo Điều kiện hoàn thành, `terminated` khi thoát.

**Origin**: mặc định cả `Integration__AllowedLmsOrigins` và `H5P_ALLOWED_ORIGINS`
đặt `*` — mọi LMS nhúng được, hộp thoại xuất không cần chọn origin, gói tự nhận
origin nơi nó chạy (postMessage vẫn gửi tới origin cụ thể, không broadcast).
Đánh đổi: trang web bất kỳ nhúng gói sẽ nhận được kết quả học viên của trang đó.
Siết lại = thay `*` bằng danh sách origin ở **cả hai** biến (`LMS_ORIGINS` trong
`.env` deploy) rồi restart. Thiếu một trong hai là lỗi khó thấy nhất: gói vẫn
chạy, `initialized`/`terminated` vẫn có, nhưng **điểm biến mất** — vì vậy API
từ chối build gói khi engine không chấp nhận origin, và player ghi lỗi rõ ràng
ra console.

**Tiếp tục bài dở**: tiến độ giữ ở 2 nơi — server (`h5p/user-data/`, lưu ngay
khi player báo thay đổi) và `cmi.suspend_data` của LMS (nén
`CompressionStream('deflate-raw')` + base64; hạn mức 4096 ký tự với SCORM 1.2,
64000 với 2004 — vượt thì chỉ ghi marker, resume dựa bản server). LMS quyết định
vòng đời lượt làm: không có suspend data → gói truyền `resume=0` (làm lại từ
đầu); có → `resume=1`. Rời giữa chừng: `exit=suspend`; hoàn thành: xoá suspend.

**Gói là bản đông cứng**: đổi Điều kiện hoàn thành hay nâng cấp Studio đều phải
**xuất lại + tải lên LMS lại**. Console in dòng nhận dạng bản dựng
(`H5P package runtime <version>, built <time>, completion rule {...}`) — kiểm
tra dòng này trước khi nghi ngờ hệ thống.

**Gói mặc định không gọi về Studio** (relay=0, `postUserStatistics:false`,
`set/getUserData` thay bằng bản bộ nhớ). Tích "Gửi thêm kết quả về H5P Studio"
khi xuất nếu muốn kết quả chảy song song vào `/api/integration/results`.

## LMS ngoài kéo kết quả & LRS

```text
GET /api/integration/results?cursor=&contentId=&userId=&limit=   (X-Api-Key)
→ { items, nextCursor, hasMore }   — keyset pagination, không trùng không sót
```

Chuyển tiếp mọi statement lên LRS ngoài: `Lrs__Enabled=true` + `Lrs__Endpoint` +
tài khoản. LRS lỗi thì kết quả vẫn ghi tại chỗ. Khi LRS không nhận statement từ
**gói xAPI**, hai nguyên nhân hay gặp: LRS thiếu CORS (kể cả preflight `OPTIONS`
và header `Authorization`, `X-Experience-API-Version`) → `TypeError: Failed to
fetch`; hoặc LMS mở gói thiếu `endpoint`/`auth`/`actor` trên query — gói sẽ hiện
cảnh báo ngay khi mở.

## Đóng gói content type theo phiên bản

`h5p/libraries/` không nằm trong git. Bundle có phiên bản
(`services/h5p-engine/library-bundles/h5p-libraries-<ver>.zip` + manifest sha256)
giúp môi trường mới không phải tải lại từ Hub:

```powershell
npm run libraries:release    # sync từ Hub + đóng bundle mới
npm run libraries:restore    # khôi phục (không bao giờ hạ cấp bản đã mới hơn)
```

Docker image chép sẵn `library-bundles/`; entrypoint tự khôi phục ở lần khởi
động đầu. Phiên bản dạng `2026.08.12-<hash>` — cùng tập library luôn ra cùng
phiên bản. Bản đang dùng ghi ở `h5p/libraries/.bundle.json`.

## Cấu hình

| Biến | Ý nghĩa |
|---|---|
| `PUBLIC_ORIGIN` (deploy) | Địa chỉ học viên mở trên trình duyệt — nguồn cho `H5p__PublicUrl`, `H5P_BASE_URL`, CORS |
| `H5p__InternalUrl` | Engine cho API gọi server-to-server (`http://h5p-engine:3001` trong compose) |
| `H5p__PublicUrl` | Engine cho trình duyệt mở iframe — **phải học viên truy cập được** |
| `H5P_ALLOWED_ORIGINS` | Origin được nhúng editor/player; `*` = mọi origin |
| `Integration__AllowedLmsOrigins__n` | Origin LMS được xuất gói; `*` = mọi origin; deploy dùng chung biến `LMS_ORIGINS` cho cả hai |
| `H5P_WEBHOOK_URL` / `H5P_WEBHOOK_SECRET` | Webhook xAPI engine → API |
| `H5P_INTERNAL_API_KEY` | Bảo vệ API quản trị engine |
| `Integration__ApiKey` / `INTEGRATION_API_KEY` | Khoá LMS ngoài (header `X-Api-Key`); bản sau cho tiến trình Next (chỉ server-side). Để trống = tắt hẳn API tích hợp |
| `H5P_SUPPORTED_LANGUAGES` / `H5p__SupportedLanguages__n` | Ngôn ngữ, phần tử đầu là mặc định (`vi,en`) |
| `Lrs__Enabled` / `Lrs__Endpoint` / `Lrs__Username` / `Lrs__Password` | Chuyển tiếp statement lên LRS |

## Cạm bẫy đã gặp — đọc trước khi sửa

Mỗi mục dưới đây từng tốn nhiều giờ điều tra. Chúng là lý do code có hình dạng
hiện tại; gỡ "cho gọn" là tái sinh lỗi.

1. **Tham số `language` trùng lặp = editor treo vĩnh viễn.** `ajaxPath` mang
   `language=vi`, nhưng `h5peditor.js` tự thêm `language=en` vào một số request.
   Express gộp thành mảng → lumi trả 500 `Language code vi,en is invalid` →
   H5PEditor chỉ log warning và spinner quay mãi. Middleware `/h5p/ajax` khử
   trùng lặp (giữ giá trị đầu). **Không xoá middleware này.**
2. **HTML editor chứa HAI bản `H5PIntegration`** (trang ngoài + iframe form).
   Vá `ajaxPath` phải dùng regex cờ `/g`; vá một bản là bản kia (bản editor thật
   sự dùng) chạy tiếng Anh — và mọi phép đo bằng `grep` bản đầu sẽ báo "đã ổn".
3. **Client merge `language`/`defaultLanguage` ĐÈ lên semantics** sau khi tải.
   Chỉ dịch `semantics` trong `getLibraryData` là nhãn bị hoàn nguyên; phải dịch
   cả hai trường kia (đã làm trong override).
4. **Chuỗi UI nằm trong `content.json` của từng nội dung**, không phải trong
   library. Đổi ngôn ngữ player không tự đổi chuỗi cũ — vì vậy có
   `localizeParams` chạy lúc render, và chỉ thay giá trị còn bằng mặc định gốc.
5. **`vi.json` upstream của H5P phần lớn là tiếng Anh** (dịch nhãn editor, bỏ
   `default` runtime). Đừng dựa vào nó; catalog của repo là nguồn sự thật.
6. **Dockerfile phải `COPY translations/`** — thiếu dòng này mọi bản dịch chạy
   dev thì được, lên Docker thì im lặng rơi về tiếng Anh (đã từng xảy ra).
7. **Origin nhúng bị âm thầm rơi về mặc định**: origin lạ không có trong
   `H5P_ALLOWED_ORIGINS` → postMessage bắn về `localhost` → LMS "mất điểm" mà
   không có lỗi nào. Chữ ký nhận biết: LRS chỉ có `initialized`/`terminated`,
   không có `answered`/`passed`. Đã chặn từ lúc build gói + console.error.
8. **SCORM 1.2 phải quy điểm về thang 0–100**: `masteryscore` là phần trăm;
   gửi `raw=7/max=10` là LMS chấm trượt bài 70%.
9. **Tên compose project quyết định tên volume.** Chạy `docker compose` trong
   `deploy/ubuntu` mà không có `-p lms-h5p` sẽ tạo project `ubuntu` mới với
   **volume rỗng** và tranh cổng 8081 với stack thật. `deploy.sh` đã ghim
   `COMPOSE_PROJECT_NAME`; đừng chạy compose tay mà quên `-p`.
10. **Danh sách loại hỗ trợ "theo vị trí" phải xác minh từ mã nguồn library**
    (`grep ending-point`), không tin tài liệu: Summary có `progressed` nhưng
    không có vị trí; Speak the Words Set có vị trí nhưng ít tài liệu nhắc.
11. **`languageOverride: 'en'`** đang truyền cho `h5pAjaxExpressRouter` — query
    param `language` luôn thắng nên vô hại, nhưng đổi hành vi router cần nhớ nó.
12. **Windows dev**: đường dẫn có dấu cách (`Thien Hoang`) — script bash cần
    quote; `H5P_DATA_PATH` phải resolve tuyệt đối (res.sendFile từ chối đường
    dẫn tương đối). Next.js proxy có `proxyTimeout` 10 phút vì cài content type
    từ Hub vượt 30 giây mặc định.
13. **Học viên là dữ liệu thật**: `h5p/user-data/` và `data/h5p-lms.db` không
    được commit; volume phải nằm trong mọi kịch bản backup.

## Kiểm chứng sau khi sửa

Ba lệnh nhanh xác nhận hệ thống sống:

```bash
curl http://10.0.0.120:8081/backend/health          # {"status":"healthy",...}
curl http://10.0.0.120:8081/h5p-engine/health        # {"status":"ok",...}
curl http://10.0.0.120:8081/h5p-engine/api/embed-origins   # {"origins":["*"]}
```

Kiểm tra đúng đường client thật (không phải chỉ curl thẳng — xem Cạm bẫy #2):

- **Editor tiếng Việt**: mở `/contents/new`, chọn loại nội dung, form phải ra
  nhãn Việt. Tự động hoá được bằng headless Chrome + CDP: gọi
  `H5PEditor.loadLibrary('H5P.QuestionSet 1.20', cb)` trong iframe editor và
  đọc nhãn trả về.
- **Gói SCORM**: dựng LMS giả (một trang HTML expose `window.API` SCORM 1.2
  hoặc `API_1484_11`), giải nén gói vào đó, chạy bằng trình duyệt, trả lời câu
  hỏi và đọc log `LMSSetValue` — phải thấy `score.raw`, `lesson_status`.
- **Gói xAPI**: LRS giả nhận POST `/statements`, mở gói kèm
  `?endpoint=...&auth=...&actor=...`, phải nhận `initialized/attempted/answered/
  passed|failed|completed/terminated`.
- Sau khi đổi bản dịch: restart engine là đủ (catalog đọc từ đĩa khi khởi động).

## Việc cần làm trước khi mở rộng production

1. Thay danh tính demo (`demo-author`, `learner-001`) bằng user thật từ hệ thống
   đăng nhập; phát signed launch token ngắn hạn cho editor/player.
2. Chỉ cho admin cài/nâng cấp H5P library; thêm antivirus + quota cho upload.
3. Cân nhắc PostgreSQL/SQL Server nếu chạy nhiều API replica (hiện SQLite).
4. `@lumieducation/h5p-server` là bản cộng đồng, còn advisory gián tiếp chưa có
   bản vá upstream — đừng mở editor/upload thẳng ra Internet khi chưa có
   authentication gateway. Có thể thay sidecar bằng H5P PHP chính thức hoặc
   H5P.com mà không đổi hợp đồng API của .NET/Next.js.
5. Nếu cần siết origin: đổi `LMS_ORIGINS=*` thành danh sách cụ thể (xem mục Xuất gói).
6. HTTPS + domain thay cho IP khi ra ngoài mạng nội bộ (đổi `PUBLIC_ORIGIN`).

## License

Xem [NOTICE.md](NOTICE.md). H5P Engine và các package Lumi dùng
GPL-3.0-or-later; ứng dụng .NET/Next.js giao tiếp với engine qua HTTP để giữ
ranh giới license.
