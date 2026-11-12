/**
 * 정적분 탐구실(미적분Ⅰ) — AI 피드백 중계 + 학생 기록 서버 (Google Apps Script)
 *
 * 하는 일
 *  - 교사 PIN(해시로만 저장)과 Gemini API 키를 '스크립트 속성'에 보관해요. 학생 브라우저에는 보내지 않아요.
 *  - 학생 앱의 요청을 받아 서버에서 Gemini를 호출하고, 결과만 돌려줘요.
 *  - 학생의 학번·이름, 단계 달성 여부, 답변 내용을 구글 스프레드시트에 기록해요.
 *  - 남용 방지: 분당·하루 AI 사용 제한, 기록 요청 분당 제한, 입력 길이 제한, PIN 5회 오류 시 10분 잠금.
 *
 * 설치 (자세한 내용은 README)
 *  1) 구글 스프레드시트를 새로 만들고 → 확장 프로그램 → Apps Script → 이 코드를 붙여 넣기
 *  2) 배포 → 새 배포 → 웹 앱 / 실행 사용자: 나 / 액세스: 모든 사용자
 */

const DEFAULTS = { model: 'gemini-3.8-flash', perMinute: 40, perDay: 1500, logsPerMinute: 400 };
const DEFAULT_PIN = '1234'; // 처음 한 번만 쓰여요. 로그인 후 반드시 바꾸세요.

const SHEETS = {
  progress: { name: '진행현황', header: ['학번', '이름', '처음 접속', '마지막 활동', '완료 단계 수'] },
  answers:  { name: '답변기록', header: ['시각', '학번', '이름', '단계', '단계 제목', '문항 유형', '학생 답', '결과', '피드백', '시도 횟수', '힌트 사용'] },
  golf:     { name: '골프기록', header: ['시각', '학번', '이름', '코스 번호', '총 타수', '기준 타수', '기준 대비', '홀별 타수'] },
};

const TEACHER_RULES = `당신은 고등학교 2학년 '미적분Ⅰ'에서 정적분을 처음 배우는 학생을 돕는 친절한 한국어 수학 선생님입니다.
학생은 정적분을 처음 배우거나, 설명을 한 번 듣고도 어려워하는 학생일 수 있습니다. 학생의 수준을 평가하거나 언급하지 말고, 다음을 반드시 지키세요.
- 정답이나 완성된 설명을 통째로 알려주지 마세요. 학생이 스스로 생각하도록 질문 한 개 또는 작은 실마리 한 개만 주세요.
- 쉬운 말과 짧은 문장을 쓰고, 2~4문장, 150자 내외로 답하세요. 마크다운 기호는 쓰지 마세요.
- 학생 답에서 잘한 점을 먼저 구체적으로 칭찬하세요.
- 이 수업에서 정적분은 '잘게 나눈 직사각형 넓이의 합이 다가가는 값', 즉 '방향(적분 구간)과 부호(함숫값)를 가진 넓이'로 배웁니다.
  x축 아래는 높이가 음수, 아래끝이 위끝보다 크면 폭 Δx가 음수, 아래끝과 위끝이 같으면 폭이 0인 넓이입니다.
- 사용할 수 있는 내용: 위의 정적분의 뜻, 정적분의 성질, 넓이 함수 S(x), 적분과 미분의 관계 S'(x)=f(x), 부정적분, F(b)−F(a).
- 미적분Ⅱ 용어(구분구적법, 급수, 수열의 극한, 리만 합)와 시그마·lim 기호를 쓴 설명은 꺼내지 마세요. "한없이 잘게 나누면 다가간다"처럼 말로 설명하세요.
- 정적분·넓이 탐구와 관계없는 요청(다른 과목 숙제, 잡담, 코드 작성 등)에는 "지금은 정적분 탐구에 집중해 볼까요?"라고만 답하세요.`;

/* ---------------- 진입점 ---------------- */
function doGet() {
  return json_(Object.assign({ ok: true, service: 'defint1' }, publicSettings_()));
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const handler = ACTIONS[req.action];
    if (!handler) return json_({ ok: false, error: '알 수 없는 요청이에요.' });
    return json_(Object.assign({ ok: true }, handler(req)));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

const ACTIONS = {
  /* 학생용 */
  status: () => publicSettings_(),
  studentLogin: req => studentLogin_(req),
  log:    req => { logAnswer_(req); return {}; },
  golf:   req => { logGolf_(req); return {}; },
  judge:  req => ({ result: judge_(req) }),
  chat:   req => ({ text: chat_(req) }),

  /* 교사용 (로그인 필요) */
  login:  req => login_(req.pin),
  logout: req => { CacheService.getScriptCache().remove('tok_' + req.token); return {}; },
  getConfig:  req => { auth_(req.token); return config_(); },
  saveConfig: req => { auth_(req.token); return saveConfig_(req); },
  listModels: req => { auth_(req.token); return { models: listModels_() }; },
  report:     req => { auth_(req.token); return report_(); },
  deleteStudents: req => { auth_(req.token); return deleteStudents_(req.sids); },
  deleteAll:      req => { auth_(req.token); if (req.confirm !== '전체삭제') throw new Error('확인 문구가 맞지 않아요.'); return deleteAll_(); },
  test:       req => { auth_(req.token); return { text: gemini_([{ role: 'user', parts: [{ text: '"연결 성공"이라고만 답하세요.' }] }], '짧게 답하세요.', false) }; },
};

/* ---------------- 설정 저장소 ---------------- */
function props_() { return PropertiesService.getScriptProperties(); }
function getKey_() { return props_().getProperty('GEMINI_API_KEY') || ''; }
function getModel_() { return props_().getProperty('MODEL') || DEFAULTS.model; }
function getNum_(name, def) { const v = Number(props_().getProperty(name)); return v > 0 ? v : def; }
function aiEnabled_() { return !!getKey_() && props_().getProperty('AI_ENABLED') !== 'false'; }
function golfOpen_() { return props_().getProperty('GOLF_OPEN') === 'true'; } // 단계 통과 없이 골프 열기
function escapeMode_() { return props_().getProperty('ESCAPE_MODE') === 'true'; } // 방탈출 모드
function courseMode_() { return props_().getProperty('COURSE_MODE') === 'short' ? 'short' : 'full'; } // 1차시 코스(short) / 전체 코스(full)
function varyLocks_() { return props_().getProperty('VARY_LOCKS') === 'true'; } // 학생마다 다른 자물쇠 숫자
function publicSettings_() { return { aiEnabled: aiEnabled_(), golfOpen: golfOpen_(), escapeMode: escapeMode_(), courseMode: courseMode_(), varyLocks: varyLocks_() }; }

function config_() {
  const key = getKey_();
  let sheetUrl = '';
  try { sheetUrl = book_().getUrl(); } catch (e) { sheetUrl = ''; }
  return {
    hasKey: !!key,
    keyTail: key ? key.slice(-4) : '',
    model: getModel_(),
    aiEnabled: props_().getProperty('AI_ENABLED') !== 'false',
    perMinute: getNum_('PER_MINUTE', DEFAULTS.perMinute),
    perDay: getNum_('PER_DAY', DEFAULTS.perDay),
    usedToday: Number(props_().getProperty(dayKey_()) || 0),
    mustChangePin: !props_().getProperty('PIN_HASH'),
    sheetUrl: sheetUrl,
    golfOpen: golfOpen_(),
    escapeMode: escapeMode_(),
    courseMode: courseMode_(),
    varyLocks: varyLocks_(),
  };
}

function saveConfig_(req) {
  const p = props_();
  if (typeof req.key === 'string' && req.key.trim()) p.setProperty('GEMINI_API_KEY', req.key.trim());
  if (req.clearKey) p.deleteProperty('GEMINI_API_KEY');
  if (typeof req.model === 'string' && /^[a-z0-9.\-]+$/i.test(req.model)) p.setProperty('MODEL', req.model);
  if (typeof req.aiEnabled === 'boolean') p.setProperty('AI_ENABLED', String(req.aiEnabled));
  if (typeof req.golfOpen === 'boolean') p.setProperty('GOLF_OPEN', String(req.golfOpen));
  if (typeof req.escapeMode === 'boolean') p.setProperty('ESCAPE_MODE', String(req.escapeMode));
  if (req.courseMode === 'short' || req.courseMode === 'full') p.setProperty('COURSE_MODE', req.courseMode);
  if (typeof req.varyLocks === 'boolean') p.setProperty('VARY_LOCKS', String(req.varyLocks));
  if (Number(req.perMinute) > 0) p.setProperty('PER_MINUTE', String(Math.min(300, Math.floor(req.perMinute))));
  if (Number(req.perDay) > 0) p.setProperty('PER_DAY', String(Math.min(20000, Math.floor(req.perDay))));
  if (typeof req.newPin === 'string' && req.newPin) {
    if (req.newPin.length < 4) throw new Error('PIN은 4자리 이상으로 정해 주세요.');
    if (req.newPin === DEFAULT_PIN) throw new Error('처음 설정값(1234)과 다른 PIN으로 정해 주세요.');
    const salt = Utilities.getUuid();
    p.setProperties({ PIN_SALT: salt, PIN_HASH: hash_(salt, req.newPin) });
  }
  return config_();
}

/* ---------------- 교사 로그인 ---------------- */
function hash_(salt, pin) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

function login_(pin) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pin_fails') || 0);
  if (fails >= 5) throw new Error('PIN을 여러 번 틀려서 10분 동안 잠겼어요. 잠시 후 다시 시도하세요.');
  const p = props_();
  const saved = p.getProperty('PIN_HASH');
  const ok = saved ? hash_(p.getProperty('PIN_SALT') || '', String(pin || '')) === saved
                   : String(pin || '') === DEFAULT_PIN;
  if (!ok) {
    cache.put('pin_fails', String(fails + 1), 600);
    throw new Error('PIN이 올바르지 않아요.');
  }
  cache.remove('pin_fails');
  const token = Utilities.getUuid();
  cache.put('tok_' + token, '1', 7200); // 2시간 동안 유효
  return { token: token, mustChangePin: !saved };
}

function auth_(token) {
  if (!token || !CacheService.getScriptCache().get('tok_' + token))
    throw new Error('관리자 로그인이 만료됐어요. 다시 로그인해 주세요.');
}

/* ---------------- 스프레드시트 ---------------- */
function book_() {
  // 1) 스프레드시트에서 만든 스크립트(권장)면 그 시트를 사용
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (ss) return ss;
  // 2) 따로 만든 스크립트면, 처음 한 번 새 스프레드시트를 만들어 계속 사용
  const p = props_();
  const id = p.getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  ss = SpreadsheetApp.create('정적분 탐구실(미적분Ⅰ) 학생 기록');
  p.setProperty('SHEET_ID', ss.getId());
  return ss;
}

function sheet_(def) {
  const ss = book_();
  let sh = ss.getSheetByName(def.name);
  if (!sh) {
    sh = ss.insertSheet(def.name);
    sh.appendRow(def.header);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, def.header.length).setFontWeight('bold').setBackground('#e0e7ff');
  }
  return sh;
}

function cleanSid_(s) { s = String(s || '').trim(); if (!/^[0-9A-Za-z\-]{2,12}$/.test(s)) throw new Error('학번 형식이 올바르지 않아요.'); return s; }
function cleanName_(s) { s = String(s || '').trim().replace(/[=+@]/g, ''); if (s.length < 1 || s.length > 20) throw new Error('이름을 확인해 주세요.'); return s; }
function safeCell_(s, n) { s = clip_(s, n); return /^[=+\-@]/.test(s) ? "'" + s : s; } // 수식으로 해석되지 않게

function checkLogQuota_() {
  const cache = CacheService.getScriptCache();
  const k = 'lg_' + Math.floor(Date.now() / 60000);
  const n = Number(cache.get(k) || 0);
  if (n >= DEFAULTS.logsPerMinute) throw new Error('기록 요청이 너무 많아요. 잠시 후 다시 시도해 주세요.');
  cache.put(k, String(n + 1), 120);
}

/** 진행현황에서 학생 행을 찾거나 만들어요. (잠금 안에서 호출) */
function progressRow_(sh, sid, name, total) {
  total = Math.max(1, Math.min(40, Number(total) || 15));
  // 단계 열 머리글 보장: 6열부터 '1단계', '2단계', …
  const need = SHEETS.progress.header.length + total;
  if (sh.getLastColumn() < need) {
    const heads = [];
    for (let i = 1; i <= total; i++) heads.push(i + '단계');
    sh.getRange(1, SHEETS.progress.header.length + 1, 1, total).setValues([heads]).setFontWeight('bold').setBackground('#e0e7ff');
  }
  const last = sh.getLastRow();
  if (last >= 2) {
    const ids = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
    for (let i = 0; i < ids.length; i++) if (ids[i][0] === sid) return i + 2;
  }
  const now = new Date();
  sh.appendRow([sid, name, now, now, 0]);
  sh.getRange(sh.getLastRow(), 1).setNumberFormat('@').setValue(sid);
  return sh.getLastRow();
}

function studentLogin_(req) {
  checkLogQuota_();
  const sid = cleanSid_(req.sid), name = cleanName_(req.name), total = Number(req.total) || 15;
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const sh = sheet_(SHEETS.progress);
    const row = progressRow_(sh, sid, name, total);
    const base = SHEETS.progress.header.length;
    const savedName = sh.getRange(row, 2).getDisplayValue();
    sh.getRange(row, 2).setValue(name);
    sh.getRange(row, 4).setValue(new Date());
    const marks = sh.getRange(row, base + 1, 1, total).getDisplayValues()[0];
    const done = [];
    marks.forEach((v, i) => { if (v) done.push(i); });
    return { done: done, nameChanged: !!savedName && savedName !== name, previousName: savedName };
  } finally { lock.releaseLock(); }
}

function logAnswer_(req) {
  checkLogQuota_();
  const sid = cleanSid_(req.sid), name = cleanName_(req.name), ev = req.event || {};
  const idx = Math.floor(Number(ev.index));
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const now = new Date();
    sheet_(SHEETS.answers).appendRow([
      now, "'" + sid, name, isFinite(idx) ? idx + 1 : '', safeCell_(ev.title, 60), safeCell_(ev.type, 20),
      safeCell_(ev.answer, 1000), safeCell_(ev.result, 20), safeCell_(ev.feedback, 600),
      Number(ev.tries) || '', Number(ev.hints) || 0,
    ]);
    const sh = sheet_(SHEETS.progress);
    const row = progressRow_(sh, sid, name, req.total);
    sh.getRange(row, 4).setValue(now);
    if (ev.result === '정답' || ev.result === '통과') {
      if (isFinite(idx) && idx >= 0 && idx < 40) {
        const cell = sh.getRange(row, SHEETS.progress.header.length + 1 + idx);
        if (!cell.getDisplayValue()) cell.setValue('✅ ' + Utilities.formatDate(now, 'Asia/Seoul', 'M/d HH:mm'));
      }
      const total = Math.max(1, Math.min(40, Number(req.total) || 15));
      const marks = sh.getRange(row, SHEETS.progress.header.length + 1, 1, total).getDisplayValues()[0];
      sh.getRange(row, 5).setValue(marks.filter(v => v).length);
    }
  } finally { lock.releaseLock(); }
}

function logGolf_(req) {
  checkLogQuota_();
  const sid = cleanSid_(req.sid), name = cleanName_(req.name);
  const card = (Array.isArray(req.card) ? req.card : []).slice(0, 18).map(v => Number(v) || '-').join(', ');
  const rel = Number(req.strokes) - Number(req.par);
  sheet_(SHEETS.golf).appendRow([new Date(), "'" + sid, name, Number(req.code) || '', Number(req.strokes) || '', Number(req.par) || '',
    isFinite(rel) ? (rel > 0 ? '+' + rel : String(rel)) : '', card]);
}

/* ---------------- 교사용 현황 보고서 ----------------
 * 진행현황 전체와 최근 답변기록(최대 4000건)을 돌려줘요. 반 구분·달성률 계산은 앱에서 해요. */
function report_() {
  const ss = book_();
  const out = { students: [], answers: [], steps: 0, sheetUrl: ss.getUrl() };
  const ps = ss.getSheetByName(SHEETS.progress.name);
  if (ps && ps.getLastRow() >= 2) {
    const base = SHEETS.progress.header.length;
    const vals = ps.getRange(1, 1, ps.getLastRow(), ps.getLastColumn()).getDisplayValues();
    out.steps = Math.max(0, vals[0].length - base);
    for (let r = 1; r < vals.length; r++) {
      const row = vals[r]; if (!row[0]) continue;
      const done = [];
      for (let i = 0; i < out.steps; i++) if (row[base + i]) done.push(i);
      out.students.push({ sid: row[0], name: row[1], first: row[2], last: row[3], done: done });
    }
  }
  const as = ss.getSheetByName(SHEETS.answers.name);
  if (as && as.getLastRow() >= 2) {
    const n = as.getLastRow() - 1, take = Math.min(n, 4000);
    const vals = as.getRange(as.getLastRow() - take + 1, 1, take, SHEETS.answers.header.length).getDisplayValues();
    out.answers = vals.map(v => ({ t: v[0], sid: v[1], name: v[2], step: Number(v[3]) || 0, title: v[4], type: v[5],
      answer: v[6], result: v[7], feedback: v[8], tries: v[9], hints: v[10] }));
  }
  return out;
}

/* ---------------- 교사용: 학생 기록 삭제 ----------------
 * 지정한 시트에서 조건에 맞는 학생 행을 지우고 나머지만 다시 써요. (머리글 행은 그대로) */
function removeRows_(def, sidCol, shouldDelete) {
  const sh = book_().getSheetByName(def.name);
  if (!sh || sh.getLastRow() < 2) return 0;
  const n = sh.getLastRow() - 1, cols = sh.getLastColumn();
  const rng = sh.getRange(2, 1, n, cols);
  const vals = rng.getValues(), disp = rng.getDisplayValues();
  const keep = [];
  let removed = 0;
  for (let i = 0; i < n; i++) {
    if (shouldDelete(String(disp[i][sidCol]).replace(/^'/, ''))) removed++;
    else keep.push(vals[i]);
  }
  if (!removed) return 0;
  rng.clearContent();
  if (keep.length) {
    sh.getRange(2, sidCol + 1, keep.length, 1).setNumberFormat('@'); // 학번은 글자로 유지
    sh.getRange(2, 1, keep.length, cols).setValues(keep.map(r => r.map((v, c) => c === sidCol ? String(v) : v)));
  }
  return removed;
}

function deleteStudents_(sids) {
  const list = (Array.isArray(sids) ? sids : []).map(s => String(s).trim()).filter(Boolean).slice(0, 1000);
  if (!list.length) throw new Error('삭제할 학생을 골라 주세요.');
  const set = {};
  list.forEach(s => set[s] = true);
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    return {
      progress: removeRows_(SHEETS.progress, 0, s => !!set[s]),
      answers:  removeRows_(SHEETS.answers, 1, s => !!set[s]),
      golf:     removeRows_(SHEETS.golf, 1, s => !!set[s]),
      students: list.length,
    };
  } finally { lock.releaseLock(); }
}

function deleteAll_() {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    return {
      progress: removeRows_(SHEETS.progress, 0, () => true),
      answers:  removeRows_(SHEETS.answers, 1, () => true),
      golf:     removeRows_(SHEETS.golf, 1, () => true),
    };
  } finally { lock.releaseLock(); }
}

/* ---------------- 사용량 제한 ---------------- */
function dayKey_() { return 'USAGE_' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd'); }

function checkQuota_() {
  if (!aiEnabled_()) throw new Error('AI 피드백이 꺼져 있어요.');
  const cache = CacheService.getScriptCache();
  const minuteKey = 'rl_' + Math.floor(Date.now() / 60000);
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const m = Number(cache.get(minuteKey) || 0);
    if (m >= getNum_('PER_MINUTE', DEFAULTS.perMinute)) throw new Error('지금 요청이 많아요. 1분 뒤에 다시 시도해 주세요.');
    const dk = dayKey_(), p = props_();
    const d = Number(p.getProperty(dk) || 0);
    if (d >= getNum_('PER_DAY', DEFAULTS.perDay)) throw new Error('오늘 사용할 수 있는 AI 횟수를 모두 썼어요.');
    cache.put(minuteKey, String(m + 1), 120);
    p.setProperty(dk, String(d + 1));
  } finally {
    lock.releaseLock();
  }
}

function clip_(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; }

/* ---------------- AI 기능 ---------------- */
function judge_(req) {
  checkQuota_();
  const rubric = (Array.isArray(req.rubric) ? req.rubric : []).slice(0, 6).map(r => clip_(r, 80)).join(' / ');
  const prompt =
`[탐구 질문] ${clip_(req.question, 300)}
[교사가 기대하는 핵심 생각 - 학생에게 그대로 알려주지 말 것] ${clip_(req.goal, 500)}
[평가 기준] 다음 요소 중 ${Number(req.need) || 1}개 이상이 학생 말로 (표현이 서툴러도) 담겨 있으면 통과: ${rubric}
[이 단계 시도 횟수] ${Number(req.tries) || 1}
[학생 답] ${clip_(req.answer, 800)}

JSON으로만 답하세요: {"pass": true 또는 false, "feedback": "학생에게 줄 피드백"}
- pass가 true면: 잘한 점을 칭찬하고, 더 생각해 볼 점이 있으면 한 가지만 가볍게 덧붙이세요.
- pass가 false면: 잘한 점을 먼저 말하고, 빠진 생각을 정답으로 알려주지 말고 질문 한 개로 이끌어 주세요. 시도 횟수가 3 이상이면 실마리를 조금 더 구체적으로 주세요.`;
  const out = gemini_([{ role: 'user', parts: [{ text: prompt }] }], TEACHER_RULES, true);
  const j = JSON.parse(out.replace(/```json|```/g, '').trim());
  return { pass: !!j.pass, feedback: clip_(j.feedback, 600) };
}

function chat_(req) {
  checkQuota_();
  const hist = (Array.isArray(req.history) ? req.history : []).slice(-10).map(m => ({
    role: m.role === 'model' ? 'model' : 'user',
    parts: [{ text: clip_(m.text, 500) }],
  }));
  if (!hist.length || hist[hist.length - 1].role !== 'user') throw new Error('질문이 비어 있어요.');
  const context = clip_(req.context, 600) +
    '\n학생이 탐구 질문의 정답을 직접 물어보면 답을 말하지 말고 생각할 질문으로 되돌려 주세요.';
  return gemini_(hist, TEACHER_RULES + '\n[현재 화면] ' + context, false).trim();
}

function gemini_(contents, system, asJson) {
  const key = getKey_();
  if (!key) throw new Error('API 키가 등록되지 않았어요.');
  const body = { contents: contents, systemInstruction: { parts: [{ text: system }] }, generationConfig: { temperature: 0.4 } };
  if (asJson) body.generationConfig.responseMimeType = 'application/json';
  const res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(getModel_()) + ':generateContent',
    { method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body), muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200) throw new Error((data.error && data.error.message) || ('Gemini 오류 ' + res.getResponseCode()));
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(p => p.text || '').join('');
}

function listModels_() {
  const key = getKey_();
  if (!key) throw new Error('먼저 API 키를 저장해 주세요.');
  let all = [], tok = '';
  do {
    const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000' + (tok ? '&pageToken=' + tok : ''),
      { headers: { 'x-goog-api-key': key }, muteHttpExceptions: true });
    const d = JSON.parse(res.getContentText() || '{}');
    if (res.getResponseCode() !== 200) throw new Error((d.error && d.error.message) || ('HTTP ' + res.getResponseCode()));
    all = all.concat(d.models || []); tok = d.nextPageToken || '';
  } while (tok);
  return all
    .filter(m => (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0)
    .map(m => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name }))
    .filter(m => /^gemini/.test(m.id) && !/(embedding|image|tts|audio|live|vision|aqa|robotics|transcribe|banana)/i.test(m.id));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- (선택) 편집기에서 직접 설정하기 ----------------
 * 앱의 관리자 화면 대신, 아래 값을 채우고 이 함수를 한 번 실행해도 돼요.
 * 실행하면 기록용 시트(진행현황·답변기록·골프기록)도 미리 만들어져요.
 * 실행한 뒤에는 키와 PIN을 지우고 저장하세요. (코드에 남겨 두지 마세요!)
 */
function setupOnce() {
  const API_KEY = '';   // 예: 'AIza...'
  const NEW_PIN = '';   // 예: '7429'
  const p = props_();
  if (API_KEY) p.setProperty('GEMINI_API_KEY', API_KEY);
  if (NEW_PIN) { const salt = Utilities.getUuid(); p.setProperties({ PIN_SALT: salt, PIN_HASH: hash_(salt, NEW_PIN) }); }
  Object.keys(SHEETS).forEach(k => sheet_(SHEETS[k]));
  Logger.log('설정 완료: 키 ' + (getKey_() ? '있음' : '없음') + ', PIN ' + (p.getProperty('PIN_HASH') ? '설정됨' : '기본값(1234)') + ', 시트 ' + book_().getUrl());
}
