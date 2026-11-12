/**
 * ============================================================
 *  ASLAN LESSONS — server (Google Apps Script)
 *  Bütün məlumatlar Google Cədvəldə saxlanılır.
 * ============================================================
 *
 *  QURAŞDIRMA:
 *  1) SPREADSHEET_URL — Google Cədvəlin linki (skript cədvəlin içindən açılıbsa, boş saxlayın).
 *  2) MAIN_ADMIN və DEVELOPER — ilkin login/şifrələr. setup()-dan əvvəl dəyişin.
 *  3) Redaktorda setup() funksiyasını bir dəfə işə salın.
 *  4) Yerləşdir → Veb tətbiq → «İcra edən: Mən», «Giriş: Hər kəs». URL-i index.html-də API_URL-ə yazın.
 *  5) Triggerlər setup() zamanı avtomatik qurulur:
 *     purgeTrashDaily (hər gün — zibil qutusu, vaxtı bitmiş imtahan cəhdləri), autoArchiveQuarterly (hər ay yoxlayır, 3 aydan bir arxivləşdirir).
 *  Kodu yenilədikdən sonra setup()-ı bir dəfə yenidən işə salın (yeni vərəqlər, sütunlar, icazələr və triggerlər üçün).
 *  setup() heç bir məlumatı silmir: yalnız çatışmayan vərəqləri yaradır və çatışmayan sütunları sonuna əlavə edir.
 */

// ===================== AYARLAR =====================
const SPREADSHEET_URL = '';            // məsələn: 'https://docs.google.com/spreadsheets/d/XXXX/edit'
const TIMEZONE = 'Asia/Baku';
const TZ_OFFSET = '+04:00';
const MAIN_ADMIN = { name: 'Leyla xanım', login: 'admin', password: 'admin123' };
const OLD_ADMIN_NAME = 'Baş admin';  // köhnə versiyanın ilkin adı — setup() onu avtomatik «Leyla xanım» edir
const DEVELOPER   = { name: 'Developer', login: 'developer', password: 'dev12345' };
const SESSION_SECONDS = 6 * 60 * 60;
const EDIT_WINDOW_HOURS = 24;
const MAX_LOGIN_FAILS = 5;
const LOGIN_LOCK_MINUTES = 10;
const TRASH_DAYS = 30;                  // zibil qutusunda saxlama müddəti
const SURVEY_TTL_DAYS = 14;             // sorğu linkinin etibarlılıq müddəti
const ARCHIVE_MONTHS = 3;               // jurnal son 3 ayı göstərir; bundan köhnə qeydlər arxivə köçürülür
const AUTO_ARCHIVE_DAYS = 90;           // avto-arxiv neçə gündən bir işləyir (3 ay)
const ARCHIVE_BATCH = 4000;             // bir dəfədə arxivləşən maksimum sətir
// Arxivləşə bilən vərəqlər və tarix sütunu. Aktiv məlumatlar arxivlənmir (bax ARCHIVE_LOCKED).
const ARCHIVE_SHEETS = { Logs: 'time', Notifs: 'createdAt', Surveys: 'sentAt', Anns: 'createdAt' };
const ARCHIVE_LABELS = { Logs: 'Jurnal', Notifs: 'Bildirişlər', Surveys: 'Sorğu cavabları', Anns: 'Passiv elanlar' };
const ARCHIVE_NOTES = {
  Logs: 'Əməliyyatlar tarixçəsi. İstifadəçi və əməliyyat növünə görə süzmək olar.',
  Notifs: 'Köhnə bildirişlər.',
  Surveys: 'Arxivlənən cavablar sorğu statistikasından çıxır. Açıq linklərə toxunulmur.',
  Anns: 'Yalnız söndürülmüş elanlar. Aktiv elanlara toxunulmur.'
};
const ARCHIVE_LOCKED = ['Dərslər', 'Tələbələr', 'Müəllimlər', 'Məşğələlər', 'Ödənişlər', 'Köçürmələr (tələbə tarixçəsi)', 'İmtahanlar və nəticələri'];
const AUTO_ARCHIVE_SHEETS = ['Logs', 'Notifs']; // avto-arxiv yalnız bunları daşıyır
const STALE_DAYS = 14;                  // «Diqqət»: neçə gün dərs qeyd olunmayan məşğələ xəbərdarlıq alır
// Test məlumatları generatoru (yalnız developer) — bir dəfədə maksimum say
const TEST_LIMITS = { teachers: 20, students: 200, courses: 60, lessons: 12 };
// İmtahanlar
const EXAM_GRACE_SEC = 45;              // şəbəkə gecikməsi üçün güzəşt (vaxt bitəndən sonra cavabın qəbul olunduğu müddət)
const EXAM_MAX_Q = 150;                 // bir imtahanda maksimum sual
const EXAM_MAX_STUDENTS = 300;          // bir imtahana təyin edilən maksimum tələbə
const EXAM_MAX_ATTEMPTS = 30;           // bir tələbənin bir imtahana maksimum cəhd sayı (sui-istifadəyə qarşı)
const EXAM_WARN_LIMIT = 3;              // xəbərdarlıq hüququ: növbəti pozuntuda imtahan bitir
const EXAM_PERSIST_SEC = 120;           // qaralama cavablar cədvələ neçə saniyədən bir yazılır (arada keşdə saxlanılır)
const EXAM_CHUNK = 45000;               // bir xanaya yazılan maksimum simvol (Google limiti 50 000)
// Toplu idxal
const IMPORT_PASSWORD = '12345';        // idxal olunan müəllimlərin ilkin şifrəsi (ilk girişdə dəyişdirilir)
const IMPORT_LIMITS = { teachers: 200, students: 3000, courses: 1500, chars: 200000 };
// Avtomatik qurulan triggerlər
const TRIGGERS = [
  { fn: 'purgeTrashDaily', label: 'Zibil qutusunun təmizlənməsi (hər gün)', make: function (b) { return b.timeBased().everyDays(1).atHour(4); } },
  { fn: 'autoArchiveQuarterly', label: 'Avtomatik arxiv (3 aydan bir)', make: function (b) { return b.timeBased().onMonthDay(1).atHour(3); } }
];

// ===================== STRUKTUR =====================
const SCHEMA = {
  Users:    ['id', 'name', 'login', 'password', 'role', 'phone', 'permissions', 'theme', 'createdAt', 'updatedAt', 'deletedAt', 'deletedBy', 'installHint', 'newsSeenAt', 'isTest', 'mustChange', 'subject'],
  Students: ['id', 'name', 'phone', 'parentName', 'parentPhone', 'note', 'cardToken', 'status', 'createdAt', 'updatedAt', 'deletedAt', 'deletedBy', 'isTest'],
  Courses:  ['id', 'title', 'type', 'teacherId', 'studentIds', 'lessonsPerMonth', 'monthNo', 'monthStart', 'createdAt', 'updatedAt', 'deletedAt', 'deletedBy', 'isTest'],
  Lessons:  ['id', 'lessonId', 'courseId', 'monthNo', 'date', 'studentId', 'status', 'reason', 'topic', 'markedBy', 'markedAt', 'editedBy', 'editedAt'],
  Payments: ['id', 'studentId', 'courseId', 'monthNo', 'amount', 'date', 'note', 'createdBy', 'createdAt'],
  Transfers:['id', 'studentId', 'fromCourseId', 'toCourseId', 'byUser', 'at', 'note'],
  Notifs:   ['id', 'userId', 'type', 'text', 'page', 'param', 'createdAt', 'readAt'],
  Anns:     ['id', 'title', 'body', 'popup', 'active', 'createdBy', 'createdAt', 'updatedAt'],
  AnnSeen:  ['id', 'annId', 'userId', 'dismissedAt', 'popupSeenAt'],
  Surveys:  ['id', 'token', 'studentId', 'courseId', 'teacherId', 'monthNo', 'status', 'qVersion', 'questions', 'answers', 'sentBy', 'sentAt', 'answeredAt', 'adminStatus', 'adminNote', 'lowFlag'],
  Changelog:['id', 'title', 'body', 'kind', 'createdBy', 'createdAt'],
  Settings: ['key', 'value', 'updatedAt'],
  Logs:     ['id', 'time', 'userId', 'userName', 'role', 'type', 'action', 'details'],
  // İmtahan — şablon (suallar bir dəfə saxlanılır). «questions*» sütunları ağırdır və siyahılarda oxunmur.
  Exams:    ['id', 'token', 'title', 'subject', 'note', 'teacherId', 'studentIds', 'keys', 'duration', 'points', 'passMin', 'maxPoints', 'qCount', 'openCount',
             'strict', 'stopOnLimit', 'shuffle', 'reveal', 'active', 'locked', 'createdBy', 'createdAt', 'updatedAt', 'deletedAt', 'deletedBy', 'isTest',
             'questions', 'questions2', 'questions3'],
  // Hər cəhd — bir sətir. İlk 4 sütunun sırası dəyişməməlidir (sürətli axtarış indeksi).
  ExamResults: ['id', 'examId', 'status', 'studentId', 'startedAt', 'dur', 'deadline', 'finishedAt', 'spent', 'autoScore', 'openScore', 'score', 'maxPoints', 'passMin',
             'openPending', 'violations', 'endReason', 'late', 'marks', 'gradedBy', 'gradedAt', 'savedAt',
             'comment', 'conf', 'vlog', 'grades', 'answers', 'answers2', 'answers3']
};
// Ağır sütunlar: siyahı oxunuşlarında buraxılır, yalnız bir sətir açılanda oxunur.
const HEAVY = {
  Exams: ['questions', 'questions2', 'questions3'],
  ExamResults: ['comment', 'conf', 'vlog', 'grades', 'answers', 'answers2', 'answers3']
};

const SOFT = { Users: true, Students: true, Courses: true, Exams: true }; // zibil qutusu olan vərəqlər

const ROLE_LABELS = { superadmin: 'Kurs rəhbəri', teacher: 'Müəllim', helper: 'Köməkçi', developer: 'Developer', student: 'Tələbə' };
const TYPE_LABELS = { individual: 'Fərdi', group: 'Qrup' };
const HELD = 'keçdi';
const ABSENT = 'qayıb';

const PERMISSIONS = [
  { group: 'Tələbələr', items: [
    { key: 'students.view', label: 'Tələbələrə bax' },
    { key: 'students.add', label: 'Tələbə əlavə et' },
    { key: 'students.edit', label: 'Tələbəni redaktə et' },
    { key: 'students.delete', label: 'Tələbəni sil' }
  ]},
  { group: 'Müəllimlər', items: [
    { key: 'teachers.view', label: 'Müəllimlərə bax' },
    { key: 'teachers.add', label: 'Müəllim əlavə et' },
    { key: 'teachers.edit', label: 'Müəllimi redaktə et' },
    { key: 'teachers.delete', label: 'Müəllimi sil' },
    { key: 'teachers.passwords', label: 'Şifrələrə bax' }
  ]},
  { group: 'Məşğələlər', items: [
    { key: 'courses.view', label: 'Məşğələlərə bax' },
    { key: 'courses.add', label: 'Məşğələ yarat' },
    { key: 'courses.edit', label: 'Məşğələni redaktə et' },
    { key: 'courses.delete', label: 'Məşğələni sil' },
    { key: 'month.new', label: 'Yeni ay başlat' }
  ]},
  { group: 'Dərs qeydləri', items: [
    { key: 'attendance.view', label: 'Dərs tarixçəsinə bax' },
    { key: 'attendance.mark', label: 'İstənilən məşğələdə dərs qeyd et' },
    { key: 'attendance.edit', label: 'Dərs qeydlərini düzəlt' },
    { key: 'attendance.delete', label: 'Dərs qeydlərini sil' }
  ]},
  { group: 'Ödənişlər', items: [
    { key: 'payments.view', label: 'Ödənişlərə bax' },
    { key: 'payments.add', label: 'Ödəniş əlavə et' },
    { key: 'payments.delete', label: 'Ödənişi sil' }
  ]},
  { group: 'Sorğular', items: [
    { key: 'survey.view', label: 'Sorğu cavablarına bax' },
    { key: 'survey.send', label: 'Sorğu linki göndər' },
    { key: 'survey.edit', label: 'Sorğu suallarını redaktə et' }
  ]},
  { group: 'Elanlar', items: [
    { key: 'announce.send', label: 'Elan göndər' }
  ]},
  { group: 'İmtahanlar', items: [
    { key: 'exams.view', label: 'Bütün imtahanlara və nəticələrə bax' },
    { key: 'exams.manage', label: 'İstənilən imtahanı yarat, redaktə et və yoxla' },
    { key: 'exams.delete', label: 'İmtahanı və nəticələri sil' }
  ]},
  { group: 'Alətlər', items: [
    { key: 'tools.trash', label: 'Zibil qutusu (bərpa/sil)' },
    { key: 'tools.bulk', label: 'Toplu əməliyyatlar (müəllim dəyişmə, köçürmə)' },
    { key: 'tools.datacheck', label: 'Məlumatların yoxlanışı' },
    { key: 'tools.import', label: 'Toplu idxal (siyahıdan müəllim, tələbə və məşğələ)' }
  ]},
  { group: 'Jurnal', items: [
    { key: 'logs.view', label: 'Jurnala bax' }
  ]}
];

const ALL_PERMS = [];
const PERM_LABEL = {};
PERMISSIONS.forEach(function (g) { g.items.forEach(function (i) { ALL_PERMS.push(i.key); PERM_LABEL[i.key] = i.label; }); });

const IMPLIED = {
  'students.add': ['students.view'], 'students.edit': ['students.view'], 'students.delete': ['students.view'],
  'teachers.add': ['teachers.view'], 'teachers.edit': ['teachers.view'], 'teachers.delete': ['teachers.view'], 'teachers.passwords': ['teachers.view'],
  'courses.add': ['courses.view'], 'courses.edit': ['courses.view'], 'courses.delete': ['courses.view'], 'month.new': ['courses.view'],
  'attendance.mark': ['courses.view'],
  'attendance.edit': ['attendance.view', 'courses.view'], 'attendance.delete': ['attendance.view', 'courses.view'],
  'payments.view': ['students.view'], 'payments.add': ['payments.view', 'students.view'], 'payments.delete': ['payments.view', 'students.view'],
  'survey.send': ['students.view'], 'survey.view': ['students.view'],
  'tools.bulk': ['courses.view'],
  'tools.import': ['students.view', 'teachers.view', 'courses.view'],
  'exams.manage': ['exams.view'], 'exams.delete': ['exams.view']
};

const STUDENT_FIELDS = { name: 'Ad Soyad', phone: 'Telefon', parentName: 'Valideyn', parentPhone: 'Valideynin telefonu', note: 'Qeyd' };

// Sorğunun ilkin (default) sualları — redaktə etmək olar, köhnə cavablar öz versiyası ilə saxlanılır.
const DEFAULT_SURVEY = {
  version: 1,
  intro: 'Xidmətlərimizin keyfiyyətini artırmaq üçün bu qısa sorğunu cavablandırmağınızı xahiş edirik. Cavablarınız anonim deyil, lakin yalnız rəhbərlik tərəfindən görünür.',
  questions: [
    { id: 'q1', type: 'scale5', teacher: true, text: 'Müəllimin mövzuları izah etmə bacarığını necə qiymətləndirirsiniz?' },
    { id: 'q2', type: 'scale5', teacher: true, text: 'Bu ay övladınızın biliklərində irəliləyiş hiss edirsinizmi?' },
    { id: 'q3', type: 'choice', options: ['Bəli', 'Qismən', 'Xeyr'], bad: ['Xeyr'], text: 'Övladınız dərslərə həvəslə gedirmi?' },
    { id: 'q4', type: 'scale5', teacher: true, text: 'Müəllimin övladınıza münasibətindən razısınızmı?' },
    { id: 'q5', type: 'scale5', teacher: true, text: 'Müəllim dərsə vaxtında başlayır və dərs vaxtından səmərəli istifadə edirmi?' },
    { id: 'q6', type: 'scale5', teacher: true, text: 'Müəllim övladınızın uğur və çətinlikləri barədə sizə kifayət qədər məlumat verirmi?' },
    { id: 'q7', type: 'choice', options: ['Azdır', 'Normaldır', 'Çoxdur'], text: 'Ev tapşırıqlarının həcmi sizcə necədir?' },
    { id: 'q8', type: 'scale5', text: 'Dərslərin vaxtı və cədvəli sizin üçün rahatdırmı?' },
    { id: 'q9', type: 'nps', text: 'Kursumuzu dost və tanışlarınıza tövsiyə edərdinizmi? (0–10)' },
    { id: 'q10', type: 'text', optional: true, text: 'Təklif və iradlarınızı yazın.' }
  ]
};

// ===================== GİRİŞ NÖQTƏLƏRİ =====================
function doGet() {
  return json_({ ok: true, message: 'Aslan Lessons API işləyir.' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Sorğu düzgün deyil.' });
  }
  try {
    return json_(handle_(req));
  } catch (err) {
    if (err && err.userMsg) return json_({ ok: false, error: err.message, code: err.code || '' });
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: 'Serverdə xəta baş verdi: ' + (err && err.message ? err.message : err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Girişsiz (public) əməliyyatlar — valideyn linkləri və tələbənin imtahan səhifəsi.
// lock: false — əməliyyat yalnız oxuyur və ya kilidi özü (lazım olan hissədə) götürür.
var PUBLIC = {
  maintenanceStatus: { fn: function () { return { maintenance: maint_() }; }, lock: false },
  publicCard:        { fn: function (req) { return publicCard_(req); }, lock: true },
  publicSurveyInfo:  { fn: function (req) { return publicSurveyInfo_(req); }, lock: true },
  submitSurvey:      { fn: function (req) { return submitSurvey_(req); }, lock: true },
  xInfo:             { fn: function (req) { return xInfo_(req); }, lock: false },
  xStart:            { fn: function (req) { return xStart_(req); }, lock: true },
  xSave:             { fn: function (req) { return xSave_(req); }, lock: false },
  xEvent:            { fn: function (req) { return xEvent_(req); }, lock: true },
  xSubmit:           { fn: function (req) { return xSubmit_(req); }, lock: true },
  xResult:           { fn: function (req) { return xResult_(req); }, lock: false }
};

const ROUTES = {
  bootstrap:      { fn: function () { return {}; }, data: true },
  logout:         { fn: logout_, lock: true },
  setTheme:       { fn: setTheme_, lock: true },
  dismissInstall: { fn: dismissInstall_, lock: true },
  changePassword: { fn: changePassword_, lock: true },

  addStudent:     { fn: addStudent_, lock: true, data: true },
  editStudent:    { fn: editStudent_, lock: true, data: true },
  deleteStudent:  { fn: deleteStudent_, lock: true, data: true },
  getStudentCard: { fn: getStudentCard_, lock: true },
  studentLink:    { fn: studentLink_, lock: true },

  addUser:        { fn: addUser_, lock: true, data: true },
  editUser:       { fn: editUser_, lock: true, data: true },
  deleteUser:     { fn: deleteUser_, lock: true, data: true },
  revealPassword: { fn: revealPassword_, lock: true },

  addCourse:      { fn: addCourse_, lock: true, data: true },
  editCourse:     { fn: editCourse_, lock: true, data: true },
  deleteCourse:   { fn: deleteCourse_, lock: true, data: true },
  newMonth:       { fn: newMonth_, lock: true, data: true },
  transferStudent:{ fn: transferStudent_, lock: true, data: true },

  markLesson:     { fn: markLesson_, lock: true, data: true },
  editLesson:     { fn: editLesson_, lock: true, data: true },
  deleteLesson:   { fn: deleteLesson_, lock: true, data: true },
  getLessons:     { fn: getLessons_ },

  addPayment:     { fn: addPayment_, lock: true, data: true },
  deletePayment:  { fn: deletePayment_, lock: true, data: true },

  getLogs:        { fn: getLogs_ },
  getDevLog:      { fn: getDevLog_, lock: true },
  setPermissions: { fn: setPermissions_, lock: true, data: true },

  // Bildirişlər
  markNotif:      { fn: markNotif_, lock: true },
  markAllNotifs:  { fn: markAllNotifs_, lock: true },

  // Elanlar
  listAnns:       { fn: listAnns_ },
  saveAnn:        { fn: saveAnn_, lock: true },
  deleteAnn:      { fn: deleteAnn_, lock: true },
  dismissAnn:     { fn: dismissAnn_, lock: true },
  seenPopup:      { fn: seenPopup_, lock: true },

  // Sorğular
  surveyTargets:  { fn: surveyTargets_ },
  sendSurvey:     { fn: sendSurvey_, lock: true },
  surveyResponses:{ fn: surveyResponses_ },
  setSurveyStatus:{ fn: setSurveyStatus_, lock: true },
  getSurveyQuestions:{ fn: getSurveyQuestions_ },
  saveSurveyQuestions:{ fn: saveSurveyQuestions_, lock: true },

  // Alətlər
  trashList:      { fn: trashList_ },
  restoreItem:    { fn: restoreItem_, lock: true, data: true },
  purgeItem:      { fn: purgeItem_, lock: true, data: true },
  teacherLeave:   { fn: teacherLeave_, lock: true, data: true },
  moveStudents:   { fn: moveStudents_, lock: true, data: true },
  dataCheck:      { fn: dataCheck_ },

  // Yeniliklər
  listChangelog:  { fn: listChangelog_ },
  addChangelog:   { fn: addChangelog_, lock: true },
  deleteChangelog:{ fn: deleteChangelog_, lock: true },
  markNewsSeen:   { fn: markNewsSeen_, lock: true },

  // Developer
  setMaintenance: { fn: setMaintenance_, lock: true },
  devStats:       { fn: devStats_ },
  archivePreview: { fn: archivePreview_ },
  archiveNow:     { fn: archiveNow_, lock: true },
  archiveAutoNow: { fn: archiveAutoNow_, lock: true },
  archiveInfo:    { fn: archiveInfo_ },
  installTriggers:{ fn: installTriggersRoute_, lock: true },
  testDataInfo:   { fn: testDataInfo_ },
  genTestData:    { fn: genTestData_, lock: true },
  purgeTestData:  { fn: purgeTestData_, lock: true },

  // Toplu idxal
  importRun:      { fn: importRun_, lock: true },

  // İmtahanlar
  examList:       { fn: examList_ },
  examGet:        { fn: examGet_, lock: true },
  saveExam:       { fn: saveExam_, lock: true, data: true },
  setExamActive:  { fn: setExamActive_, lock: true },
  copyExam:       { fn: copyExam_, lock: true },
  deleteExam:     { fn: deleteExam_, lock: true, data: true },
  examNewLinks:   { fn: examNewLinks_, lock: true },
  examAttempt:    { fn: examAttempt_, lock: true },
  gradeAttempt:   { fn: gradeAttempt_, lock: true, data: true },
  deleteAttempt:  { fn: deleteAttempt_, lock: true, data: true }
};

function handle_(req) {
  var action = String(req.action || '');
  req._at = Date.now();   // sorğunun serverə çatdığı an (kilid gözləməsindən əvvəl) — imtahan vaxtı bununla hesablanır

  // Public (girişsiz) əməliyyatlar — valideyn linkləri və imtahan səhifəsi texniki iş zamanı da işləyir
  if (PUBLIC.hasOwnProperty(action)) {
    var pub = PUBLIC[action];
    var runPub = function () { var res = pub.fn(req) || {}; res.ok = true; return res; };
    return pub.lock ? withLock_(runPub) : runPub();
  }

  if (action === 'login') return withLock_(function () { return login_(req); });

  var route = ROUTES[action];
  if (!route) throw fail_('Naməlum əməliyyat.');
  var user = auth_(req.token);

  // Texniki iş rejimi: developer işləyir; digərləri yalnız çıxış edə bilər, qalan əməliyyatlar bağlıdır
  if (maintOn_() && user.role !== 'developer' && action !== 'logout') {
    return { ok: false, code: 'MAINT', error: 'Sistemdə texniki işlər aparılır.', maintenance: maint_(),
      me: { id: user.id, name: user.name, role: user.role, theme: user.theme === 'dark' ? 'dark' : 'light' } };
  }

  // İlk giriş: şifrə dəyişdirilməyincə heç bir əməliyyat işləmir (hesaba bağlıdır — cihazdan asılı deyil)
  if (isTrue_(user.mustChange) && action !== 'changePassword' && action !== 'logout' && action !== 'setTheme') {
    return { ok: false, code: 'PWD', error: 'Davam etmək üçün əvvəlcə şifrənizi dəyişin.',
      me: { id: user.id, name: user.name, login: user.login, role: user.role, theme: user.theme === 'dark' ? 'dark' : 'light' } };
  }

  var run = function () {
    var res;
    try {
      res = route.fn(user, req) || {};
    } catch (err) {
      if (err && err.code === 'PERM') log_(user, 'security', 'İcazəsiz əməliyyat cəhdi', 'Əməliyyat: ' + action + ' — ' + err.message);
      throw err;
    }
    var out = { ok: true };
    Object.keys(res).forEach(function (k) { out[k] = res[k]; });
    if (route.data) out.data = bootstrap_(findUser_(user.id) || user, req);
    return out;
  };
  return route.lock ? withLock_(run) : run();
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw fail_('Server hazırda məşğuldur. Bir neçə saniyədən sonra yenidən cəhd edin.');
  try {
    var res = fn();
    SpreadsheetApp.flush();
    return res;
  } finally {
    lock.releaseLock();
  }
}

function fail_(msg, code) {
  var e = new Error(msg);
  e.userMsg = true;
  e.code = code || '';
  return e;
}

// ===================== QURAŞDIRMA =====================
function setup() {
  Object.keys(SCHEMA).forEach(function (name) {
    var m = meta_(name);
    m.sh.getRange('A:' + colLetter_(m.head.length)).setNumberFormat('@');
  });
  var users = rawRows_('Users');
  var main = users.filter(function (u) { return u.role === 'superadmin'; })[0];
  if (!main) {
    if (users.some(function (u) { return lower_(u.login) === lower_(MAIN_ADMIN.login); })) {
      throw new Error('«' + MAIN_ADMIN.login + '» loginli istifadəçi artıq var. MAIN_ADMIN.login-i dəyişin.');
    }
    insertMany_('Users', [{
      id: newId_('U'), name: MAIN_ADMIN.name, login: MAIN_ADMIN.login, password: MAIN_ADMIN.password,
      role: 'superadmin', phone: '', permissions: '', theme: 'light', createdAt: now_(), updatedAt: '', deletedAt: '', deletedBy: ''
    }]);
    log_(null, 'system', 'Sistem quruldu', 'Əsas hesab yaradıldı. Login: ' + MAIN_ADMIN.login);
    Logger.log('Əsas hesab yaradıldı. Login: ' + MAIN_ADMIN.login + ' | Şifrə: ' + MAIN_ADMIN.password);
  } else if (main.name === OLD_ADMIN_NAME) {
    // köhnə versiyadan qalan ilkin ad — saytda «admin» sözü görünməsin
    update_('Users', main, { name: MAIN_ADMIN.name, updatedAt: now_() });
    log_(null, 'system', 'Sistem yeniləndi', 'Əsas hesabın adı «' + OLD_ADMIN_NAME + '» → «' + MAIN_ADMIN.name + '» edildi.');
  }
  var dev = rawRows_('Users').filter(function (u) { return u.role === 'developer'; })[0];
  if (!dev) {
    if (rawRows_('Users').some(function (u) { return lower_(u.login) === lower_(DEVELOPER.login); })) {
      Logger.log('Developer logini məşğuldur, yaradılmadı.');
    } else {
      insertMany_('Users', [{
        id: newId_('U'), name: DEVELOPER.name, login: DEVELOPER.login, password: DEVELOPER.password,
        role: 'developer', phone: '', permissions: '', theme: 'light', createdAt: now_(), updatedAt: '', deletedAt: '', deletedBy: ''
      }]);
      log_(null, 'system', 'Sistem quruldu', 'Developer hesabı yaradıldı. Login: ' + DEVELOPER.login);
      Logger.log('Developer yaradıldı. Login: ' + DEVELOPER.login + ' | Şifrə: ' + DEVELOPER.password);
    }
  }
  if (!settingGet_('survey')) settingSet_('survey', DEFAULT_SURVEY);
  try {
    var created = installTriggers_();
    Logger.log(created.length ? 'Triggerlər quruldu: ' + created.join(', ') : 'Triggerlər artıq qurulub.');
  } catch (e) {
    Logger.log('Triggerləri qurmaq olmadı: ' + e.message + ' — Developer panelindən yenidən cəhd edin.');
  }
}

/** Lazım olan triggerləri yaradır (təkrar yaratmır). */
function installTriggers_() {
  var have = {};
  ScriptApp.getProjectTriggers().forEach(function (t) { have[t.getHandlerFunction()] = true; });
  var created = [];
  TRIGGERS.forEach(function (t) {
    if (!have[t.fn]) { t.make(ScriptApp.newTrigger(t.fn)).create(); created.push(t.fn); }
  });
  return created;
}
function triggersStatus_() {
  var have = {};
  try { ScriptApp.getProjectTriggers().forEach(function (t) { have[t.getHandlerFunction()] = true; }); }
  catch (e) { return TRIGGERS.map(function (t) { return { fn: t.fn, label: t.label, on: null }; }); }
  return TRIGGERS.map(function (t) { return { fn: t.fn, label: t.label, on: !!have[t.fn] }; });
}

/** Trigger üçün: köhnə zibili təmizləyir. */
function purgeTrashDaily() {
  withLock_(function () {
    try { examCloseExpired_(null); } catch (e) { console.error(e); }   // vaxtı bitmiş, bağlanmamış imtahan cəhdləri
    Object.keys(SOFT).forEach(function (name) {
      var old = trashRows_(name).filter(function (r) { return ageHours_(r.deletedAt) > TRASH_DAYS * 24; });
      if (!old.length) return;
      if (name === 'Exams') examPurgeResults_(old.map(function (r) { return r.id; }));   // imtahanla birlikdə nəticələri də silinir
      removeRows_(name, old.map(function (r) { return r._row; }));
    });
    SpreadsheetApp.flush();
  });
}

// ===================== CƏDVƏL QATI =====================
var _ss = null, _meta = {}, _raw = {};

function ss_() {
  if (_ss) return _ss;
  _ss = SPREADSHEET_URL ? SpreadsheetApp.openByUrl(SPREADSHEET_URL) : SpreadsheetApp.getActiveSpreadsheet();
  if (!_ss) throw fail_('Google Cədvəl tapılmadı. Code.gs faylında SPREADSHEET_URL-i yoxlayın.');
  return _ss;
}

function meta_(name) {
  if (_meta[name]) return _meta[name];
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    // iki sorğu eyni anda yeni vərəq yaratmağa çalışsa, ikincisi sadəcə mövcud olanı götürür
    try { sh = ss.insertSheet(name); } catch (e) { sh = ss.getSheetByName(name); if (!sh) throw e; }
  }
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  while (head.length && head[head.length - 1] === '') head.pop();
  var changed = false;
  SCHEMA[name].forEach(function (h) { if (head.indexOf(h) === -1) { head.push(h); changed = true; } });
  if (changed) {
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:' + colLetter_(head.length)).setNumberFormat('@');
  }
  _meta[name] = { sh: sh, head: head };
  return _meta[name];
}

function rawRows_(name) {
  if (_raw[name]) return _raw[name];
  var m = meta_(name);
  var last = m.sh.getLastRow();
  var out = [];
  if (last >= 2) {
    var heavy = HEAVY[name] || null;
    var vals, cols = [];
    if (!heavy) {
      vals = m.sh.getRange(2, 1, last - 1, m.head.length).getValues();
      for (var j = 0; j < m.head.length; j++) cols.push(j);
    } else {
      // Ağır sütunlar (sual və cavab mətnləri) oxunmur: yalnız yüngül sütunların ardıcıl blokları götürülür.
      var blocks = [];
      for (var c = 0; c < m.head.length; c++) {
        if (!m.head[c] || heavy.indexOf(m.head[c]) !== -1) continue;
        var b = blocks[blocks.length - 1];
        if (b && b[0] + b[1] === c) b[1]++; else blocks.push([c, 1]);
        cols.push(c);
      }
      var parts = blocks.map(function (bl) { return m.sh.getRange(2, bl[0] + 1, last - 1, bl[1]).getValues(); });
      vals = [];
      for (var r = 0; r < last - 1; r++) {
        var line = [];
        for (var k = 0; k < parts.length; k++) for (var x = 0; x < blocks[k][1]; x++) line[blocks[k][0] + x] = parts[k][r][x];
        vals.push(line);
      }
    }
    var keyCol = m.head[0];
    for (var i = 0; i < vals.length; i++) {
      var o = { _row: i + 2 };
      if (heavy) o._light = true;   // natamam sətir: update_ onu bütöv yazmır, yalnız dəyişən xanaları yazır
      for (var q = 0; q < cols.length; q++) { var h = m.head[cols[q]]; if (h) o[h] = cell_(vals[i][cols[q]]); }
      if (o[keyCol] !== '' && o[keyCol] != null) out.push(o);
    }
  }
  _raw[name] = out;
  return out;
}

// Bir sətrin bütün sütunları (ağır sütunlar daxil)
function fullRowAt_(name, rowNum) {
  var m = meta_(name);
  var v = m.sh.getRange(rowNum, 1, 1, m.head.length).getValues()[0];
  var o = { _row: rowNum };
  for (var j = 0; j < m.head.length; j++) if (m.head[j]) o[m.head[j]] = cell_(v[j]);
  return o;
}

// Yalnız göstərilən xanaları yazır (yanaşı sütunlar bir əməliyyatla)
function setCells_(name, rowNum, changes) {
  var m = meta_(name);
  var idx = Object.keys(changes).map(function (k) { return m.head.indexOf(k); })
    .filter(function (i) { return i !== -1; }).sort(function (a, b) { return a - b; });
  var i = 0;
  while (i < idx.length) {
    var start = idx[i], n = 1;
    while (i + n < idx.length && idx[i + n] === start + n) n++;
    var vals = [];
    for (var k = 0; k < n; k++) vals.push(val_(changes[m.head[start + k]]));
    m.sh.getRange(rowNum, start + 1, 1, n).setValues([vals]);
    i += n;
  }
}

// Aktiv (silinməmiş) sətirlər
function rows_(name) {
  var all = rawRows_(name);
  if (!SOFT[name]) return all;
  return all.filter(function (r) { return !r.deletedAt; });
}
function trashRows_(name) {
  return rawRows_(name).filter(function (r) { return !!r.deletedAt; });
}

function insertMany_(name, objs) {
  if (!objs.length) return;
  var m = meta_(name);
  var data = objs.map(function (o) { return m.head.map(function (h) { return val_(o[h]); }); });
  var start = m.sh.getLastRow() + 1;
  var need = start + data.length - 1 - m.sh.getMaxRows();
  if (need > 0) m.sh.insertRowsAfter(m.sh.getMaxRows(), need + 20);
  m.sh.getRange(start, 1, data.length, m.head.length).setValues(data);
  delete _raw[name]; delete _raw[name + '#idx'];
}

function update_(name, rowObj, changes) {
  var m = meta_(name);
  Object.keys(changes).forEach(function (k) { rowObj[k] = changes[k]; });
  if (rowObj._light) { setCells_(name, rowObj._row, changes); return; }   // natamam oxunmuş sətir — yalnız dəyişən xanalar
  m.sh.getRange(rowObj._row, 1, 1, m.head.length).setValues([m.head.map(function (h) { return val_(rowObj[h]); })]);
}

function removeRows_(name, nums) {
  if (!nums.length) return;
  var m = meta_(name);
  var s = nums.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return b - a; });
  if (m.sh.getMaxRows() - s.length < 3) m.sh.insertRowsAfter(m.sh.getMaxRows(), 10);
  var i = 0;
  while (i < s.length) {
    var start = s[i], count = 1;
    while (i + count < s.length && s[i + count] === start - count) count++;
    m.sh.deleteRows(start - count + 1, count);
    i += count;
  }
  delete _raw[name]; delete _raw[name + '#idx'];
}

function cell_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    var full = Utilities.formatDate(v, TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    return /\s00:00:00$/.test(full) ? full.slice(0, 10) : full;
  }
  return String(v);
}
function val_(v) {
  if (v === null || v === undefined) return '';
  var s = String(v);
  if (/^=/.test(s)) s = "'" + s;
  return s;
}
function colLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ===================== AYARLAR (Settings) =====================
function settingGet_(key) {
  var r = rawRows_('Settings').filter(function (x) { return x.key === key; })[0];
  if (!r || r.value === '') return null;
  try { return JSON.parse(r.value); } catch (e) { return null; }
}
function settingSet_(key, obj) {
  var r = rawRows_('Settings').filter(function (x) { return x.key === key; })[0];
  var val = JSON.stringify(obj);
  if (r) update_('Settings', r, { value: val, updatedAt: now_() });
  else insertMany_('Settings', [{ key: key, value: val, updatedAt: now_() }]);
}
function maint_() { return settingGet_('maintenance') || { on: false }; }
function maintOn_() { return !!maint_().on; }

// ===================== KÖMƏKÇİLƏR =====================
function newId_(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function newToken_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }
function now_() { return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss'); }
function today_() { return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd'); }
function monthKey_() { return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM'); }
function lower_(s) { return String(s || '').toLowerCase(); }
function fold_(s) {
  return String(s || '').toLocaleLowerCase('az')
    .replace(/ə/g, 'e').replace(/ı/g, 'i').replace(/i̇/g, 'i').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .replace(/ç/g, 'c').replace(/ş/g, 's').replace(/ğ/g, 'g');
}
function digits_(s) { return String(s || '').replace(/\D/g, ''); }
function ageHours_(s) {
  if (!s) return Infinity;
  var t = new Date(String(s).replace(' ', 'T') + TZ_OFFSET).getTime();
  return isNaN(t) ? Infinity : (Date.now() - t) / 36e5;
}
function str_(v, max) { return String(v === null || v === undefined ? '' : v).trim().slice(0, max || 200); }
function reqStr_(v, label, min, max) {
  var s = str_(v, max);
  if (s.length < (min || 1)) throw fail_('«' + label + '» sahəsini doldurun' + (min > 1 ? ' (ən azı ' + min + ' simvol).' : '.'));
  return s;
}
function phone_(v, label) {
  var s = str_(v, 30);
  if (s && !/^[0-9+()\-\s]{5,25}$/.test(s)) throw fail_('«' + (label || 'Telefon') + '» düzgün deyil.');
  return s;
}
function date_(v) {
  var s = str_(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw fail_('Tarix düzgün deyil.');
  var d = new Date(s + 'T12:00:00' + TZ_OFFSET);
  if (isNaN(d.getTime()) || Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd') !== s) throw fail_('Tarix düzgün deyil.');
  if (s > today_()) throw fail_('Gələcək tarixi seçmək olmaz.');
  return s;
}
function idList_(s) { return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(String); }

function findUser_(id) { return rows_('Users').filter(function (x) { return x.id === String(id); })[0] || null; }
function findStudent_(id) { return rows_('Students').filter(function (x) { return x.id === String(id); })[0] || null; }
function findCourse_(id) { return rows_('Courses').filter(function (x) { return x.id === String(id); })[0] || null; }
function mustStudent_(id) { var s = findStudent_(id); if (!s) throw fail_('Tələbə tapılmadı. Səhifəni yeniləyin.'); return s; }
function mustCourse_(id) { var c = findCourse_(id); if (!c) throw fail_('Məşğələ tapılmadı. Səhifəni yeniləyin.'); return c; }
function mustUser_(id) { var u = findUser_(id); if (!u) throw fail_('İstifadəçi tapılmadı. Səhifəni yeniləyin.'); return u; }
function studentName_(id) { var s = findStudent_(id); return s ? s.name : '(silinmiş tələbə)'; }
function userName_(id) { var u = findUser_(id); return u ? u.name : (id ? '(silinmiş istifadəçi)' : '—'); }

function courseLabel_(c) {
  if (!c) return '(silinmiş məşğələ)';
  if (c.title) return c.title;
  var names = idList_(c.studentIds).map(studentName_);
  if (c.type === 'individual') return names[0] || 'Fərdi məşğələ';
  return names.slice(0, 2).join(', ') + (names.length > 2 ? ' +' + (names.length - 2) : '');
}
function courseLabelFrom_(c, sMap) {
  if (c.title) return c.title;
  var names = idList_(c.studentIds).map(function (id) { return sMap[id] ? sMap[id].name : '(silinmiş tələbə)'; });
  if (c.type === 'individual') return names[0] || 'Fərdi məşğələ';
  return names.slice(0, 2).join(', ') + (names.length > 2 ? ' +' + (names.length - 2) : '');
}

// ===================== İCAZƏLƏR =====================
function permsOf_(u) {
  if (!u) return [];
  if (u.role === 'superadmin') return ALL_PERMS.slice();
  if (u.role === 'developer') return [];
  var list = idList_(u.permissions).filter(function (k) { return ALL_PERMS.indexOf(k) !== -1; });
  return expandPerms_(list);
}
function expandPerms_(list) {
  var set = {};
  list.forEach(function (k) { set[k] = true; (IMPLIED[k] || []).forEach(function (x) { set[x] = true; }); });
  return ALL_PERMS.filter(function (k) { return set[k]; });
}
function can_(u, key) { return u.role === 'superadmin' || permsOf_(u).indexOf(key) !== -1; }
function need_(u, key) {
  if (!can_(u, key)) throw fail_('Bu əməliyyat üçün icazəniz yoxdur («' + PERM_LABEL[key] + '»).', 'PERM');
}

// ===================== JURNAL =====================
function log_(user, type, action, details) {
  var m = meta_('Logs');
  // Developer-in fəaliyyəti "dev" tipi ilə yazılır — adi jurnalda görünmür.
  var t = (user && user.role === 'developer' && type !== 'auth') ? 'dev' : type;
  var row = {
    id: newId_('L'), time: now_(),
    userId: user ? user.id : '', userName: user ? user.name : '—',
    role: user ? (ROLE_LABELS[user.role] || user.role) : '—',
    type: t, action: action, details: details || ''
  };
  m.sh.appendRow(m.head.map(function (h) { return val_(row[h]); }));
  delete _raw.Logs;
}

// ===================== BİLDİRİŞLƏR =====================
function notify_(userIds, type, text, page, param) {
  var seen = {}, rows = [];
  (userIds || []).forEach(function (id) {
    id = String(id || '');
    if (!id || seen[id]) return;
    seen[id] = true;
    rows.push({ id: newId_('N'), userId: id, type: type, text: text, page: page || '', param: param || '', createdAt: now_(), readAt: '' });
  });
  if (rows.length) insertMany_('Notifs', rows);
}
function adminsFor_(perm, exceptId) {
  return rows_('Users').filter(function (u) {
    if (u.id === exceptId) return false;
    if (u.role === 'developer') return false;
    return u.role === 'superadmin' || permsOf_(u).indexOf(perm) !== -1;
  }).map(function (u) { return u.id; });
}

// ===================== SESSİYA =====================
function auth_(token) {
  if (!token) throw fail_('Sessiya bitib. Yenidən daxil olun.', 'AUTH');
  var cache = CacheService.getScriptCache();
  var uid = cache.get('s_' + token);
  if (!uid) throw fail_('Sessiyanın vaxtı bitib. Yenidən daxil olun.', 'AUTH');
  var u = findUser_(uid);
  if (!u) { cache.remove('s_' + token); throw fail_('Hesabınız tapılmadı. Leyla xanımla əlaqə saxlayın.', 'AUTH'); }
  cache.put('s_' + token, uid, SESSION_SECONDS);
  u._token = token;
  return u;
}

function login_(req) {
  var login = str_(req.login, 60);
  var pass = String(req.password || '');
  if (!login || !pass) throw fail_('Login və şifrəni daxil edin.');
  var cache = CacheService.getScriptCache();
  var key = 'f_' + lower_(login);
  var fails = Number(cache.get(key) || 0);
  if (fails >= MAX_LOGIN_FAILS) {
    log_(null, 'auth', 'Bloklanmış giriş cəhdi', 'Login: ' + login);
    throw fail_('Çoxlu uğursuz cəhd edildi. ' + LOGIN_LOCK_MINUTES + ' dəqiqədən sonra yenidən yoxlayın.');
  }
  var u = rows_('Users').filter(function (x) { return lower_(x.login) === lower_(login); })[0];
  if (!u || String(u.password) !== pass) {
    cache.put(key, String(fails + 1), LOGIN_LOCK_MINUTES * 60);
    log_(null, 'auth', 'Uğursuz giriş cəhdi', 'Login: ' + login + (u ? ' (şifrə yanlışdır)' : ' (belə login yoxdur)'));
    throw fail_('Login və ya şifrə yanlışdır.');
  }
  cache.remove(key);
  var token = newToken_();
  cache.put('s_' + token, u.id, SESSION_SECONDS);
  // Texniki iş zamanı da giriş mümkündür — istifadəçi daxil olur, amma məlumat yox, texniki iş ekranı görür
  if (maintOn_() && u.role !== 'developer') {
    log_(u, 'auth', 'Sistemə daxil oldu', 'Login: ' + u.login + ' · texniki iş rejimində');
    return { ok: true, token: token, maintenance: maint_(),
      me: { id: u.id, name: u.name, role: u.role, theme: u.theme === 'dark' ? 'dark' : 'light' } };
  }
  // İlk giriş: şifrə dəyişdirilməyincə məlumat verilmir (hesaba bağlıdır — hər girişdə və ya hər cihazda yox, yalnız bir dəfə)
  if (isTrue_(u.mustChange)) {
    log_(u, 'auth', 'Sistemə daxil oldu', 'Login: ' + u.login + ' · ilk giriş, şifrə dəyişdirilməlidir');
    return { ok: true, token: token, mustChange: true,
      me: { id: u.id, name: u.name, login: u.login, role: u.role, theme: u.theme === 'dark' ? 'dark' : 'light' } };
  }
  log_(u, 'auth', 'Sistemə daxil oldu', 'Login: ' + u.login);
  return { ok: true, token: token, data: bootstrap_(u, req) };
}

function dismissInstall_(u) {
  if (u.installHint !== 'dismissed') {
    update_('Users', u, { installHint: 'dismissed' });
    log_(u, 'profile', 'Ana ekrana əlavə et təklifini bağladı', '');
  }
  return {};
}

function logout_(u) {
  CacheService.getScriptCache().remove('s_' + u._token);
  log_(u, 'auth', 'Sistemdən çıxdı', '');
  return {};
}

function setTheme_(u, req) {
  var theme = req.theme === 'dark' ? 'dark' : 'light';
  if (u.theme !== theme) {
    update_('Users', u, { theme: theme });
    if (u.role !== 'developer') log_(u, 'profile', 'Görünüşü dəyişdi', theme === 'dark' ? 'Qaranlıq rejim' : 'İşıqlı rejim');
  }
  return { theme: theme };
}

function changePassword_(u, req) {
  if (String(req.oldPassword || '') !== String(u.password)) throw fail_('Hazırkı şifrə yanlışdır.');
  var np = String(req.newPassword || '');
  if (np.length < 4 || np.length > 50) throw fail_('Yeni şifrə 4–50 simvol olmalıdır.');
  if (/\s/.test(np)) throw fail_('Şifrədə boşluq olmamalıdır.');
  if (np === String(u.password)) throw fail_('Yeni şifrə hazırkı şifrədən fərqli olmalıdır.');
  var forced = isTrue_(u.mustChange);
  if (forced && lower_(np) === lower_(u.login)) throw fail_('Şifrə loginlə eyni ola bilməz.');
  update_('Users', u, { password: np, mustChange: '', updatedAt: now_() });
  log_(u, 'profile', forced ? 'İlk girişdə şifrəsini dəyişdi' : 'Öz şifrəsini dəyişdi', '');
  return { changed: true };
}

// ===================== BOOTSTRAP =====================
function bootstrap_(u, req) {
  // Developer "müəllim gözü ilə" bax (yalnız oxu)
  var viewAs = null, real = null;
  if (u.role === 'developer' && req && req.viewAs) {
    var tgt = findUser_(req.viewAs);
    if (tgt && tgt.role !== 'developer') {
      real = u; viewAs = tgt;
      // yalnız baxış başlayanda qeyd et (avtomatik yeniləmələr jurnalı doldurmasın)
      if (req.viewAsStart) log_(u, 'dev', 'Müəllim gözü ilə baxış', tgt.name + ' (' + ROLE_LABELS[tgt.role] + ')');
      u = Object.assign({}, tgt, { _readOnly: true }); // yalnız oxu — heç bir qeyd düzəldilə bilməz
    }
  }

  var isDev = !viewAs && u.role === 'developer';
  var P = permsOf_(u);
  var has = function (k) { return P.indexOf(k) !== -1; };
  var isSuper = u.role === 'superadmin';
  var readOnly = !!viewAs;

  var base = {
    me: {
      id: u.id, name: u.name, login: u.login, role: u.role, subject: u.subject || '',
      phone: u.phone, theme: (viewAs ? real : u).theme === 'dark' ? 'dark' : 'light',
      perms: P, isSuper: isSuper, isDev: isDev,
      readOnly: readOnly,
      viewAs: viewAs ? { id: viewAs.id, name: viewAs.name, role: viewAs.role } : null,
      devName: real ? real.name : '',
      installHint: (real || u).installHint || ''
    },
    today: today_(), now: now_(), editWindowHours: EDIT_WINDOW_HOURS,
    maintenance: maint_(),
    changelogCount: rawRows_('Changelog').length,
    staleDays: STALE_DAYS
  };
  // Yeniliklər: bu istifadəçinin hələ açmadığı qeydlərin sayı (developer özü yazır — sayğac lazım deyil)
  var newsSeen = newsSeenAt_(viewAs || u);
  base.me.newsSeenAt = newsSeen;
  base.newsUnread = isDev ? 0 : rawRows_('Changelog').filter(function (c) { return c.createdAt > newsSeen; }).length;

  if (isDev) {
    // Developer app məlumatlarını görmür — yalnız öz paneli
    base.devPanel = {
      teachers: rows_('Users').filter(function (x) { return x.role === 'teacher' || x.role === 'helper' || x.role === 'superadmin'; })
        .map(function (x) { return { id: x.id, name: x.name, role: x.role, login: x.login }; })
        .sort(function (a, b) { return a.name.localeCompare(b.name, 'az'); })
    };
    return base;
  }

  var users = rows_('Users'), students = rows_('Students'), courses = rows_('Courses'), lessons = rows_('Lessons');
  var sMap = {}; students.forEach(function (s) { sMap[s.id] = s; });
  var uMap = {}; users.forEach(function (x) { uMap[x.id] = x; });
  var byCourse = {};
  lessons.forEach(function (l) { (byCourse[l.courseId] = byCourse[l.courseId] || []).push(l); });

  var visible = has('courses.view') ? courses : courses.filter(function (c) { return c.teacherId === u.id; });
  base.courses = visible.map(function (c) {
    var withLessons = c.teacherId === u.id || has('attendance.view') || has('attendance.mark');
    return courseView_(c, byCourse[c.id] || [], u, P, sMap, uMap, withLessons);
  });

  if (has('students.view')) {
    base.students = students.map(function (s) {
      var o = { id: s.id, name: s.name, phone: s.phone, parentName: s.parentName, parentPhone: s.parentPhone, note: s.note, createdAt: s.createdAt };
      if (isTrue_(s.isTest)) o.isTest = true;
      return o;
    });
  } else {
    var need = {};
    if (has('courses.add') || has('courses.edit') || has('tools.bulk')) students.forEach(function (s) { need[s.id] = true; });
    visible.forEach(function (c) { idList_(c.studentIds).forEach(function (id) { need[id] = true; }); });
    base.students = students.filter(function (s) { return need[s.id]; }).map(function (s) { return { id: s.id, name: s.name }; });
  }

  base.users = users.map(function (x) {
    var o = { id: x.id, name: x.name, role: x.role };
    var hide = (x.role === 'superadmin' || x.role === 'developer') && !isSuper;
    if (x.role === 'developer' && !isSuper) return null; // developer yalnız baş adminə görünür
    if (x.subject) o.subject = x.subject;
    if (has('teachers.view') && !hide) { o.login = x.login; o.phone = x.phone; o.createdAt = x.createdAt; if (isTrue_(x.mustChange)) o.mustChange = true; }
    if (isSuper && x.role !== 'superadmin' && x.role !== 'developer') o.permissions = permsOf_(x);
    if (isTrue_(x.isTest)) o.isTest = true;
    return o;
  }).filter(Boolean);

  // İcmal: ödəniş vəziyyəti, son 7 günün dərsləri, sorğu xəbərdarlıqları (yalnız icazəsi olanlara)
  if (has('payments.view')) base.pay = payStatus_(courses, students, lessons);
  if (has('courses.view')) base.stats = { lessons7: heldSince_(lessons, 7) };
  if (has('survey.view')) {
    var answered = rawRows_('Surveys').filter(function (sv) { return sv.status === 'answered' && (sv.adminStatus || 'new') === 'new'; });
    base.surveyAlerts = { fresh: answered.length, low: answered.filter(function (sv) { return sv.lowFlag === 'true'; }).length };
  }

  base.permCatalog = isSuper ? PERMISSIONS : [];
  base.permImplied = isSuper ? IMPLIED : {};

  // Bildirişlər
  var myNotifs = rawRows_('Notifs').filter(function (n) { return n.userId === u.id; })
    .sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
  base.notifs = myNotifs.slice(0, 40).map(function (n) {
    return { id: n.id, type: n.type, text: n.text, page: n.page, param: n.param, createdAt: n.createdAt, read: !!n.readAt };
  });
  base.notifUnread = myNotifs.filter(function (n) { return !n.readAt; }).length;

  // Elanlar: aktiv olanlar, bu istifadəçinin bağlamadıqları
  var seenRows = rawRows_('AnnSeen').filter(function (x) { return x.userId === u.id; });
  var seenMap = {}; seenRows.forEach(function (x) { seenMap[x.annId] = x; });
  var activeAnns = rawRows_('Anns').filter(function (a) { return a.active === 'true' || a.active === '1' || a.active === true; })
    .sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
  base.announcements = activeAnns.filter(function (a) { return !(seenMap[a.id] && seenMap[a.id].dismissedAt); })
    .map(function (a) { return { id: a.id, title: a.title, body: a.body, createdAt: a.createdAt, by: userName_(a.createdBy) }; });
  var popup = activeAnns.filter(function (a) { return (a.popup === 'true' || a.popup === '1') && !(seenMap[a.id] && seenMap[a.id].popupSeenAt); })[0];
  base.popupAnnouncement = popup ? { id: popup.id, title: popup.title, body: popup.body, by: userName_(popup.createdBy), createdAt: popup.createdAt } : null;

  // Sorğu xəbərdarlığı (göndərilə biləcək)
  base.flags = { announce: has('announce.send'), survey: has('survey.view') || has('survey.send') || has('survey.edit'),
    tools: has('tools.trash') || has('tools.bulk') || has('tools.datacheck') || has('tools.import'), imp: has('tools.import') };

  // İmtahanlar: müəllim öz imtahanlarını görür; icazəsi olan — hamısını. pending — yoxlanılmağı gözləyən açıq cavablar.
  var teaches = u.role === 'teacher' || courses.some(function (c) { return c.teacherId === u.id; });
  base.exam = { all: has('exams.view'), manage: has('exams.manage'), del: has('exams.delete'),
    create: teaches || has('exams.manage'), warnLimit: EXAM_WARN_LIMIT, maxQ: EXAM_MAX_Q, pending: 0 };
  base.exam.show = base.exam.create || base.exam.all;
  if (base.exam.show) { try { base.exam.pending = examPending_(u); } catch (e) { base.exam.pending = 0; } }

  return base;
}

function courseView_(c, rows, u, P, sMap, uMap, withLessons) {
  var N = Number(c.lessonsPerMonth) === 12 ? 12 : 8;
  var m = Number(c.monthNo) || 1;
  var ids = idList_(c.studentIds);
  var cur = rows.filter(function (r) { return Number(r.monthNo) === m; });
  var ev = events_(cur, u, P, sMap, uMap);
  var held = ev.filter(function (e) { return e.held; }).length;
  var per = {};
  ids.forEach(function (id) { per[id] = { held: 0, absent: 0 }; });
  var absent = 0;
  cur.forEach(function (r) {
    if (r.status === ABSENT) absent++;
    if (!per[r.studentId]) return;
    if (r.status === HELD) per[r.studentId].held++; else per[r.studentId].absent++;
  });
  var t = uMap[c.teacherId];
  return {
    id: c.id, title: c.title, type: c.type === 'group' ? 'group' : 'individual',
    teacherId: c.teacherId, teacherName: t ? t.name : '(silinmiş müəllim)',
    studentIds: ids, lessonsPerMonth: N, monthNo: m, monthStart: c.monthStart,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
    held: held, absent: absent, complete: held >= N, perStudent: per,
    lastDate: ev.length ? ev[ev.length - 1].date : '',
    lessons: withLessons ? ev : null,
    isTest: isTrue_(c.isTest)
  };
}

function isTrue_(v) { return v === true || v === 'true' || v === '1' || v === 1; }

/**
 * Ödəniş vəziyyəti — qiymət saxlanılmadığı üçün «ay» əsasında hesablanır:
 *  · borc (d)  — tələbənin dərsdə iştirak etdiyi, artıq bağlanmış ay üçün ödəniş yazılmayıb
 *               (bağlanmış ay = məşğələ növbəti aya keçib, ya da tələbə artıq bu məşğələdə deyil);
 *  · gözlənilir (w) — məşğələnin cari ayı üçün ödəniş hələ yoxdur.
 * Yalnız problemi olan tələbələr qaytarılır: { studentId: { d: [[courseId, ay, keçdiyi dərs]], w: [[...]] } }.
 * Məşğələsiz («ümumi») ödənişlər heç bir aya aid edilmir.
 */
function payStatus_(courses, students, lessons) {
  var live = {}; students.forEach(function (s) { live[s.id] = true; });
  var cMap = {}; courses.forEach(function (c) { cMap[c.id] = c; });
  var paid = {};
  rows_('Payments').forEach(function (p) { if (p.courseId) paid[p.studentId + '|' + p.courseId + '|' + Number(p.monthNo || 0)] = true; });
  var held = {};
  lessons.forEach(function (l) {
    if (l.status !== HELD || !cMap[l.courseId] || !live[l.studentId]) return;
    var k = l.studentId + '|' + l.courseId + '|' + (Number(l.monthNo) || 1);
    held[k] = (held[k] || 0) + 1;
  });
  var out = {};
  var add = function (sid, kind, row) { var o = out[sid] || (out[sid] = { d: [], w: [] }); o[kind].push(row); };
  Object.keys(held).forEach(function (k) {
    if (paid[k]) return;
    var p = k.split('|'), c = cMap[p[1]], m = Number(p[2]);
    var inCourse = idList_(c.studentIds).indexOf(p[0]) !== -1;
    var cur = Number(c.monthNo) || 1;
    if (m < cur || !inCourse) add(p[0], 'd', [c.id, m, held[k]]);
  });
  courses.forEach(function (c) {
    var m = Number(c.monthNo) || 1;
    idList_(c.studentIds).forEach(function (sid) {
      if (!live[sid] || paid[sid + '|' + c.id + '|' + m]) return;
      add(sid, 'w', [c.id, m, held[sid + '|' + c.id + '|' + m] || 0]);
    });
  });
  Object.keys(out).forEach(function (sid) { out[sid].d.sort(function (a, b) { return a[1] - b[1]; }); });
  return out;
}

// Son N gündə keçirilmiş dərslərin sayı (qrup dərsi bir dərs sayılır)
function heldSince_(lessons, days) {
  var from = Utilities.formatDate(new Date(Date.now() - days * 864e5), TIMEZONE, 'yyyy-MM-dd');
  var seen = {};
  lessons.forEach(function (l) { if (l.status === HELD && l.date >= from) seen[l.lessonId] = true; });
  return Object.keys(seen).length;
}

// Yeniliklərin «oxundu» nöqtəsi: heç açmayıbsa — hesabın yaradılma vaxtı (yeni istifadəçiyə köhnə qeydlər «yeni» görünməsin)
function newsSeenAt_(u) { return String(u.newsSeenAt || u.createdAt || ''); }

function events_(rows, u, P, sMap, uMap) {
  var g = {}, order = [];
  rows.forEach(function (r) {
    if (!g[r.lessonId]) {
      g[r.lessonId] = {
        lessonId: r.lessonId, courseId: r.courseId, monthNo: Number(r.monthNo) || 1, date: r.date, topic: r.topic,
        markedBy: r.markedBy, markedByName: uMap[r.markedBy] ? uMap[r.markedBy].name : (r.markedBy ? '(silinmiş istifadəçi)' : '—'),
        markedAt: r.markedAt, editedBy: r.editedBy,
        editedByName: r.editedBy ? (uMap[r.editedBy] ? uMap[r.editedBy].name : '(silinmiş istifadəçi)') : '',
        editedAt: r.editedAt, entries: []
      };
      order.push(r.lessonId);
    }
    g[r.lessonId].entries.push({
      studentId: r.studentId,
      studentName: sMap[r.studentId] ? sMap[r.studentId].name : '(silinmiş tələbə)',
      status: r.status === HELD ? HELD : ABSENT, reason: r.reason
    });
  });
  var list = order.map(function (k) { return g[k]; });
  list.forEach(function (e) { e.held = e.entries.some(function (x) { return x.status === HELD; }); });
  list.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.markedAt < b.markedAt ? -1 : (a.markedAt > b.markedAt ? 1 : 0);
  });
  var cnt = {};
  var ro = u._readOnly;
  list.forEach(function (e) {
    var k = e.courseId + '|' + e.monthNo;
    if (e.held) { cnt[k] = (cnt[k] || 0) + 1; e.no = cnt[k]; } else e.no = null;
    var age = ageHours_(e.markedAt);
    var own = e.markedBy === u.id && age < EDIT_WINDOW_HOURS;
    e.canEdit = !ro && (P.indexOf('attendance.edit') !== -1 || own);
    e.canDelete = !ro && (P.indexOf('attendance.delete') !== -1 || own);
    e.editHoursLeft = e.markedBy === u.id && age < EDIT_WINDOW_HOURS ? Math.max(0, Math.round((EDIT_WINDOW_HOURS - age) * 10) / 10) : null;
  });
  return list;
}

// ===================== TƏLƏBƏLƏR =====================
function studentPayload_(req) {
  return {
    name: reqStr_(req.name, 'Ad Soyad', 2, 80),
    phone: phone_(req.phone, 'Telefon'),
    parentName: str_(req.parentName, 80),
    parentPhone: phone_(req.parentPhone, 'Valideynin telefonu'),
    note: str_(req.note, 500)
  };
}
function diffText_(oldObj, newObj, labels) {
  var out = [];
  Object.keys(labels).forEach(function (k) {
    if (!(k in newObj)) return;
    var a = String(oldObj[k] || ''), b = String(newObj[k] || '');
    if (a !== b) out.push(labels[k] + ': «' + (a || '—') + '» → «' + (b || '—') + '»');
  });
  return out.join('; ');
}

function dupStudents_(name, phone, exceptId) {
  var fn = fold_(name), dp = digits_(phone);
  return rows_('Students').filter(function (s) {
    if (exceptId && s.id === exceptId) return false;
    if (fold_(s.name) === fn) return true;
    if (dp && dp.length >= 7 && digits_(s.phone) === dp) return true;
    return false;
  });
}

function addStudent_(u, req) {
  need_(u, 'students.add');
  var p = studentPayload_(req);
  if (!req.force) {
    var dups = dupStudents_(p.name, p.phone, null);
    if (dups.length) {
      throw fail_('Belə tələbə artıq var: ' + dups.map(function (d) { return d.name + (d.phone ? ' (' + d.phone + ')' : ''); }).join(', ') +
        '. Yenə də əlavə edilsin?', 'DUP');
    }
  }
  var s = { id: newId_('S'), cardToken: newToken_(), status: 'active', createdAt: now_(), updatedAt: '', deletedAt: '', deletedBy: '' };
  Object.keys(p).forEach(function (k) { s[k] = p[k]; });
  insertMany_('Students', [s]);
  log_(u, 'student', 'Tələbə əlavə etdi', s.name + (s.phone ? ' · Tel: ' + s.phone : '') + (s.parentName ? ' · Valideyn: ' + s.parentName : ''));
  return { id: s.id };
}

function editStudent_(u, req) {
  need_(u, 'students.edit');
  var s = mustStudent_(req.id);
  var p = studentPayload_(req);
  var oldName = s.name;
  var diff = diffText_(s, p, STUDENT_FIELDS);
  p.updatedAt = now_();
  update_('Students', s, p);
  log_(u, 'student', 'Tələbəni redaktə etdi', oldName + ' — ' + (diff || 'dəyişiklik edilmədi'));
  return { id: s.id };
}

function deleteStudent_(u, req) {
  need_(u, 'students.delete');
  var s = mustStudent_(req.id);
  var inCourses = rows_('Courses').filter(function (c) { return idList_(c.studentIds).indexOf(s.id) !== -1; });
  if (inCourses.length) {
    throw fail_('Bu tələbə ' + inCourses.length + ' məşğələdə iştirak edir: ' + inCourses.map(courseLabel_).join(', ') +
      '. Əvvəlcə onu məşğələlərdən çıxarın və ya həmin məşğələləri silin.');
  }
  update_('Students', s, { deletedAt: now_(), deletedBy: u.id });
  log_(u, 'student', 'Tələbəni sildi', s.name + (s.phone ? ' · Tel: ' + s.phone : '') + ' · Zibil qutusuna köçürüldü');
  return {};
}

function studentLink_(u, req) {
  need_(u, 'students.view');
  var s = mustStudent_(req.id);
  if (!s.cardToken) { update_('Students', s, { cardToken: newToken_() }); }
  return { token: s.cardToken, name: s.name, parentPhone: s.parentPhone };
}

function monthlySeries_(history) {
  var by = {};
  history.forEach(function (h) {
    var k = String(h.monthNo || 1);
    if (!by[k]) by[k] = { monthNo: Number(k), held: 0, absent: 0 };
    if (h.status === HELD) by[k].held++; else by[k].absent++;
  });
  return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return a.monthNo - b.monthNo; });
}

function buildCard_(s, u, forPublic) {
  var P = forPublic ? ALL_PERMS.slice() : permsOf_(u);
  var users = rows_('Users'), students = rows_('Students'), courses = rows_('Courses'), lessons = rows_('Lessons');
  var sMap = {}; students.forEach(function (x) { sMap[x.id] = x; });
  var uMap = {}; users.forEach(function (x) { uMap[x.id] = x; });
  var cMap = {}; courses.forEach(function (c) { cMap[c.id] = c; });
  var viewer = forPublic ? { id: '', role: 'public', _readOnly: true } : u;

  var myCourses = courses.filter(function (c) { return idList_(c.studentIds).indexOf(s.id) !== -1; });
  var touched = {};
  lessons.forEach(function (l) { if (l.studentId === s.id) touched[l.courseId] = true; });
  myCourses.forEach(function (c) { touched[c.id] = true; });
  var byCourse = {};
  lessons.forEach(function (l) { if (touched[l.courseId]) (byCourse[l.courseId] = byCourse[l.courseId] || []).push(l); });

  var history = [];
  Object.keys(byCourse).forEach(function (cid) {
    var c = cMap[cid];
    events_(byCourse[cid], viewer, P, sMap, uMap).forEach(function (e) {
      var mine = e.entries.filter(function (x) { return x.studentId === s.id; })[0];
      if (!mine) return;
      history.push({
        lessonId: e.lessonId, courseId: cid, courseExists: !!c,
        courseTitle: c ? courseLabelFrom_(c, sMap) : '(silinmiş məşğələ)', courseType: c ? c.type : '',
        teacherName: c && uMap[c.teacherId] ? uMap[c.teacherId].name : '—',
        monthNo: e.monthNo, no: e.no, date: e.date, topic: e.topic, status: mine.status, reason: mine.reason,
        markedByName: e.markedByName, markedAt: e.markedAt, editedByName: e.editedByName, editedAt: e.editedAt,
        canEdit: !forPublic && e.canEdit && !!c, canDelete: !forPublic && e.canDelete, groupSize: e.entries.length
      });
    });
  });
  history.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.markedAt < b.markedAt ? 1 : -1;
  });

  var courseViews = myCourses.map(function (c) {
    var v = courseView_(c, byCourse[c.id] || [], viewer, P, sMap, uMap, false);
    v.mine = v.perStudent[s.id] || { held: 0, absent: 0 };
    v.studentNames = v.studentIds.map(function (id) { return sMap[id] ? sMap[id].name : '(silinmiş tələbə)'; });
    return v;
  });

  var payments = null, total = 0;
  if (forPublic || P.indexOf('payments.view') !== -1) {
    payments = rows_('Payments').filter(function (p) { return p.studentId === s.id; }).map(function (p) {
      total += Number(p.amount) || 0;
      return {
        id: p.id, amount: Number(p.amount) || 0, date: p.date, note: p.note, monthNo: p.monthNo,
        courseId: p.courseId, courseTitle: p.courseId ? (cMap[p.courseId] ? courseLabelFrom_(cMap[p.courseId], sMap) : '(silinmiş məşğələ)') : '',
        createdByName: forPublic ? '' : (uMap[p.createdBy] ? uMap[p.createdBy].name : '—'), createdAt: p.createdAt
      };
    }).sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1)); });
  }

  return {
    student: forPublic
      ? { name: s.name }
      : { id: s.id, name: s.name, phone: s.phone, parentName: s.parentName, parentPhone: s.parentPhone, note: s.note, createdAt: s.createdAt },
    courses: courseViews, history: history,
    stats: {
      held: history.filter(function (h) { return h.status === HELD; }).length,
      absent: history.filter(function (h) { return h.status === ABSENT; }).length
    },
    monthly: monthlySeries_(history),
    transfers: forPublic ? [] : transfersOf_(s.id, sMap, uMap),
    payments: payments, paymentsTotal: Math.round(total * 100) / 100,
    exams: examsOfStudent_(s.id, uMap)
  };
}

// Tələbənin qruplar arası köçürmə tarixçəsi (silinmiş məşğələlərin adları da göstərilir)
function transfersOf_(studentId, sMap, uMap) {
  var allC = {}; rawRows_('Courses').forEach(function (c) { allC[c.id] = c; });
  var label = function (id) {
    var c = allC[id];
    if (!c) return '(silinmiş məşğələ)';
    return courseLabelFrom_(c, sMap) + (c.deletedAt ? ' (silinib)' : '');
  };
  return rows_('Transfers').filter(function (t) { return t.studentId === studentId; }).map(function (t) {
    return { at: t.at, from: label(t.fromCourseId), to: label(t.toCourseId), by: uMap[t.byUser] ? uMap[t.byUser].name : '—', note: t.note };
  }).sort(function (a, b) { return a.at < b.at ? 1 : -1; });
}

function getStudentCard_(u, req) {
  need_(u, 'students.view');
  var s = mustStudent_(req.id);
  log_(u, 'view', 'Tələbə kartına baxdı', s.name);
  return { card: buildCard_(s, u, false) };
}

// ===================== İSTİFADƏÇİLƏR =====================
function userPayload_(req, isNew, target) {
  var p = {};
  p.name = reqStr_(req.name, 'Ad Soyad', 2, 80);
  p.login = str_(req.login, 30);
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(p.login)) {
    throw fail_('Login 3–30 simvol olmalı və yalnız latın hərfləri, rəqəmlər, nöqtə, alt xətt və ya tire daxil etməlidir.');
  }
  var dup = rawRows_('Users').filter(function (x) { return lower_(x.login) === lower_(p.login) && !x.deletedAt && (!target || x.id !== target.id); })[0];
  if (dup) throw fail_('«' + p.login + '» logini artıq istifadə olunur.');
  var pw = String(req.password || '');
  if (isNew || pw) {
    if (pw.length < 4 || pw.length > 50) throw fail_('Şifrə 4–50 simvol olmalıdır.');
    if (/\s/.test(pw)) throw fail_('Şifrədə boşluq olmamalıdır.');
    p.password = pw;
  }
  p.phone = phone_(req.phone, 'Telefon');
  if (req.subject !== undefined) p.subject = str_(req.subject, 60);
  return p;
}

function addUser_(u, req) {
  need_(u, 'teachers.add');
  var role = req.role === 'helper' ? 'helper' : 'teacher';
  var p = userPayload_(req, true, null);
  var row = { id: newId_('U'), role: role, permissions: '', theme: 'light', createdAt: now_(), updatedAt: '', deletedAt: '', deletedBy: '' };
  Object.keys(p).forEach(function (k) { row[k] = p[k]; });
  if (req.mustChange) row.mustChange = 'true';   // ilk girişdə şifrəni dəyişməlidir
  insertMany_('Users', [row]);
  log_(u, 'teacher', role === 'helper' ? 'Yeni köməkçi əlavə etdi' : 'Yeni müəllim əlavə etdi',
    row.name + ' · Login: ' + row.login + (row.subject ? ' · Fənn: ' + row.subject : '') + (row.phone ? ' · Tel: ' + row.phone : '') + (row.mustChange ? ' · ilk girişdə şifrə dəyişdirilməlidir' : ''));
  return { id: row.id };
}

function editUser_(u, req) {
  var t = mustUser_(req.id);
  if (t.role === 'superadmin' || t.role === 'developer') {
    if (u.id !== t.id) throw fail_('Bu hesabı yalnız özü redaktə edə bilər.', 'PERM');
  } else {
    need_(u, 'teachers.edit');
  }
  var p = userPayload_(req, false, t);
  var newRole = t.role;
  if (t.role === 'teacher' || t.role === 'helper') {
    newRole = req.role === 'helper' ? 'helper' : 'teacher';
    if (newRole === 'helper' && t.role === 'teacher') {
      var cs = rows_('Courses').filter(function (c) { return c.teacherId === t.id; });
      if (cs.length) throw fail_('Bu müəllimin ' + cs.length + ' məşğələsi var. Köməkçi etməzdən əvvəl məşğələləri başqa müəllimə verin.');
    }
  }
  var changes = [];
  var d = diffText_(t, p, { name: 'Ad Soyad', login: 'Login', phone: 'Telefon', subject: 'Fənn' });
  if (d) changes.push(d);
  if (newRole !== t.role) changes.push('Rol: «' + ROLE_LABELS[t.role] + '» → «' + ROLE_LABELS[newRole] + '»');
  if (p.password && p.password !== t.password) changes.push('Şifrə dəyişdirildi');
  // «İlk girişdə şifrəni dəyişsin» — yalnız müəllim/köməkçi hesabları üçün və yalnız başqası tərəfindən qoyulur
  if (req.mustChange !== undefined && u.id !== t.id && (t.role === 'teacher' || t.role === 'helper')) {
    var mc = req.mustChange ? 'true' : '';
    if (mc !== (isTrue_(t.mustChange) ? 'true' : '')) changes.push(mc ? 'Növbəti girişdə şifrəni dəyişməlidir' : 'Şifrəni dəyişmə tələbi götürüldü');
    p.mustChange = mc;
  }
  var oldName = t.name;
  p.role = newRole;
  p.updatedAt = now_();
  update_('Users', t, p);
  var title = (t.role === 'superadmin' || t.role === 'developer') ? 'Öz profilini redaktə etdi' : (newRole === 'helper' ? 'Köməkçini redaktə etdi' : 'Müəllimi redaktə etdi');
  log_(u, 'teacher', title, oldName + ' — ' + (changes.join('; ') || 'dəyişiklik edilmədi'));
  return { id: t.id };
}

function deleteUser_(u, req) {
  need_(u, 'teachers.delete');
  var t = mustUser_(req.id);
  if (t.role === 'superadmin') throw fail_('Leyla xanımın hesabını silmək olmaz.', 'PERM');
  if (t.role === 'developer') throw fail_('Developer hesabını silmək olmaz.', 'PERM');
  if (t.id === u.id) throw fail_('Öz hesabınızı silə bilməzsiniz.');
  var cs = rows_('Courses').filter(function (c) { return c.teacherId === t.id; });
  if (cs.length) {
    throw fail_('Bu müəllimin ' + cs.length + ' məşğələsi var: ' + cs.map(courseLabel_).join(', ') +
      '. Əvvəlcə «Alətlər»də məşğələləri başqa müəllimə verin və ya silin.');
  }
  update_('Users', t, { deletedAt: now_(), deletedBy: u.id });
  log_(u, 'teacher', t.role === 'helper' ? 'Köməkçini sildi' : 'Müəllimi sildi', t.name + ' · Login: ' + t.login + ' · Zibil qutusuna köçürüldü');
  return {};
}

function revealPassword_(u, req) {
  need_(u, 'teachers.passwords');
  var t = mustUser_(req.id);
  if ((t.role === 'superadmin' || t.role === 'developer') && u.role !== 'superadmin') throw fail_('Bu hesabın şifrəsinə baxmaq olmaz.', 'PERM');
  if (t.role === 'developer') throw fail_('Developer şifrəsinə baxmaq olmaz.', 'PERM');
  log_(u, 'security', 'Şifrəyə baxdı', t.name + ' (' + ROLE_LABELS[t.role] + ')');
  return { password: t.password };
}

// ===================== MƏŞĞƏLƏLƏR =====================
function coursePayload_(req) {
  var type = req.type === 'group' ? 'group' : (req.type === 'individual' ? 'individual' : '');
  if (!type) throw fail_('Məşğələnin növünü seçin.');
  var teacher = findUser_(req.teacherId);
  if (!teacher || (teacher.role !== 'teacher' && teacher.role !== 'superadmin')) throw fail_('Müəllim seçin.');
  var ids = (Array.isArray(req.studentIds) ? req.studentIds : []).map(String).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
  ids.forEach(function (id) { if (!findStudent_(id)) throw fail_('Seçilmiş tələbələrdən biri tapılmadı. Səhifəni yeniləyin.'); });
  if (type === 'individual' && ids.length !== 1) throw fail_('Fərdi məşğələ üçün bir tələbə seçin.');
  if (type === 'group' && ids.length < 2) throw fail_('Qrup məşğələsi üçün ən azı iki tələbə seçin.');
  var N = Number(req.lessonsPerMonth);
  if (N !== 8 && N !== 12) throw fail_('Aylıq dərs sayı 8 və ya 12 olmalıdır.');
  return { type: type, title: str_(req.title, 80), teacherId: teacher.id, studentIds: ids.join(','), lessonsPerMonth: String(N) };
}

function addCourse_(u, req) {
  need_(u, 'courses.add');
  var p = coursePayload_(req);
  var c = { id: newId_('C'), monthNo: '1', monthStart: today_(), createdAt: now_(), updatedAt: '', deletedAt: '', deletedBy: '' };
  Object.keys(p).forEach(function (k) { c[k] = p[k]; });
  insertMany_('Courses', [c]);
  log_(u, 'course', TYPE_LABELS[c.type] + ' məşğələ yaratdı',
    '«' + courseLabel_(c) + '» · Müəllim: ' + userName_(c.teacherId) + ' · Tələbə' + (c.type === 'group' ? 'lər' : '') + ': ' +
    idList_(c.studentIds).map(studentName_).join(', ') + ' · Ayda ' + c.lessonsPerMonth + ' dərs');
  if (c.teacherId !== u.id) notify_([c.teacherId], 'course', 'Sizə yeni məşğələ təyin edildi: «' + courseLabel_(c) + '»', 'mine', '');
  return { id: c.id };
}

function editCourse_(u, req) {
  need_(u, 'courses.edit');
  var c = mustCourse_(req.id);
  var p = coursePayload_(req);
  var label = courseLabel_(c);
  var ch = [];
  if (c.type !== p.type) ch.push('Növ: ' + TYPE_LABELS[c.type] + ' → ' + TYPE_LABELS[p.type]);
  if (String(c.title || '') !== p.title) ch.push('Ad: «' + (c.title || '—') + '» → «' + (p.title || '—') + '»');
  var teacherChanged = c.teacherId !== p.teacherId;
  if (teacherChanged) ch.push('Müəllim: ' + userName_(c.teacherId) + ' → ' + userName_(p.teacherId));
  var oldIds = idList_(c.studentIds), newIds = idList_(p.studentIds);
  var added = newIds.filter(function (x) { return oldIds.indexOf(x) === -1; });
  var removed = oldIds.filter(function (x) { return newIds.indexOf(x) === -1; });
  if (added.length) ch.push('Əlavə edilən tələbələr: ' + added.map(studentName_).join(', '));
  if (removed.length) ch.push('Çıxarılan tələbələr: ' + removed.map(studentName_).join(', '));
  if (String(c.lessonsPerMonth) !== p.lessonsPerMonth) ch.push('Aylıq dərs sayı: ' + c.lessonsPerMonth + ' → ' + p.lessonsPerMonth);
  var oldTeacher = c.teacherId;
  p.updatedAt = now_();
  update_('Courses', c, p);
  log_(u, 'course', 'Məşğələni redaktə etdi', '«' + label + '» — ' + (ch.join('; ') || 'dəyişiklik edilmədi'));
  if (teacherChanged) {
    if (p.teacherId !== u.id) notify_([p.teacherId], 'course', 'Sizə yeni məşğələ təyin edildi: «' + courseLabel_(c) + '»', 'mine', '');
    if (oldTeacher && oldTeacher !== u.id) notify_([oldTeacher], 'course', '«' + label + '» məşğələsi başqa müəlliməyə verildi.', 'mine', '');
  }
  return { id: c.id };
}

function deleteCourse_(u, req) {
  need_(u, 'courses.delete');
  var c = mustCourse_(req.id);
  var label = courseLabel_(c);
  update_('Courses', c, { deletedAt: now_(), deletedBy: u.id });
  log_(u, 'course', 'Məşğələni sildi',
    '«' + label + '» (' + TYPE_LABELS[c.type] + ') · Müəllim: ' + userName_(c.teacherId) + ' · Zibil qutusuna köçürüldü');
  if (c.teacherId && c.teacherId !== u.id) notify_([c.teacherId], 'course', '«' + label + '» məşğələsi silindi.', 'mine', '');
  return {};
}

function newMonth_(u, req) {
  need_(u, 'month.new');
  var c = mustCourse_(req.id);
  var m = Number(c.monthNo) || 1;
  var held = heldIn_(c.id, m, null);
  update_('Courses', c, { monthNo: String(m + 1), monthStart: today_(), updatedAt: now_() });
  log_(u, 'month', 'Yeni ay başlatdı', '«' + courseLabel_(c) + '» · Ay ' + m + ' → Ay ' + (m + 1) + ' · Bitən ayda keçirilən dərslər: ' + held + '/' + c.lessonsPerMonth);
  if (c.teacherId && c.teacherId !== u.id) notify_([c.teacherId], 'month', '«' + courseLabel_(c) + '» üçün yeni ay (ay ' + (m + 1) + ') başladıldı.', 'mine', '');
  return {};
}

function transferStudent_(u, req) {
  need_(u, 'tools.bulk');
  var s = mustStudent_(req.studentId);
  var from = mustCourse_(req.fromCourseId);
  var to = mustCourse_(req.toCourseId);
  if (from.id === to.id) throw fail_('Mənbə və hədəf məşğələ eyni ola bilməz.');
  var fromIds = idList_(from.studentIds), toIds = idList_(to.studentIds);
  if (fromIds.indexOf(s.id) === -1) throw fail_('Tələbə mənbə məşğələdə yoxdur.');
  if (toIds.indexOf(s.id) !== -1) throw fail_('Tələbə artıq hədəf məşğələdədir.');
  if (from.type === 'individual') throw fail_('Fərdi məşğələdən köçürmə olmaz. Fərdi məşğələni redaktə edin.');
  if (fromIds.length - 1 < 2) throw fail_('Köçürmədən sonra mənbə qrupda 2-dən az tələbə qalır. Əvvəlcə qrupu redaktə edin və ya bağlayın.');
  if (to.type === 'individual') throw fail_('Fərdi məşğələyə əlavə etmək olmaz.');
  var note = str_(req.note, 200);
  update_('Courses', from, { studentIds: fromIds.filter(function (x) { return x !== s.id; }).join(','), updatedAt: now_() });
  update_('Courses', to, { studentIds: toIds.concat([s.id]).join(','), updatedAt: now_() });
  insertMany_('Transfers', [{ id: newId_('T'), studentId: s.id, fromCourseId: from.id, toCourseId: to.id, byUser: u.id, at: now_(), note: note }]);
  log_(u, 'transfer', 'Tələbəni köçürdü', s.name + ': «' + courseLabel_(from) + '» → «' + courseLabel_(to) + '»' + (note ? ' · ' + note : ''));
  var who = [];
  if (from.teacherId && from.teacherId !== u.id) who.push(from.teacherId);
  if (to.teacherId && to.teacherId !== u.id && to.teacherId !== from.teacherId) who.push(to.teacherId);
  notify_(who, 'transfer', s.name + ' tələbəsi «' + courseLabel_(from) + '» ↔ «' + courseLabel_(to) + '» köçürüldü.', 'mine', '');
  return {};
}

// ===================== DƏRS QEYDLƏRİ =====================
function normEntries_(entries, ids) {
  var map = {};
  (Array.isArray(entries) ? entries : []).forEach(function (e) { if (e && e.studentId) map[String(e.studentId)] = e; });
  Object.keys(map).forEach(function (k) { if (ids.indexOf(k) === -1) throw fail_('Siyahıda məşğələyə aid olmayan tələbə var. Səhifəni yeniləyin.'); });
  return ids.map(function (id) {
    var e = map[id];
    if (!e) throw fail_('Bütün tələbələr üçün qeyd seçin. Səhifəni yeniləyin.');
    var status = e.status === HELD ? HELD : (e.status === ABSENT ? ABSENT : '');
    if (!status) throw fail_('Qeyd növü düzgün deyil.');
    var reason = status === ABSENT ? str_(e.reason, 300) : '';
    if (status === ABSENT && !reason) throw fail_('Qayıb üçün səbəb yazın: ' + studentName_(id) + '.');
    return { studentId: id, status: status, reason: reason };
  });
}
function heldIn_(courseId, monthNo, exceptLessonId) {
  var set = {};
  rows_('Lessons').forEach(function (l) {
    if (l.courseId === courseId && Number(l.monthNo) === Number(monthNo) && l.status === HELD && l.lessonId !== exceptLessonId) set[l.lessonId] = true;
  });
  return Object.keys(set).length;
}
function entriesText_(entries) {
  return entries.map(function (e) { return studentName_(e.studentId) + ': ' + e.status + (e.reason ? ' (' + e.reason + ')' : ''); }).join('; ');
}

function markLesson_(u, req) {
  var c = mustCourse_(req.courseId);
  if (c.teacherId !== u.id && !can_(u, 'attendance.mark')) throw fail_('Bu məşğələdə dərs qeyd etmək üçün icazəniz yoxdur.', 'PERM');
  var date = date_(req.date);
  var topic = str_(req.topic, 200);
  var ids = idList_(c.studentIds);
  if (!ids.length) throw fail_('Məşğələdə tələbə yoxdur.');
  var entries = normEntries_(req.entries, ids);
  var N = Number(c.lessonsPerMonth) || 8;
  var m = Number(c.monthNo) || 1;
  var held = heldIn_(c.id, m, null);
  if (held >= N) throw fail_('Bu ayın bütün dərsləri (' + N + '/' + N + ') artıq qeyd olunub. Tələbə davam edirsə, Leyla xanım yeni ay başlatmalıdır.');
  var isHeld = entries.some(function (e) { return e.status === HELD; });
  var lessonId = newId_('D');
  var stamp = now_();
  insertMany_('Lessons', entries.map(function (e) {
    return { id: newId_('A'), lessonId: lessonId, courseId: c.id, monthNo: String(m), date: date,
      studentId: e.studentId, status: e.status, reason: e.reason, topic: topic, markedBy: u.id, markedAt: stamp, editedBy: '', editedAt: '' };
  }));
  var action = isHeld ? 'Dərsi keçirilmiş kimi qeyd etdi' : 'Dərsi qayıb kimi qeyd etdi';
  var complete = isHeld && held + 1 >= N;
  log_(u, 'lesson', action,
    '«' + courseLabel_(c) + '» · Ay ' + m + ' · Tarix: ' + date + ' · ' + (isHeld ? 'Keçirilən dərslər: ' + (held + 1) + '/' + N : 'Dərs sayına daxil edilmədi') +
    (topic ? ' · Mövzu: ' + topic : '') + ' · ' + entriesText_(entries));
  if (complete) notify_(adminsFor_('month.new', u.id), 'complete', '«' + courseLabel_(c) + '» məşğələsi ' + N + '/' + N + ' oldu — yeni ay başlatmaq lazımdır.', 'courses', '');
  return { lessonId: lessonId, complete: complete };
}

function lessonRows_(lessonId) {
  var rows = rows_('Lessons').filter(function (l) { return l.lessonId === String(lessonId); });
  if (!rows.length) throw fail_('Dərs qeydi tapılmadı. Səhifəni yeniləyin.');
  return rows;
}
function canTouchLesson_(u, rows, permKey) {
  if (can_(u, permKey)) return true;
  var r = rows[0];
  return r.markedBy === u.id && ageHours_(r.markedAt) < EDIT_WINDOW_HOURS;
}

function editLesson_(u, req) {
  var rows = lessonRows_(req.lessonId);
  if (!canTouchLesson_(u, rows, 'attendance.edit')) throw fail_('Qeydi düzəltmək üçün vaxt (' + EDIT_WINDOW_HOURS + ' saat) bitib. Düzəliş üçün Leyla xanıma müraciət edin.', 'PERM');
  var c = findCourse_(rows[0].courseId);
  if (!c) throw fail_('Bu qeydin aid olduğu məşğələ silinib.');
  var ids = rows.map(function (r) { return r.studentId; });
  var date = date_(req.date);
  var topic = str_(req.topic, 200);
  var entries = normEntries_(req.entries, ids);
  var wasHeld = rows.some(function (r) { return r.status === HELD; });
  var isHeld = entries.some(function (e) { return e.status === HELD; });
  var m = Number(rows[0].monthNo) || 1;
  var N = Number(c.lessonsPerMonth) || 8;
  if (isHeld && !wasHeld && heldIn_(c.id, m, rows[0].lessonId) >= N) throw fail_('Bu ayın bütün dərsləri (' + N + '/' + N + ') artıq qeyd olunub. Bu qeydi «keçdi» etmək olmaz.');
  var before = 'Tarix: ' + rows[0].date + (rows[0].topic ? ', Mövzu: ' + rows[0].topic : '') + ', ' +
    entriesText_(rows.map(function (r) { return { studentId: r.studentId, status: r.status, reason: r.reason }; }));
  var stamp = now_();
  var byId = {};
  entries.forEach(function (e) { byId[e.studentId] = e; });
  var markedBy = rows[0].markedBy;
  rows.forEach(function (r) {
    var e = byId[r.studentId];
    update_('Lessons', r, { date: date, topic: topic, status: e.status, reason: e.reason, editedBy: u.id, editedAt: stamp });
  });
  var after = 'Tarix: ' + date + (topic ? ', Mövzu: ' + topic : '') + ', ' + entriesText_(entries);
  log_(u, 'lesson', 'Dərs qeydini düzəltdi', '«' + courseLabel_(c) + '» · Ay ' + m + ' · Əvvəl: [' + before + '] → Sonra: [' + after + ']');
  if (markedBy && markedBy !== u.id) notify_([markedBy], 'lesson', u.name + ' «' + courseLabel_(c) + '» üzrə sizin dərs qeydinizi düzəltdi (' + fmtD_(date) + ').', 'mine', '');
  return {};
}

function deleteLesson_(u, req) {
  var rows = lessonRows_(req.lessonId);
  if (!canTouchLesson_(u, rows, 'attendance.delete')) throw fail_('Qeydi silmək üçün vaxt (' + EDIT_WINDOW_HOURS + ' saat) bitib. Silmək üçün Leyla xanıma müraciət edin.', 'PERM');
  var c = findCourse_(rows[0].courseId);
  var markedBy = rows[0].markedBy;
  var desc = '«' + courseLabel_(c) + '» · Ay ' + rows[0].monthNo + ' · Tarix: ' + rows[0].date + ' · ' +
    entriesText_(rows.map(function (r) { return { studentId: r.studentId, status: r.status, reason: r.reason }; })) + ' · Qeyd edən: ' + userName_(markedBy);
  removeRows_('Lessons', rows.map(function (r) { return r._row; }));
  log_(u, 'lesson', 'Dərs qeydini sildi', desc);
  if (markedBy && markedBy !== u.id) notify_([markedBy], 'lesson', u.name + ' «' + courseLabel_(c) + '» üzrə sizin dərs qeydinizi sildi (' + fmtD_(rows[0].date) + ').', 'mine', '');
  return {};
}
function fmtD_(s) { return String(s || '').slice(0, 10); }

function getLessons_(u, req) {
  var courseId = str_(req.courseId, 40);
  var own = false;
  if (courseId) { var cc = findCourse_(courseId); own = !!cc && cc.teacherId === u.id; }
  if (!own && !can_(u, 'attendance.view')) throw fail_('Dərs tarixçəsinə baxmaq üçün icazəniz yoxdur.', 'PERM');
  var P = permsOf_(u);
  var users = rows_('Users'), students = rows_('Students'), courses = rows_('Courses');
  var sMap = {}; students.forEach(function (x) { sMap[x.id] = x; });
  var uMap = {}; users.forEach(function (x) { uMap[x.id] = x; });
  var cMap = {}; courses.forEach(function (c) { cMap[c.id] = c; });
  var rows = rows_('Lessons');
  if (courseId) rows = rows.filter(function (l) { return l.courseId === courseId; });
  var list = events_(rows, u, P, sMap, uMap);
  list.forEach(function (e) {
    var c = cMap[e.courseId];
    e.courseExists = !!c;
    e.courseTitle = c ? courseLabelFrom_(c, sMap) : '(silinmiş məşğələ)';
    e.courseType = c ? c.type : '';
    e.teacherName = c && uMap[c.teacherId] ? uMap[c.teacherId].name : '—';
    e.lessonsPerMonth = c ? Number(c.lessonsPerMonth) : null;
    if (!c) e.canEdit = false;
  });
  var from = str_(req.from, 10), to = str_(req.to, 10), status = str_(req.status, 10), q = fold_(str_(req.q, 80));
  list = list.filter(function (e) {
    if (from && e.date < from) return false;
    if (to && e.date > to) return false;
    if (status === HELD && !e.held) return false;
    if (status === ABSENT && !e.entries.some(function (x) { return x.status === ABSENT; })) return false;
    if (q) {
      var hay = fold_([e.courseTitle, e.teacherName, e.markedByName, e.topic].concat(e.entries.map(function (x) { return x.studentName + ' ' + (x.reason || ''); })).join(' '));
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });
  list.sort(function (a, b) { if (a.date !== b.date) return a.date < b.date ? 1 : -1; return a.markedAt < b.markedAt ? 1 : -1; });
  var offset = Math.max(0, Number(req.offset) || 0);
  var limit = Math.min(200, Math.max(1, Number(req.limit) || 50));
  return { lessons: list.slice(offset, offset + limit), total: list.length };
}

// ===================== ÖDƏNİŞLƏR =====================
function addPayment_(u, req) {
  need_(u, 'payments.add');
  var s = mustStudent_(req.studentId);
  var amount = Number(String(req.amount || '').replace(',', '.'));
  if (!isFinite(amount) || amount <= 0 || amount > 100000) throw fail_('Məbləği düzgün daxil edin.');
  amount = Math.round(amount * 100) / 100;
  var date = date_(req.date);
  var courseId = str_(req.courseId, 40);
  var c = null;
  var monthNo = '';
  if (courseId) {
    c = mustCourse_(courseId);
    var cur = Number(c.monthNo) || 1;
    // Köhnə ay (borc) üçün ödəniş: tələbə həmin ayda bu məşğələdə dərs keçibsə, artıq qrupda olmasa da qəbul olunur
    var m = req.monthNo === undefined || req.monthNo === '' ? cur : Number(req.monthNo);
    if (!(m >= 1 && m <= cur && Math.floor(m) === m)) throw fail_('Ay düzgün seçilməyib (1–' + cur + ').');
    var inCourse = idList_(c.studentIds).indexOf(s.id) !== -1;
    if (!inCourse) {
      var attended = rows_('Lessons').some(function (l) { return l.courseId === c.id && l.studentId === s.id && Number(l.monthNo) === m; });
      if (!attended) throw fail_('Bu tələbə seçilmiş məşğələdə iştirak etmir.');
    }
    monthNo = String(m);
  }
  var p = { id: newId_('P'), studentId: s.id, courseId: c ? c.id : '', monthNo: monthNo,
    amount: String(amount), date: date, note: str_(req.note, 200), createdBy: u.id, createdAt: now_() };
  insertMany_('Payments', [p]);
  log_(u, 'payment', 'Ödəniş əlavə etdi',
    s.name + ' · ' + amount + ' AZN · Tarix: ' + date + (c ? ' · Məşğələ: «' + courseLabel_(c) + '», Ay ' + p.monthNo : '') + (p.note ? ' · Qeyd: ' + p.note : ''));
  return { id: p.id };
}
function deletePayment_(u, req) {
  need_(u, 'payments.delete');
  var p = rows_('Payments').filter(function (x) { return x.id === String(req.id); })[0];
  if (!p) throw fail_('Ödəniş tapılmadı. Səhifəni yeniləyin.');
  removeRows_('Payments', [p._row]);
  log_(u, 'payment', 'Ödənişi sildi', studentName_(p.studentId) + ' · ' + p.amount + ' AZN · Tarix: ' + p.date + (p.note ? ' · Qeyd: ' + p.note : ''));
  return {};
}

// ===================== JURNAL =====================
function getLogs_(u, req) {
  need_(u, 'logs.view');
  var type = str_(req.type, 20), userId = str_(req.userId, 40), from = str_(req.from, 10), to = str_(req.to, 10), q = fold_(str_(req.q, 80));
  var since = monthsAgo_(ARCHIVE_MONTHS); // jurnal yalnız son 3 ayı göstərir
  var list = rows_('Logs').slice().reverse().filter(function (l) {
    if (l.type === 'dev') return false; // developer fəaliyyəti adi jurnalda görünmür
    if (type && l.type !== type) return false;
    if (userId && l.userId !== userId) return false;
    var d = String(l.time).slice(0, 10);
    if (d < since) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (q && fold_(l.userName + ' ' + l.action + ' ' + l.details).indexOf(q) === -1) return false;
    return true;
  });
  var offset = Math.max(0, Number(req.offset) || 0);
  var limit = Math.min(200, Math.max(1, Number(req.limit) || 20));
  return {
    logs: list.slice(offset, offset + limit).map(function (l) {
      return { id: l.id, time: l.time, userId: l.userId, userName: l.userName, role: l.role, type: l.type, action: l.action, details: l.details };
    }),
    total: list.length,
    retentionMonths: ARCHIVE_MONTHS,
    since: since
  };
}

// Developer fəaliyyəti — yalnız baş admin və developer görür (son 3 ay)
function getDevLog_(u, req) {
  if (u.role !== 'superadmin' && u.role !== 'developer') throw fail_('İcazə yoxdur.', 'PERM');
  var since = monthsAgo_(ARCHIVE_MONTHS);
  var list = rows_('Logs').slice().reverse().filter(function (l) { return l.type === 'dev' && String(l.time).slice(0, 10) >= since; });
  var offset = Math.max(0, Number(req.offset) || 0);
  var limit = Math.min(200, Math.max(1, Number(req.limit) || 20));
  // baxış bir dəfə qeyd olunur (səhifələmə və avtomatik yeniləmə jurnalı doldurmasın)
  if (u.role === 'superadmin' && req.first) log_(u, 'view', 'Developer fəaliyyətinə baxdı', '');
  return { logs: list.slice(offset, offset + limit).map(function (l) {
    return { id: l.id, time: l.time, userName: l.userName, action: l.action, details: l.details };
  }), total: list.length, retentionMonths: ARCHIVE_MONTHS, since: since };
}

// ===================== İCAZƏLƏR =====================
function setPermissions_(u, req) {
  if (u.role !== 'superadmin') throw fail_('«İcazələr» bölməsi yalnız Leyla xanım üçündür.', 'PERM');
  var t = mustUser_(req.userId);
  if (t.role === 'superadmin' || t.role === 'developer') throw fail_('Bu hesabın icazələrini dəyişmək olmaz.');
  var wanted = (Array.isArray(req.permissions) ? req.permissions : []).map(String).filter(function (k) { return ALL_PERMS.indexOf(k) !== -1; });
  var next = expandPerms_(wanted);
  var prev = permsOf_(t);
  var added = next.filter(function (k) { return prev.indexOf(k) === -1; });
  var removed = prev.filter(function (k) { return next.indexOf(k) === -1; });
  update_('Users', t, { permissions: next.join(','), updatedAt: now_() });
  added.forEach(function (k) { log_(u, 'permission', 'İcazə verdi', '«' + t.name + '» istifadəçisinə «' + PERM_LABEL[k] + '» icazəsini verdi'); });
  removed.forEach(function (k) { log_(u, 'permission', 'İcazəni geri aldı', '«' + t.name + '» istifadəçisindən «' + PERM_LABEL[k] + '» icazəsini geri aldı'); });
  if (!added.length && !removed.length) log_(u, 'permission', 'İcazələri yadda saxladı', '«' + t.name + '» — dəyişiklik edilmədi');
  if (added.length || removed.length) notify_([t.id], 'perm', 'İcazələriniz Leyla xanım tərəfindən yeniləndi.', '', '');
  return { added: added.length, removed: removed.length };
}

// ===================== BİLDİRİŞLƏR (route) =====================
function markNotif_(u, req) {
  var n = rawRows_('Notifs').filter(function (x) { return x.id === String(req.id) && x.userId === u.id; })[0];
  if (n && !n.readAt) update_('Notifs', n, { readAt: now_() });
  return {};
}
function markAllNotifs_(u, req) {
  rawRows_('Notifs').forEach(function (n) { if (n.userId === u.id && !n.readAt) update_('Notifs', n, { readAt: now_() }); });
  return {};
}

// ===================== ELANLAR =====================
function listAnns_(u, req) {
  need_(u, 'announce.send');
  return { anns: rawRows_('Anns').sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; }).map(function (a) {
    return { id: a.id, title: a.title, body: a.body, popup: a.popup === 'true', active: a.active === 'true', by: userName_(a.createdBy), createdAt: a.createdAt };
  }) };
}
function saveAnn_(u, req) {
  need_(u, 'announce.send');
  var title = reqStr_(req.title, 'Başlıq', 2, 120);
  var body = reqStr_(req.body, 'Mətn', 2, 2000);
  var popup = req.popup ? 'true' : 'false';
  var active = (req.active === false) ? 'false' : 'true';
  if (req.id) {
    var a = rawRows_('Anns').filter(function (x) { return x.id === String(req.id); })[0];
    if (!a) throw fail_('Elan tapılmadı.');
    var wasActive = a.active === 'true', wasPopup = a.popup === 'true';
    update_('Anns', a, { title: title, body: body, popup: popup, active: active, updatedAt: now_() });
    // Yenidən aktivləşdirmə/yeni popup → köhnə "görülüb" qeydlərini sıfırla
    if ((active === 'true' && !wasActive) || (popup === 'true' && !wasPopup)) resetAnnSeen_(a.id, popup === 'true');
    markAuthorSeen_(a.id, u.id); // müəllif öz elanını görmür
    log_(u, 'announce', 'Elanı redaktə etdi', '«' + title + '»');
    return { id: a.id };
  }
  var id = newId_('AN');
  insertMany_('Anns', [{ id: id, title: title, body: body, popup: popup, active: active, createdBy: u.id, createdAt: now_(), updatedAt: '' }]);
  markAuthorSeen_(id, u.id);
  log_(u, 'announce', 'Elan göndərdi', '«' + title + '»' + (popup === 'true' ? ' · Girişdə pəncərə' : ''));
  return { id: id };
}
function markAuthorSeen_(annId, userId) {
  update_('AnnSeen', annSeenRow_(annId, userId), { dismissedAt: now_(), popupSeenAt: now_() });
}
function resetAnnSeen_(annId, popupToo) {
  rawRows_('AnnSeen').filter(function (x) { return x.annId === annId; }).forEach(function (x) {
    var ch = { dismissedAt: '' };
    if (popupToo) ch.popupSeenAt = '';
    update_('AnnSeen', x, ch);
  });
}
function deleteAnn_(u, req) {
  need_(u, 'announce.send');
  var a = rawRows_('Anns').filter(function (x) { return x.id === String(req.id); })[0];
  if (!a) throw fail_('Elan tapılmadı.');
  removeRows_('Anns', [a._row]);
  var seen = rawRows_('AnnSeen').filter(function (x) { return x.annId === a.id; });
  if (seen.length) removeRows_('AnnSeen', seen.map(function (x) { return x._row; }));
  log_(u, 'announce', 'Elanı sildi', '«' + a.title + '»');
  return {};
}
function annSeenRow_(annId, userId) {
  var r = rawRows_('AnnSeen').filter(function (x) { return x.annId === annId && x.userId === userId; })[0];
  if (!r) { insertMany_('AnnSeen', [{ id: newId_('AS'), annId: annId, userId: userId, dismissedAt: '', popupSeenAt: '' }]);
    r = rawRows_('AnnSeen').filter(function (x) { return x.annId === annId && x.userId === userId; })[0]; }
  return r;
}
function dismissAnn_(u, req) {
  var a = rawRows_('Anns').filter(function (x) { return x.id === String(req.id); })[0];
  if (!a) return {};
  update_('AnnSeen', annSeenRow_(a.id, u.id), { dismissedAt: now_() });
  return {};
}
function seenPopup_(u, req) {
  var a = rawRows_('Anns').filter(function (x) { return x.id === String(req.id); })[0];
  if (!a) return {};
  update_('AnnSeen', annSeenRow_(a.id, u.id), { popupSeenAt: now_() });
  return {};
}

// ===================== SORĞULAR =====================
function surveyQuestions_() { return settingGet_('survey') || DEFAULT_SURVEY; }

function getSurveyQuestions_(u, req) {
  if (!can_(u, 'survey.edit') && !can_(u, 'survey.view') && !can_(u, 'survey.send')) throw fail_('İcazə yoxdur.', 'PERM');
  return { survey: surveyQuestions_(), canEdit: can_(u, 'survey.edit') };
}
function saveSurveyQuestions_(u, req) {
  need_(u, 'survey.edit');
  var cur = surveyQuestions_();
  var intro = str_(req.intro, 600) || cur.intro;
  var inQ = Array.isArray(req.questions) ? req.questions : [];
  var qs = [];
  inQ.forEach(function (q, i) {
    var text = str_(q.text, 300);
    if (!text) return;
    var type = ['scale5', 'choice', 'nps', 'text'].indexOf(q.type) !== -1 ? q.type : 'scale5';
    var o = { id: 'q' + (i + 1), type: type, text: text };
    if (type === 'choice') {
      var opts = (Array.isArray(q.options) ? q.options : []).map(function (x) { return str_(x, 60); }).filter(String);
      if (opts.length < 2) throw fail_('«' + text + '» sualı üçün ən azı 2 variant yazın.');
      o.options = opts;
      if (Array.isArray(q.bad)) o.bad = q.bad.map(function (x) { return str_(x, 60); }).filter(function (x) { return opts.indexOf(x) !== -1; });
    }
    if (q.teacher) o.teacher = true;
    if (q.optional || type === 'text') o.optional = true;
    qs.push(o);
  });
  if (!qs.length) throw fail_('Ən azı bir sual olmalıdır.');
  var next = { version: (Number(cur.version) || 1) + 1, intro: intro, questions: qs };
  settingSet_('survey', next);
  log_(u, 'survey', 'Sorğu suallarını dəyişdi', qs.length + ' sual · versiya ' + next.version);
  return { survey: next };
}

// Hədəf siyahısı: tələbələr və onların cari ay statusu
function surveyTargets_(u, req) {
  need_(u, 'survey.send');
  var mk = monthKey_();
  var surveys = rawRows_('Surveys');
  var byStudent = {};
  surveys.forEach(function (sv) {
    var key = sv.studentId;
    if (!byStudent[key]) byStudent[key] = [];
    byStudent[key].push(sv);
  });
  var courses = rows_('Courses');
  var out = rows_('Students').map(function (s) {
    var cs = courses.filter(function (c) { return idList_(c.studentIds).indexOf(s.id) !== -1; });
    var mine = (byStudent[s.id] || []).filter(function (sv) { return String(sv.sentAt).slice(0, 7) === mk; });
    var answered = mine.some(function (sv) { return sv.status === 'answered'; });
    var sent = mine.length > 0;
    return {
      id: s.id, name: s.name, parentPhone: s.parentPhone,
      courses: cs.map(function (c) { return { id: c.id, title: courseLabel_(c), teacherId: c.teacherId, teacherName: userName_(c.teacherId) }; }),
      status: answered ? 'answered' : (sent ? 'sent' : 'none')
    };
  }).sort(function (a, b) { return a.name.localeCompare(b.name, 'az'); });
  return { targets: out, monthKey: mk };
}

function sendSurvey_(u, req) {
  need_(u, 'survey.send');
  var s = mustStudent_(req.studentId);
  var cs = rows_('Courses').filter(function (c) { return idList_(c.studentIds).indexOf(s.id) !== -1; });
  if (!cs.length) throw fail_('Bu tələbə heç bir məşğələdə yoxdur.');
  var course = req.courseId ? cs.filter(function (c) { return c.id === String(req.courseId); })[0] : cs[0];
  if (!course) throw fail_('Məşğələ tapılmadı.');
  var mk = monthKey_();
  // Bu ay artıq cavablanmış sorğu varsa, yenisini yaratma
  var existing = rawRows_('Surveys').filter(function (sv) {
    return sv.studentId === s.id && String(sv.sentAt).slice(0, 7) === mk;
  });
  var answered = existing.filter(function (sv) { return sv.status === 'answered'; })[0];
  if (answered) throw fail_('Bu tələbə bu ay sorğunu artıq cavablandırıb.');
  var open = existing.filter(function (sv) { return sv.status === 'sent' && sv.courseId === course.id; })[0];
  var survey = surveyQuestions_();
  if (open) {
    log_(u, 'survey', 'Sorğu linkini yenidən götürdü', s.name);
    return link_(open, s, course);
  }
  var row = {
    id: newId_('SV'), token: newToken_(), studentId: s.id, courseId: course.id, teacherId: course.teacherId,
    monthNo: String(course.monthNo || 1), status: 'sent', qVersion: String(survey.version),
    questions: JSON.stringify(survey.questions), answers: '', sentBy: u.id, sentAt: now_(), answeredAt: '',
    adminStatus: '', adminNote: '', lowFlag: ''
  };
  insertMany_('Surveys', [row]);
  log_(u, 'survey', 'Sorğu linki göndərdi', s.name + ' · Müəllim: ' + userName_(course.teacherId) + ' · «' + courseLabel_(course) + '»');
  return link_(row, s, course);
}
function link_(sv, s, course) {
  return { token: sv.token, studentName: s.name, teacherName: userName_(course.teacherId), parentPhone: s.parentPhone, courseTitle: courseLabel_(course) };
}

function surveyResponses_(u, req) {
  need_(u, 'survey.view');
  var users = rows_('Users'), courses = rawRows_('Courses');
  var uMap = {}; users.forEach(function (x) { uMap[x.id] = x; });
  var cMap = {}; courses.forEach(function (c) { cMap[c.id] = c; });
  var all = rawRows_('Surveys').filter(function (sv) { return sv.status === 'answered'; });
  var teacherId = str_(req.teacherId, 40), monthK = str_(req.month, 7), low = !!req.low, onlyNew = !!req.onlyNew;
  var list = all.map(function (sv) {
    var ans = []; try { ans = JSON.parse(sv.answers || '[]'); } catch (e) {}
    var qs = []; try { qs = JSON.parse(sv.questions || '[]'); } catch (e) {}
    return {
      id: sv.id, studentName: studentName_(sv.studentId), teacherId: sv.teacherId, teacherName: uMap[sv.teacherId] ? uMap[sv.teacherId].name : '(silinmiş)',
      courseTitle: cMap[sv.courseId] ? courseLabel_(cMap[sv.courseId]) : '(silinmiş məşğələ)',
      monthKey: String(sv.answeredAt).slice(0, 7), answeredAt: sv.answeredAt,
      answers: qs.map(function (q) { var a = ans.filter(function (x) { return x.id === q.id; })[0]; return { q: q.text, type: q.type, value: a ? a.value : '' }; }),
      low: sv.lowFlag === 'true', adminStatus: sv.adminStatus || 'new', adminNote: sv.adminNote || '',
      teacherScore: teacherScore_(qs, ans)
    };
  });
  var filtered = list.filter(function (r) {
    if (teacherId && r.teacherId !== teacherId) return false;
    if (monthK && r.monthKey !== monthK) return false;
    if (low && !r.low) return false;
    if (onlyNew && r.adminStatus !== 'new') return false;
    return true;
  }).sort(function (a, b) { return a.answeredAt < b.answeredAt ? 1 : -1; });

  // Sводka: müəllim üzrə orta bal
  var byTeacher = {};
  list.forEach(function (r) {
    if (r.teacherScore == null) return;
    var k = r.teacherId;
    if (!byTeacher[k]) byTeacher[k] = { teacherId: k, teacherName: r.teacherName, sum: 0, n: 0, low: 0, total: 0 };
    byTeacher[k].sum += r.teacherScore; byTeacher[k].n++;
  });
  list.forEach(function (r) { var k = r.teacherId; if (byTeacher[k]) { byTeacher[k].total++; if (r.low) byTeacher[k].low++; } });
  var summary = Object.keys(byTeacher).map(function (k) {
    var t = byTeacher[k];
    return { teacherId: k, teacherName: t.teacherName, avg: t.n ? Math.round(t.sum / t.n * 10) / 10 : null, responses: t.total, low: t.low };
  }).sort(function (a, b) { return (b.avg || 0) - (a.avg || 0); });

  var months = {}; list.forEach(function (r) { months[r.monthKey] = (months[r.monthKey] || 0) + 1; });
  var monthList = Object.keys(months).sort().reverse();
  var teachers = {}; list.forEach(function (r) { teachers[r.teacherId] = r.teacherName; });

  return {
    responses: filtered, summary: summary, total: all.length, shown: filtered.length,
    months: monthList, teachers: Object.keys(teachers).map(function (k) { return { id: k, name: teachers[k] }; })
  };
}
function teacherScore_(qs, ans) {
  var sum = 0, n = 0;
  qs.forEach(function (q) {
    if (q.type === 'scale5' && q.teacher) {
      var a = ans.filter(function (x) { return x.id === q.id; })[0];
      if (a && Number(a.value) >= 1) { sum += Number(a.value); n++; }
    }
  });
  return n ? Math.round(sum / n * 10) / 10 : null;
}
function setSurveyStatus_(u, req) {
  need_(u, 'survey.view');
  var sv = rawRows_('Surveys').filter(function (x) { return x.id === String(req.id); })[0];
  if (!sv) throw fail_('Cavab tapılmadı.');
  var st = ['new', 'reviewed', 'contacted'].indexOf(req.status) !== -1 ? req.status : sv.adminStatus;
  var note = str_(req.note, 500);
  update_('Surveys', sv, { adminStatus: st, adminNote: note });
  var lbl = { new: 'Yeni', reviewed: 'Baxıldı', contacted: 'Valideynlə əlaqə saxlanıldı' };
  log_(u, 'survey', 'Sorğu cavabının statusunu dəyişdi', studentName_(sv.studentId) + ' → ' + (lbl[st] || st) + (note ? ' · ' + note : ''));
  return {};
}

// ---- Public survey ----
function publicSurveyInfo_(req) {
  var sv = rawRows_('Surveys').filter(function (x) { return x.token === String(req.token || ''); })[0];
  if (!sv) throw fail_('Sorğu tapılmadı. Link yanlışdır.', 'NOTFOUND');
  if (sv.status === 'answered') return { state: 'answered' };
  if (ageHours_(sv.sentAt) > SURVEY_TTL_DAYS * 24) return { state: 'expired' };
  var qs = []; try { qs = JSON.parse(sv.questions || '[]'); } catch (e) {}
  var survey = surveyQuestions_();
  var course = findCourse_(sv.courseId);
  return {
    state: 'open',
    studentName: studentName_(sv.studentId),
    teacherName: userName_(sv.teacherId),
    courseTitle: course ? courseLabel_(course) : '',
    intro: survey.intro || DEFAULT_SURVEY.intro,
    questions: qs
  };
}
function submitSurvey_(req) {
  var sv = rawRows_('Surveys').filter(function (x) { return x.token === String(req.token || ''); })[0];
  if (!sv) throw fail_('Sorğu tapılmadı. Link yanlışdır.', 'NOTFOUND');
  if (sv.status === 'answered') return { state: 'answered' };
  if (ageHours_(sv.sentAt) > SURVEY_TTL_DAYS * 24) return { state: 'expired' };
  var qs = []; try { qs = JSON.parse(sv.questions || '[]'); } catch (e) {}
  var inAns = {};
  (Array.isArray(req.answers) ? req.answers : []).forEach(function (a) { if (a && a.id) inAns[a.id] = a.value; });
  var out = [], low = false;
  qs.forEach(function (q) {
    var v = inAns[q.id];
    if (q.type === 'scale5') {
      var n = Number(v);
      if (!(n >= 1 && n <= 5)) throw fail_('Bütün suallara cavab verin.');
      if (n <= 2) low = true;
      out.push({ id: q.id, value: n });
    } else if (q.type === 'nps') {
      var m = Number(v);
      if (!(m >= 0 && m <= 10)) throw fail_('Bütün suallara cavab verin.');
      if (m <= 6) low = true;
      out.push({ id: q.id, value: m });
    } else if (q.type === 'choice') {
      if ((q.options || []).indexOf(v) === -1) throw fail_('Bütün suallara cavab verin.');
      if ((q.bad || []).indexOf(v) !== -1) low = true;
      out.push({ id: q.id, value: v });
    } else { // text
      out.push({ id: q.id, value: str_(v, 1000) });
    }
  });
  update_('Surveys', sv, { status: 'answered', answers: JSON.stringify(out), answeredAt: now_(), lowFlag: low ? 'true' : 'false', adminStatus: 'new' });
  notify_(adminsFor_('survey.view', ''), 'survey', 'Yeni sorğu cavabı: ' + studentName_(sv.studentId) + (low ? ' (aşağı qiymət!)' : ''), 'tools', 'surveys');
  return { state: 'done' };
}

// ---- Public card ----
function publicCard_(req) {
  var s = rows_('Students').filter(function (x) { return x.cardToken && x.cardToken === String(req.token || ''); })[0];
  if (!s) throw fail_('Tələbə tapılmadı. Link yanlışdır.', 'NOTFOUND');
  return { card: buildCard_(s, null, true) };
}

// ===================== ALƏTLƏR =====================
function trashList_(u, req) {
  need_(u, 'tools.trash');
  var purgeHint = TRASH_DAYS;
  var out = { students: [], users: [], courses: [], exams: [], purgeDays: purgeHint };
  var resCount = {};
  if (trashRows_('Exams').length) examIndex_().forEach(function (x) { resCount[x.examId] = (resCount[x.examId] || 0) + 1; });
  trashRows_('Exams').forEach(function (e) {
    out.exams.push({ id: e.id, title: e.title, teacherName: userName_(e.teacherId), attempts: resCount[e.id] || 0,
      deletedAt: e.deletedAt, deletedBy: userName_(e.deletedBy), daysLeft: daysLeft_(e.deletedAt) });
  });
  trashRows_('Students').forEach(function (s) {
    out.students.push({ id: s.id, name: s.name, phone: s.phone, deletedAt: s.deletedAt, deletedBy: userName_(s.deletedBy), daysLeft: daysLeft_(s.deletedAt) });
  });
  trashRows_('Users').forEach(function (x) {
    out.users.push({ id: x.id, name: x.name, login: x.login, role: x.role, deletedAt: x.deletedAt, deletedBy: userName_(x.deletedBy), daysLeft: daysLeft_(x.deletedAt) });
  });
  trashRows_('Courses').forEach(function (c) {
    out.courses.push({ id: c.id, title: courseLabel_(c), type: c.type, teacherName: userName_(c.teacherId), deletedAt: c.deletedAt, deletedBy: userName_(c.deletedBy), daysLeft: daysLeft_(c.deletedAt) });
  });
  return out;
}
function daysLeft_(deletedAt) { return Math.max(0, Math.ceil(TRASH_DAYS - ageHours_(deletedAt) / 24)); }

function restoreItem_(u, req) {
  need_(u, 'tools.trash');
  var kind = req.kind, sheet = { student: 'Students', user: 'Users', course: 'Courses', exam: 'Exams' }[kind];
  if (!sheet) throw fail_('Naməlum element.');
  var r = trashRows_(sheet).filter(function (x) { return x.id === String(req.id); })[0];
  if (!r) throw fail_('Element tapılmadı.');
  if (sheet === 'Users') {
    var dup = rows_('Users').filter(function (x) { return lower_(x.login) === lower_(r.login); })[0];
    if (dup) throw fail_('«' + r.login + '» logini artıq istifadə olunur. Bərpadan əvvəl digərini dəyişin.');
  }
  update_(sheet, r, { deletedAt: '', deletedBy: '' });
  var nm = sheet === 'Courses' ? courseLabel_(r) : (sheet === 'Exams' ? r.title : r.name);
  log_(u, 'trash', 'Zibildən bərpa etdi', TRASH_KIND[kind] + ': ' + nm);
  return {};
}
var TRASH_KIND = { student: 'Tələbə', user: 'İstifadəçi', course: 'Məşğələ', exam: 'İmtahan' };
function purgeItem_(u, req) {
  need_(u, 'tools.trash');
  var kind = req.kind, sheet = { student: 'Students', user: 'Users', course: 'Courses', exam: 'Exams' }[kind];
  if (!sheet) throw fail_('Naməlum element.');
  var r = trashRows_(sheet).filter(function (x) { return x.id === String(req.id); })[0];
  if (!r) throw fail_('Element tapılmadı.');
  var nm = sheet === 'Courses' ? courseLabel_(r) : (sheet === 'Exams' ? r.title : r.name);
  var extra = '';
  if (sheet === 'Courses') {
    var lr = rows_('Lessons').filter(function (l) { return l.courseId === r.id; });
    if (lr.length) removeRows_('Lessons', lr.map(function (l) { return l._row; }));
  }
  if (sheet === 'Exams') {
    need_(u, 'exams.delete');
    var gone = examPurgeResults_([r.id]);
    extra = ' · ' + gone + ' nəticə ilə birlikdə';
    r = trashRows_('Exams').filter(function (x) { return x.id === String(req.id); })[0];   // sətir nömrəsi təzələnir
  }
  removeRows_(sheet, [r._row]);
  log_(u, 'trash', 'Həmişəlik sildi', TRASH_KIND[kind] + ': ' + nm + extra);
  return {};
}

function teacherLeave_(u, req) {
  need_(u, 'tools.bulk');
  var t = mustUser_(req.teacherId);
  var to = mustUser_(req.toTeacherId);
  if (t.id === to.id) throw fail_('Eyni müəllim seçildi.');
  if (to.role !== 'teacher' && to.role !== 'superadmin') throw fail_('Hədəf müəllim düzgün deyil.');
  var cs = rows_('Courses').filter(function (c) { return c.teacherId === t.id; });
  if (!cs.length) throw fail_('Bu müəllimin məşğələsi yoxdur.');
  cs.forEach(function (c) { update_('Courses', c, { teacherId: to.id, updatedAt: now_() }); });
  log_(u, 'course', 'Müəllimin məşğələlərini köçürdü', cs.length + ' məşğələ: ' + t.name + ' → ' + to.name);
  if (to.id !== u.id) notify_([to.id], 'course', cs.length + ' məşğələ sizə köçürüldü (əvvəlki müəllim: ' + t.name + ').', 'mine', '');
  return { moved: cs.length };
}

function moveStudents_(u, req) {
  need_(u, 'tools.bulk');
  var from = mustCourse_(req.fromCourseId);
  var to = mustCourse_(req.toCourseId);
  if (from.id === to.id) throw fail_('Mənbə və hədəf eyni ola bilməz.');
  if (to.type === 'individual') throw fail_('Fərdi məşğələyə köçürmək olmaz.');
  var ids = (Array.isArray(req.studentIds) ? req.studentIds : []).map(String);
  var fromIds = idList_(from.studentIds);
  ids = ids.filter(function (id) { return fromIds.indexOf(id) !== -1; });
  if (!ids.length) throw fail_('Köçürüləcək tələbə seçilməyib.');
  if (from.type === 'group' && fromIds.length - ids.length < 2 && fromIds.length - ids.length > 0) throw fail_('Köçürmədən sonra mənbə qrupda 2-dən az tələbə qalır.');
  var toIds = idList_(to.studentIds);
  ids.forEach(function (id) { if (toIds.indexOf(id) === -1) toIds.push(id); });
  update_('Courses', from, { studentIds: fromIds.filter(function (x) { return ids.indexOf(x) === -1; }).join(','), updatedAt: now_() });
  update_('Courses', to, { studentIds: toIds.join(','), updatedAt: now_() });
  ids.forEach(function (id) { insertMany_('Transfers', [{ id: newId_('T'), studentId: id, fromCourseId: from.id, toCourseId: to.id, byUser: u.id, at: now_(), note: 'Toplu köçürmə' }]); });
  log_(u, 'transfer', 'Tələbələri köçürdü', ids.length + ' tələbə: «' + courseLabel_(from) + '» → «' + courseLabel_(to) + '»');
  return { moved: ids.length };
}

function dataCheck_(u, req) {
  need_(u, 'tools.datacheck');
  var issues = [];
  var students = rows_('Students'), courses = rows_('Courses'), lessons = rows_('Lessons'), payments = rows_('Payments');
  var sIds = {}; students.forEach(function (s) { sIds[s.id] = true; });
  var cIds = {}; courses.forEach(function (c) { cIds[c.id] = true; });

  // Dubl tələbələr (ad üzrə)
  var byName = {};
  students.forEach(function (s) { var k = fold_(s.name); (byName[k] = byName[k] || []).push(s.name); });
  Object.keys(byName).forEach(function (k) { if (byName[k].length > 1) issues.push({ type: 'warn', text: 'Eyni adlı tələbələr: ' + byName[k].join(', ') }); });
  // Dubl telefon
  var byPhone = {};
  students.forEach(function (s) { var d = digits_(s.phone); if (d.length >= 7) (byPhone[d] = byPhone[d] || []).push(s.name); });
  Object.keys(byPhone).forEach(function (k) { if (byPhone[k].length > 1) issues.push({ type: 'warn', text: 'Eyni telefon: ' + byPhone[k].join(', ') }); });

  // Boş və ya tək tələbəli qruplar
  courses.forEach(function (c) {
    var ids = idList_(c.studentIds).filter(function (id) { return sIds[id]; });
    if (ids.length === 0) issues.push({ type: 'err', text: '«' + courseLabel_(c) + '» məşğələsində tələbə yoxdur.' });
    else if (c.type === 'group' && ids.length < 2) issues.push({ type: 'warn', text: '«' + courseLabel_(c) + '» qrupunda cəmi 1 tələbə var.' });
    var missing = idList_(c.studentIds).filter(function (id) { return !sIds[id]; });
    if (missing.length) issues.push({ type: 'err', text: '«' + courseLabel_(c) + '» məşğələsində silinmiş tələbəyə istinad var (' + missing.length + ').' });
    // Normadan artıq keçid
    var m = Number(c.monthNo) || 1, N = Number(c.lessonsPerMonth) || 8;
    if (heldIn_(c.id, m, null) > N) issues.push({ type: 'err', text: '«' + courseLabel_(c) + '»: cari ayda keçirilən dərs sayı normadan (' + N + ') çoxdur.' });
  });

  // Silinmiş məşğələyə bağlı dərslər / ödənişlər (aktiv olmayan kurs)
  var lessonOrphan = 0, lessonSet = {};
  lessons.forEach(function (l) { if (!cIds[l.courseId]) lessonSet[l.courseId] = true; });
  lessonOrphan = Object.keys(lessonSet).length;
  if (lessonOrphan) issues.push({ type: 'info', text: lessonOrphan + ' məşğələyə aid dərs qeydləri var, lakin məşğələ artıq aktiv deyil (silinib).' });
  var payOrphanS = payments.filter(function (p) { return !sIds[p.studentId]; }).length;
  if (payOrphanS) issues.push({ type: 'warn', text: payOrphanS + ' ödəniş silinmiş tələbəyə aiddir.' });
  examCheck_(issues, sIds);
  var tc = testCounts_(testScope_());
  if (tc.teachers || tc.students || tc.courses) issues.push({ type: 'info', text: 'Sistemdə test məlumatları var: ' + tc.teachers + ' müəllim, ' + tc.students + ' tələbə, ' + tc.courses + ' məşğələ. Developer onları bir düymə ilə silə bilər.' });

  log_(u, 'tools', 'Məlumatları yoxladı', 'Tapılan problem sayı: ' + issues.length);
  return { issues: issues, counts: { students: students.length, courses: courses.length, lessons: lessons.length, payments: payments.length } };
}

// ===================== YENİLİKLƏR (Changelog) =====================
function listChangelog_(u, req) {
  return { items: rawRows_('Changelog').sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; }).map(function (c) {
    return { id: c.id, title: c.title, body: c.body, kind: c.kind || 'update', createdAt: c.createdAt, by: userName_(c.createdBy) };
  }), canEdit: u.role === 'developer' };
}
function addChangelog_(u, req) {
  if (u.role !== 'developer') throw fail_('Yalnız developer yenilik əlavə edə bilər.', 'PERM');
  var title = reqStr_(req.title, 'Başlıq', 2, 160);
  var body = str_(req.body, 3000);
  var kind = ['update', 'fix', 'new'].indexOf(req.kind) !== -1 ? req.kind : 'update';
  if (req.id) {
    var c = rawRows_('Changelog').filter(function (x) { return x.id === String(req.id); })[0];
    if (!c) throw fail_('Qeyd tapılmadı.');
    var was = c.title;
    update_('Changelog', c, { title: title, body: body, kind: kind });
    log_(u, 'dev', 'Yeniliyi redaktə etdi', was === title ? title : '«' + was + '» → «' + title + '»');
    return { id: c.id };
  }
  var id = newId_('CL');
  insertMany_('Changelog', [{ id: id, title: title, body: body, kind: kind, createdBy: u.id, createdAt: now_() }]);
  log_(u, 'dev', 'Yenilik əlavə etdi', title);
  return { id: id };
}
function deleteChangelog_(u, req) {
  if (u.role !== 'developer') throw fail_('İcazə yoxdur.', 'PERM');
  var c = rawRows_('Changelog').filter(function (x) { return x.id === String(req.id); })[0];
  if (!c) throw fail_('Qeyd tapılmadı.');
  removeRows_('Changelog', [c._row]);
  log_(u, 'dev', 'Yeniliyi sildi', c.title);
  return {};
}
// İstifadəçi «Yeniliklər»i açdı — sayğac sıfırlanır. Jurnala yalnız oxunmamış qeyd olanda yazılır.
function markNewsSeen_(u, req) {
  if (u.role === 'developer') return { unread: 0 };
  var seen = newsSeenAt_(u);
  var fresh = rawRows_('Changelog').filter(function (c) { return c.createdAt > seen; });
  if (!fresh.length) return { unread: 0 };
  update_('Users', u, { newsSeenAt: now_() });
  log_(u, 'view', 'Yenilikləri oxudu', fresh.length + ' yeni qeyd: ' + fresh.map(function (c) { return c.title; }).slice(0, 5).join('; '));
  return { unread: 0 };
}

// ===================== DEVELOPER =====================
function setMaintenance_(u, req) {
  if (u.role !== 'developer') throw fail_('Yalnız developer texniki rejimi idarə edə bilər.', 'PERM');
  var on = !!req.on;
  var text = on ? str_(req.text, 300) : '';            // developerin əlavə qeydi (istəyə bağlı)
  var minutes = on ? Number(req.minutes) || 0 : 0;      // təxmini müddət (0 = naməlum)
  if ([0, 15, 30, 60, 120, 240].indexOf(minutes) === -1) minutes = 0;
  var until = minutes ? Utilities.formatDate(new Date(Date.now() + minutes * 60000), TIMEZONE, 'yyyy-MM-dd HH:mm:ss') : '';
  settingSet_('maintenance', { on: on, text: text, until: until, by: u.name, at: now_() });
  log_(u, 'dev', on ? 'Texniki rejimi açdı' : 'Texniki rejimi bağladı',
    on ? ((minutes ? 'Təxmini müddət: ' + minutes + ' dəq' : 'Müddət göstərilməyib') + (text ? ' · Qeyd: ' + text : '')) : '');
  return { maintenance: maint_() };
}
function devStats_(u, req) {
  if (u.role !== 'developer' && u.role !== 'superadmin') throw fail_('İcazə yoxdur.', 'PERM');
  var sheets = {};
  Object.keys(SCHEMA).forEach(function (name) { sheets[name] = rawRows_(name).length; });
  var surveys = rawRows_('Surveys');
  return {
    sheets: sheets,
    students: rows_('Students').length, trashStudents: trashRows_('Students').length,
    courses: rows_('Courses').length, users: rows_('Users').length,
    lessons: rawRows_('Lessons').length, surveysSent: surveys.length, surveysAnswered: surveys.filter(function (s) { return s.status === 'answered'; }).length,
    surveyVersion: surveyQuestions_().version, now: now_()
  };
}

// ===================== TEST MƏLUMATLARI (yalnız developer) =====================
// Bütün yaradılan qeydlərin adı «Test» sözü ilə başlayır və isTest=true işarəsi daşıyır —
// bir düymə ilə tam silinir. Telefon nömrələri yazılmır (təsadüfən real nömrəyə mesaj getməsin).
var TEST_NAMES_F = ['Aysel', 'Nigar', 'Leyla', 'Günay', 'Səbinə', 'Nərmin', 'Aynur', 'Fidan', 'Zəhra', 'Lalə', 'Aytac', 'Könül'];
var TEST_NAMES_M = ['Kamran', 'Tural', 'Orxan', 'Elvin', 'Rauf', 'Murad', 'Fərid', 'Nicat', 'Ülvi', 'Rəşad', 'Samir', 'Emil'];
var TEST_SURNAMES = ['Əliyev', 'Məmmədov', 'Həsənov', 'Hüseynov', 'Quliyev', 'Cəfərov', 'Kərimov', 'İsmayılov', 'Rəhimov', 'Abbasov', 'Nəsirov', 'Babayev'];
var TEST_SUBJECTS = ['İngilis dili', 'Rus dili', 'Riyaziyyat', 'Alman dili', 'Fizika', 'Kimya'];
var TEST_TOPICS = ['Present Simple', 'Past Simple', 'Lüğət: ailə', 'Oxu tapşırığı', 'Danışıq praktikası', 'Test işi', 'Dinləmə', 'Qrammatika təkrarı', ''];
var TEST_REASONS = ['Xəstə idi', 'Ailə səbəbi', 'Səfərdə idi', 'Xəbər vermədi'];
var TEST_PASSWORD = 'test1234';

function needDev_(u) { if (u.role !== 'developer') throw fail_('Bu əməliyyat yalnız developer üçündür.', 'PERM'); }
function pick_(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function daysAgo_(n) { return Utilities.formatDate(new Date(Date.now() - n * 864e5), TIMEZONE, 'yyyy-MM-dd'); }
function testPerson_() {
  var female = Math.random() < 0.5;
  var sur = pick_(TEST_SURNAMES);
  return 'Test ' + (female ? pick_(TEST_NAMES_F) : pick_(TEST_NAMES_M)) + ' ' + (female ? sur + 'a' : sur);
}

// Test qeydləri və onlardan asılı sətirlər (silinmə üçün də istifadə olunur)
function testScope_() {
  var tU = {}, tS = {}, tC = {};
  rawRows_('Users').forEach(function (x) { if (isTrue_(x.isTest)) tU[x.id] = x; });
  rawRows_('Students').forEach(function (x) { if (isTrue_(x.isTest)) tS[x.id] = x; });
  rawRows_('Courses').forEach(function (x) { if (isTrue_(x.isTest)) tC[x.id] = x; });
  var lessons = rawRows_('Lessons').filter(function (l) { return tC[l.courseId] || tS[l.studentId]; });
  var payments = rawRows_('Payments').filter(function (p) { return tS[p.studentId] || tC[p.courseId]; });
  var transfers = rawRows_('Transfers').filter(function (t) { return tS[t.studentId] || tC[t.fromCourseId] || tC[t.toCourseId]; });
  var surveys = rawRows_('Surveys').filter(function (s) { return tS[s.studentId] || tC[s.courseId] || tU[s.teacherId]; });
  var notifs = rawRows_('Notifs').filter(function (n) { return tU[n.userId]; });
  var annSeen = rawRows_('AnnSeen').filter(function (n) { return tU[n.userId]; });
  // İmtahanlar: test işarəli və ya test müəllimə aid imtahanlar; test tələbələrin bütün cəhdləri
  var tE = {};
  rawRows_('Exams').forEach(function (x) { if (isTrue_(x.isTest) || tU[x.teacherId]) tE[x.id] = x; });
  var examRes = examIndex_().filter(function (a) { return tE[a.examId] || tS[a.studentId]; });
  var realExams = rawRows_('Exams').filter(function (e) { return !tE[e.id] && idList_(e.studentIds).some(function (id) { return tS[id]; }); });
  // Real (test olmayan) məşğələ test müəllimə bağlıdırsa — silmək olmaz, əvvəlcə müəllimi dəyişmək lazımdır
  var conflicts = rows_('Courses').filter(function (c) { return !tC[c.id] && tU[c.teacherId]; });
  var realWithTestStudents = rawRows_('Courses').filter(function (c) {
    return !tC[c.id] && idList_(c.studentIds).some(function (id) { return tS[id]; });
  });
  return { tU: tU, tS: tS, tC: tC, tE: tE, examRes: examRes, realExams: realExams, lessons: lessons, payments: payments, transfers: transfers, surveys: surveys,
    notifs: notifs, annSeen: annSeen, conflicts: conflicts, realWithTestStudents: realWithTestStudents };
}
function testCounts_(sc) {
  var lessonIds = {}; sc.lessons.forEach(function (l) { lessonIds[l.lessonId] = true; });
  return {
    teachers: Object.keys(sc.tU).length, students: Object.keys(sc.tS).length, courses: Object.keys(sc.tC).length,
    lessons: Object.keys(lessonIds).length, payments: sc.payments.length, exams: Object.keys(sc.tE).length,
    other: sc.transfers.length + sc.surveys.length + sc.notifs.length + sc.annSeen.length + sc.examRes.length
  };
}
function testDataInfo_(u, req) {
  needDev_(u);
  var sc = testScope_();
  return {
    counts: testCounts_(sc), password: TEST_PASSWORD, limits: TEST_LIMITS,
    conflicts: sc.conflicts.map(function (c) { return courseLabel_(c) + ' (müəllim: ' + userName_(c.teacherId) + ')'; }),
    mixed: sc.realWithTestStudents.length
  };
}

function genTestData_(u, req) {
  needDev_(u);
  var n = function (k, min) {
    var v = Math.floor(Number(req[k]) || 0);
    if (v < (min || 0) || v > TEST_LIMITS[k]) throw fail_('Say düzgün deyil: ' + k + ' (0–' + TEST_LIMITS[k] + ').');
    return v;
  };
  var nT = n('teachers'), nS = n('students'), nC = n('courses'), nL = n('lessons');
  var mix = ['mixed', 'individual', 'group'].indexOf(req.mix) !== -1 ? req.mix : 'mixed';
  var withPay = !!req.payments, withPast = !!req.pastMonth, withExams = !!req.exams;
  if (!nT && !nS && !nC) throw fail_('Heç olmasa bir rəqəm daxil edin.');

  var stamp = now_(), today = today_();
  var users = rawRows_('Users');
  var logins = {}; users.forEach(function (x) { logins[String(x.login).toLowerCase()] = true; });
  var seq = 1;
  var nextLogin = function () { var l; do { l = 'test' + (seq < 10 ? '0' : '') + seq; seq++; } while (logins[l]); logins[l] = true; return l; };

  // 1) Müəllimlər
  var newU = [];
  var mkTeacher = function () {
    var row = { id: newId_('U'), name: testPerson_(), login: nextLogin(), password: TEST_PASSWORD, role: 'teacher', phone: '',
      permissions: '', theme: 'light', createdAt: stamp, updatedAt: '', deletedAt: '', deletedBy: '', isTest: 'true' };
    newU.push(row); return row;
  };
  for (var i = 0; i < nT; i++) mkTeacher();

  // 2) Tələbələr
  var newS = [];
  var mkStudent = function () {
    var row = { id: newId_('S'), name: testPerson_(), phone: '', parentName: '', parentPhone: '',
      note: '', cardToken: newToken_(), status: 'active', createdAt: stamp, updatedAt: '', deletedAt: '', deletedBy: '', isTest: 'true' };
    newS.push(row); return row;
  };
  for (i = 0; i < nS; i++) mkStudent();

  // 3) Məşğələlər + dərslər + ödənişlər
  var newC = [], newL = [], newP = [], lessonCount = 0, autoT = 0, autoS = 0;
  if (nC) {
    var teacherPool = newU.slice();
    if (!teacherPool.length) teacherPool = rows_('Users').filter(function (x) { return isTrue_(x.isTest) && x.role === 'teacher'; });
    if (!teacherPool.length) { teacherPool = [mkTeacher()]; autoT = 1; }
    var studentPool = newS.slice();
    if (studentPool.length < 2) studentPool = studentPool.concat(rows_('Students').filter(function (x) { return isTrue_(x.isTest); }));
    var need = mix === 'individual' ? 1 : 2;
    while (studentPool.length < need) { studentPool.push(mkStudent()); autoS++; }
    var sp = 0;
    var takeStudents = function (k) {
      var out = [];
      for (var j = 0; j < k && out.length < studentPool.length; j++) {
        var s = studentPool[sp % studentPool.length]; sp++;
        if (out.indexOf(s.id) === -1) out.push(s.id);
      }
      return out;
    };
    for (i = 0; i < nC; i++) {
      var type = mix === 'mixed' ? (i % 3 === 2 ? 'group' : 'individual') : mix;
      if (type === 'group' && studentPool.length < 2) type = 'individual';
      var ids = takeStudents(type === 'group' ? Math.min(studentPool.length, 2 + Math.floor(Math.random() * 4)) : 1);
      if (type === 'group' && ids.length < 2) type = 'individual';
      var N = Math.random() < 0.7 ? 8 : 12;
      var t = teacherPool[i % teacherPool.length];
      var past = withPast && i % 2 === 0;
      var cur = past ? 2 : 1;
      var lessonsNow = Math.min(nL, N);
      var span = Math.max(lessonsNow, 1) * 3;           // cari ayın dərsləri təxminən 3 gündən bir
      var monthStart = daysAgo_(span);
      var c = { id: newId_('C'), title: type === 'group' ? 'Test qrup ' + (i + 1) + ' — ' + pick_(TEST_SUBJECTS) : '', type: type,
        teacherId: t.id, studentIds: ids.join(','), lessonsPerMonth: String(N), monthNo: String(cur), monthStart: monthStart,
        createdAt: stamp, updatedAt: '', deletedAt: '', deletedBy: '', isTest: 'true' };
      newC.push(c);
      var mkLessons = function (month, count, startAgo, spacing) {
        for (var k = 0; k < count; k++) {
          var ago = Math.max(0, startAgo - k * spacing);
          var date = daysAgo_(ago);
          var lessonId = newId_('D');
          var topic = pick_(TEST_TOPICS);
          var markedAt = ago === 0 ? stamp : date + ' 18:' + (10 + Math.floor(Math.random() * 40)) + ':00';
          var anyHeld = false;
          var rows = ids.map(function (sid) {
            var held = Math.random() < 0.86;
            if (held) anyHeld = true;
            return { sid: sid, held: held };
          });
          if (!anyHeld && Math.random() < 0.6) { rows[0].held = true; anyHeld = true; }
          rows.forEach(function (r) {
            newL.push({ id: newId_('A'), lessonId: lessonId, courseId: c.id, monthNo: String(month), date: date, studentId: r.sid,
              status: r.held ? HELD : ABSENT, reason: r.held ? '' : pick_(TEST_REASONS), topic: topic,
              markedBy: t.id, markedAt: markedAt, editedBy: '', editedAt: '' });
          });
          lessonCount++;
        }
      };
      // Keçmiş ay: tam keçirilmiş (N dərs), cari aydan əvvəl
      if (past) mkLessons(1, N, span + 3 + (N - 1) * 3, 3);
      if (lessonsNow) mkLessons(cur, lessonsNow, (lessonsNow - 1) * 3, 3);
      if (withPay) {
        ids.forEach(function (sid, idx) {
          var amount = String(pick_([80, 100, 120, 150]));
          if (past && (idx + i) % 2 === 0) newP.push({ id: newId_('P'), studentId: sid, courseId: c.id, monthNo: '1', amount: amount, date: monthStart, note: 'Test ödənişi', createdBy: u.id, createdAt: stamp });
          if (Math.random() < 0.6) newP.push({ id: newId_('P'), studentId: sid, courseId: c.id, monthNo: String(cur), amount: amount, date: today, note: 'Test ödənişi', createdBy: u.id, createdAt: stamp });
        });
      }
    }
  }

  // Cari ayın dərs sayı aylıq limitdən (8/12) çox ola bilməz — lessonsNow = min(nL, N)
  insertMany_('Users', newU);
  insertMany_('Students', newS);
  insertMany_('Courses', newC);
  insertMany_('Lessons', newL);
  insertMany_('Payments', newP);

  // Nümunə imtahanlar: məşğələsi olan hər test müəllimə bir imtahan (bir neçə hazır nəticə ilə)
  var newE = [], newR = [];
  if (withExams && newC.length) {
    var byT = {};
    newC.forEach(function (c) { var l = byT[c.teacherId] || (byT[c.teacherId] = []); idList_(c.studentIds).forEach(function (id) { if (l.indexOf(id) === -1 && l.length < 12) l.push(id); }); });
    Object.keys(byT).slice(0, 10).forEach(function (tid, k) {
      var pack = examTestRows_(tid, byT[tid], u.id, stamp, k + 1);
      newE.push(pack.exam); newR = newR.concat(pack.results);
    });
    insertMany_('Exams', newE);
    insertMany_('ExamResults', newR);
  }

  var res = { teachers: newU.length, students: newS.length, courses: newC.length, lessons: lessonCount, payments: newP.length, exams: newE.length, examResults: newR.length,
    logins: newU.map(function (x) { return x.login; }), password: TEST_PASSWORD, autoTeachers: autoT, autoStudents: autoS };
  log_(u, 'dev', 'Test məlumatları yaratdı',
    res.teachers + ' müəllim, ' + res.students + ' tələbə, ' + res.courses + ' məşğələ, ' + res.lessons + ' dərs, ' + res.payments + ' ödəniş' +
    (res.exams ? ', ' + res.exams + ' imtahan (' + res.examResults + ' nəticə)' : '') + (withPast ? ' · keçmiş ay ilə' : ''));
  return res;
}

function purgeTestData_(u, req) {
  needDev_(u);
  var sc = testScope_();
  if (sc.conflicts.length) {
    throw fail_('Bu real məşğələlər test müəllimə bağlıdır: ' + sc.conflicts.map(courseLabel_).join(', ') +
      '. Əvvəlcə onlara başqa müəllim təyin edin, sonra yenidən cəhd edin.');
  }
  var counts = testCounts_(sc);
  if (!counts.teachers && !counts.students && !counts.courses) return { removed: counts };
  // Real məşğələlərdən test tələbələri çıxar (qrupun real tələbələri qalır)
  sc.realWithTestStudents.forEach(function (c) {
    var keep = idList_(c.studentIds).filter(function (id) { return !sc.tS[id]; });
    update_('Courses', c, { studentIds: keep.join(','), updatedAt: now_() });
  });
  var rowsOf = function (list) { return list.map(function (r) { return r._row; }); };
  // İmtahanlar: test cəhdləri və test imtahanları silinir; real imtahanların təyinatından test tələbələr çıxarılır
  sc.realExams.forEach(function (e) {
    var keep = idList_(e.studentIds).filter(function (id) { return !sc.tS[id]; });
    var keys = parseJson_(e.keys, {}), nk = {}; keep.forEach(function (id) { if (keys[id]) nk[id] = keys[id]; });
    update_('Exams', e, { studentIds: keep.join(','), keys: JSON.stringify(nk), updatedAt: now_() });
  });
  removeRows_('ExamResults', rowsOf(sc.examRes));
  removeRows_('Exams', Object.keys(sc.tE).map(function (k) { return sc.tE[k]._row; }));
  removeRows_('Lessons', rowsOf(sc.lessons));
  removeRows_('Payments', rowsOf(sc.payments));
  removeRows_('Transfers', rowsOf(sc.transfers));
  removeRows_('Surveys', rowsOf(sc.surveys));
  removeRows_('Notifs', rowsOf(sc.notifs));
  removeRows_('AnnSeen', rowsOf(sc.annSeen));
  var objRows = function (map) { return Object.keys(map).map(function (k) { return map[k]._row; }); };
  removeRows_('Courses', objRows(sc.tC));
  removeRows_('Students', objRows(sc.tS));
  removeRows_('Users', objRows(sc.tU));
  log_(u, 'dev', 'Bütün test məlumatlarını sildi',
    counts.teachers + ' müəllim, ' + counts.students + ' tələbə, ' + counts.courses + ' məşğələ, ' + counts.lessons + ' dərs, ' + counts.payments + ' ödəniş' +
    (counts.exams ? ', ' + counts.exams + ' imtahan' : '') +
    (sc.realWithTestStudents.length ? ' · ' + sc.realWithTestStudents.length + ' real məşğələdən test tələbələri çıxarıldı' : ''));
  return { removed: counts, cleanedReal: sc.realWithTestStudents.length };
}

// ===================== ARXİV =====================
function monthsAgo_(n) {
  var d = new Date();
  d.setMonth(d.getMonth() - n);
  return Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
}
function archiveRowDate_(r, col) { return String(r[col] || '').slice(0, 10); }
function addDays_(s, days) {
  var t = new Date(String(s).replace(' ', 'T') + TZ_OFFSET).getTime();
  if (isNaN(t)) return '';
  return Utilities.formatDate(new Date(t + days * 864e5), TIMEZONE, 'yyyy-MM-dd');
}

/**
 * Seçilmiş vərəqdə arxivləşəcək sətirlər.
 * p = { cutoff | from/to, userId, type } — userId/type yalnız jurnal üçün.
 * Qorunanlar: aktiv elanlar və hələ açıq olan sorğu linkləri heç vaxt arxivlənmir.
 */
function archiveCandidates_(name, p) {
  var col = ARCHIVE_SHEETS[name];
  if (!col) return [];
  return rawRows_(name).filter(function (r) {
    var d = archiveRowDate_(r, col);
    if (!d) return false;
    if (p.from || p.to) {
      if (p.from && d < p.from) return false;
      if (p.to && d > p.to) return false;
    } else if (!(d < p.cutoff)) return false;
    if (name === 'Logs') {
      if (p.userId && r.userId !== p.userId) return false;
      if (p.type && r.type !== p.type) return false;
    }
    if (name === 'Anns' && (r.active === 'true' || r.active === '1')) return false;
    if (name === 'Surveys' && r.status === 'sent' && ageHours_(r.sentAt) <= SURVEY_TTL_DAYS * 24) return false;
    return true;
  });
}

function devOnly_(u) { if (u.role !== 'developer') throw fail_('Bu əməliyyat yalnız developer üçündür.', 'PERM'); }

function parseArchiveReq_(req) {
  var sheets = (Array.isArray(req.sheets) ? req.sheets : []).map(String).filter(function (s, i, a) { return ARCHIVE_SHEETS[s] && a.indexOf(s) === i; });
  var from = str_(req.from, 10), to = str_(req.to, 10);
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw fail_('Başlanğıc tarixi düzgün deyil.');
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw fail_('Son tarix düzgün deyil.');
  if (from && to && from > to) throw fail_('Başlanğıc tarixi son tarixdən sonra ola bilməz.');
  var cutoff = null;
  if (!from && !to) {
    var months = Number(req.months) || ARCHIVE_MONTHS;
    if ([3, 6, 12, 24].indexOf(months) === -1) months = ARCHIVE_MONTHS;
    cutoff = monthsAgo_(months);
  }
  return { sheets: sheets, from: from, to: to, cutoff: cutoff, userId: str_(req.userId, 40), type: str_(req.type, 20) };
}
function describeArchive_(p) {
  var s = p.cutoff ? p.cutoff + '-dən köhnə' : (p.from || '…') + ' — ' + (p.to || '…');
  if (p.userId) s += ' · istifadəçi: ' + userName_(p.userId);
  if (p.type) s += ' · növ: ' + p.type;
  return s;
}

function archivePreview_(u, req) {
  devOnly_(u);
  var p = parseArchiveReq_(req);
  var out = p.sheets.map(function (name) {
    return { sheet: name, label: ARCHIVE_LABELS[name], count: archiveCandidates_(name, p).length };
  });
  return { preview: out, total: out.reduce(function (s, x) { return s + x.count; }, 0), describe: describeArchive_(p) };
}

// Arxiv faylı (cari il üzrə) — yoxdursa yaradılır. Hər il yeni fayl: hər faylın öz 10 mln xana limiti var.
function archiveSS_() {
  var cfg = settingGet_('archive') || {};
  var year = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy');
  var ss = null;
  if (cfg[year]) { try { ss = SpreadsheetApp.openByUrl(cfg[year]); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('Aslan Lessons — Arxiv ' + year);
    cfg[year] = ss.getUrl();
    settingSet_('archive', cfg);
  }
  return ss;
}

// Arxivə yazır. Təkrar yazmır: id artıq arxivdədirsə keçir (yarımçıq qalmış əməliyyat təkrarlananda dublikat olmasın).
function appendArchive_(ss, name, rows) {
  if (!rows.length) return 0;
  var head = SCHEMA[name];
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:' + colLetter_(head.length)).setNumberFormat('@');
  }
  var have = {};
  var last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (v) { have[String(v[0])] = true; });
  var keyCol = head[0];
  var data = rows.filter(function (r) { return !have[String(r[keyCol])]; })
    .map(function (r) { return head.map(function (h) { return val_(r[h]); }); });
  if (!data.length) return 0;
  var start = last + 1;
  var need = start + data.length - 1 - sh.getMaxRows();
  if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need + 50);
  sh.getRange(start, 1, data.length, head.length).setValues(data);
  return data.length;
}

// Bir vərəqi arxivləşdir: əvvəlcə arxivə yaz, sonra işçi cədvəldən sil
function archiveSheet_(name, p, remaining) {
  var rows = archiveCandidates_(name, p);
  if (!rows.length) return { count: 0, left: 0 };
  var batch = rows.slice(0, Math.max(1, remaining));
  var ss = archiveSS_();
  appendArchive_(ss, name, batch);
  // Elanla birlikdə onun «görülüb» qeydləri də köçür
  var seen = [];
  if (name === 'Anns') {
    var ids = {}; batch.forEach(function (a) { ids[a.id] = true; });
    seen = rawRows_('AnnSeen').filter(function (x) { return ids[x.annId]; });
    appendArchive_(ss, 'AnnSeen', seen);
  }
  SpreadsheetApp.flush(); // arxivə yazıldığına əmin ol, sonra sil
  removeRows_(name, batch.map(function (r) { return r._row; }));
  if (seen.length) removeRows_('AnnSeen', seen.map(function (r) { return r._row; }));
  return { count: batch.length, left: rows.length - batch.length };
}

function archiveNow_(u, req) {
  devOnly_(u);
  var p = parseArchiveReq_(req);
  if (!p.sheets.length) throw fail_('Arxivləşəcək bölmə seçin.');
  var results = [], total = 0, left = 0;
  var remaining = ARCHIVE_BATCH;
  p.sheets.forEach(function (name) {
    if (remaining <= 0) { left += archiveCandidates_(name, p).length; return; }
    var r = archiveSheet_(name, p, remaining);
    remaining -= r.count; total += r.count; left += r.left;
    if (r.count) results.push(ARCHIVE_LABELS[name] + ': ' + r.count);
  });
  if (total) log_(u, 'dev', 'Məlumatları arxivləşdirdi', results.join(', ') + (left ? ' · qalan: ' + left : '') + ' · ' + describeArchive_(p));
  return { archived: total, left: left, details: results };
}

// Avto-arxivin özü (kilidsiz) — trigger və developer düyməsi bunu çağırır
function autoArchiveCore_(actor, force) {
  var st = settingGet_('archiveAuto') || {};
  if (!force && st.last && ageHours_(st.last) < AUTO_ARCHIVE_DAYS * 24) return { skipped: true, last: st.last };
  var p = { cutoff: monthsAgo_(ARCHIVE_MONTHS) };
  var results = [], total = 0;
  AUTO_ARCHIVE_SHEETS.forEach(function (name) {
    var done = 0, guard = 0;
    while (guard++ < 20) {
      var r = archiveSheet_(name, p, ARCHIVE_BATCH);
      done += r.count;
      if (!r.count || !r.left) break;
    }
    if (done) results.push(ARCHIVE_LABELS[name] + ': ' + done);
    total += done;
  });
  settingSet_('archiveAuto', { last: now_(), archived: total, by: actor ? actor.name : 'avtomatik' });
  log_(actor || null, actor ? 'dev' : 'system', actor ? 'Avtomatik arxivi əl ilə işə saldı' : 'Avtomatik arxivləşdirmə',
    (results.length ? results.join(', ') : 'köçürüləcək qeyd yox idi') + ' · ' + ARCHIVE_MONTHS + ' aydan köhnə');
  return { archived: total, details: results };
}

/** Trigger: hər ayın 1-də işləyir, amma arxivi yalnız 3 aydan bir edir. */
function autoArchiveQuarterly() {
  withLock_(function () { autoArchiveCore_(null, false); });
}

function archiveAutoNow_(u, req) {
  devOnly_(u);
  return autoArchiveCore_(u, true);
}

function installTriggersRoute_(u, req) {
  devOnly_(u);
  var created = installTriggers_();
  log_(u, 'dev', 'Triggerləri qurdu', created.length ? created.join(', ') : 'hamısı artıq qurulub idi');
  return { created: created, triggers: triggersStatus_() };
}

function archiveInfo_(u, req) {
  if (u.role !== 'developer' && u.role !== 'superadmin') throw fail_('İcazə yoxdur.', 'PERM');
  var cfg = settingGet_('archive') || {};
  var files = Object.keys(cfg).sort().reverse().map(function (y) { return { year: y, url: cfg[y] }; });
  var sections = Object.keys(ARCHIVE_SHEETS).map(function (name) {
    return { sheet: name, label: ARCHIVE_LABELS[name], note: ARCHIVE_NOTES[name] || '', count: rawRows_(name).length,
      auto: AUTO_ARCHIVE_SHEETS.indexOf(name) !== -1 };
  });
  var st = settingGet_('archiveAuto') || {};
  var users = rawRows_('Users').map(function (x) { return { id: x.id, name: x.name + (x.deletedAt ? ' (silinib)' : '') }; })
    .sort(function (a, b) { return a.name.localeCompare(b.name, 'az'); });
  return {
    files: files, sections: sections, locked: ARCHIVE_LOCKED, users: users,
    retentionMonths: ARCHIVE_MONTHS, autoDays: AUTO_ARCHIVE_DAYS,
    autoSheets: AUTO_ARCHIVE_SHEETS.map(function (s) { return ARCHIVE_LABELS[s]; }),
    autoLast: st.last || '', autoLastCount: st.archived == null ? null : st.archived,
    autoNext: st.last ? addDays_(st.last, AUTO_ARCHIVE_DAYS) : '',
    triggers: triggersStatus_()
  };
}

// ===================== TOPLU İDXAL (siyahıdan müəllim, tələbə və məşğələ) =====================
// Mətn formatı (hər sətir bir qeyd; sahələr « | » ilə ayrılır):
//   Müəllim: Ad Soyad | Fənn | Telefon | login (istəyə bağlı)
//   Qrup: Qrupun adı | 8 və ya 12
//   Tələbə Ad Soyad | Telefon | Valideyn | Valideynin telefonu
//   Fərdi: 8 və ya 12        ← bundan sonrakı hər tələbə ayrıca fərdi məşğələdir
//   Tələbələr:               ← məşğələsiz tələbələr
// Yalnız yeni sətirlər əlavə olunur — mövcud məlumat dəyişdirilmir və silinmir (istisna: mövcud qrupa yeni tələbə əlavə edilir).
var IMPORT_KEYS = {
  muellim: 'T', muellime: 'T', teacher: 'T', 'учитель': 'T', 'преподаватель': 'T', 'педагог': 'T',
  qrup: 'G', qrupu: 'G', group: 'G', 'группа': 'G',
  ferdi: 'I', ferdimesgele: 'I', ferdiders: 'I', individual: 'I', 'индивидуально': 'I', 'индивидуальные': 'I', 'индивидуальный': 'I',
  telebeler: 'S', telebe: 'S', sagirdler: 'S', students: 'S', 'ученики': 'S', 'студенты': 'S'
};
var IMPORT_SUBJECTS = [
  ['riyaziyyat', 'math'], ['математик', 'math'], ['mathem', 'math'], ['math', 'math'], ['cebr', 'math'], ['hendese', 'math'], ['geometr', 'math'],
  ['kimya', 'chem'], ['хими', 'chem'], ['chem', 'chem'],
  ['tarix', 'hist'], ['истори', 'hist'], ['hist', 'hist'],
  ['fizika', 'phys'], ['физик', 'phys'], ['phys', 'phys'],
  ['biologiya', 'bio'], ['биологи', 'bio'], ['biolog', 'bio'],
  ['ielts', 'ielts'], ['toefl', 'toefl'],
  ['ingilis', 'eng'], ['english', 'eng'], ['англий', 'eng'],
  ['rus', 'rus'], ['русск', 'rus'],
  ['azerbaycan', 'az'], ['ana dili', 'az'], ['азербайджан', 'az'],
  ['edebiyyat', 'lit'], ['литератур', 'lit'],
  ['cografiya', 'geo'], ['географи', 'geo'], ['geograf', 'geo'],
  ['informatika', 'inf'], ['информатик', 'inf'], ['proqram', 'code'], ['программ', 'code'],
  ['alman', 'ger'], ['немец', 'ger'], ['fransiz', 'fr'], ['француз', 'fr'], ['turk', 'tur'], ['турец', 'tur'], ['ereb', 'arab'], ['араб', 'arab'],
  ['ispan', 'esp'], ['испан', 'esp'], ['cin dili', 'chin'], ['китай', 'chin'], ['koreya', 'kor'], ['корей', 'kor'],
  ['mentiq', 'logic'], ['логик', 'logic'], ['ibtidai', 'prim'], ['началь', 'prim'], ['hazirliq', 'prep'], ['подготов', 'prep'],
  ['musiqi', 'mus'], ['музык', 'mus'], ['resm', 'art'], ['рисов', 'art'], ['sahmat', 'chess'], ['шахмат', 'chess'],
  ['huquq', 'law'], ['iqtisad', 'econ'], ['эконом', 'econ'], ['psixolog', 'psy'], ['психолог', 'psy']
];
var CYR_LAT = { 'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'j', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o',
  'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'x', 'ц': 'ts', 'ч': 'c', 'ш': 's', 'щ': 's', 'ъ': '', 'ы': 'i', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
  'ә': 'e', 'ғ': 'g', 'ҝ': 'g', 'ө': 'o', 'ү': 'u', 'һ': 'h', 'ҹ': 'c', 'ј': 'y' };

// Yalnız latın hərfləri və rəqəmlər (login üçün): ə→e, ç→c, ş→s, kiril → latın
function latin_(s) {
  var f = fold_(s);
  try { f = f.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
  return f.replace(/[Ѐ-ӿ]/g, function (ch) { return CYR_LAT[ch] === undefined ? '' : CYR_LAT[ch]; }).replace(/[^a-z0-9]/g, '');
}
function subjectCode_(subject) {
  var f = fold_(subject).replace(/\s+/g, ' ').trim();
  if (!f) return '';
  for (var i = 0; i < IMPORT_SUBJECTS.length; i++) if (f.indexOf(IMPORT_SUBJECTS[i][0]) !== -1) return IMPORT_SUBJECTS[i][1];
  return latin_(subject).slice(0, 4);
}
// «Rəna Əliyeva» + «Riyaziyyat» → renamath (təkrar olarsa: renamath2, renamath3 …)
function loginFor_(name, subject, taken) {
  var first = latin_(String(name).trim().split(/\s+/)[0] || '');
  if (!first) first = latin_(name) || 'muellim';
  var base = (first.slice(0, 20) + subjectCode_(subject)).slice(0, 26);
  while (base.length < 3) base += '1';
  var login = base, n = 2;
  while (taken[login]) { login = base + n; n++; }
  taken[login] = true;
  return login;
}
function looksPhone_(s) { return /^[0-9+()\-\s]{5,25}$/.test(s) && digits_(s).length >= 5; }

/** Mətni oxuyur və planı qurur (heç nə yazmır). */
function importPlan_(text) {
  var errors = [], warnings = [];
  var err = function (line, t) { if (errors.length < 200) errors.push({ line: line, text: t }); };
  var warn = function (line, t) { if (warnings.length < 200) warnings.push({ line: line, text: t }); };
  var lines = String(text || '').replace(/\r/g, '').split('\n');
  var teachers = [], tIndex = {}, loose = [];
  var curT = null, curC = null, mode = '';
  var split = function (s, comma) { return s.split(comma ? /\s*[|;\t,]\s*/ : /\s*[|;\t]\s*/).map(function (x) { return x.trim(); }); };

  lines.forEach(function (raw, i) {
    var ln = i + 1;
    var line = raw.replace(/[ ​﻿]/g, ' ').trim();
    if (!line || line[0] === '#' || line.slice(0, 2) === '//') return;
    line = line.replace(/^[-–—•*]\s+/, '').replace(/^\d{1,3}[.)]\s+/, '');   // «- Ad», «1. Ad», «2) Ad» kimi siyahı işarələri
    var kw = line.match(/^([^:|;\t,0-9]{3,22}?)\s*:\s*(.*)$/);
    var kind = kw ? IMPORT_KEYS[fold_(kw[1]).replace(/\s+/g, '')] : null;

    if (kind === 'T') {
      var f = split(kw[2], true), name = '', subject = '', phone = '', login = '';
      f.forEach(function (x) {
        if (!x) return;
        var lg = x.match(/^login\s*[:=]?\s*(\S+)$/i);
        if (lg) { login = lg[1]; return; }
        if (looksPhone_(x)) { if (!phone) phone = x; return; }
        if (!name) name = x; else if (!subject) subject = x; else warn(ln, 'Artıq sahə nəzərə alınmadı: «' + x.slice(0, 40) + '». Login vermək üçün «login: ad» yazın.');
      });
      curC = null; mode = '';
      if (name.length < 2 || name.length > 80) { err(ln, 'Müəllimin adı yazılmayıb. Nümunə: Müəllim: Rəna Əliyeva | Riyaziyyat'); curT = null; return; }
      if (login && !/^[A-Za-z0-9._-]{3,30}$/.test(login)) { err(ln, 'Login 3–30 simvol olmalı və yalnız latın hərfləri, rəqəmlər, nöqtə, alt xətt və ya tire daxil etməlidir: ' + login); login = ''; }
      var key = fold_(name) + '|' + fold_(subject);
      if (tIndex[key]) { curT = tIndex[key]; warn(ln, '«' + name + '» siyahıda təkrarlanır — eyni müəllim sayıldı, məşğələlər birləşdirildi.'); }
      else { curT = { line: ln, name: name.slice(0, 80), subject: subject.slice(0, 60), phone: phone, login: login, courses: [] }; tIndex[key] = curT; teachers.push(curT); }
      return;
    }
    if (kind === 'G') {
      if (!curT) { err(ln, 'Qrupdan əvvəl müəllim sətri olmalıdır: «Müəllim: Ad Soyad | Fənn».'); curC = null; mode = 'skip'; return; }
      var g = split(kw[2], false), title = '', N = 8;
      g.forEach(function (x) { if (!x) return; if (/^\d{1,2}$/.test(x)) N = Number(x); else if (!title) title = x; });
      if (N !== 8 && N !== 12) { err(ln, 'Aylıq dərs sayı 8 və ya 12 olmalıdır.'); N = 8; }
      curC = { line: ln, type: 'group', title: title.slice(0, 80), lessons: N, students: [] };
      curT.courses.push(curC); mode = 'group';
      return;
    }
    if (kind === 'I') {
      if (!curT) { err(ln, 'Fərdi məşğələlərdən əvvəl müəllim sətri olmalıdır: «Müəllim: Ad Soyad | Fənn».'); curC = null; mode = 'skip'; return; }
      var v = kw[2].replace(/[^\d]/g, ''), NI = v ? Number(v) : 8;
      if (NI !== 8 && NI !== 12) { err(ln, 'Aylıq dərs sayı 8 və ya 12 olmalıdır.'); NI = 8; }
      curC = null; mode = 'ind'; curT._indN = NI;
      return;
    }
    if (kind === 'S') { curT = null; curC = null; mode = 'students'; if (!kw[2].trim()) return; line = kw[2]; }

    // tələbə sətri
    if (mode === 'skip') return;
    var p = split(line, true), st = { line: ln, name: (p[0] || '').replace(/\s+/g, ' ').slice(0, 80), phone: '', parentName: '', parentPhone: '', note: '' };
    for (var k = 1; k < p.length; k++) {
      var x = p[k]; if (!x) continue;
      var letters = /[A-Za-zƏəİıÖöÜüÇçŞşĞğА-Яа-яЁё]/.test(x);
      if (looksPhone_(x)) { if (st.parentName || st.phone) { if (!st.parentPhone) st.parentPhone = x; } else st.phone = x; }
      else if (!letters) err(ln, 'Telefon nömrəsi düzgün deyil: ' + x.slice(0, 40));
      else if (!st.parentName && !/\d/.test(x)) st.parentName = x.replace(/^(valideyn|ana|ata|родитель)\s*[:\-–]\s*/i, '').slice(0, 80);
      else st.note = (st.note ? st.note + '; ' : '') + x.slice(0, 200);     // rəqəmli mətn (məs. «9-cu sinif») — qeyd kimi saxlanılır
    }
    if (st.name.indexOf(':') !== -1) { err(ln, 'Sətir oxunmadı: «' + line.slice(0, 60) + '». Açar sözlər: «Müəllim:», «Qrup:», «Fərdi:», «Tələbələr:».'); return; }
    if (st.name.length < 2 || !/[A-Za-zƏəİıÖöÜüÇçŞşĞğА-Яа-яЁё]/.test(st.name)) { err(ln, 'Tələbənin adı oxunmadı: «' + line.slice(0, 60) + '».'); return; }
    if (mode === 'group' && curC) {
      if (curC.students.some(function (y) { return fold_(y.name) === fold_(st.name); })) { warn(ln, '«' + st.name + '» bu qrupda təkrarlanır — bir dəfə sayıldı.'); return; }
      curC.students.push(st);
    } else if (mode === 'ind' && curT) {
      curT.courses.push({ line: ln, type: 'individual', title: '', lessons: curT._indN || 8, students: [st] });
    } else if (mode === 'students' || !curT) {
      if (mode !== 'students' && !loose.length) warn(ln, 'Bu sətirdən əvvəl müəllim göstərilməyib — tələbə məşğələsiz əlavə olunacaq.');
      loose.push(st);
    } else {
      err(ln, 'Tələbədən əvvəl «Qrup: …» və ya «Fərdi:» sətri olmalıdır.');
    }
  });

  teachers.forEach(function (t) {
    t.courses = t.courses.filter(function (c) {
      if (c.type !== 'group') return true;
      if (c.students.length >= 2) return true;
      err(c.line, 'Qrupda ən azı 2 tələbə olmalıdır' + (c.title ? ' («' + c.title + '»)' : '') + '. Bir tələbə üçün «Fərdi:» yazın.');
      return false;
    });
  });
  return { teachers: teachers, loose: loose, errors: errors, warnings: warnings };
}

/** Planı mövcud məlumatla tutuşdurur: nə yenidir, nə artıq var. */
function importResolve_(plan) {
  var users = rawRows_('Users'), liveUsers = rows_('Users'), students = rows_('Students'), courses = rows_('Courses');
  var warn = function (line, t) { if (plan.warnings.length < 200) plan.warnings.push({ line: line, text: t }); };
  var err = function (line, t) { if (plan.errors.length < 200) plan.errors.push({ line: line, text: t }); };

  // --- müəllimlər ---
  var taken = {}; users.forEach(function (x) { taken[lower_(x.login)] = true; });
  plan.teachers.forEach(function (t) {
    var same = liveUsers.filter(function (x) { return (x.role === 'teacher' || x.role === 'superadmin') && fold_(x.name) === fold_(t.name); });
    var hit = same.filter(function (x) { return fold_(x.subject) === fold_(t.subject); })[0] || same.filter(function (x) { return !x.subject || !t.subject; })[0];
    if (hit) { t.isNew = false; t.id = hit.id; t.login = hit.login; if (!t.subject) t.subject = hit.subject || ''; return; }
    if (same.length) warn(t.line, '«' + t.name + '» adlı müəllim artıq var, amma fənni fərqlidir — yeni hesab yaradılacaq.');
    t.isNew = true;
    if (t.login) {
      if (taken[lower_(t.login)]) { err(t.line, '«' + t.login + '» logini artıq istifadə olunur.'); return; }
      taken[lower_(t.login)] = true;
    } else t.login = loginFor_(t.name, t.subject, taken);
  });

  // --- tələbələr: eyni ad (+ fərqli olmayan telefon) = eyni şəxs ---
  var mentions = [];
  plan.teachers.forEach(function (t) { t.courses.forEach(function (c) { c.students.forEach(function (s) { mentions.push(s); }); }); });
  plan.loose.forEach(function (s) { mentions.push(s); });
  var byName = {};
  mentions.forEach(function (s) { var k = fold_(s.name); (byName[k] = byName[k] || []).push(s); });
  var existingByName = {};
  students.forEach(function (s) { var k = fold_(s.name); (existingByName[k] = existingByName[k] || []).push(s); });
  var people = [], claimed = {};
  Object.keys(byName).forEach(function (k) {
    var list = byName[k], persons = [];
    list.forEach(function (s) {
      var d = digits_(s.phone);
      var p = persons.filter(function (x) { return !d || !x.digits || x.digits === d; })[0];
      if (!p) { p = { name: s.name, phone: '', digits: '', parentName: '', parentPhone: '', note: '', line: s.line, refs: 0 }; persons.push(p); }
      if (d && !p.digits) { p.digits = d; p.phone = s.phone; }
      if (s.parentName && !p.parentName) p.parentName = s.parentName;
      if (s.parentPhone && !p.parentPhone) p.parentPhone = s.parentPhone;
      if (s.note && !p.note) p.note = s.note;
      p.refs++; s._p = p;
    });
    if (persons.length > 1) warn(persons[1].line, '«' + persons[0].name + '» adlı ' + persons.length + ' tələbə var (telefonları fərqlidir) — ayrı-ayrı tələbə kimi əlavə olunacaq.');
    var ex = existingByName[k] || [];
    persons.forEach(function (p) {
      var hit = ex.filter(function (e) { return !claimed[e.id] && p.digits && digits_(e.phone) === p.digits; })[0] ||
                ex.filter(function (e) { return !claimed[e.id] && (!p.digits || !digits_(e.phone)); })[0];
      if (hit) { p.isNew = false; p.id = hit.id; claimed[hit.id] = true; }
      else { p.isNew = true; if (ex.length) warn(p.line, '«' + p.name + '» adlı tələbə artıq var, amma telefonu fərqlidir — yeni tələbə kimi əlavə olunacaq.'); }
      people.push(p);
    });
  });

  // --- məşğələlər ---
  var out = [];
  plan.teachers.forEach(function (t) {
    var mine = t.isNew ? [] : courses.filter(function (c) { return c.teacherId === t.id; });
    t.courses.forEach(function (c) {
      c.teacher = t; c.isNew = true; c.add = 0;
      if (!t.isNew) {
        if (c.type === 'group' && c.title) {
          var g = mine.filter(function (x) { return x.type === 'group' && fold_(x.title) === fold_(c.title); })[0];
          if (g) { c.isNew = false; c.id = g.id; var have = idList_(g.studentIds);
            c.add = c.students.filter(function (s) { return s._p.isNew || have.indexOf(s._p.id) === -1; }).length; }
        } else if (c.type === 'group' && c.students.every(function (s) { return !s._p.isNew; })) {
          // adsız qrup: eyni müəllim + eyni tələbə tərkibi = eyni qrup
          var sig = c.students.map(function (s) { return s._p.id; }).sort().join(',');
          var g2 = mine.filter(function (x) { return x.type === 'group' && idList_(x.studentIds).sort().join(',') === sig; })[0];
          if (g2) { c.isNew = false; c.id = g2.id; }
        } else if (c.type === 'individual' && !c.students[0]._p.isNew) {
          var sid = c.students[0]._p.id;
          var ind = mine.filter(function (x) { return x.type === 'individual' && idList_(x.studentIds).join(',') === sid; })[0];
          if (ind) { c.isNew = false; c.id = ind.id; }
        }
      }
      out.push(c);
    });
  });
  plan.people = people; plan.courses = out;
  return plan;
}

function importView_(plan, pw, must) {
  var T = plan.teachers, C = plan.courses, P = plan.people;
  return {
    summary: {
      teachersNew: T.filter(function (t) { return t.isNew; }).length, teachersOld: T.filter(function (t) { return !t.isNew; }).length,
      studentsNew: P.filter(function (p) { return p.isNew; }).length, studentsOld: P.filter(function (p) { return !p.isNew; }).length,
      coursesNew: C.filter(function (c) { return c.isNew; }).length, coursesOld: C.filter(function (c) { return !c.isNew; }).length,
      joins: C.reduce(function (a, c) { return a + (c.isNew ? 0 : c.add); }, 0),
      repeats: P.filter(function (p) { return p.refs > 1; }).length
    },
    teachers: T.map(function (t) { return { line: t.line, name: t.name, subject: t.subject, phone: t.phone, login: t.login, isNew: !!t.isNew, courses: t.courses.length }; }),
    courses: C.slice(0, 600).map(function (c) { return { line: c.line, type: c.type, title: c.title, teacherName: c.teacher.name, lessons: c.lessons,
      students: c.students.map(function (s) { return s.name; }), isNew: c.isNew, add: c.add }; }),
    students: P.slice(0, 800).map(function (p) { return { name: p.name, phone: p.phone, isNew: p.isNew, refs: p.refs }; }),
    studentsTotal: P.length, coursesTotal: C.length,
    errors: plan.errors, warnings: plan.warnings, password: pw, mustChange: must
  };
}

function importRun_(u, req) {
  need_(u, 'tools.import');
  var text = String(req.text || '');
  if (!text.trim()) throw fail_('Siyahını mətn sahəsinə yapışdırın.');
  if (text.length > IMPORT_LIMITS.chars) throw fail_('Siyahı həddən artıq uzundur. Onu hissələrə bölüb ayrı-ayrı idxal edin.');
  var pw = req.password === undefined || req.password === '' ? IMPORT_PASSWORD : String(req.password);
  if (pw.length < 4 || pw.length > 50 || /\s/.test(pw)) throw fail_('İlkin şifrə 4–50 simvol olmalı və boşluqsuz yazılmalıdır.');
  var must = req.mustChange !== false;

  var plan = importResolve_(importPlan_(text));
  var view = importView_(plan, pw, must);
  var sm = view.summary;
  if (sm.teachersNew > IMPORT_LIMITS.teachers || sm.studentsNew > IMPORT_LIMITS.students || sm.coursesNew > IMPORT_LIMITS.courses) {
    plan.errors.push({ line: 0, text: 'Bir dəfəyə ən çoxu ' + IMPORT_LIMITS.teachers + ' müəllim, ' + IMPORT_LIMITS.students + ' tələbə və ' + IMPORT_LIMITS.courses + ' məşğələ idxal etmək olar. Siyahını hissələrə bölün.' });
  }
  if (!plan.teachers.length && !plan.people.length && !plan.errors.length) plan.errors.push({ line: 0, text: 'Siyahıda heç bir müəllim və ya tələbə tapılmadı. «Necə istifadə etməli» düyməsindəki nümunəyə baxın.' });
  if (req.dry) { view.dry = true; return view; }
  if (plan.errors.length) throw fail_('Siyahıda ' + plan.errors.length + ' xəta var. Əvvəlcə «Yoxla» düyməsi ilə xətaları düzəldin.');
  if (!sm.teachersNew && !sm.studentsNew && !sm.coursesNew && !sm.joins) { view.done = true; view.nothing = true; view.created = []; return view; }

  var stamp = now_(), today = today_(), logs = [];
  var usedIds = {};
  var nid = function (p) { var id; do { id = newId_(p); } while (usedIds[id]); usedIds[id] = true; return id; };
  var role = ROLE_LABELS[u.role] || u.role;
  var lg = function (type, action, details) { logs.push({ id: nid('L'), time: stamp, userId: u.id, userName: u.name, role: role, type: type, action: action, details: details }); };

  // 1) müəllimlər
  var newU = [];
  plan.teachers.forEach(function (t) {
    if (!t.isNew) return;
    t.id = nid('U');
    newU.push({ id: t.id, name: t.name, login: t.login, password: pw, role: 'teacher', phone: looksPhone_(t.phone) ? t.phone : '', permissions: '', theme: 'light',
      createdAt: stamp, updatedAt: '', deletedAt: '', deletedBy: '', installHint: '', newsSeenAt: '', isTest: '', mustChange: must ? 'true' : '', subject: t.subject });
    lg('teacher', 'Toplu idxal: müəllim əlavə etdi', t.name + ' · Login: ' + t.login + (t.subject ? ' · Fənn: ' + t.subject : '') + (must ? ' · ilk girişdə şifrə dəyişdirilməlidir' : ''));
  });
  // 2) tələbələr
  var newS = [];
  plan.people.forEach(function (p) {
    if (!p.isNew) return;
    p.id = nid('S');
    newS.push({ id: p.id, name: p.name, phone: p.phone, parentName: p.parentName, parentPhone: p.parentPhone, note: p.note || '', cardToken: newToken_(), status: 'active',
      createdAt: stamp, updatedAt: '', deletedAt: '', deletedBy: '', isTest: '' });
    lg('student', 'Toplu idxal: tələbə əlavə etdi', p.name + (p.phone ? ' · Tel: ' + p.phone : '') + (p.parentName ? ' · Valideyn: ' + p.parentName : ''));
  });
  // 3) məşğələlər
  var newC = [], joins = 0;
  var existing = {}; rows_('Courses').forEach(function (c) { existing[c.id] = c; });
  plan.courses.forEach(function (c) {
    var ids = c.students.map(function (s) { return s._p.id; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    if (c.isNew) {
      var id = nid('C');
      newC.push({ id: id, title: c.title, type: c.type, teacherId: c.teacher.id, studentIds: ids.join(','), lessonsPerMonth: String(c.lessons), monthNo: '1', monthStart: today,
        createdAt: stamp, updatedAt: '', deletedAt: '', deletedBy: '', isTest: '' });
      lg('course', 'Toplu idxal: ' + (c.type === 'group' ? 'qrup' : 'fərdi') + ' məşğələ yaratdı',
        '«' + (c.title || c.students.map(function (s) { return s.name; }).slice(0, 2).join(', ')) + '» · Müəllim: ' + c.teacher.name + ' · Tələbə' + (ids.length > 1 ? 'lər' : '') + ': ' +
        c.students.map(function (s) { return s.name; }).join(', ') + ' · Ayda ' + c.lessons + ' dərs');
    } else if (c.type === 'group' && existing[c.id]) {
      var row = existing[c.id], have = idList_(row.studentIds), added = ids.filter(function (x) { return have.indexOf(x) === -1; });
      if (added.length) {
        update_('Courses', row, { studentIds: have.concat(added).join(','), updatedAt: stamp });
        joins += added.length;
        lg('course', 'Toplu idxal: qrupa tələbə əlavə etdi', '«' + (c.title || 'Qrup') + '» · ' + c.students.filter(function (s) { return added.indexOf(s._p.id) !== -1; }).map(function (s) { return s.name; }).join(', '));
      }
    }
  });
  insertMany_('Users', newU);
  insertMany_('Students', newS);
  insertMany_('Courses', newC);
  lg('import', 'Toplu idxal etdi', newU.length + ' müəllim, ' + newS.length + ' tələbə, ' + newC.length + ' məşğələ' + (joins ? ', mövcud qruplara ' + joins + ' tələbə' : '') +
    (newU.length ? ' · Loginlər: ' + newU.map(function (x) { return x.login; }).join(', ') : ''));
  insertMany_('Logs', logs);

  view.done = true;
  view.created = newU.map(function (x) { return { name: x.name, login: x.login, subject: x.subject }; });
  view.result = { teachers: newU.length, students: newS.length, courses: newC.length, joins: joins };
  return view;
}

// ===================== İMTAHANLAR =====================
// Model: imtahan — şablon (suallar bir dəfə, JSON kimi saxlanılır); hər cəhd — ExamResults vərəqində bir sətir.
// Qaydalar:
//  · müəllim yalnız öz imtahanlarını və öz məşğələlərindəki tələbələri görür; icazəsi olan (exams.*) — hamısını;
//  · ilk cəhddən sonra suallar, ballar və keçid balı dəyişdirilmir (kilid) — yalnız şərtlər və təyinat;
//  · vaxt serverdə hesablanır (deadline); düzgün cavablar imtahan bitənə qədər tələbəyə göndərilmir;
//  · cəhd sayı məhdud deyil; hər cəhd ayrıca saxlanılır.
var EXAM_END = { submit: 'tələbə özü bitirdi', time: 'vaxt bitdi', violations: 'qayda pozuntularına görə dayandırıldı' };
var EXAM_VKINDS = { leave: 1, copy: 1, paste: 1, shot: 1, print: 1, other: 1 };

function parseJson_(s, fb) {
  if (s === '' || s === null || s === undefined) return fb;
  try { var v = JSON.parse(s); return v === null || v === undefined ? fb : v; } catch (e) { return fb; }
}
function range_(n) { var a = []; for (var i = 0; i < n; i++) a.push(i); return a; }
function shuffle_(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function num_(v) { var n = Number(v); return isFinite(n) ? n : 0; }
function pts_(v) { var n = Number(String(v).replace(',', '.')); return isFinite(n) ? Math.round(n * 2) / 2 : NaN; }   // bal addımı 0.5
function pct_(score, max) { max = num_(max); return max > 0 ? Math.round(num_(score) / max * 100) : 0; }
function msToStamp_(ms) { return Utilities.formatDate(new Date(ms), TIMEZONE, 'yyyy-MM-dd HH:mm:ss'); }

// Böyük JSON-u 3 xanaya bölür (xana limiti 50 000 simvol). Parça «'» və ya «=» ilə başlamır, surroqat cütü bölünmür.
function chunks_(s) {
  var out = [], i = 0;
  while (i < s.length && out.length < 3) {
    var end = Math.min(s.length, i + EXAM_CHUNK);
    if (end < s.length) {
      var guard = 0;
      while (guard++ < 40 && end > i + 1) {
        var prev = s.charCodeAt(end - 1), next = s.charAt(end);
        if ((prev >= 0xD800 && prev <= 0xDBFF) || next === "'" || next === '=') end--; else break;
      }
    }
    out.push(s.slice(i, end)); i = end;
  }
  if (i < s.length) return null;
  while (out.length < 3) out.push('');
  return out;
}
function bigPut_(prefix, value, what) {
  var c = chunks_(JSON.stringify(value));
  if (!c) throw fail_((what || 'Mətn') + ' həddən artıq böyükdür. Zəhmət olmasa, qısaldın.');
  var o = {}; o[prefix] = c[0]; o[prefix + '2'] = c[1]; o[prefix + '3'] = c[2];
  return o;
}
// Cavablar xanalara sığmırsa (çox nadir: onlarla çox uzun açıq cavab), ən uzun mətnlər qısaldılır — cəhd heç vaxt «ilişib» qalmasın
function answersPut_(ans) {
  var guard = 0;
  while (guard++ < 60 && JSON.stringify(ans).length > EXAM_CHUNK * 3 - 3000) {
    var longest = null;
    Object.keys(ans).forEach(function (k) { if (typeof ans[k] === 'string' && (longest === null || ans[k].length > ans[longest].length)) longest = k; });
    if (longest === null) break;
    ans[longest] = ans[longest].slice(0, Math.max(200, Math.floor(ans[longest].length * 0.6)));
  }
  return bigPut_('answers', ans, 'Cavablar');
}
function bigGet_(row, prefix, fb) {
  var s = String(row[prefix] || '') + String(row[prefix + '2'] || '') + String(row[prefix + '3'] || '');
  return parseJson_(s, fb);
}

// ---- sürətli indeks: ExamResults-ın ilk 4 sütunu (id, examId, status, studentId) ----
function examIndex_() {
  if (_raw['ExamResults#idx']) return _raw['ExamResults#idx'];
  var m = meta_('ExamResults'), out = [];
  if (m.head[0] !== 'id' || m.head[1] !== 'examId' || m.head[2] !== 'status' || m.head[3] !== 'studentId') {
    out = rawRows_('ExamResults').map(function (r) { return { _row: r._row, id: r.id, examId: r.examId, status: r.status, studentId: r.studentId }; });
  } else {
    var last = m.sh.getLastRow();
    if (last >= 2) {
      var v = m.sh.getRange(2, 1, last - 1, 4).getValues();
      for (var i = 0; i < v.length; i++) {
        if (v[i][0] === '' || v[i][0] == null) continue;
        out.push({ _row: i + 2, id: String(v[i][0]), examId: String(v[i][1]), status: String(v[i][2]), studentId: String(v[i][3]) });
      }
    }
  }
  _raw['ExamResults#idx'] = out;
  return out;
}
function examFresh_() { delete _raw.Exams; delete _raw.ExamResults; delete _raw['ExamResults#idx']; }
function attemptFull_(id) {
  var e = examIndex_().filter(function (x) { return x.id === String(id); })[0];
  return e ? fullRowAt_('ExamResults', e._row) : null;
}
function resPatch_(a, changes) {
  setCells_('ExamResults', a._row, changes);
  Object.keys(changes).forEach(function (k) { a[k] = changes[k]; });
  delete _raw.ExamResults; delete _raw['ExamResults#idx'];
}
function examAny_(id) { return rawRows_('Exams').filter(function (x) { return x.id === String(id); })[0] || null; }   // silinmişlər daxil
function mustExam_(id) {
  var e = rows_('Exams').filter(function (x) { return x.id === String(id); })[0];
  if (!e) throw fail_('İmtahan tapılmadı. Səhifəni yeniləyin.', 'NOTFOUND');
  return e;
}
function examQuestionsOf_(ex) { return bigGet_(fullRowAt_('Exams', ex._row), 'questions', []); }
function examHasAttempts_(examId) { return examIndex_().some(function (x) { return x.examId === examId; }); }
function examKey_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 12); }
function examAccess_(u, ex, level) {           // level: view | manage | delete
  if (level !== 'delete' && ex.teacherId === u.id) return true;
  return can_(u, 'exams.' + level);
}
function needExam_(u, ex, level) {
  if (!examAccess_(u, ex, level)) throw fail_('Bu imtahan üçün icazəniz yoxdur.', 'PERM');
}
function canCreateExam_(u) {
  if (can_(u, 'exams.manage')) return true;
  if (u.role === 'developer' || u.role === 'helper') return false;
  return u.role === 'teacher' || rows_('Courses').some(function (c) { return c.teacherId === u.id; });
}
// Müəllimin seçə biləcəyi tələbələr: öz məşğələlərindəkilər. İcazəli istifadəçi üçün null (hamısı).
function examPool_(u) {
  if (can_(u, 'exams.manage')) return null;
  var ok = {};
  rows_('Courses').forEach(function (c) { if (c.teacherId === u.id) idList_(c.studentIds).forEach(function (id) { ok[id] = true; }); });
  return ok;
}

// ---- suallar (strukturlaşdırılmış siyahı saytda mətndən yaradılır, burada yoxlanılır) ----
function examQuestions_(req, defPts) {
  var inQ = Array.isArray(req.questions) ? req.questions : [];
  if (!inQ.length) throw fail_('Ən azı bir sual əlavə edin.');
  if (inQ.length > EXAM_MAX_Q) throw fail_('Bir imtahanda ən çoxu ' + EXAM_MAX_Q + ' sual ola bilər.');
  var out = [], max = 0, open = 0;
  inQ.forEach(function (q, i) {
    var n = 'Sual ' + (i + 1) + ': ';
    q = q || {};
    var text = String(q.q === undefined || q.q === null ? '' : q.q).replace(/\r/g, '').trim().slice(0, 2000);
    if (!text) throw fail_(n + 'mətn boşdur.');
    var p = q.p === undefined || q.p === null || q.p === '' ? defPts : pts_(q.p);
    if (!(p > 0 && p <= 100)) throw fail_(n + 'bal 0.5–100 aralığında olmalıdır.');
    if (q.t === 'o') {
      out.push({ t: 'o', q: text, a: String(q.a || '').replace(/\r/g, '').trim().slice(0, 2000), p: p });
      open++;
    } else {
      var opts = (Array.isArray(q.o) ? q.o : []).map(function (x) { return String(x === null || x === undefined ? '' : x).replace(/\s+/g, ' ').trim().slice(0, 500); });
      if (opts.length < 2 || opts.length > 8) throw fail_(n + 'variantların sayı 2–8 olmalıdır.');
      if (opts.some(function (x) { return !x; })) throw fail_(n + 'boş variant var.');
      var c = q.c === '' || q.c === null || q.c === undefined ? -1 : Math.floor(Number(q.c));
      if (!(c >= 0 && c < opts.length)) throw fail_(n + 'düzgün cavab işarələnməyib.');
      out.push({ t: 't', q: text, o: opts, c: c, p: p });
    }
    max += p;
  });
  return { list: out, max: Math.round(max * 100) / 100, open: open };
}

function examLight_(e, st, u) {
  var mine = e.teacherId === u.id;
  return {
    id: e.id, title: e.title, subject: e.subject, teacherId: e.teacherId, teacherName: userName_(e.teacherId),
    students: idList_(e.studentIds).length, duration: num_(e.duration), points: num_(e.points), passMin: num_(e.passMin), maxPoints: num_(e.maxPoints),
    qCount: num_(e.qCount), openCount: num_(e.openCount), strict: isTrue_(e.strict), stopOnLimit: isTrue_(e.stopOnLimit),
    shuffle: isTrue_(e.shuffle), reveal: isTrue_(e.reveal), active: isTrue_(e.active), locked: isTrue_(e.locked),
    createdAt: e.createdAt, updatedAt: e.updatedAt, isTest: isTrue_(e.isTest),
    mine: mine, canManage: !u._readOnly && (mine || can_(u, 'exams.manage')),
    canDelete: !u._readOnly && (can_(u, 'exams.delete') || (mine && !isTrue_(e.locked))),   // nəticəsi olan imtahanı yalnız icazəli istifadəçi silir
    stats: st || { attempts: 0, students: 0, avg: null, pending: 0, running: 0, passed: 0, last: '' }
  };
}
function attemptLight_(a, ex, nameOf) {
  var fin = a.status !== 'started', score = num_(a.score), pm = num_(a.passMin);
  var pass = null;
  if (fin && pm > 0) pass = score >= pm ? true : (a.status === 'done' ? false : null);   // yoxlama bitməyibsə, «keçmədi» demək tezdir
  return {
    id: a.id, examId: a.examId, title: ex ? ex.title : '(silinmiş imtahan)', subject: ex ? ex.subject : '',
    studentId: a.studentId, studentName: nameOf ? nameOf(a.studentId) : '',
    status: a.status, startedAt: a.startedAt, finishedAt: a.finishedAt, spent: num_(a.spent), duration: num_(a.dur),
    score: fin ? score : null, maxPoints: num_(a.maxPoints), pct: fin ? pct_(score, a.maxPoints) : null, passMin: pm, pass: pass,
    pending: num_(a.openPending), violations: num_(a.violations), endReason: a.endReason, late: num_(a.late), marks: a.marks || ''
  };
}
function examStatsMap_(rows) {
  var map = {};
  rows.forEach(function (a) {
    var s = map[a.examId] || (map[a.examId] = { attempts: 0, students: 0, avg: null, pending: 0, running: 0, passed: 0, last: '', _sum: 0, _n: 0, _st: {} });
    if (a.status === 'started') { s.running++; return; }
    s.attempts++; s._st[a.studentId] = true;
    if (a.status === 'review') s.pending++;
    else { s._sum += pct_(a.score, a.maxPoints); s._n++; }
    if (num_(a.passMin) > 0 && num_(a.score) >= num_(a.passMin)) s.passed++;
    if (a.finishedAt > s.last) s.last = a.finishedAt;
  });
  Object.keys(map).forEach(function (k) { var s = map[k]; s.students = Object.keys(s._st).length; s.avg = s._n ? Math.round(s._sum / s._n) : null; delete s._sum; delete s._n; delete s._st; });
  return map;
}

// Yoxlanılmağı gözləyən açıq cavablar (istifadəçinin öz imtahanları üzrə) — menyudakı sayğac
function examPending_(u) {
  var rev = examIndex_().filter(function (x) { return x.status === 'review'; });
  if (!rev.length) return 0;
  var own = {}; rows_('Exams').forEach(function (e) { if (e.teacherId === u.id) own[e.id] = true; });
  return rev.filter(function (x) { return own[x.examId]; }).length;
}

// Tələbə kartı: hər cəhd ayrıca (imtahan + tarix + bal), ümumi uğur — yoxlanılmış cəhdlərin orta faizi
function examsOfStudent_(sid, uMap) {
  if (!examIndex_().some(function (x) { return x.studentId === sid && x.status !== 'started'; })) return { list: [], avg: null, count: 0 };
  var exMap = {}; rows_('Exams').forEach(function (e) { exMap[e.id] = e; });
  var list = rawRows_('ExamResults').filter(function (a) { return a.studentId === sid && a.status !== 'started' && exMap[a.examId]; })
    .map(function (a) { var o = attemptLight_(a, exMap[a.examId], null); o.teacherName = uMap && uMap[exMap[a.examId].teacherId] ? uMap[exMap[a.examId].teacherId].name : userName_(exMap[a.examId].teacherId); delete o.marks; return o; })
    .sort(function (a, b) { return a.finishedAt < b.finishedAt ? 1 : -1; });
  var done = list.filter(function (x) { return x.status === 'done'; });
  var avg = done.length ? Math.round(done.reduce(function (s, x) { return s + x.pct; }, 0) / done.length) : null;
  return { list: list, avg: avg, count: list.length };
}

// ---- STAFF: siyahı ----
function examList_(u, req) {
  if (u.role === 'developer') throw fail_('İcazə yoxdur.', 'PERM');
  var all = can_(u, 'exams.view');
  var create = canCreateExam_(u);
  if (!all && !create && !rows_('Exams').some(function (e) { return e.teacherId === u.id; })) throw fail_('İmtahanlar bölməsi üçün icazəniz yoxdur.', 'PERM');
  // vaxtı bitmiş, bağlanmamış cəhdlər varsa — əvvəlcə bağla (nadir hal)
  if (examIndex_().some(function (x) { return x.status === 'started'; })) {
    try { withLock_(function () { examFresh_(); examCloseExpired_(null); }); } catch (e) {}
    examFresh_();
  }
  var exams = rows_('Exams').filter(function (e) { return all || e.teacherId === u.id; });
  var ids = {}; exams.forEach(function (e) { ids[e.id] = true; });
  var stats = examStatsMap_(exams.length && examIndex_().length ? rawRows_('ExamResults').filter(function (a) { return ids[a.examId]; }) : []);
  var list = exams.map(function (e) { return examLight_(e, stats[e.id], u); })
    .sort(function (a, b) { return (a.updatedAt || a.createdAt) < (b.updatedAt || b.createdAt) ? 1 : -1; });
  var tMap = {}; list.forEach(function (e) { tMap[e.teacherId] = e.teacherName; });
  return { exams: list, canCreate: create && !u._readOnly, all: all,
    teachers: Object.keys(tMap).map(function (k) { return { id: k, name: tMap[k] }; }).sort(function (a, b) { return a.name.localeCompare(b.name, 'az'); }) };
}

// ---- STAFF: bir imtahan (suallar, linklər, cəhdlər, sual təhlili) ----
function examGet_(u, req) {
  var ex = mustExam_(req.id);
  needExam_(u, ex, 'view');
  examCloseExpired_(ex.id);
  ex = mustExam_(req.id);
  var qs = examQuestionsOf_(ex);
  var sMap = {}; rows_('Students').forEach(function (s) { sMap[s.id] = s; });
  var showPhones = can_(u, 'students.view');
  var keys = parseJson_(ex.keys, {});
  var canManage = examAccess_(u, ex, 'manage');
  var students = idList_(ex.studentIds).map(function (id) {
    var s = sMap[id];
    var o = { id: id, name: s ? s.name : '(silinmiş tələbə)', gone: !s, key: canManage ? (keys[id] || '') : '' };
    if (s && showPhones) { o.phone = s.phone; o.parentPhone = s.parentPhone; }
    return o;
  });
  var rows = examIndex_().some(function (x) { return x.examId === ex.id; }) ? rawRows_('ExamResults').filter(function (a) { return a.examId === ex.id; }) : [];
  var nameOf = function (id) { return sMap[id] ? sMap[id].name : '(silinmiş tələbə)'; };
  var attempts = rows.map(function (a) { return attemptLight_(a, ex, nameOf); })
    .sort(function (a, b) { return (a.finishedAt || a.startedAt) < (b.finishedAt || b.startedAt) ? 1 : -1; });
  // sual təhlili: hər sual üzrə düzgün / səhv / cavabsız (bitmiş cəhdlər)
  var qstats = qs.map(function () { return { ok: 0, bad: 0, empty: 0, open: 0 }; });
  attempts.forEach(function (a) {
    if (a.status === 'started') return;
    for (var i = 0; i < qs.length; i++) {
      var ch = a.marks.charAt(i);
      if (ch === '1') qstats[i].ok++; else if (ch === '0') qstats[i].bad++; else if (ch === '-' || ch === 'e') qstats[i].empty++; else if (ch) qstats[i].open++;
    }
  });
  attempts.forEach(function (a) { delete a.marks; });
  var light = examLight_(ex, examStatsMap_(rows)[ex.id], u);
  light.note = ex.note; light.studentIds = idList_(ex.studentIds);
  light.token = canManage ? ex.token : '';
  light.questions = qs;
  light.locked = rows.length > 0;
  light.canDelete = !u._readOnly && (can_(u, 'exams.delete') || (light.mine && !rows.length));
  if (req.first && ex.teacherId !== u.id) log_(u, 'view', 'İmtahana və nəticələrinə baxdı', '«' + ex.title + '» · Müəllim: ' + userName_(ex.teacherId));
  return { exam: light, students: students, attempts: attempts, qstats: qstats, showPhones: showPhones };
}

function examCond_(p) {
  return 'Müddət: ' + p.duration + ' dəq · Məhdudiyyətlər: ' + (p.strict === 'true' ? 'var' : 'yox') +
    (p.strict === 'true' ? ' · ' + EXAM_WARN_LIMIT + ' xəbərdarlıqdan sonra bitir: ' + (p.stopOnLimit === 'true' ? 'bəli' : 'xeyr') : '');
}

function saveExam_(u, req) {
  var old = req.id ? mustExam_(req.id) : null;
  if (old) needExam_(u, old, 'manage');
  else if (!canCreateExam_(u)) throw fail_('İmtahan yaratmaq üçün icazəniz yoxdur.', 'PERM');
  var locked = old ? examHasAttempts_(old.id) : false;
  var manageAll = can_(u, 'exams.manage');

  var p = {};
  p.title = reqStr_(req.title, 'İmtahanın adı', 2, 120);
  p.subject = str_(req.subject, 60);
  p.note = str_(req.note, 600);
  var dur = Math.floor(Number(req.duration));
  if (!(dur >= 5 && dur <= 300)) throw fail_('Müddət 5–300 dəqiqə aralığında olmalıdır.');
  p.duration = String(dur);
  p.strict = req.strict ? 'true' : 'false';
  p.stopOnLimit = req.strict && req.stopOnLimit ? 'true' : 'false';
  p.shuffle = req.shuffle ? 'true' : 'false';
  p.reveal = req.reveal === false ? 'false' : 'true';
  p.active = req.active === false ? 'false' : 'true';

  // sahib (müəllim)
  var teacherId = old ? old.teacherId : u.id;
  if (manageAll && req.teacherId) {
    var t = findUser_(req.teacherId);
    if (!t || (t.role !== 'teacher' && t.role !== 'superadmin')) throw fail_('Müəllim seçin.');
    teacherId = t.id;
  }
  p.teacherId = teacherId;

  // təyinat
  var ids = (Array.isArray(req.studentIds) ? req.studentIds : []).map(String).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
  if (!ids.length) throw fail_('Ən azı bir tələbə seçin.');
  if (ids.length > EXAM_MAX_STUDENTS) throw fail_('Bir imtahana ən çoxu ' + EXAM_MAX_STUDENTS + ' tələbə təyin etmək olar.');
  var pool = examPool_(u), had = old ? idList_(old.studentIds) : [];
  var sLive = {}; rows_('Students').forEach(function (s) { sLive[s.id] = true; });
  ids.forEach(function (id) {
    if (had.indexOf(id) !== -1) return;                       // əvvəldən təyin olunanlar qalır
    if (!sLive[id]) throw fail_('Seçilmiş tələbələrdən biri tapılmadı. Səhifəni yeniləyin.');
    if (pool && !pool[id]) throw fail_('Yalnız öz məşğələlərinizdəki tələbələri seçə bilərsiniz.', 'PERM');
  });
  p.studentIds = ids.join(',');
  var keys = old ? parseJson_(old.keys, {}) : {}, nk = {};
  ids.forEach(function (id) { nk[id] = keys[id] || examKey_(); });
  p.keys = JSON.stringify(nk);

  var heavy = null, qInfo = '';
  if (!locked) {
    var defPts = pts_(req.points === undefined || req.points === '' ? 1 : req.points);
    if (!(defPts > 0 && defPts <= 100)) throw fail_('Bir sualın balı 0.5–100 aralığında olmalıdır.');
    var q = examQuestions_(req, defPts);
    var pm = req.passMin === undefined || req.passMin === '' ? 0 : pts_(req.passMin);
    if (!(pm >= 0)) throw fail_('Keçid balı düzgün deyil.');
    if (pm > q.max) throw fail_('Keçid balı maksimum baldan (' + q.max + ') çox ola bilməz.');
    p.points = String(defPts); p.passMin = String(pm); p.maxPoints = String(q.max);
    p.qCount = String(q.list.length); p.openCount = String(q.open);
    heavy = bigPut_('questions', q.list, 'Sualların mətni');
    qInfo = q.list.length + ' sual (' + (q.list.length - q.open) + ' test, ' + q.open + ' açıq) · Maks. bal: ' + q.max + (pm ? ' · Keçid balı: ' + pm : '');
  } else if (req.questions !== undefined || (req.passMin !== undefined && pts_(req.passMin) !== num_(old.passMin)) || (req.points !== undefined && pts_(req.points) !== num_(old.points))) {
    // kilidli imtahanda suallar/ballar göndərilibsə — fərq varsa, heç nə yazılmır
    var same = req.questions === undefined;
    if (!same) { try { same = JSON.stringify(examQuestions_(req, num_(old.points) || 1).list) === JSON.stringify(examQuestionsOf_(old)); } catch (e) { same = false; } }
    if (!same || (req.passMin !== undefined && pts_(req.passMin) !== num_(old.passMin)) || (req.points !== undefined && pts_(req.points) !== num_(old.points))) {
      throw fail_('Bu imtahanı artıq yerinə yetirən var: suallar, ballar və keçid balı dəyişdirilə bilməz. Fərqli suallar üçün imtahanın surətini çıxarın.', 'LOCKED');
    }
  }

  if (old) {
    var ch = [];
    if (old.title !== p.title) ch.push('Ad: «' + old.title + '» → «' + p.title + '»');
    if (String(old.subject || '') !== p.subject) ch.push('Fənn: «' + (old.subject || '—') + '» → «' + (p.subject || '—') + '»');
    if (String(old.note || '') !== p.note) ch.push('Qeyd dəyişdirildi');
    if (old.duration !== p.duration) ch.push('Müddət: ' + old.duration + ' → ' + p.duration + ' dəq');
    [['strict', 'Məhdudiyyətlər'], ['stopOnLimit', 'Xəbərdarlıqdan sonra bitmə'], ['shuffle', 'Qarışdırma'], ['reveal', 'Düzgün cavabların göstərilməsi'], ['active', 'Aktivlik']].forEach(function (x) {
      if ((isTrue_(old[x[0]]) ? 'true' : 'false') !== p[x[0]]) ch.push(x[1] + ': ' + (p[x[0]] === 'true' ? 'açıldı' : 'söndürüldü'));
    });
    if (old.teacherId !== p.teacherId) ch.push('Müəllim: ' + userName_(old.teacherId) + ' → ' + userName_(p.teacherId));
    var added = ids.filter(function (x) { return had.indexOf(x) === -1; }), removed = had.filter(function (x) { return ids.indexOf(x) === -1; });
    if (added.length) ch.push('Əlavə edilən tələbələr: ' + added.map(studentName_).join(', '));
    if (removed.length) ch.push('Çıxarılan tələbələr: ' + removed.map(studentName_).join(', '));
    if (heavy) {
      if (old.qCount !== p.qCount || old.maxPoints !== p.maxPoints || old.passMin !== p.passMin || old.points !== p.points) ch.push('Suallar: ' + qInfo);
      else if (JSON.stringify(examQuestionsOf_(old)) !== JSON.stringify(bigGet_(heavy, 'questions', []))) ch.push('Sualların mətni dəyişdirildi');
    }
    p.updatedAt = now_();
    var prevTeacher = old.teacherId, title0 = old.title;
    var all = {}; Object.keys(p).forEach(function (k) { all[k] = p[k]; });
    if (heavy) Object.keys(heavy).forEach(function (k) { all[k] = heavy[k]; });
    update_('Exams', old, all);
    log_(u, 'exam', 'İmtahanı redaktə etdi', '«' + title0 + '» — ' + (ch.join('; ') || 'dəyişiklik edilmədi'));
    if (prevTeacher !== u.id && findUser_(prevTeacher) && ch.length) notify_([prevTeacher], 'exam', u.name + ' «' + p.title + '» imtahanınızı redaktə etdi.', 'exams', old.id);
    if (p.teacherId !== prevTeacher && p.teacherId !== u.id) notify_([p.teacherId], 'exam', 'Sizə imtahan təyin edildi: «' + p.title + '»', 'exams', old.id);
    return { id: old.id, locked: locked };
  }

  var row = { id: newId_('E'), token: Utilities.getUuid().replace(/-/g, '').slice(0, 24), locked: 'false', createdBy: u.id, createdAt: now_(), updatedAt: '', deletedAt: '', deletedBy: '', isTest: '' };
  Object.keys(p).forEach(function (k) { row[k] = p[k]; });
  Object.keys(heavy).forEach(function (k) { row[k] = heavy[k]; });
  insertMany_('Exams', [row]);
  log_(u, 'exam', 'İmtahan yaratdı', '«' + row.title + '» · Müəllim: ' + userName_(row.teacherId) + ' · ' + qInfo + ' · ' + examCond_(p) + ' · Tələbə sayı: ' + ids.length);
  if (row.teacherId !== u.id) notify_([row.teacherId], 'exam', u.name + ' sizin üçün imtahan yaratdı: «' + row.title + '»', 'exams', row.id);
  return { id: row.id, locked: false };
}

function setExamActive_(u, req) {
  var ex = mustExam_(req.id);
  needExam_(u, ex, 'manage');
  var on = !!req.active;
  if (isTrue_(ex.active) !== on) {
    update_('Exams', ex, { active: on ? 'true' : 'false', updatedAt: now_() });
    log_(u, 'exam', on ? 'İmtahanı açdı' : 'İmtahanı bağladı', '«' + ex.title + '»' + (on ? ' · link yenidən işləyir' : ' · link artıq yeni cəhd qəbul etmir'));
    if (ex.teacherId !== u.id && findUser_(ex.teacherId)) notify_([ex.teacherId], 'exam', u.name + ' «' + ex.title + '» imtahanını ' + (on ? 'açdı.' : 'bağladı.'), 'exams', ex.id);
  }
  return { active: on };
}

function copyExam_(u, req) {
  var ex = mustExam_(req.id);
  needExam_(u, ex, 'manage');
  if (!canCreateExam_(u)) throw fail_('İmtahan yaratmaq üçün icazəniz yoxdur.', 'PERM');
  var full = fullRowAt_('Exams', ex._row);
  var keys = {}; idList_(ex.studentIds).forEach(function (id) { keys[id] = examKey_(); });
  var row = {};
  SCHEMA.Exams.forEach(function (h) { row[h] = full[h]; });
  row.id = newId_('E'); row.token = Utilities.getUuid().replace(/-/g, '').slice(0, 24);
  row.title = (String(ex.title).slice(0, 110) + ' (surət)');
  row.keys = JSON.stringify(keys); row.locked = 'false'; row.active = 'true';
  row.createdBy = u.id; row.createdAt = now_(); row.updatedAt = ''; row.deletedAt = ''; row.deletedBy = ''; row.isTest = '';
  insertMany_('Exams', [row]);
  log_(u, 'exam', 'İmtahanın surətini çıxardı', '«' + ex.title + '» → «' + row.title + '»');
  return { id: row.id };
}

function deleteExam_(u, req) {
  var ex = mustExam_(req.id);
  var has = examHasAttempts_(ex.id);
  // nəticəsi olan imtahanı yalnız «sil» icazəsi olan silə bilər (nəticələr qorunur); nəticəsiz öz imtahanını müəllim özü silir
  if (has || ex.teacherId !== u.id) need_(u, 'exams.delete');
  update_('Exams', ex, { deletedAt: now_(), deletedBy: u.id });
  log_(u, 'exam', 'İmtahanı sildi', '«' + ex.title + '» · Müəllim: ' + userName_(ex.teacherId) + ' · Zibil qutusuna köçürüldü' + (has ? ' (nəticələri ilə birlikdə)' : ''));
  if (ex.teacherId !== u.id && findUser_(ex.teacherId)) notify_([ex.teacherId], 'exam', '«' + ex.title + '» imtahanı silindi.', 'exams', '');
  return {};
}

function examNewLinks_(u, req) {
  var ex = mustExam_(req.id);
  needExam_(u, ex, 'manage');
  var keys = {}; idList_(ex.studentIds).forEach(function (id) { keys[id] = examKey_(); });
  update_('Exams', ex, { token: Utilities.getUuid().replace(/-/g, '').slice(0, 24), keys: JSON.stringify(keys), updatedAt: now_() });
  log_(u, 'exam', 'İmtahan linklərini yenilədi', '«' + ex.title + '» · köhnə linklər artıq işləmir');
  return {};
}

// İmtahan həmişəlik silinəndə onun bütün cəhdləri də silinir
function examPurgeResults_(examIds) {
  var set = {}; examIds.forEach(function (id) { set[id] = true; });
  var rows = examIndex_().filter(function (x) { return set[x.examId]; });
  if (rows.length) removeRows_('ExamResults', rows.map(function (x) { return x._row; }));
  return rows.length;
}

// «Məlumatların yoxlanışı» üçün
function examCheck_(issues, sIds) {
  var exams = rows_('Exams');
  if (!exams.length) return;
  var uIds = {}; rows_('Users').forEach(function (x) { uIds[x.id] = true; });
  exams.forEach(function (e) {
    if (!uIds[e.teacherId]) issues.push({ type: 'warn', text: '«' + e.title + '» imtahanının müəllimi silinib.' });
    var gone = idList_(e.studentIds).filter(function (id) { return !sIds[id]; }).length;
    if (gone) issues.push({ type: 'info', text: '«' + e.title + '» imtahanında silinmiş tələbə var (' + gone + ').' });
  });
  var rev = examIndex_().filter(function (x) { return x.status === 'review'; }).length;
  if (rev) issues.push({ type: 'info', text: rev + ' imtahan cavabı müəllimin yoxlamasını gözləyir (açıq suallar).' });
}

// ---- cəhdin tam görünüşü (müəllim və tələbə/valideyn üçün) ----
function resultView_(ex, qs, a, staff) {
  var ans = bigGet_(a, 'answers', {}) || {}, grades = parseJson_(a.grades, {}) || {};
  var reveal = staff || isTrue_(ex.reveal);
  var counts = { ok: 0, bad: 0, empty: 0, open: 0 };
  var fin = a.status !== 'started';
  var items = qs.map(function (q, i) {
    var v = ans[i];
    if (q.t === 't') {
      var chosen = v === undefined || v === null || v === '' ? null : Number(v);
      var ok = chosen === null ? null : chosen === q.c;
      if (ok === null) counts.empty++; else if (ok) counts.ok++; else counts.bad++;
      return { t: 't', q: q.q, p: q.p, o: q.o, chosen: chosen, ok: ok, correct: (reveal || ok) ? q.c : null, got: ok ? q.p : 0 };
    }
    var text = typeof v === 'string' ? v : '';
    var graded = grades[i] !== undefined && grades[i] !== null && grades[i] !== '';
    if (!text.trim()) counts.empty++; else counts.open++;
    return { t: 'o', q: q.q, p: q.p, answer: text, got: !text.trim() ? 0 : (graded ? num_(grades[i]) : null),
      model: (staff || (reveal && a.status === 'done')) ? q.a : '' };
  });
  var light = attemptLight_(a, ex, studentName_);
  delete light.marks;
  light.teacherName = userName_(ex.teacherId);
  light.autoScore = num_(a.autoScore); light.openScore = num_(a.openScore);
  light.comment = a.comment || ''; light.gradedAt = a.gradedAt || '';
  light.counts = counts; light.items = items; light.reveal = isTrue_(ex.reveal);
  light.strict = isTrue_(ex.strict); light.warnLimit = EXAM_WARN_LIMIT;
  if (staff) { light.vlog = parseJson_(a.vlog, []); light.gradedBy = a.gradedBy ? userName_(a.gradedBy) : ''; light.examDeleted = !!ex.deletedAt; }
  return light;
}

function examAttempt_(u, req) {
  var a = attemptFull_(req.id);
  if (!a) throw fail_('Nəticə tapılmadı. Səhifəni yeniləyin.', 'NOTFOUND');
  var ex = examAny_(a.examId);
  if (!ex) throw fail_('Bu nəticənin imtahanı silinib.', 'NOTFOUND');
  // imtahanın sahibi və «bax» icazəsi olanlar; tələbə kartından — «tələbələrə bax» icazəsi ilə
  if (!examAccess_(u, ex, 'view') && !can_(u, 'students.view')) throw fail_('Bu nəticəyə baxmaq üçün icazəniz yoxdur.', 'PERM');
  if (a.status === 'started' && req._at > num_(a.deadline) + 60000) { finalize_(ex, examQuestionsOf_(ex), a, null, 'time', req._at, ''); a = attemptFull_(req.id); }
  var s = findStudent_(a.studentId);
  var view = resultView_(ex, examQuestionsOf_(ex), a, true);
  view.canGrade = !u._readOnly && examAccess_(u, ex, 'manage') && a.status !== 'started';
  view.canDelete = !u._readOnly && can_(u, 'exams.delete');
  if (s && can_(u, 'students.view')) { view.phone = s.phone; view.parentPhone = s.parentPhone; view.parentName = s.parentName; }
  if (ex.teacherId !== u.id) log_(u, 'view', 'İmtahan nəticəsinə baxdı', '«' + ex.title + '» · Tələbə: ' + (s ? s.name : '(silinmiş tələbə)'));
  return { attempt: view };
}

function gradeAttempt_(u, req) {
  var a = attemptFull_(req.id);
  if (!a) throw fail_('Nəticə tapılmadı. Səhifəni yeniləyin.', 'NOTFOUND');
  var ex = examAny_(a.examId);
  if (!ex || ex.deletedAt) throw fail_('Bu nəticənin imtahanı silinib.', 'NOTFOUND');
  needExam_(u, ex, 'manage');
  if (a.status === 'started') throw fail_('Bu cəhd hələ davam edir.');
  var qs = examQuestionsOf_(ex), ans = bigGet_(a, 'answers', {}) || {}, grades = parseJson_(a.grades, {}) || {};
  var inG = req.grades && typeof req.grades === 'object' ? req.grades : {};
  var marks = String(a.marks || '').split(''), openScore = 0, pending = 0;
  qs.forEach(function (q, i) {
    if (q.t !== 'o') return;
    var has = typeof ans[i] === 'string' && ans[i].trim();
    if (!has) { marks[i] = 'e'; delete grades[i]; return; }
    if (inG[i] !== undefined && inG[i] !== null && inG[i] !== '') {
      var g = pts_(inG[i]);
      if (!(g >= 0 && g <= q.p)) throw fail_('Sual ' + (i + 1) + ': bal 0–' + q.p + ' aralığında olmalıdır.');
      grades[i] = g;
    }
    if (grades[i] === undefined || grades[i] === null || grades[i] === '') { marks[i] = 'p'; pending++; }
    else { marks[i] = 'g'; openScore += num_(grades[i]); }
  });
  openScore = Math.round(openScore * 100) / 100;
  var score = Math.round((num_(a.autoScore) + openScore) * 100) / 100;
  var ch = { status: pending ? 'review' : 'done', openScore: String(openScore), score: String(score), openPending: String(pending), marks: marks.join(''),
    gradedBy: u.id, gradedAt: now_(), grades: JSON.stringify(grades) };
  if (req.comment !== undefined) ch.comment = str_(req.comment, 600);
  resPatch_(a, ch);
  log_(u, 'exam', 'Açıq cavabları yoxladı', '«' + ex.title + '» · Tələbə: ' + studentName_(a.studentId) + ' · Yekun: ' + score + '/' + a.maxPoints + (pending ? ' · yoxlanılmamış: ' + pending : ''));
  if (ex.teacherId !== u.id && findUser_(ex.teacherId)) notify_([ex.teacherId], 'exam', u.name + ' «' + ex.title + '» imtahanında ' + studentName_(a.studentId) + ' adlı tələbənin cavablarını yoxladı.', 'exams', ex.id);
  var view = resultView_(ex, qs, attemptFull_(a.id), true);
  view.canGrade = true; view.canDelete = can_(u, 'exams.delete');
  return { attempt: view };
}

function deleteAttempt_(u, req) {
  need_(u, 'exams.delete');
  var a = attemptFull_(req.id);
  if (!a) throw fail_('Nəticə tapılmadı. Səhifəni yeniləyin.', 'NOTFOUND');
  var ex = examAny_(a.examId);
  removeRows_('ExamResults', [a._row]);
  var cache = CacheService.getScriptCache(); cache.remove('xa_' + a.id); cache.remove('xd_' + a.id);
  if (ex && isTrue_(ex.locked) && !examHasAttempts_(ex.id)) update_('Exams', ex, { locked: 'false' });
  log_(u, 'exam', 'İmtahan cəhdini sildi', '«' + (ex ? ex.title : '(silinmiş imtahan)') + '» · Tələbə: ' + studentName_(a.studentId) + ' · ' + (a.status === 'started' ? 'davam edən cəhd' : 'Nəticə: ' + a.score + '/' + a.maxPoints) + ' · Tarix: ' + a.startedAt);
  if (ex && ex.teacherId !== u.id && findUser_(ex.teacherId)) notify_([ex.teacherId], 'exam', u.name + ' «' + ex.title + '» imtahanında ' + studentName_(a.studentId) + ' adlı tələbənin cəhdini sildi.', 'exams', ex.id);
  return {};
}

// ===================== İMTAHAN: TƏLƏBƏ SƏHİFƏSİ (girişsiz) =====================
function examByLink_(link) {
  link = String(link || '').slice(0, 80);
  var bad = function () { return fail_('İmtahan tapılmadı. Link yanlışdır və ya artıq etibarsızdır.', 'NOTFOUND'); };
  var list = rows_('Exams');
  var m = link.match(/^([A-Za-z0-9]+)\.([A-Za-z0-9]+)$/);
  if (m) {
    var ex = list.filter(function (x) { return x.id === m[1]; })[0];
    if (!ex) throw bad();
    var keys = parseJson_(ex.keys, {}), sid = '';
    Object.keys(keys).forEach(function (k) { if (keys[k] === m[2]) sid = k; });
    if (!sid || idList_(ex.studentIds).indexOf(sid) === -1) throw bad();
    return { ex: ex, studentId: sid };
  }
  if (!/^[A-Za-z0-9]{12,}$/.test(link)) throw bad();
  var e2 = list.filter(function (x) { return x.token && x.token === link; })[0];
  if (!e2) throw bad();
  return { ex: e2, studentId: '' };
}
function examPublic_(ex) {
  return { title: ex.title, subject: ex.subject, note: ex.note, teacherName: userName_(ex.teacherId), duration: num_(ex.duration),
    qCount: num_(ex.qCount), openCount: num_(ex.openCount), maxPoints: num_(ex.maxPoints), passMin: num_(ex.passMin),
    strict: isTrue_(ex.strict), stopOnLimit: isTrue_(ex.stopOnLimit), warnLimit: EXAM_WARN_LIMIT };
}

function xInfo_(req) {
  var r = examByLink_(req.link), ex = r.ex;
  var out = { state: isTrue_(ex.active) ? 'open' : 'closed', exam: examPublic_(ex) };
  if (r.studentId) {
    var s = findStudent_(r.studentId);
    if (!s) throw fail_('İmtahan tapılmadı. Link yanlışdır və ya artıq etibarsızdır.', 'NOTFOUND');
    out.student = { id: s.id, name: s.name };
    var run = examIndex_().filter(function (x) { return x.examId === ex.id && x.studentId === s.id && x.status === 'started'; })[0];
    if (run) { var a = fullRowAt_('ExamResults', run._row); if (a.id === run.id && req._at <= num_(a.deadline)) { out.state = 'open'; out.running = Math.max(0, Math.round((num_(a.deadline) - req._at) / 1000)); } }
  } else {
    var sMap = {}; rows_('Students').forEach(function (x) { sMap[x.id] = x; });
    out.students = idList_(ex.studentIds).filter(function (id) { return sMap[id]; }).map(function (id) { return { id: id, name: sMap[id].name }; })
      .sort(function (a, b) { return a.name.localeCompare(b.name, 'az'); });
  }
  return out;
}

function cleanAnswers_(raw, n) {
  var out = {};
  if (!raw || typeof raw !== 'object') return out;
  Object.keys(raw).slice(0, 400).forEach(function (k) {
    var i = Number(k);
    if (!(i >= 0 && i < n) || Math.floor(i) !== i) return;
    var v = raw[k];
    if (typeof v === 'number' && isFinite(v) && v >= 0 && v < 20) out[i] = Math.floor(v);
    else if (typeof v === 'string') { var s = v.replace(/\r/g, '').slice(0, 3000); if (s.trim()) out[i] = s; }
  });
  return out;
}
function draftOf_(a) {    // son saxlanılmış qaralama: keş (daha təzə), yoxdursa cədvəl
  var c = parseJson_(CacheService.getScriptCache().get('xd_' + a.id), null);
  if (c && c.a && typeof c.a === 'object') return c.a;
  var s = bigGet_(a, 'answers', null);
  return s && typeof s === 'object' ? s : null;
}
function attemptForStudent_(ex, qs, a, resumed) {
  var conf = parseJson_(a.conf, {}) || {};
  var order = Array.isArray(conf.o) && conf.o.length === qs.length ? conf.o : range_(qs.length);
  var list = order.map(function (i) {
    var q = qs[i], o = { i: i, t: q.t, q: q.q, p: q.p };
    if (q.t === 't') {
      var perm = conf.p && Array.isArray(conf.p[i]) && conf.p[i].length === q.o.length ? conf.p[i] : range_(q.o.length);
      o.o = perm.map(function (k) { return { v: k, x: q.o[k] }; });
    }
    return o;
  });
  var s = findStudent_(a.studentId);
  return { state: 'running',
    attempt: { id: a.id, left: Math.max(0, Math.round((num_(a.deadline) - Date.now()) / 1000)), duration: num_(a.dur), violations: num_(a.violations), resumed: !!resumed },
    exam: examPublic_(ex), student: { name: s ? s.name : '' }, questions: list, answers: (resumed ? draftOf_(a) : null) || {} };
}

function xStart_(req) {
  var r = examByLink_(req.link), ex = r.ex;
  var sid = r.studentId || String(req.studentId || '');
  if (!sid || idList_(ex.studentIds).indexOf(sid) === -1) throw fail_('Siyahıdan öz adınızı seçin.');
  var s = findStudent_(sid);
  if (!s) throw fail_('Tələbə tapılmadı. Müəlliminizə müraciət edin.', 'NOTFOUND');
  var at = req._at;
  var mine = examIndex_().filter(function (x) { return x.examId === ex.id && x.studentId === sid; });
  var run = mine.filter(function (x) { return x.status === 'started'; })[0];
  var qs = examQuestionsOf_(ex);
  if (run) {
    var a = fullRowAt_('ExamResults', run._row);
    if (at <= num_(a.deadline) + EXAM_GRACE_SEC * 1000) return attemptForStudent_(ex, qs, a, true);   // davam edən cəhd — eyni vaxtla davam
    finalize_(ex, qs, a, null, 'time', at, '');
    return { state: 'finished', resultId: a.id };
  }
  if (!isTrue_(ex.active)) return { state: 'closed', exam: examPublic_(ex) };
  if (!req.accept) throw fail_('İmtahana başlamaq üçün qaydaları qəbul edin.');
  if (!qs.length) throw fail_('Bu imtahanda sual yoxdur. Müəlliminizə müraciət edin.');
  if (mine.length >= EXAM_MAX_ATTEMPTS) throw fail_('Bu imtahan üçün cəhd limiti (' + EXAM_MAX_ATTEMPTS + ') bitib. Müəlliminizə müraciət edin.');
  var dur = num_(ex.duration) || 30, conf = {};
  if (isTrue_(ex.shuffle)) {
    conf.o = shuffle_(range_(qs.length)); conf.p = {};
    qs.forEach(function (q, i) { if (q.t === 't') conf.p[i] = shuffle_(range_(q.o.length)); });
  }
  var row = { id: 'R' + Utilities.getUuid().replace(/-/g, ''), examId: ex.id, status: 'started', studentId: sid, startedAt: msToStamp_(at), dur: String(dur),
    deadline: String(at + dur * 60000), finishedAt: '', spent: '', autoScore: '', openScore: '', score: '', maxPoints: ex.maxPoints, passMin: ex.passMin,
    openPending: '', violations: '0', endReason: '', late: '', marks: '', gradedBy: '', gradedAt: '', savedAt: '',
    comment: '', conf: JSON.stringify(conf), vlog: '[]', grades: '', answers: '', answers2: '', answers3: '' };
  insertMany_('ExamResults', [row]);
  if (!isTrue_(ex.locked)) update_('Exams', ex, { locked: 'true' });
  CacheService.getScriptCache().put('xa_' + row.id, JSON.stringify({ e: ex.id, d: at + dur * 60000, n: qs.length, s: 'started', p: at }), 21600);
  log_({ id: '', name: s.name, role: 'student' }, 'exam', 'İmtahana başladı', '«' + ex.title + '» · Müəllim: ' + userName_(ex.teacherId) + ' · Cəhd № ' + (mine.length + 1));
  return attemptForStudent_(ex, qs, row, false);
}

function attemptMeta_(id) {
  var cache = CacheService.getScriptCache();
  var m = parseJson_(cache.get('xa_' + id), null);
  if (m && m.d) return m;
  var a = attemptFull_(id);
  if (!a) return null;
  var ex = examAny_(a.examId);
  m = { e: a.examId, d: num_(a.deadline), n: ex ? (num_(ex.qCount) || EXAM_MAX_Q) : EXAM_MAX_Q, s: a.status, p: 0 };
  if (a.status === 'started') cache.put('xa_' + id, JSON.stringify(m), 21600);
  return m;
}

// Avtomatik yadda saxlama: keşə (kilidsiz, sürətli), vaxtaşırı cədvələ. Qalan vaxt serverdən qayıdır.
function xSave_(req) {
  var id = String(req.id || '').slice(0, 60), at = req._at;
  var meta = attemptMeta_(id);
  if (!meta) throw fail_('İmtahan cəhdi tapılmadı.', 'NOTFOUND');
  if (meta.s !== 'started') return { state: 'finished', resultId: id };
  if (at > meta.d + EXAM_GRACE_SEC * 1000) return { state: 'time' };
  var ans = cleanAnswers_(req.answers, meta.n);
  var json = JSON.stringify({ t: at, a: ans });
  var cache = CacheService.getScriptCache(), cached = false;
  if (json.length < 90000) { cache.put('xd_' + id, json, 21600); cached = true; }
  if (!cached || at - (meta.p || 0) > EXAM_PERSIST_SEC * 1000) {
    var still = true;
    withLock_(function () {
      examFresh_();
      var a = attemptFull_(id);
      if (!a || a.status !== 'started') { still = false; return; }
      var ch = answersPut_(ans); ch.savedAt = now_();
      setCells_('ExamResults', a._row, ch);
    });
    if (!still) { cache.remove('xa_' + id); return { state: 'finished', resultId: id }; }
    meta.p = at; cache.put('xa_' + id, JSON.stringify(meta), 21600);
  }
  return { state: 'ok', left: Math.max(0, Math.round((meta.d - Date.now()) / 1000)) };
}

function gradeAuto_(qs, ans) {
  var auto = 0, marks = '', pending = 0;
  qs.forEach(function (q, i) {
    var v = ans[i];
    if (q.t === 't') {
      if (v === undefined || v === null || v === '') marks += '-';
      else if (Number(v) === q.c) { marks += '1'; auto += q.p; }
      else marks += '0';
    } else if (typeof v === 'string' && v.trim()) { marks += 'p'; pending++; }
    else marks += 'e';
  });
  return { auto: Math.round(auto * 100) / 100, marks: marks, pending: pending };
}

/** Cəhdi bağlayır: testlər avtomatik yoxlanılır, açıq cavablar müəllimi gözləyir. answers == null → son qaralama. */
function finalize_(ex, qs, a, answers, reason, at, lateMin) {
  var ans = answers || draftOf_(a) || {};
  var g = gradeAuto_(qs, ans);
  var dl = num_(a.deadline), startMs = dl - num_(a.dur) * 60000;
  var endMs = Math.max(startMs, Math.min(at, dl));
  var ch = answersPut_(ans);
  ch.status = g.pending ? 'review' : 'done';
  ch.finishedAt = msToStamp_(endMs);
  ch.spent = String(Math.max(0, Math.round((endMs - startMs) / 1000)));
  ch.autoScore = String(g.auto); ch.openScore = '0'; ch.score = String(g.auto);
  ch.openPending = String(g.pending); ch.endReason = reason; ch.late = lateMin || ''; ch.marks = g.marks; ch.savedAt = now_();
  resPatch_(a, ch);
  var cache = CacheService.getScriptCache(); cache.remove('xa_' + a.id); cache.remove('xd_' + a.id);
  var s = findStudent_(a.studentId), name = s ? s.name : '(silinmiş tələbə)';
  var res = g.auto + '/' + a.maxPoints + ' (' + pct_(g.auto, a.maxPoints) + '%)';
  log_({ id: '', name: name, role: 'student' }, 'exam', reason === 'violations' ? 'İmtahan qayda pozuntularına görə dayandırıldı' : 'İmtahanı bitirdi',
    '«' + ex.title + '» · Nəticə: ' + res + (g.pending ? ' · yoxlanılacaq açıq cavab: ' + g.pending : '') + ' · Səbəb: ' + (EXAM_END[reason] || reason) +
    (num_(a.violations) ? ' · Xəbərdarlıq sayı: ' + a.violations : '') + (lateMin ? ' · cavablar ' + lateMin + ' dəq gec göndərilib' : ''));
  examNotify_(ex, name + ' «' + ex.title + '» imtahanını bitirdi: ' + res + (g.pending ? ' — açıq cavablar yoxlanılmalıdır' : '') + (reason === 'violations' ? ' (qayda pozuntularına görə dayandırıldı)' : ''));
}
// Müəllimə bildiriş: oxunmamış bildiriş varsa, yenisi yaradılmır — sayğac artır
function examNotify_(ex, text) {
  var uid = ex.teacherId;
  if (!uid || !findUser_(uid)) return;
  var open = rawRows_('Notifs').filter(function (n) { return n.userId === uid && n.type === 'exam' && n.param === ex.id && !n.readAt; })[0];
  if (!open) { notify_([uid], 'exam', text, 'exams', ex.id); return; }
  var m = String(open.text).match(/^(\d+) yeni nəticə/);
  update_('Notifs', open, { text: (m ? Number(m[1]) + 1 : 2) + ' yeni nəticə: «' + ex.title + '»', createdAt: now_() });
}

// Vaxtı bitmiş, amma bağlanmamış cəhdləri bağlayır (kilid daxilində çağırılır)
function examCloseExpired_(examId) {
  var started = examIndex_().filter(function (x) { return x.status === 'started' && (!examId || x.examId === examId); });
  var n = 0, now = Date.now();
  started.forEach(function (ent) {
    var a = fullRowAt_('ExamResults', ent._row);
    if (a.id !== ent.id || a.status !== 'started') return;
    if (now <= num_(a.deadline) + 60000) return;
    var ex = examAny_(a.examId);
    if (!ex) { resPatch_(a, { status: 'done', endReason: 'time', finishedAt: msToStamp_(num_(a.deadline)) }); return; }
    finalize_(ex, examQuestionsOf_(ex), a, null, 'time', now, '');
    n++;
  });
  return n;
}

// Qayda pozuntusu (başqa pəncərəyə keçid, kopyalama və s.). Limit keçiləndə imtahan dərhal bağlanır.
function xEvent_(req) {
  var a = attemptFull_(String(req.id || '').slice(0, 60));
  if (!a) throw fail_('İmtahan cəhdi tapılmadı.', 'NOTFOUND');
  if (a.status !== 'started') return { state: 'finished', resultId: a.id };
  var ex = examAny_(a.examId);
  if (!ex) throw fail_('İmtahan tapılmadı.', 'NOTFOUND');
  var qs = examQuestionsOf_(ex), at = req._at;
  var ans = req.answers ? cleanAnswers_(req.answers, qs.length) : null;
  if (at > num_(a.deadline) + EXAM_GRACE_SEC * 1000) { finalize_(ex, qs, a, null, 'time', at, ''); return { state: 'finished', resultId: a.id }; }
  if (!isTrue_(ex.strict)) return { state: 'ok', violations: 0, limit: EXAM_WARN_LIMIT };
  var kind = EXAM_VKINDS[req.kind] ? String(req.kind) : 'other';
  var vlog = parseJson_(a.vlog, []) || [];
  if (vlog.length < 80) vlog.push([msToStamp_(at).slice(11), kind]);
  var n = num_(a.violations) + 1;
  var ch = { violations: String(n), vlog: JSON.stringify(vlog) };
  if (ans) { var big = answersPut_(ans); Object.keys(big).forEach(function (k) { ch[k] = big[k]; }); ch.savedAt = now_();
    var json = JSON.stringify({ t: at, a: ans }); if (json.length < 90000) CacheService.getScriptCache().put('xd_' + a.id, json, 21600); }
  resPatch_(a, ch);
  if (isTrue_(ex.stopOnLimit) && n > EXAM_WARN_LIMIT) {
    finalize_(ex, qs, a, ans, 'violations', at, '');
    return { state: 'finished', resultId: a.id, violations: n };
  }
  return { state: 'ok', violations: n, limit: EXAM_WARN_LIMIT, left: Math.max(0, Math.round((num_(a.deadline) - Date.now()) / 1000)) };
}

function xSubmit_(req) {
  var a = attemptFull_(String(req.id || '').slice(0, 60));
  if (!a) throw fail_('İmtahan cəhdi tapılmadı.', 'NOTFOUND');
  if (a.status !== 'started') return { state: 'finished', resultId: a.id };
  var ex = examAny_(a.examId);
  if (!ex) throw fail_('İmtahan tapılmadı.', 'NOTFOUND');
  var qs = examQuestionsOf_(ex), at = req._at, dl = num_(a.deadline);
  var ans = cleanAnswers_(req.answers, qs.length), reason = 'submit', lateMin = '';
  if (at > dl + EXAM_GRACE_SEC * 1000) {
    // vaxt bitəndən sonra gələn cavab: vaxtında saxlanılmış qaralama varsa — o sayılır
    reason = 'time';
    var d = draftOf_(a);
    if (d) ans = d; else lateMin = String(Math.max(1, Math.round((at - dl) / 60000)));
  } else if (req.reason === 'time') reason = 'time';
  else if (req.reason === 'violations' && isTrue_(ex.strict) && isTrue_(ex.stopOnLimit)) {
    reason = 'violations';
    var v = Math.min(99, Math.floor(Number(req.violations) || 0));
    if (v > num_(a.violations)) resPatch_(a, { violations: String(Math.max(v, EXAM_WARN_LIMIT + 1)) });
  }
  finalize_(ex, qs, a, ans, reason, at, lateMin);
  return { state: 'finished', resultId: a.id };
}

// Nəticə səhifəsi (tələbə və valideyn üçün; link yalnız cəhdin təsadüfi nömrəsini bilənə açılır)
function xResult_(req) {
  var id = String(req.id || '').slice(0, 60);
  var bad = function () { return fail_('Nəticə tapılmadı. Link yanlışdır.', 'NOTFOUND'); };
  if (!/^R[a-f0-9]{32}$/.test(id)) throw bad();
  var a = attemptFull_(id);
  if (!a) throw bad();
  var ex = examAny_(a.examId);
  if (!ex) throw bad();
  if (a.status === 'started') {
    if (req._at <= num_(a.deadline) + EXAM_GRACE_SEC * 1000) return { state: 'running' };
    withLock_(function () {
      examFresh_();
      var b = attemptFull_(id);
      if (b && b.status === 'started') { var e2 = examAny_(b.examId); if (e2) finalize_(e2, examQuestionsOf_(e2), b, null, 'time', req._at, ''); }
    });
    examFresh_();
    a = attemptFull_(id); ex = examAny_(a.examId);
    if (!a || !ex || a.status === 'started') throw bad();
  }
  return { state: 'done', result: resultView_(ex, examQuestionsOf_(ex), a, false) };
}

// ---- test məlumatları üçün nümunə imtahan (yalnız developer generatoru) ----
var TEST_EXAM_Q = [
  { t: 't', q: '12 × 8 neçədir?', o: ['86', '96', '108', '92'], c: 1, p: 2 },
  { t: 't', q: 'Azərbaycanın paytaxtı hansı şəhərdir?', o: ['Gəncə', 'Sumqayıt', 'Bakı', 'Şəki'], c: 2, p: 2 },
  { t: 't', q: '«Book» sözünün tərcüməsi hansıdır?', o: ['Dəftər', 'Kitab', 'Qələm'], c: 1, p: 2 },
  { t: 't', q: 'Suyun kimyəvi formulu hansıdır?', o: ['CO2', 'O2', 'H2O', 'NaCl'], c: 2, p: 2 },
  { t: 't', q: 'Bir saatda neçə dəqiqə var?', o: ['30', '60', '90', '100'], c: 1, p: 2 },
  { t: 'o', q: 'Bu ay keçdiyiniz mövzulardan birini qısa izah edin.', a: 'Mövzunun adı və 2–3 cümləlik izahı.', p: 5 }
];
function examTestRows_(teacherId, studentIds, creatorId, stamp, n) {
  var keys = {}; studentIds.forEach(function (id) { keys[id] = examKey_(); });
  var max = TEST_EXAM_Q.reduce(function (s, q) { return s + q.p; }, 0);
  var ex = { id: newId_('E'), token: Utilities.getUuid().replace(/-/g, '').slice(0, 24), title: 'Test imtahanı ' + n, subject: pick_(TEST_SUBJECTS), note: '',
    teacherId: teacherId, studentIds: studentIds.join(','), keys: JSON.stringify(keys), duration: '30', points: '2', passMin: '8', maxPoints: String(max),
    qCount: String(TEST_EXAM_Q.length), openCount: '1', strict: 'true', stopOnLimit: 'true', shuffle: 'false', reveal: 'true', active: 'true', locked: 'false',
    createdBy: creatorId, createdAt: stamp, updatedAt: '', deletedAt: '', deletedBy: '', isTest: 'true' };
  var big = bigPut_('questions', TEST_EXAM_Q); Object.keys(big).forEach(function (k) { ex[k] = big[k]; });
  var results = [];
  studentIds.forEach(function (sid, i) {
    if (i % 4 === 3) return;                                   // bəziləri hələ başlamayıb
    var ans = {}; TEST_EXAM_Q.forEach(function (q, k) { if (q.t === 't') { if (Math.random() < 0.9) ans[k] = Math.random() < 0.7 ? q.c : Math.floor(Math.random() * q.o.length); } else if (Math.random() < 0.8) ans[k] = 'Test cavabı: mövzunu öz sözlərimlə izah edirəm.'; });
    var g = gradeAuto_(TEST_EXAM_Q, ans), dur = 30, startMs = Date.now() - (i + 1) * 3600e3, spent = 600 + Math.floor(Math.random() * 1000);
    var stopped = i % 7 === 5;
    var row = { id: 'R' + Utilities.getUuid().replace(/-/g, ''), examId: ex.id, status: g.pending ? 'review' : 'done', studentId: sid, startedAt: msToStamp_(startMs), dur: String(dur),
      deadline: String(startMs + dur * 60000), finishedAt: msToStamp_(startMs + spent * 1000), spent: String(spent), autoScore: String(g.auto), openScore: '0', score: String(g.auto),
      maxPoints: String(max), passMin: '8', openPending: String(g.pending), violations: stopped ? '4' : String(i % 3), endReason: stopped ? 'violations' : 'submit', late: '', marks: g.marks,
      gradedBy: '', gradedAt: '', savedAt: stamp, comment: '', conf: '{}', vlog: stopped ? '[["12:01:10","leave"],["12:03:42","copy"],["12:05:03","leave"],["12:06:30","leave"]]' : '[]', grades: '' };
    var b = bigPut_('answers', ans); Object.keys(b).forEach(function (k) { row[k] = b[k]; });
    results.push(row);
  });
  if (results.length) ex.locked = 'true';
  return { exam: ex, results: results };
}
