export const LOCALES = ["vi", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "vi";

/** Cookie holding the choice. Readable by JS so the switcher can set it client-side. */
export const LOCALE_COOKIE = "h5p-studio-locale";
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function resolveLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export const LOCALE_LABELS: Record<Locale, string> = {
  vi: "Tiếng Việt",
  en: "English",
};

const vi = {
  "brand.subtitle": "Học tập tương tác",
  "nav.library": "Thư viện nội dung",
  "nav.create": "Tạo nội dung mới",
  "sider.noteTitle": "H5P mã nguồn mở",
  "sider.noteBody": "Editor và player chạy trên hạ tầng của bạn.",
  "sider.language": "Ngôn ngữ",

  "meta.title": "H5P Studio | Nội dung LMS",
  "meta.description": "Tạo, quản lý và theo dõi nội dung học tập tương tác H5P.",

  "home.eyebrow": "Không gian biên soạn",
  "home.heroTitle": "Biến nội dung thành trải nghiệm học tập.",
  "home.heroBody":
    "Tạo bài giảng, câu hỏi và video tương tác bằng H5P; chạy trực tiếp trong LMS và thu nhận kết quả xAPI.",
  "home.ctaCreate": "Tạo nội dung H5P",
  "home.ctaRefresh": "Làm mới dữ liệu",
  "home.statContents": "Nội dung đã tạo",
  "home.statEvents": "Sự kiện kết quả",
  "home.statEngine": "H5P Engine",
  "home.engineChecking": "Đang kiểm tra",
  "home.engineReady": "Sẵn sàng",
  "home.engineOffline": "Mất kết nối",
  "home.libraryTitle": "Thư viện nội dung",
  "home.librarySubtitle": "Quản lý nội dung, mở editor và xem điểm học viên.",
  "home.newContent": "Nội dung mới",
  "home.emptyTitle": "Chưa có nội dung H5P nào",
  "home.emptyCta": "Tạo bài đầu tiên",
  "home.loadError": "Không tải được nội dung.",

  "home.colContent": "Nội dung",
  "home.colType": "Loại",
  "home.colAttempts": "Lượt ghi nhận",
  "home.colLatestScore": "Điểm gần nhất",
  "home.colUpdated": "Cập nhật",
  "home.noScore": "Chưa có",

  "home.actionPlay": "Chạy nội dung",
  "home.actionEdit": "Chỉnh sửa",
  "home.actionGrades": "Xem kết quả",
  "home.actionDelete": "Xóa",
  "home.actionsFor": "Thao tác với {title}",
  "home.deleteTitle": "Xóa nội dung này?",
  "home.deleteBody": "“{title}” và lịch sử điểm liên quan sẽ bị xóa.",
  "home.deleteOk": "Xóa nội dung",
  "home.deleteCancel": "Giữ lại",
  "home.deleteDone": "Đã xóa nội dung.",

  "editor.titleNew": "Tạo nội dung H5P",
  "editor.titleEdit": "Chỉnh sửa nội dung",
  "editor.back": "Thư viện",
  "editor.notice": "Nội dung được lưu trên H5P Engine và đăng ký tự động về LMS.",
  "editor.loading": "Đang khởi tạo H5P Editor…",
  "editor.errorTitle": "Không mở được H5P Editor",
  "editor.errorFallback": "Không mở được H5P Editor.",
  "editor.backToLibrary": "Về thư viện",
  "editor.frameTitleNew": "Tạo nội dung H5P",
  "editor.frameTitleEdit": "Chỉnh sửa nội dung H5P",

  "play.back": "Thư viện",
  "play.loadingTitle": "Đang tải nội dung…",
  "play.learner": "Học viên",
  "play.results": "Kết quả",
  "play.edit": "Chỉnh sửa",
  "play.alert": "Các sự kiện answered, completed, passed và failed được gửi về ASP.NET Core qua webhook.",
  "play.loading": "Đang nạp H5P Player…",
  "play.errorTitle": "Không chạy được nội dung",
  "play.errorFallback": "Không chạy được nội dung.",
  "play.backToLibrary": "Về thư viện",
  "play.contentFallback": "Nội dung H5P",

  "grades.back": "Quay lại bài học",
  "grades.title": "Kết quả: {title}",
  "grades.subtitle": "Mỗi dòng là một sự kiện kết quả H5P được backend ghi nhận.",
  "grades.empty": "Chưa có kết quả nào. Hãy chạy nội dung và hoàn thành một tương tác.",
  "grades.colLearner": "Học viên",
  "grades.colScore": "Điểm",
  "grades.colStatus": "Trạng thái",
  "grades.colEvent": "Sự kiện",
  "grades.colTime": "Thời gian",
  "grades.passed": "Đạt",
  "grades.failed": "Chưa đạt",

  "callback.errorTitle": "Không đăng ký được nội dung với LMS",
  "callback.doneTitle": "Đã lưu nội dung",
  "callback.doneSubtitle": "Đang quay lại thư viện…",
  "callback.syncing": "Đang đồng bộ nội dung với LMS…",

  "api.requestFailed": "Yêu cầu thất bại ({status})",

  "home.actionCompletion": "Điều kiện hoàn thành",
  "home.colCompletion": "Hoàn thành khi",
  "completion.summaryDefault": "Theo nội dung",
  "completion.summaryScore": "Đạt ≥ {percent}%",
  "completion.summaryPosition": "Tới bước {position}",
  "completion.title": "Điều kiện hoàn thành: {title}",
  "completion.modeDefault": "Theo nội dung H5P",
  "completion.modeDefaultHint": "Dùng nguyên kết quả H5P báo về, không áp thêm ngưỡng.",
  "completion.modeScore": "Theo điểm",
  "completion.modeScoreHint": "Học viên hoàn thành khi đạt từ ngưỡng điểm trở lên.",
  "completion.modePosition": "Theo vị trí",
  "completion.modePositionHint": "Học viên hoàn thành khi tới bước/slide chỉ định.",
  "completion.modePositionUnsupported": "{library} không phát sự kiện vị trí nên chế độ này không thể kích hoạt. Các loại hỗ trợ: Course Presentation, Question Set, Branching Scenario, Column, Documentation Tool, Game Map, Questionnaire, Speak the Words Set.",
  "completion.passLabel": "Ngưỡng đạt: {percent}%",
  "completion.positionLabel": "Bước/slide tối thiểu",
  "completion.exportNote": "Điều kiện này được nhúng vào gói SCORM/xAPI, nên LMS bên ngoài chấm hoàn thành giống hệt.",
  "completion.save": "Lưu",
  "completion.cancel": "Đóng",
  "completion.saved": "Đã lưu điều kiện hoàn thành.",
  "completion.failed": "Không lưu được điều kiện hoàn thành.",

  "home.actionPackage": "Tải gói tích hợp",
  "package.title": "Tải gói tích hợp: {title}",
  "package.formatLabel": "Định dạng gói",
  "package.scorm12": "SCORM 1.2",
  "package.scorm12Hint": "Tương thích rộng nhất, gồm cả Moodle bản cũ.",
  "package.scorm2004": "SCORM 2004 (4th Edition)",
  "package.scorm2004Hint": "Tách riêng hoàn thành và đạt/không đạt, có điểm scaled 0–1.",
  "package.xapi": "xAPI (Tin Can)",
  "package.xapiHint": "Gửi statement thẳng tới LRS bằng tham số khởi chạy của LRS.",
  "package.completionLabel": "Điều kiện hoàn thành",
  "package.completionHint": "Được nhúng vào gói và quyết định statement passed/failed/completed gửi tới LMS. Lưu lại ngay khi bấm Tải xuống.",
  "package.originLabel": "Origin của LMS sẽ chạy gói",
  "package.originHint": "Phải trùng đúng địa chỉ trình duyệt học viên mở LMS. Nếu không thấy origin của bạn ở đây, thêm nó vào Integration__AllowedLmsOrigins và H5P_ALLOWED_ORIGINS rồi khởi động lại.",
  "package.originAny": "Mọi origin LMS đều được chấp nhận — gói tự nhận origin nơi nó chạy, không cần chọn hay nhập domain.",
  "package.noOrigins": "Chưa khai báo origin nào trong Integration:AllowedLmsOrigins.",
  "package.hostNote": "Origin này cũng phải nằm trong H5P_ALLOWED_ORIGINS của engine, nếu không kết quả sẽ không về được LMS.",
  "package.originRejected": "engine chưa chấp nhận",
  "package.originRejectedDetail": "H5P Engine chưa chấp nhận {origin} nên kết quả sẽ không về được LMS. Thêm origin này vào H5P_ALLOWED_ORIGINS rồi khởi động lại engine. Engine đang chấp nhận: {accepted}",
  "package.relayLabel": "Gửi thêm kết quả về H5P Studio",
  "package.relayHint": "Mặc định tắt: gói chỉ báo kết quả qua runtime chuẩn của LMS (SCORM API hoặc LRS). Bật nếu bạn muốn kéo kết quả qua /api/integration/results.",
  "package.download": "Tải xuống",
  "package.cancel": "Đóng",
  "package.done": "Đã tạo gói.",
  "package.failed": "Không tạo được gói.",
};

/** Same keys as `vi`; TypeScript enforces it via the Dictionary type below. */
const en: Record<keyof typeof vi, string> = {
  "brand.subtitle": "Interactive learning",
  "nav.library": "Content library",
  "nav.create": "Create content",
  "sider.noteTitle": "Open source H5P",
  "sider.noteBody": "Editor and player run on your own infrastructure.",
  "sider.language": "Language",

  "meta.title": "H5P Studio | LMS Content",
  "meta.description": "Create, manage and track interactive H5P learning content.",

  "home.eyebrow": "Authoring space",
  "home.heroTitle": "Turn content into learning experiences.",
  "home.heroBody":
    "Build interactive lessons, questions and videos with H5P; run them inside the LMS and collect xAPI results.",
  "home.ctaCreate": "Create H5P content",
  "home.ctaRefresh": "Refresh data",
  "home.statContents": "Content created",
  "home.statEvents": "Result events",
  "home.statEngine": "H5P Engine",
  "home.engineChecking": "Checking",
  "home.engineReady": "Ready",
  "home.engineOffline": "Disconnected",
  "home.libraryTitle": "Content library",
  "home.librarySubtitle": "Manage content, open the editor and review learner scores.",
  "home.newContent": "New content",
  "home.emptyTitle": "No H5P content yet",
  "home.emptyCta": "Create your first one",
  "home.loadError": "Could not load content.",

  "home.colContent": "Content",
  "home.colType": "Type",
  "home.colAttempts": "Recorded attempts",
  "home.colLatestScore": "Latest score",
  "home.colUpdated": "Updated",
  "home.noScore": "None yet",

  "home.actionPlay": "Play content",
  "home.actionEdit": "Edit",
  "home.actionGrades": "View results",
  "home.actionDelete": "Delete",
  "home.actionsFor": "Actions for {title}",
  "home.deleteTitle": "Delete this content?",
  "home.deleteBody": "“{title}” and its score history will be deleted.",
  "home.deleteOk": "Delete content",
  "home.deleteCancel": "Keep it",
  "home.deleteDone": "Content deleted.",

  "editor.titleNew": "Create H5P content",
  "editor.titleEdit": "Edit content",
  "editor.back": "Library",
  "editor.notice": "Content is stored on the H5P Engine and registered with the LMS automatically.",
  "editor.loading": "Starting the H5P Editor…",
  "editor.errorTitle": "Could not open the H5P Editor",
  "editor.errorFallback": "Could not open the H5P Editor.",
  "editor.backToLibrary": "Back to library",
  "editor.frameTitleNew": "Create H5P content",
  "editor.frameTitleEdit": "Edit H5P content",

  "play.back": "Library",
  "play.loadingTitle": "Loading content…",
  "play.learner": "Learner",
  "play.results": "Results",
  "play.edit": "Edit",
  "play.alert": "The answered, completed, passed and failed events are sent to ASP.NET Core through the webhook.",
  "play.loading": "Loading the H5P Player…",
  "play.errorTitle": "Could not play this content",
  "play.errorFallback": "Could not play this content.",
  "play.backToLibrary": "Back to library",
  "play.contentFallback": "H5P content",

  "grades.back": "Back to the lesson",
  "grades.title": "Results: {title}",
  "grades.subtitle": "Each row is one H5P result event recorded by the backend.",
  "grades.empty": "No results yet. Play the content and complete an interaction.",
  "grades.colLearner": "Learner",
  "grades.colScore": "Score",
  "grades.colStatus": "Status",
  "grades.colEvent": "Event",
  "grades.colTime": "Time",
  "grades.passed": "Passed",
  "grades.failed": "Not passed",

  "callback.errorTitle": "Could not register the content with the LMS",
  "callback.doneTitle": "Content saved",
  "callback.doneSubtitle": "Returning to the library…",
  "callback.syncing": "Syncing content with the LMS…",

  "api.requestFailed": "Request failed ({status})",

  "home.actionCompletion": "Completion rule",
  "home.colCompletion": "Completed when",
  "completion.summaryDefault": "As reported",
  "completion.summaryScore": "Score ≥ {percent}%",
  "completion.summaryPosition": "Reaches step {position}",
  "completion.title": "Completion rule: {title}",
  "completion.modeDefault": "As the H5P content reports",
  "completion.modeDefaultHint": "Use whatever H5P sends, without applying a threshold.",
  "completion.modeScore": "By score",
  "completion.modeScoreHint": "The learner completes it by reaching the pass mark.",
  "completion.modePosition": "By position",
  "completion.modePositionHint": "The learner completes it by reaching the given step/slide.",
  "completion.modePositionUnsupported": "{library} never reports a position, so this rule could never fire. Supported: Course Presentation, Question Set, Branching Scenario, Column, Documentation Tool, Game Map, Questionnaire, Speak the Words Set.",
  "completion.passLabel": "Pass mark: {percent}%",
  "completion.positionLabel": "Minimum step/slide",
  "completion.exportNote": "The rule is compiled into the SCORM/xAPI package, so an external LMS grades completion identically.",
  "completion.save": "Save",
  "completion.cancel": "Close",
  "completion.saved": "Completion rule saved.",
  "completion.failed": "Could not save the completion rule.",

  "home.actionPackage": "Download integration package",
  "package.title": "Download integration package: {title}",
  "package.formatLabel": "Package format",
  "package.scorm12": "SCORM 1.2",
  "package.scorm12Hint": "Widest compatibility, including older Moodle.",
  "package.scorm2004": "SCORM 2004 (4th Edition)",
  "package.scorm2004Hint": "Keeps completion and pass/fail apart, adds a 0–1 scaled score.",
  "package.xapi": "xAPI (Tin Can)",
  "package.xapiHint": "Posts statements straight to the LRS using its launch parameters.",
  "package.completionLabel": "Completion rule",
  "package.completionHint": "Compiled into the package and decides the passed/failed/completed statement sent to the LMS. Saved when you press Download.",
  "package.originLabel": "Origin of the LMS that will run the package",
  "package.originHint": "Must match exactly the address learners open the LMS at. If yours is not listed, add it to Integration__AllowedLmsOrigins and H5P_ALLOWED_ORIGINS, then restart.",
  "package.originAny": "Every LMS origin is accepted — the package adapts to wherever it runs, nothing to choose or type.",
  "package.noOrigins": "No origin is listed in Integration:AllowedLmsOrigins yet.",
  "package.hostNote": "This origin must also be in the engine's H5P_ALLOWED_ORIGINS, otherwise results cannot reach the LMS.",
  "package.originRejected": "engine does not accept it",
  "package.originRejectedDetail": "The H5P Engine does not accept {origin}, so results cannot reach the LMS. Add it to H5P_ALLOWED_ORIGINS and restart the engine. The engine currently accepts: {accepted}",
  "package.relayLabel": "Also send results to H5P Studio",
  "package.relayHint": "Off by default: the package reports only through the LMS's standard runtime (SCORM API or LRS). Turn it on if you want to pull results from /api/integration/results.",
  "package.download": "Download",
  "package.cancel": "Close",
  "package.done": "Package created.",
  "package.failed": "Could not create the package.",
};

export type TranslationKey = keyof typeof vi;

export const dictionaries: Record<Locale, Record<TranslationKey, string>> = { vi, en };

export type Translator = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** Replaces {name} placeholders; unknown keys fall back to the key itself. */
export function createTranslator(locale: Locale): Translator {
  const dictionary = dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE];

  return (key, params) => {
    const template = dictionary[key] ?? key;
    if (!params) return template;

    return Object.entries(params).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      template,
    );
  };
}
