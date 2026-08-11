# H5P Studio — ASP.NET Core + Next.js + Ant Design

Project mẫu tự host để tạo, chỉnh sửa, chạy nội dung H5P và ghi nhận kết quả xAPI.

## Kiến trúc

```text
Next.js + Ant Design (3000)
        │ REST
        ▼
ASP.NET Core 8 API (5050) ─── SQLite metadata + điểm
        │ HTTP                         ▲
        ▼                              │ webhook có secret
H5P Engine sidecar (3001) ─────────────┘
  @lumieducation/h5p-server
  H5P Core + H5P Editor
```

ASP.NET Core là backend nghiệp vụ và nguồn dữ liệu của LMS. H5P Engine được tách
thành sidecar vì hiện không có H5P Core/Editor chính thức cho .NET. Biên HTTP giữ
cho mã GPL của engine tách khỏi ứng dụng LMS.

## Chức năng đã có

- Thư viện nội dung H5P với trạng thái engine.
- H5P Editor để tạo và chỉnh sửa nội dung.
- H5P Player chạy trong LMS.
- Đăng ký metadata nội dung về ASP.NET Core.
- Relay xAPI server-side; secret webhook không lộ ra trình duyệt.
- Lưu điểm và sự kiện `answered`, `completed`, `passed`, `failed` vào SQLite.
- Trang xem lịch sử kết quả theo nội dung và học viên.
- Chuyển ngôn ngữ Tiếng Việt / English cho cả LMS và iframe H5P.
- Xuất gói SCORM 1.2, SCORM 2004 hoặc xAPI để chạy nội dung trong LMS ngoài.
- API cho LMS ngoài kéo kết quả về, và tuỳ chọn chuyển tiếp xAPI sang LRS.

## Tích hợp với LMS ngoài

Hai đường chạy song song: điểm vào sổ điểm LMS qua SCORM API, đồng thời vào
database của H5P Studio để LMS kéo về qua REST.

### Xuất gói

Trong thư viện nội dung, mở menu `⋯` của một nội dung và chọn **Tải gói tích hợp**.
Hộp thoại cho chọn định dạng và origin của LMS.

| Định dạng | Ghi vào đâu |
|---|---|
| SCORM 1.2 | `cmi.core.score.raw/min/max`, `cmi.core.lesson_status` |
| SCORM 2004 4th Ed | `cmi.score.raw/min/max/scaled`, `cmi.completion_status`, `cmi.success_status` |
| xAPI (Tin Can) | POST statement tới LRS bằng `endpoint`/`auth`/`actor` của lần khởi chạy |

Trình duyệt **không** giữ khoá tích hợp: nút tải gọi route Next `/api/packages/...`
chạy phía server, route này mới đính `X-Api-Key` rồi gọi ASP.NET. Cần đặt
`INTEGRATION_API_KEY` cho tiến trình web.

Gọi trực tiếp API nếu cần tự động hoá:

```powershell
curl -H "X-Api-Key: $env:INTEGRATION_API_KEY" `
  "http://localhost:5050/api/integration/contents/<h5pContentId>/package?format=scorm2004&lmsOrigin=https://lms.example.com" `
  -o content.zip
```

Mọi định dạng đều là **wrapper nhúng iframe** trỏ về H5P Studio, không phải gói
tự chứa. Gói tự chứa sẽ chạy khép kín trong LMS và kết quả không bao giờ về tới
đây, khiến API kéo kết quả luôn rỗng.

Điều kiện để chạy được:

1. `Integration__AllowedLmsOrigins__n` phải chứa origin của LMS.
2. `H5P_ALLOWED_ORIGINS` của engine **cũng** phải chứa origin đó, nếu không
   player sẽ không `postMessage` được kết quả về wrapper.

Danh tính học viên lấy từ chính host: `cmi.core.student_id` (SCORM 1.2),
`cmi.learner_id` (SCORM 2004), hoặc `actor` trong tham số khởi chạy (xAPI).

### Kéo kết quả

```text
GET /api/integration/results?cursor=&contentId=&userId=&limit=
Header: X-Api-Key: <Integration__ApiKey>
```

Trả về `{ items, nextCursor, hasMore }`. Lưu `nextCursor` rồi truyền lại ở lần
gọi sau để chỉ nhận kết quả mới, không trùng và không sót. Bỏ `cursor` thì có
thể dùng `since=<ISO-8601>`.

### Chuyển tiếp xAPI sang LRS

Bật `Lrs__Enabled=true` và khai báo `Lrs__Endpoint` cùng thông tin đăng nhập.
Mỗi statement được POST tới `<Endpoint>/statements` với `X-Experience-API-Version:
1.0.3`. Statement của H5P không có `actor` nên API tự bổ sung từ `userId`. LRS
lỗi thì kết quả vẫn được lưu tại chỗ; webhook không thất bại theo.
- Docker Compose cùng volume bền vững cho SQLite và H5P assets.

## Yêu cầu

- .NET SDK 8.
- Node.js 20+ và npm 10+.
- Kết nối Internet trong lần đầu để tải npm package và content type từ H5P Hub.
- Docker là tùy chọn.

## Chạy local

```powershell
npm run bootstrap
npm run dev
```

Lệnh `bootstrap` cài dependency Next.js ở root và dependency H5P Engine trong
thư mục cô lập để hai dependency tree không xung đột.

Mở:

- Giao diện: http://localhost:3000
- ASP.NET API: http://localhost:5050/health
- H5P Engine: http://localhost:3001/health

Editor và player được trình duyệt mở qua proxy cùng origin
`http://localhost:3000/h5p-engine`. Cổng `3001` chỉ là endpoint trực tiếp để
kiểm tra health và giao tiếp nội bộ khi phát triển.

Lần đầu mở **Tạo nội dung mới**, H5P Editor sẽ lấy danh sách content type từ
H5P Hub. Chọn một loại nội dung, cài library nếu được hỏi, biên soạn và bấm Save.
Danh sách Hub thành công gần nhất được lưu trong `H5P_DATA_PATH/cache.json`, vì vậy
editor vẫn hiển thị catalog cũ khi H5P.org tạm thời không truy cập được.

## Chạy bằng Docker

Tạo file `.env` từ `.env.example`, thay hai secret, sau đó:

```powershell
docker compose up --build
```

Không dùng các secret mặc định trong production.

## Cấu hình chính

| Biến | Ý nghĩa |
|---|---|
| `NEXT_PUBLIC_API_URL` | URL công khai của ASP.NET API |
| `H5p__InternalUrl` | URL H5P Engine mà API gọi server-to-server |
| `H5p__PublicUrl` | URL H5P Engine mà trình duyệt mở iframe |
| `H5P_WEBHOOK_URL` | Endpoint xAPI của ASP.NET Core |
| `H5P_WEBHOOK_SECRET` | Secret dùng giữa engine và API |
| `H5P_INTERNAL_API_KEY` | Khóa bảo vệ API quản trị của engine |
| `H5P_ALLOWED_ORIGINS` | Origin frontend được phép nhúng editor/player |
| `H5P_SUPPORTED_LANGUAGES` | Ngôn ngữ editor/player, phần tử đầu là mặc định |
| `H5p__SupportedLanguages__n` | Danh sách tương ứng phía ASP.NET Core |
| `Integration__ApiKey` | Khoá LMS ngoài gửi trong `X-Api-Key`; để trống là tắt |
| `INTEGRATION_API_KEY` | Cùng khoá đó, cho tiến trình Next (chỉ phía server) |
| `Integration__AllowedLmsOrigins__n` | Origin LMS được phép nhúng gói SCORM |
| `Lrs__Enabled` / `Lrs__Endpoint` | Bật và trỏ endpoint xAPI của LRS |

## Việc cần làm trước production

Starter này dùng danh tính demo để luồng H5P có thể chạy ngay. Trước khi đưa vào
LMS thật cần:

1. Thay `demo-author` và `learner-001` bằng user lấy từ hệ thống đăng nhập.
2. Đặt editor/player sau gateway và phát signed launch token ngắn hạn.
3. Chỉ cho admin cài hoặc nâng cấp H5P library.
4. Thêm antivirus, quota, object storage và backup cho media upload.
5. Chuyển SQLite sang PostgreSQL/SQL Server nếu chạy nhiều API replica.
6. Chốt version content type và kiểm thử migration trước khi nâng cấp.
7. Bổ sung rate limit, audit log và chính sách CSP phù hợp domain triển khai.

### Lưu ý dependency H5P cộng đồng

`@lumieducation/h5p-server` là implementation cộng đồng và bản phát hành hiện tại
còn một số security advisory gián tiếp chưa có bản sửa tự động từ upstream. Vì vậy
starter này phù hợp để phát triển, thử nghiệm và làm nền tích hợp; không nên mở
editor/upload trực tiếp ra Internet trước khi đặt sau authentication gateway,
allow-list content type và quy trình quét file. Với môi trường yêu cầu kiểm soát
bảo mật cao, có thể thay sidecar này bằng H5P PHP integration chính thức hoặc
H5P.com mà không đổi hợp đồng API của ứng dụng .NET/Next.js.

## License

Xem [NOTICE.md](NOTICE.md). H5P Engine và Lumi H5P packages dùng
GPL-3.0-or-later; ứng dụng .NET/Next.js giao tiếp với engine qua HTTP.
