/* 우리집 가계부 — PWA 클라이언트 (프레임워크 없이 동작) */
(function () {
  'use strict';

  // ───────────── 저장소 ─────────────
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem('gb.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { localStorage.setItem('gb.' + k, JSON.stringify(v)); },
    del: function (k) { localStorage.removeItem('gb.' + k); }
  };

  var ALL_CURRENCIES = ('KRW USD JPY CNY EUR GBP THB VND PHP MYR SGD IDR TWD HKD AUD NZD CAD CHF MXN BRL ARS CLP COP PEN BOB ' +
    'CUP UYU PYG ZAR NAD BWP ZMW TZS KES ETB EGP JOD TRY AED INR NPR LKR MVR KHR LAK MMK MNT KZT UZS PLN CZK HUF SEK NOK DKK ISK MAD TND SCR MUR MGA').split(' ');
  var CUR_NAMES = { KRW: '원', USD: '미국 달러', JPY: '엔', CNY: '위안', EUR: '유로', GBP: '파운드', THB: '바트', VND: '동', PHP: '페소(필)',
    MYR: '링깃', SGD: '싱가포르 달러', IDR: '루피아', TWD: '대만 달러', HKD: '홍콩 달러', AUD: '호주 달러', MXN: '멕시코 페소',
    BRL: '헤알', ARS: '아르헨 페소', CLP: '칠레 페소', COP: '콜롬비아 페소', PEN: '솔', BOB: '볼리비아노', CUP: '쿠바 페소',
    ZAR: '랜드', NAD: '나미비아 달러', BWP: '풀라', ZMW: '콰차', TZS: '탄자니아 실링', KES: '케냐 실링', ETB: '비르', EGP: '이집트 파운드',
    JOD: '요르단 디나르', TRY: '리라', MGA: '아리아리', SCR: '세이셸 루피', MUR: '모리셔스 루피' };

  var cfg = LS.get('cfg', { apiUrl: '', token: '', user: '', travel: { on: false, currency: 'THB', trip: '' } });
  var boot = LS.get('boot', null);
  var queue = LS.get('queue', []);
  var fxCache = LS.get('fx', {});
  var cache = {}; // year → txs

  var state = {
    tab: 'list',
    ym: ymOf(new Date()),
    year: new Date().getFullYear(),
    filter: 'all',
    search: '',
    statsMeasure: '소비',
    statsSection: '소비',
    listMode: 'list',
    calDay: '',
    statsBig: '',
    syncing: false,
    lastError: '',
    years: []
  };

  // ───────────── 유틸 ─────────────
  function $(s, el) { return (el || document).querySelector(s); }
  function $$(s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function ymOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
  function today() { return ymd(new Date()); }
  function won(n) { n = Math.round(Number(n) || 0); return n.toLocaleString('ko-KR') + '원'; }
  function wonShort(n) {
    n = Math.round(Number(n) || 0); var a = Math.abs(n), s = n < 0 ? '-' : '';
    if (a >= 100000000) return s + (a / 100000000).toFixed(a >= 1e9 ? 0 : 1).replace(/\.0$/, '') + '억';
    if (a >= 10000) return s + Math.round(a / 10000).toLocaleString('ko-KR') + '만';
    return s + a.toLocaleString('ko-KR');
  }
  function fmtLocal(n, cur) {
    var digits = ['JPY', 'KRW', 'VND', 'IDR', 'CLP', 'COP', 'PYG', 'TZS', 'MGA', 'UZS', 'LAK', 'KHR', 'MMK'].indexOf(cur) >= 0 ? 0 : 2;
    return cur + ' ' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
  }
  function uid() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  var DOW = ['일', '월', '화', '수', '목', '금', '토'];
  function dayLabel(s) { var p = s.split('-'); var d = new Date(+p[0], +p[1] - 1, +p[2]); return (+p[1]) + '월 ' + (+p[2]) + '일 (' + DOW[d.getDay()] + ')'; }
  function toast(msg, ms) {
    var t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.add('hidden'); }, ms || 2200);
  }
  function isSpend(t) { return t.kind !== '수입'; }
  function configured() { return !!(cfg.apiUrl && (cfg.token || cfg.apiUrl === 'demo')); }
  function saveCfg() { LS.set('cfg', cfg); }

  // ───────────── 서버 통신 ─────────────
  function api(action, payload) {
    if (cfg.apiUrl === 'demo') return Demo.handle(action, payload || {});
    var body = Object.assign({ token: cfg.token, action: action }, payload || {});
    return fetch(cfg.apiUrl, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow' })
      .then(function (r) { if (!r.ok) throw new Error('서버 응답 ' + r.status); return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || '서버 오류'); return j; });
  }

  // ───────────── 오프라인 대기열 & 동기화 ─────────────
  function enqueue(op) {
    var key = op.type === 'delete' ? op.id : op.tx.id;
    queue = queue.filter(function (q) { return (q.type === 'delete' ? q.id : q.tx.id) !== key; });
    queue.push(op);
    LS.set('queue', queue);
  }
  function applyQueue(list, year) {
    var byId = {}; list.forEach(function (t) { byId[t.id] = t; });
    queue.forEach(function (q) {
      if (q.type === 'delete') delete byId[q.id];
      else if (q.tx.date.slice(0, 4) === String(year)) byId[q.tx.id] = Object.assign({}, q.tx, { _pending: true });
      else delete byId[q.tx.id];
    });
    return Object.keys(byId).map(function (k) { return byId[k]; });
  }
  function flush() {
    if (!queue.length) return Promise.resolve();
    var q = queue[0];
    var p = q.type === 'delete' ? api('delete', { id: q.id }) : api('add', { tx: stripLocal(q.tx) });
    return p.then(function () {
      queue = queue.filter(function (x) { return x !== q; });
      LS.set('queue', queue);
      return flush();
    });
  }
  function stripLocal(t) { var o = Object.assign({}, t); delete o._pending; return o; }

  function sync(silent) {
    if (!configured() || state.syncing) return Promise.resolve();
    state.syncing = true; renderSync();
    var years = [state.year];
    if (state.tab === 'list') years = [Number(state.ym.slice(0, 4))];
    return flush()
      .then(function () { return boot ? null : api('bootstrap').then(function (b) { setBoot(b); }); })
      .then(function () { return Promise.all(years.map(loadYearRemote)); })
      .then(function () { state.lastError = ''; LS.set('lastSync', Date.now()); })
      .catch(function (e) { state.lastError = e.message || String(e); if (!silent) toast('동기화 실패: ' + state.lastError); })
      .then(function () { state.syncing = false; renderSync(); render(); });
  }
  function refreshBoot() {
    return api('bootstrap').then(function (b) { setBoot(b); render(); });
  }
  function setBoot(b) { boot = b; LS.set('boot', b); if (!cfg.user && b.users && b.users.length) { cfg.user = b.users[0]; saveCfg(); } }
  function loadYearRemote(year) {
    return api('list', { year: year }).then(function (r) {
      cache[year] = r.txs; LS.set('tx.' + year, r.txs);
      if (r.years) { state.years = r.years.map(Number); LS.set('years', state.years); }
    });
  }
  function getYear(year) {
    if (!cache[year]) cache[year] = LS.get('tx.' + year, []);
    return applyQueue(cache[year], year);
  }
  function saveTx(tx) {
    tx.updatedAt = new Date().toISOString();
    var y = Number(tx.date.slice(0, 4));
    // 다른 연도로 옮겨진 경우 기존 연도 캐시에서 제거
    Object.keys(cache).forEach(function (k) { cache[k] = cache[k].filter(function (t) { return t.id !== tx.id; }); LS.set('tx.' + k, cache[k]); });
    enqueue({ type: 'save', tx: tx });
    if (!cache[y]) cache[y] = LS.get('tx.' + y, []);
    render();
    sync(true);
  }
  function deleteTx(id) {
    enqueue({ type: 'delete', id: id });
    render();
    sync(true);
  }

  function renderSync() {
    var dot = $('#syncDot'), txt = $('#syncText');
    dot.className = 'dot';
    if (!configured()) { txt.textContent = '연결 필요'; dot.classList.add('err'); return; }
    if (cfg.apiUrl === 'demo') { txt.textContent = '데모'; dot.classList.add('pending'); return; }
    if (state.syncing) { txt.textContent = '동기화 중…'; dot.classList.add('pending'); return; }
    if (state.lastError) { txt.textContent = queue.length ? ('대기 ' + queue.length + '건') : '오프라인'; dot.classList.add('err'); return; }
    if (queue.length) { txt.textContent = '대기 ' + queue.length + '건'; dot.classList.add('pending'); return; }
    txt.textContent = '동기화됨'; dot.classList.add('ok');
  }

  // ───────────── 환율 ─────────────
  function getRate(cur, date) {
    cur = cur.toUpperCase();
    if (cur === 'KRW') return Promise.resolve({ rate: 1, date: date });
    var key = cur + '@' + date;
    if (fxCache[key]) return Promise.resolve({ rate: fxCache[key], date: date });
    var c = cur.toLowerCase();
    var isToday = date >= today();
    var urls = (isToday ? [] : [
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@' + date + '/v1/currencies/' + c + '.json',
      'https://' + date + '.currency-api.pages.dev/v1/currencies/' + c + '.json'
    ]).concat([
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/' + c + '.json',
      'https://latest.currency-api.pages.dev/v1/currencies/' + c + '.json'
    ]);
    function attempt(i) {
      if (i >= urls.length) return Promise.reject(new Error('환율 조회 실패'));
      return fetch(urls[i]).then(function (r) { if (!r.ok) throw 0; return r.json(); })
        .then(function (j) {
          var rate = j[c] && j[c].krw; if (!(rate > 0)) throw 0;
          if (!isToday || i >= 0) { fxCache[key] = rate; fxCache['last.' + cur] = rate; LS.set('fx', fxCache); }
          return { rate: rate, date: j.date || date };
        })
        .catch(function () { return attempt(i + 1); });
    }
    return attempt(0).catch(function () {
      var last = fxCache['last.' + cur];
      if (last) return { rate: last, date: date, stale: true };
      throw new Error('환율 조회 실패(오프라인)');
    });
  }

  // ───────────── 분류 도우미 ─────────────
  function cats() { return (boot && boot.categories) || Demo.boot().categories; }
  function methods() { return ((boot && boot.methods) || Demo.boot().methods).map(function (m) { return m.name; }); }
  function users() { return (boot && boot.users) || ['홍키', '핸니']; }
  function groups(kindFilter) {
    var out = [], idx = {};
    cats().forEach(function (c) {
      if (kindFilter === '수입' ? c.kind !== '수입' : c.kind === '수입') return;
      var key = c.kind + '|' + c.big;
      if (!idx[key]) { idx[key] = { kind: c.kind, big: c.big, subs: [] }; out.push(idx[key]); }
      idx[key].subs.push(c.sub);
    });
    return out;
  }
  function currencyOptions(selected) {
    var fav = (boot && boot.currencies) || ['KRW', 'USD', 'JPY', 'THB', 'EUR', 'CNY'];
    if (cfg.travel.on && fav.indexOf(cfg.travel.currency) < 0) fav = [cfg.travel.currency].concat(fav);
    var rest = ALL_CURRENCIES.filter(function (c) { return fav.indexOf(c) < 0; });
    function opt(c) { return '<option value="' + c + '"' + (c === selected ? ' selected' : '') + '>' + c + (CUR_NAMES[c] ? ' ' + CUR_NAMES[c] : '') + '</option>'; }
    return '<optgroup label="자주 쓰는 통화">' + fav.map(opt).join('') + '</optgroup><optgroup label="전체">' + rest.map(opt).join('') + '</optgroup>';
  }
  var EMOJI = {
    '병원/약국': '💊', '고양이': '🐱', '항공권': '✈️', '기차/버스': '🚆', '대중교통/택시': '🚕', '주유/주차': '⛽', '차량유지관리': '🔧',
    '뷰티': '💄', '패션': '👕', '관리': '💆', '수리비': '🛠️', '숙박비': '🏨', '액티비티/입장료': '🎟️',
    '외식': '🍽️', '배달': '🛵', '마트': '🛒', '인터넷쇼핑(쿠팡)': '📦', '생필품/생활': '🧻', '가전/가구': '🛋️',
    '주류': '🍺', '담배': '🚬', '친구/지인': '🥂', '경조사/선물': '🎁', '홍키용돈': '💵', '핸니용돈': '💵',
    '세무사/종소세': '🧾', '재산세/보유세': '🏛️', '세금': '🧾', '공과금(전기/가스/수도)': '💡', '건보료': '🏥', '연금': '🏦',
    '보험료': '🛡️', '구독': '📺', '인터넷/핸드폰': '📱', '임대관리': '🏢', '기타': '📌',
    '배당소득': '📈', '채권/이자': '🏦', '주식매도': '📈'
  };
  var BIG_EMOJI = { '가족': '👪', '교통': '🚌', '자동차': '🚗', '미용': '💇', '수리': '🛠️', '여행': '🧳', '생활': '🏠', '기호': '☕', '모임': '🥂', '용돈': '💵', '임대수익': '🏠', '기타소득': '💰', '미분류': '❔' };
  // 분류별 고정 색 (순위가 아니라 분류에 따라 같은 색)
  var BIG_SLOT = { '생활': 1, '가족': 2, '교통': 3, '여행': 4, '기호': 5, '자동차': 6, '미용': 7, '모임': 8 };
  function bigColor(big) { return 'var(--c' + (BIG_SLOT[big] || 0) + ')'; }
  function iconHtml(t) {
    var e = EMOJI[t.sub] || BIG_EMOJI[t.big] || (t.kind === '수입' ? '💰' : '📌');
    if (t.kind === '수입' && !EMOJI[t.sub]) e = BIG_EMOJI[t.big] || '💰';
    var c = t.kind === '수입' ? 'var(--accent)' : t.kind === '비소비' ? 'var(--c0)' : bigColor(t.big);
    return '<div class="ic" style="background:color-mix(in srgb, ' + c + ' 15%, transparent)">' + e + '</div>';
  }
  function bigInitial(t) {
    if (t.kind === '수입') return '입';
    if (t.kind === '비소비') return '고';
    return (t.big || '?').slice(0, 1);
  }

  // ───────────── 렌더링 ─────────────
  function render() {
    renderSync();
    $$('#tabbar button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === state.tab); });
    var v = $('#view');
    if (!configured() && state.tab !== 'settings') { v.innerHTML = renderWelcome(); bindWelcome(); return; }
    if (state.tab === 'list') { v.innerHTML = renderList(); bindList(); }
    else if (state.tab === 'stats') { v.innerHTML = renderStats(); bindStats(); }
    else if (state.tab === 'trips') { v.innerHTML = renderTrips(); bindTrips(); }
    else if (state.tab === 'settings') { v.innerHTML = renderSettings(); bindSettings(); }
    animateCounts();
  }

  var lastCounts = {};
  function animateCounts() {
    $$('[data-count]').forEach(function (el) {
      var to = Number(el.dataset.count), key = el.dataset.key || 'k';
      var from = lastCounts[key] === undefined ? 0 : lastCounts[key];
      lastCounts[key] = to;
      if (from === to || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      var t0 = performance.now(), dur = 650;
      (function step(now) {
        var k = Math.min(1, (now - t0) / dur); k = 1 - Math.pow(1 - k, 3);
        el.textContent = Math.round(from + (to - from) * k).toLocaleString('ko-KR');
        if (k < 1) requestAnimationFrame(step);
      })(t0);
    });
  }
  function renderWelcome() {
    return '<div class="welcome"><img class="logo" src="icons/icon-192.png" alt=""><h2>우리집 가계부</h2>' +
      '<p>부부가 함께 쓰는 가계부예요.<br>서버 주소와 접속 코드를 넣으면 바로 시작해요.</p></div><div class="card">' +
      '<div class="actions"><button class="btn primary" id="goSettings">연결 설정하기</button></div>' +
      '<div class="actions"><button class="btn" id="goDemo">데모 데이터로 둘러보기</button></div></div>';
  }
  function bindWelcome() {
    $('#goSettings').onclick = function () { state.tab = 'settings'; render(); };
    $('#goDemo').onclick = function () { cfg.apiUrl = 'demo'; cfg.token = ''; saveCfg(); boot = null; Demo.reset(); sync().then(function () { state.tab = 'list'; render(); }); };
  }

  // ── 내역 ──
  function monthTxs() {
    var y = Number(state.ym.slice(0, 4));
    return getYear(y).filter(function (t) { return t.date.slice(0, 7) === state.ym; });
  }
  function renderList() {
    var all = monthTxs();
    var inc = 0, con = 0, non = 0;
    all.forEach(function (t) { if (t.kind === '수입') inc += t.amount; else if (t.kind === '비소비') non += t.amount; else con += t.amount; });
    var review = all.filter(function (t) { return t.status === '확인필요'; }).length;
    var list = all.filter(function (t) {
      if (state.filter === 'review' && t.status !== '확인필요') return false;
      if (state.filter === '수입' && t.kind !== '수입') return false;
      if (state.filter === '지출' && t.kind === '수입') return false;
      if (users().indexOf(state.filter) >= 0 && t.user !== state.filter) return false;
      if (state.search) {
        var q = state.search.toLowerCase();
        if ((t.desc + ' ' + t.sub + ' ' + t.big + ' ' + t.memo + ' ' + t.method + ' ' + (t.trip || '')).toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    }).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || '').localeCompare(a.createdAt || ''); });

    var p = state.ym.split('-');
    var html = '';
    if (cfg.travel.on) html += '<div class="travel-banner">✈ 여행 모드: <b>' + esc(cfg.travel.trip || '여행') + '</b> · ' + esc(cfg.travel.currency) + ' 기본 입력</div>';
    html += '<div class="period"><button id="prevM" aria-label="이전 달">‹</button><div class="label">' + p[0] + '년 ' + (+p[1]) + '월</div><button id="nextM" aria-label="다음 달">›</button></div>';
    html += '<div class="hero"><div class="hk">' + (+p[1]) + '월에 쓴 돈</div>' +
      '<div class="hv num"><span data-count="' + Math.round(con + non) + '" data-key="m' + state.ym + '">' + Math.round(con + non).toLocaleString('ko-KR') + '</span><small>원</small></div>' +
      '<div class="sub"><span>소비 <b class="num">' + wonShort(con) + '</b></span><span>고정 <b class="num">' + wonShort(non) + '</b></span>' +
      '<span>수입 <b class="income num">' + wonShort(inc) + '</b></span><span>잉여 <b class="num">' + wonShort(inc - con - non) + '</b></span></div>' +
      monthInsight(con) + '</div>';
    html += budgetCard(all, state.ym);
    if (state.ym === today().slice(0, 7) && boot && boot.fixed && boot.fixed.length && !all.some(function (t) { return t.fixed; }))
      html += '<div class="notice"><span>📌 이번 달 고정지출이 아직 없어요</span><button class="btn small primary" id="fixedBtn2">넣기</button></div>';
    var f = [['all', '전체'], ['지출', '지출'], ['수입', '수입']].concat(users().map(function (u) { return [u, u]; }));
    html += '<div class="toolbar"><div class="chips">' + f.map(function (x) {
      return '<button class="chip' + (state.filter === x[0] ? ' on' : '') + '" data-f="' + esc(x[0]) + '">' + esc(x[1]) + '</button>';
    }).join('') + (review ? '<button class="chip' + (state.filter === 'review' ? ' on' : '') + '" data-f="review">확인필요<span class="n">' + review + '</span></button>' : '') + '</div></div>';
    html += '<div class="toolbar"><input class="search" id="search" type="search" placeholder="내용·분류 검색" value="' + esc(state.search) + '">' +
      '<div class="seg mini"><button type="button" data-lm="list" class="' + (state.listMode === 'list' ? 'on' : '') + '">목록</button><button type="button" data-lm="cal" class="' + (state.listMode === 'cal' ? 'on' : '') + '">달력</button></div></div>';
    html += '<div class="actionbar"><button class="btn" id="fixedBtn">📌 고정지출 넣기</button><button class="btn" id="smsBtn">💬 문자 붙여넣기</button></div>';
    if (state.listMode === 'cal') {
      html += calendarHtml(all);
      if (state.calDay && state.calDay.slice(0, 7) === state.ym) list = list.filter(function (t) { return t.date === state.calDay; });
      else { html += '<div class="empty" style="padding:16px 0">날짜를 누르면 그날 내역이 보여요</div>'; return html; }
    }

    if (!list.length) html += '<div class="empty">' + (all.length ? '조건에 맞는 내역이 없어요' : '이 달의 내역이 없어요.<br>아래 ＋ 버튼으로 입력해 보세요.') + '</div>';
    var byDay = {}; var days = [];
    list.forEach(function (t) { if (!byDay[t.date]) { byDay[t.date] = []; days.push(t.date); } byDay[t.date].push(t); });
    days.forEach(function (d) {
      var sum = byDay[d].reduce(function (s, t) { return s + (isSpend(t) ? -t.amount : t.amount); }, 0);
      html += '<div class="day"><span>' + dayLabel(d) + '</span><span class="num">' + (sum > 0 ? '+' : '') + won(sum) + '</span></div><div class="txlist">';
      byDay[d].forEach(function (t) { html += txRow(t); });
      html += '</div>';
    });
    return html;
  }
  function txRow(t) {
    var inc = t.kind === '수입';
    var meta = [t.sub || t.big, t.method, t.user].filter(Boolean).join(' · ');
    var badges = '';
    if (t.status === '확인필요') badges += '<span class="badge warn">확인필요</span>';
    if (t.source === '문자' || t.source === '애플페이') badges += '<span class="badge auto">' + esc(t.source) + '</span>';
    if (t._pending) badges += '<span class="badge wait">전송대기</span>';
    var fx = t.currency && t.currency !== 'KRW' && t.localAmount != null ? '<div class="fx">' + esc(fmtLocal(t.localAmount, t.currency)) + '</div>' : '';
    return '<div class="tx" data-id="' + esc(t.id) + '">' + iconHtml(t) +
      '<div class="main"><div class="d">' + esc(t.desc || '(내용 없음)') + badges + '</div><div class="m">' + esc(meta) + (t.trip ? ' · ✈' + esc(t.trip) : '') + '</div></div>' +
      '<div class="a num' + (inc ? ' inc' : '') + '">' + (inc ? '+' : '') + won(t.amount) + fx + '</div></div>';
  }
  function bindList() {
    $('#prevM').onclick = function () { shiftMonth(-1); };
    $('#nextM').onclick = function () { shiftMonth(1); };
    $$('.chip[data-f]').forEach(function (b) { b.onclick = function () { state.filter = b.dataset.f; render(); }; });
    var s = $('#search');
    s.oninput = function () { state.search = s.value; var pos = s.selectionStart; render(); var n = $('#search'); n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) {} };
    $$('.tx').forEach(function (el) { el.onclick = function () { var t = findTx(el.dataset.id); if (t) openForm(t); }; });
    $('#fixedBtn').onclick = openFixed;
    var fb2 = $('#fixedBtn2'); if (fb2) fb2.onclick = openFixed;
    $('#smsBtn').onclick = openSmsPaste;
    $$('[data-lm]').forEach(function (b) { b.onclick = function () { state.listMode = b.dataset.lm; render(); }; });
    $$('.cal-cell[data-day]').forEach(function (c) { c.onclick = function () { state.calDay = state.calDay === c.dataset.day ? '' : c.dataset.day; render(); }; });
    var bs = $('#budgetSet'); if (bs) bs.onclick = openBudgetEditor;
  }
  function shiftMonth(d) {
    var p = state.ym.split('-'); var dt = new Date(+p[0], +p[1] - 1 + d, 1);
    var oldY = +p[0]; state.ym = ymOf(dt);
    render();
    if (dt.getFullYear() !== oldY) sync(true);
  }
  function findTx(id) {
    var ys = Object.keys(cache);
    for (var i = 0; i < ys.length; i++) { var f = getYear(Number(ys[i])).filter(function (t) { return t.id === id; })[0]; if (f) return f; }
    return null;
  }

  // ── 입력 폼 ──
  function recentDescMap() {
    var map = {};
    Object.keys(cache).sort().forEach(function (y) {
      getYear(Number(y)).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }).forEach(function (t) {
        if (t.desc && t.big !== '미분류') map[t.desc] = t;
      });
    });
    return map;
  }
  function openForm(existing) {
    var isNew = !existing;
    var t = existing ? Object.assign({}, existing) : {
      id: uid(), date: today(), kind: '소비', big: '', sub: '', desc: '', amount: 0,
      currency: cfg.travel.on ? cfg.travel.currency : 'KRW', localAmount: null, rate: null,
      method: '', user: cfg.user || users()[0], trip: cfg.travel.on ? cfg.travel.trip : '', memo: '', fixed: false, source: '앱', status: ''
    };
    var mode = t.kind === '수입' ? '수입' : '지출';
    var manualKrw = false;
    var rateInfo = null;
    var descMap = recentDescMap();
    var quick = frequentItems(8);

    function catChips() {
      return groups(mode).map(function (g) {
        var label = g.kind === '비소비' ? '고정·비소비성' : g.big;
        return '<div class="grp"><div class="gl">' + esc(label) + '</div><div class="chips">' + g.subs.map(function (s) {
          var on = t.kind === g.kind && t.big === g.big && t.sub === s;
          return '<button type="button" class="chip' + (on ? ' on' : '') + '" data-k="' + esc(g.kind) + '" data-b="' + esc(g.big) + '" data-s="' + esc(s) + '">' + esc(s) + '</button>';
        }).join('') + '</div></div>';
      }).join('');
    }
    function chipRow(name, items, val) {
      return '<div class="chips">' + items.map(function (x) {
        return '<button type="button" class="chip' + (x === val ? ' on' : '') + '" data-' + name + '="' + esc(x) + '">' + esc(x) + '</button>';
      }).join('') + '</div>';
    }
    var amtVal = t.currency !== 'KRW' && t.localAmount != null ? t.localAmount : (t.amount || '');
    var m = $('#modal');
    m.innerHTML = '<div class="sheet"><div class="sheet-head"><h2>' + (isNew ? '새 내역' : '내역 수정') + '</h2><button class="x" id="fClose" aria-label="닫기">✕</button></div>' +
      '<div class="seg"><button type="button" data-mode="지출" class="' + (mode === '지출' ? 'on' : '') + '">지출</button><button type="button" data-mode="수입" class="' + (mode === '수입' ? 'on' : '') + '">수입</button></div>' +
      (isNew && quick.length ? '<div class="quick"><div class="gl">자주 쓰는 내역</div><div class="chips">' + quick.map(function (q, i) {
        return '<button type="button" class="chip" data-q="' + i + '">' + esc(q.desc) + '</button>';
      }).join('') + '</div></div>' : '') +
      '<div class="amount-row"><select id="fCur" aria-label="통화">' + currencyOptions(t.currency) + '</select>' +
      '<input id="fAmt" inputmode="decimal" placeholder="0" value="' + esc(amtVal === 0 ? '' : amtVal) + '" aria-label="금액" autocomplete="off"></div>' +
      '<div class="calc">' + ['+', '−', '×', '÷', '00', '000', '⌫'].map(function (k) { return '<button type="button" data-k="' + k + '">' + k + '</button>'; }).join('') + '</div>' +
      '<div class="conv num" id="fConv"></div>' +
      '<div class="field hidden" id="fKrwWrap"><label>원화 금액 (카드 청구액을 알면 직접 고치세요)</label><input type="number" id="fKrw" inputmode="numeric"></div>' +
      '<div class="field"><label>내용</label><input type="text" id="fDesc" list="descList" value="' + esc(t.desc) + '" placeholder="예: 스타벅스, 관리비"><datalist id="descList">' +
      Object.keys(descMap).slice(-300).map(function (d) { return '<option value="' + esc(d) + '">'; }).join('') + '</datalist></div>' +
      '<div class="field"><label>날짜</label><input type="date" id="fDate" value="' + esc(t.date) + '"></div>' +
      '<div class="field"><label>분류</label><div id="fCats">' + catChips() + '</div></div>' +
      '<div class="field" id="fMethodWrap"><label>결제수단</label><div id="fMethods">' + chipRow('m', methods(), t.method) + '</div></div>' +
      '<div class="field"><label>작성자</label><div id="fUsers">' + chipRow('u', users(), t.user) + '</div></div>' +
      '<div class="two"><div class="field"><label>여행 (선택)</label><input type="text" id="fTrip" value="' + esc(t.trip || '') + '" placeholder="예: 2027 미국"></div>' +
      '<div class="field"><label>메모</label><input type="text" id="fMemo" value="' + esc(t.memo || '') + '"></div></div>' +
      '<div class="actions">' + (isNew ? '' : '<button class="btn danger" id="fDel">삭제</button>') +
      '<button class="btn primary" id="fSave">' + (isNew ? '저장' : '수정 완료') + '</button></div></div>';
    m.classList.remove('hidden');

    var cur = $('#fCur'), amt = $('#fAmt'), conv = $('#fConv'), krw = $('#fKrw');
    function refreshMode() {
      $$('.seg button', m).forEach(function (b) { b.classList.toggle('on', b.dataset.mode === mode); });
      $('#fCats').innerHTML = catChips(); bindCats();
      $('#fMethodWrap').classList.toggle('hidden', mode === '수입');
    }
    function bindCats() {
      $$('#fCats .chip').forEach(function (b) {
        b.onclick = function () { t.kind = b.dataset.k; t.big = b.dataset.b; t.sub = b.dataset.s; $$('#fCats .chip').forEach(function (x) { x.classList.toggle('on', x === b); }); };
      });
    }
    function bindChipRow(sel, attr, key) {
      $$(sel + ' .chip').forEach(function (b) {
        b.onclick = function () { t[key] = t[key] === b.dataset[attr] ? '' : b.dataset[attr]; $$(sel + ' .chip').forEach(function (x) { x.classList.toggle('on', x.dataset[attr] === t[key]); }); };
      });
    }
    function num(v) { return calcExpr(v) || 0; }
    var convSeq = 0;
    function updateConv() {
      var c = cur.value, a = num(amt.value);
      $('#fKrwWrap').classList.toggle('hidden', c === 'KRW');
      if (c === 'KRW') { conv.textContent = a ? (/[+\-*/×÷−]/.test(String(amt.value).replace(/^-/, '')) ? '= ' : '') + won(a) : ''; rateInfo = null; return; }
      if (!a) { conv.textContent = ''; return; }
      var seq = ++convSeq;
      conv.textContent = '환율 확인 중…';
      getRate(c, $('#fDate').value || today()).then(function (r) {
        if (seq !== convSeq) return;
        rateInfo = r;
        if (!manualKrw) krw.value = Math.round(a * r.rate);
        conv.textContent = '≈ ' + won(manualKrw ? num(krw.value) : a * r.rate) + ' · 1 ' + c + ' = ' + r.rate.toLocaleString('ko-KR', { maximumFractionDigits: 4 }) + '원' + (r.stale ? ' (지난 환율 · 온라인 시 재계산)' : '');
      }).catch(function () { if (seq === convSeq) { rateInfo = null; conv.textContent = '오프라인: 환율은 저장 후 서버에서 자동 계산돼요'; } });
    }
    if (!isNew && t.currency !== 'KRW') { krw.value = t.amount; manualKrw = !!(t.rate && t.localAmount && Math.abs(Math.round(t.localAmount * t.rate) - t.amount) > 1); }
    amt.oninput = function () { manualKrw = false; updateConv(); };
    cur.onchange = function () { manualKrw = false; updateConv(); };
    $('#fDate').onchange = function () { manualKrw = false; updateConv(); };
    krw.oninput = function () { manualKrw = true; conv.textContent = '직접 입력: ' + won(num(krw.value)); };
    $('#fDesc').onchange = function () {
      var prev = descMap[this.value.trim()];
      if (prev && !t.sub) {
        t.kind = prev.kind; t.big = prev.big; t.sub = prev.sub; mode = prev.kind === '수입' ? '수입' : '지출';
        if (!t.method && prev.method) t.method = prev.method;
        refreshMode(); $('#fMethods').innerHTML = chipRow('m', methods(), t.method); bindChipRow('#fMethods', 'm', 'method');
      }
    };
    $$('.seg button', m).forEach(function (b) { b.onclick = function () { mode = b.dataset.mode; t.kind = ''; t.big = ''; t.sub = ''; refreshMode(); }; });
    $$('.calc button', m).forEach(function (b) {
      b.onclick = function () {
        var k = b.dataset.k, v = amt.value;
        if (k === '⌫') amt.value = v.slice(0, -1);
        else amt.value = v + ({ '−': '-', '×': '*', '÷': '/' }[k] || k);
        manualKrw = false; updateConv();
      };
    });
    $$('[data-q]', m).forEach(function (b) {
      b.onclick = function () {
        var q = quick[Number(b.dataset.q)];
        $('#fDesc').value = q.desc; t.kind = q.kind; t.big = q.big; t.sub = q.sub; t.method = q.method || t.method;
        mode = q.kind === '수입' ? '수입' : '지출';
        refreshMode(); $('#fMethods').innerHTML = chipRow('m', methods(), t.method); bindChipRow('#fMethods', 'm', 'method');
        $$('[data-q]', m).forEach(function (x) { x.classList.toggle('on', x === b); });
        amt.placeholder = q.amount ? Number(q.amount).toLocaleString('ko-KR') : '0';
        amt.focus();
      };
    });
    bindCats(); bindChipRow('#fMethods', 'm', 'method'); bindChipRow('#fUsers', 'u', 'user');
    $('#fMethodWrap').classList.toggle('hidden', mode === '수입');
    updateConv();
    $('#fClose').onclick = closeModal;
    m.onclick = function (e) { if (e.target === m) closeModal(); };
    if (isNew) setTimeout(function () { amt.focus(); }, 80);

    $('#fSave').onclick = function () {
      var a = num(amt.value);
      if (!a) { toast('금액을 입력해 주세요'); amt.focus(); return; }
      if (!t.sub) { toast('분류를 골라 주세요'); return; }
      t.desc = $('#fDesc').value.trim() || t.sub;
      t.date = $('#fDate').value || today();
      t.trip = $('#fTrip').value.trim();
      t.memo = $('#fMemo').value.trim();
      t.currency = cur.value;
      if (mode === '수입') t.method = '';
      if (t.currency === 'KRW') { t.amount = Math.round(a); t.localAmount = null; t.rate = null; }
      else {
        t.localAmount = a;
        if (manualKrw && num(krw.value)) { t.amount = Math.round(num(krw.value)); t.rate = t.amount / a; }
        else if (rateInfo && !rateInfo.stale) { t.rate = rateInfo.rate; t.amount = Math.round(a * rateInfo.rate); }
        else { t.rate = null; t.amount = rateInfo ? Math.round(a * rateInfo.rate) : 0; }
      }
      if (t.status === '확인필요' && t.big !== '미분류') t.status = '';
      if (!t.createdAt) t.createdAt = new Date().toISOString();
      if (t.date.slice(0, 7) !== state.ym && state.tab === 'list' && isNew) state.ym = t.date.slice(0, 7);
      closeModal();
      saveTx(t);
      toast(isNew ? '저장했어요' : '수정했어요');
    };
    if (!isNew) $('#fDel').onclick = function () {
      if (!confirm('이 내역을 삭제할까요?\n' + (t.desc || '') + ' ' + won(t.amount))) return;
      closeModal(); deleteTx(t.id); toast('삭제했어요');
    };
  }
  function closeModal() { var m = $('#modal'); m.classList.add('hidden'); m.innerHTML = ''; }

  // ── 고정지출 넣기 ──
  function openFixed() {
    var tpl = (boot && boot.fixed) || [];
    if (!tpl.length) { toast('구글 시트의 "고정지출" 탭에 항목을 먼저 넣어 주세요'); return; }
    var month = monthTxs();
    var done = {}; month.forEach(function (t) { if (t.fixed) done[t.desc] = t; });
    var m = $('#modal');
    m.innerHTML = '<div class="sheet"><div class="sheet-head"><h2>' + (+state.ym.slice(5)) + '월 고정지출 넣기</h2><button class="x" id="xClose">✕</button></div>' +
      '<p class="faint">금액이 매달 달라지는 항목(관리비 등)은 이번 달 금액을 적어 주세요. 체크한 항목만 들어가요. 항목 자체는 구글 시트 "고정지출" 탭에서 바꿀 수 있어요.</p>' +
      tpl.map(function (f, i) {
        var d = done[f.desc];
        return '<div class="fixed-item"><input type="checkbox" data-i="' + i + '"' + (!d && f.amount ? ' checked' : '') + (d ? ' disabled' : '') + '>' +
          '<div><div>' + esc(f.desc) + '</div><div class="faint">' + esc([f.sub, f.method].filter(Boolean).join(' · ')) + (d ? ' <span class="done">✓ 이미 입력됨</span>' : '') + '</div></div>' +
          '<input type="number" inputmode="numeric" data-a="' + i + '" value="' + (d ? d.amount : (f.amount || '')) + '" placeholder="금액"' + (d ? ' disabled' : '') + '></div>';
      }).join('') +
      '<div class="actions"><button class="btn primary" id="fxAdd">선택한 항목 넣기</button></div></div>';
    m.classList.remove('hidden');
    $$('input[data-a]', m).forEach(function (inp) { inp.oninput = function () { var cb = $('input[data-i="' + inp.dataset.a + '"]', m); if (cb && !cb.disabled) cb.checked = !!Number(inp.value); }; });
    $('#xClose').onclick = closeModal;
    m.onclick = function (e) { if (e.target === m) closeModal(); };
    $('#fxAdd').onclick = function () {
      var date = state.ym === today().slice(0, 7) ? today() : state.ym + '-01';
      var n = 0;
      $$('input[data-i]', m).forEach(function (cb) {
        if (!cb.checked || cb.disabled) return;
        var f = tpl[Number(cb.dataset.i)];
        var a = Number($('input[data-a="' + cb.dataset.i + '"]', m).value) || 0;
        if (!a) return;
        enqueue({ type: 'save', tx: { id: uid(), date: date, kind: f.kind || '비소비', big: f.big || '비소비', sub: f.sub, desc: f.desc, amount: a, currency: 'KRW',
          localAmount: null, rate: null, method: f.method || '', user: cfg.user, trip: '', memo: '', fixed: true, source: '앱', status: '', createdAt: new Date().toISOString() } });
        n++;
      });
      closeModal(); render(); sync(true);
      toast(n ? n + '개 고정지출을 넣었어요' : '넣을 항목이 없어요');
    };
  }

  // ── 분석 ──
  function sumBy(txs, keyFn) {
    var out = {};
    txs.forEach(function (t) { var k = keyFn(t); if (k == null) return; var mth = Number(t.date.slice(5, 7)); out[k] = out[k] || new Array(13).fill(0); out[k][mth] += t.amount; out[k][0] += t.amount; });
    return out;
  }
  function renderStats() {
    var y = state.year;
    var txs = getYear(y);
    var inc = 0, con = 0, non = 0;
    var monthly = { 수입: new Array(13).fill(0), 소비: new Array(13).fill(0), 전체: new Array(13).fill(0) };
    txs.forEach(function (t) {
      var mth = Number(t.date.slice(5, 7));
      if (t.kind === '수입') { inc += t.amount; monthly['수입'][mth] += t.amount; }
      else { if (t.kind === '비소비') non += t.amount; else { con += t.amount; monthly['소비'][mth] += t.amount; } monthly['전체'][mth] += t.amount; }
    });
    var surplus = inc - con - non;
    var curMonth = (y === new Date().getFullYear()) ? new Date().getMonth() + 1 : 12;
    var months = Math.max(1, Math.min(12, curMonth));
    var html = '<div class="period"><button id="prevY" aria-label="이전 해">‹</button><div class="label">' + y + '년</div><button id="nextY" aria-label="다음 해">›</button></div>';
    html += '<div class="kpis">' +
      kpi('연간 수입', won(inc), '월평균 ' + wonShort(inc / months)) +
      kpi('소비성 지출', won(con), '월평균 ' + wonShort(con / months)) +
      kpi('비소비성(고정) 지출', won(non), '월평균 ' + wonShort(non / months)) +
      kpi('잉여금', won(surplus), inc ? '소득대비 ' + (surplus / inc * 100).toFixed(1) + '%' : '') + '</div>';

    var repYm = y === new Date().getFullYear() ? today().slice(0, 7) : y + '-12';
    html += reportCard(repYm) || (repYm.slice(0, 4) === String(y) ? reportCard(prevYm(repYm)) : '');
    var measures = [['소비', '소비성 지출'], ['전체', '전체 지출'], ['수입', '수입']];
    html += '<div class="card"><h3>월별 ' + esc(measures.filter(function (x) { return x[0] === state.statsMeasure; })[0][1]) + ' <span class="faint">· 막대를 누르면 그 달 내역</span></h3><div class="chips" style="margin-bottom:6px">' +
      measures.map(function (x) { return '<button class="chip' + (state.statsMeasure === x[0] ? ' on' : '') + '" data-ms="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>' +
      monthChart(monthly[state.statsMeasure], state.statsMeasure === '수입' ? 's1' : 's2') + '</div>';

    // 대분류별 소비
    var bigSum = sumBy(txs.filter(function (t) { return t.kind === '소비'; }), function (t) { return t.big || '미분류'; });
    var bigs = Object.keys(bigSum).sort(function (a, b) { return bigSum[b][0] - bigSum[a][0]; });
    var maxBig = bigs.length ? bigSum[bigs[0]][0] : 1;
    var segs = bigs.filter(function (b) { return BIG_SLOT[b]; }).slice(0, 5);
    var segRest = con - segs.reduce(function (a, b) { return a + bigSum[b][0]; }, 0);
    html += '<div class="card"><h3>소비성 지출, 어디에 썼나</h3>' + (bigs.length ? '<div class="segbar" role="img" aria-label="대분류별 비율">' +
      segs.map(function (b) { return '<i style="flex:' + bigSum[b][0] + ';background:' + bigColor(b) + '" title="' + esc(b) + ' ' + won(bigSum[b][0]) + '"></i>'; }).join('') +
      (segRest > 0 ? '<i style="flex:' + segRest + ';background:var(--c0)" title="그 외 ' + won(segRest) + '"></i>' : '') + '</div>' + bigs.map(function (b) {
      var v = bigSum[b][0];
      return '<div class="hbar' + (state.statsBig === b ? ' on' : '') + '" data-big="' + esc(b) + '"><span class="sw" style="background:' + (segs.indexOf(b) >= 0 ? bigColor(b) : 'var(--c0)') + '"></span><div class="lab">' + esc(b) + '</div><div class="track"><div class="fill" style="width:' + Math.max(0.5, v / maxBig * 100) + '%"></div></div>' +
        '<div class="val num">' + wonShort(v) + '<small>' + (con ? (v / con * 100).toFixed(1) : 0) + '%</small></div></div>';
    }).join('') + '<div class="faint" style="margin-top:6px">막대를 누르면 아래 표에서 그 분류만 볼 수 있어요</div>' : '<div class="empty">내역이 없어요</div>') + '</div>';

    // 월별 표 (연결산)
    var sections = [['소비', '소비성'], ['비소비', '비소비성'], ['수입', '수입'], ['결제', '결제수단'], ['작성자', '작성자']];
    html += '<div class="card"><div class="row" style="margin-bottom:8px"><h3 style="margin:0">월별 표</h3><span class="spacer"></span></div><div class="chips" style="margin-bottom:10px">' +
      sections.map(function (s) { return '<button class="chip' + (state.statsSection === s[0] ? ' on' : '') + '" data-sec="' + s[0] + '">' + s[1] + '</button>'; }).join('') +
      (state.statsBig ? '<button class="chip on" id="clearBig">' + esc(state.statsBig) + ' ✕</button>' : '') + '</div>' +
      statsTable(txs, months) + '</div>';
    html += '<div class="faint" style="text-align:center;margin:8px 0">구글 시트의 "연간분석" 탭에서도 같은 표를 볼 수 있어요</div>';
    return html;
  }
  function kpi(k, v, s) { return '<div class="kpi"><div class="k">' + k + '</div><div class="v num">' + v + '</div><div class="s">' + (s || '&nbsp;') + '</div></div>'; }
  function monthChart(arr, cls) {
    var W = 400, H = 200, L = 40, R = 4, T = 10, B = 24;
    var vals = arr.slice(1);
    var max = Math.max.apply(null, vals.concat([1]));
    var nice = niceMax(max);
    var bw = (W - L - R) / 12;
    var s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="월별 금액 막대 그래프">';
    for (var g = 0; g <= 4; g++) {
      var gy = T + (H - T - B) * (1 - g / 4);
      s += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + gy + '" y2="' + gy + '"/>';
      s += '<text x="' + (L - 6) + '" y="' + (gy + 4) + '" text-anchor="end">' + wonShort(nice * g / 4) + '</text>';
    }
    vals.forEach(function (v, i) {
      var h = (H - T - B) * (v / nice);
      var x = L + i * bw + bw * 0.22, w = bw * 0.56, y = H - B - h;
      var r = Math.min(4, w / 2, h);
      if (h > 0) s += '<path class="bar ' + cls + '" d="M' + x + ',' + (H - B) + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + (H - B) + 'Z"/>';
      s += '<text x="' + (L + i * bw + bw / 2) + '" y="' + (H - 7) + '" text-anchor="middle">' + (i + 1) + '</text>';
      s += '<rect class="hit" data-m="' + (i + 1) + '" data-v="' + v + '" x="' + (L + i * bw) + '" y="' + T + '" width="' + bw + '" height="' + (H - T - B) + '"/>';
    });
    return s + '</svg>';
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * p;
  }
  function statsTable(txs, months) {
    var sec = state.statsSection, rows = [], groupsOrder = [];
    var filt, keyFn, groupFn;
    if (sec === '소비') { filt = function (t) { return t.kind === '소비' && (!state.statsBig || t.big === state.statsBig); }; groupFn = function (t) { return t.big || '미분류'; }; keyFn = function (t) { return (t.big || '미분류') + '|' + (t.sub || '-'); }; }
    else if (sec === '비소비') { filt = function (t) { return t.kind === '비소비'; }; keyFn = function (t) { return t.sub || '-'; }; }
    else if (sec === '수입') { filt = function (t) { return t.kind === '수입'; }; groupFn = function (t) { return t.big; }; keyFn = function (t) { return t.big + '|' + (t.sub || '-'); }; }
    else if (sec === '결제') { filt = isSpend; keyFn = function (t) { return t.method || '(미지정)'; }; }
    else { filt = function () { return true; }; keyFn = function (t) { return (t.user || '(미지정)') + '|' + (t.kind === '수입' ? '수입' : '지출'); }; groupFn = function (t) { return t.user || '(미지정)'; }; }
    var data = txs.filter(filt);
    var sums = sumBy(data, keyFn);
    var total = new Array(13).fill(0); data.forEach(function (t) { total[Number(t.date.slice(5, 7))] += t.amount; total[0] += t.amount; });
    // 정렬: 분류 시트 순서 유지
    var order = [];
    cats().forEach(function (c) { order.push(c.big + '|' + c.sub); order.push(c.sub); });
    var keys = Object.keys(sums).sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      if (ia < 0 && ib < 0) return sums[b][0] - sums[a][0];
      if (ia < 0) return 1; if (ib < 0) return -1; return ia - ib;
    });
    function cells(arr, cls) {
      var h = '';
      for (var i = 1; i <= 12; i++) h += '<td class="num' + (arr[i] ? '' : ' zero') + '">' + (arr[i] ? Math.round(arr[i]).toLocaleString('ko-KR') : '-') + '</td>';
      h += '<td class="num"><b>' + Math.round(arr[0]).toLocaleString('ko-KR') + '</b></td><td class="num">' + Math.round(arr[0] / months).toLocaleString('ko-KR') + '</td>' +
        '<td class="num">' + (total[0] ? (arr[0] / total[0] * 100).toFixed(1) : '0.0') + '%</td>';
      return h;
    }
    var head = '<tr><th>항목</th>' + [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(function (i) { return '<th>' + i + '월</th>'; }).join('') + '<th>연간합계</th><th>월평균</th><th>비중</th></tr>';
    var body = '';
    if (groupFn) {
      var gsum = sumBy(data, groupFn);
      var seen = {};
      keys.forEach(function (k) {
        var g = k.split('|')[0];
        if (!seen[g]) { seen[g] = 1; body += '<tr class="big"><td>' + esc(g) + '</td>' + cells(gsum[g]) + '</tr>'; }
        body += '<tr><td>&nbsp;&nbsp;' + esc(k.split('|')[1]) + '</td>' + cells(sums[k]) + '</tr>';
      });
    } else {
      keys.forEach(function (k) { body += '<tr><td>' + esc(k) + '</td>' + cells(sums[k]) + '</tr>'; });
    }
    if (!keys.length) return '<div class="empty">내역이 없어요</div>';
    body += '<tr class="total"><td>합계</td>' + cells(total) + '</tr>';
    return '<div class="tablewrap"><table class="grid">' + head + body + '</table></div>';
  }
  function bindStats() {
    $('#prevY').onclick = function () { state.year--; render(); sync(true); };
    $('#nextY').onclick = function () { state.year++; render(); sync(true); };
    $$('[data-ms]').forEach(function (b) { b.onclick = function () { state.statsMeasure = b.dataset.ms; render(); }; });
    $$('[data-sec]').forEach(function (b) { b.onclick = function () { state.statsSection = b.dataset.sec; render(); }; });
    $$('.hbar').forEach(function (b) { b.onclick = function () { state.statsBig = state.statsBig === b.dataset.big ? '' : b.dataset.big; state.statsSection = '소비'; render(); }; });
    var cb = $('#clearBig'); if (cb) cb.onclick = function () { state.statsBig = ''; render(); };
    var tip = $('#tooltip');
    $$('.chart .hit').forEach(function (r) {
      function show(e) {
        var p = e.touches ? e.touches[0] : e;
        tip.innerHTML = '<b>' + state.year + '년 ' + r.dataset.m + '월</b>' + won(r.dataset.v);
        tip.classList.remove('hidden');
        var x = Math.min(window.innerWidth - 150, p.clientX + 12), y = Math.max(8, p.clientY - 50);
        tip.style.left = x + 'px'; tip.style.top = y + 'px';
        var bar = r.previousElementSibling && r.previousElementSibling.previousElementSibling;
        $$('.chart .bar').forEach(function (b) { b.classList.remove('hl'); });
        if (bar && bar.classList.contains('bar')) bar.classList.add('hl');
      }
      r.addEventListener('mousemove', show); r.addEventListener('touchstart', show, { passive: true });
      r.addEventListener('mouseleave', function () { tip.classList.add('hidden'); });
      r.addEventListener('click', function () { state.tab = 'list'; state.ym = state.year + '-' + pad(Number(r.dataset.m)); tip.classList.add('hidden'); render(); });
    });
  }

  // ── 여행 ──
  function renderTrips() {
    var html = '<div class="card"><div class="set-row"><div><b>여행 모드</b><div class="faint">켜면 새 내역이 아래 통화·여행 이름으로 기본 입력돼요</div></div>' +
      '<label class="switch"><input type="checkbox" id="tOn"' + (cfg.travel.on ? ' checked' : '') + '><span></span></label></div>' +
      '<div class="two"><div class="field"><label>현지 통화</label><select id="tCur">' + currencyOptions(cfg.travel.currency) + '</select></div>' +
      '<div class="field"><label>여행 이름</label><input type="text" id="tTrip" value="' + esc(cfg.travel.trip) + '" placeholder="예: 2027 미국"></div></div>' +
      '<div class="conv" id="tRate"></div></div>';
    // 여행별 합계 (캐시된 모든 연도)
    var trips = {};
    Object.keys(cache).forEach(function (y) {
      getYear(Number(y)).forEach(function (t) {
        if (!t.trip || t.kind === '수입') return;
        var tr = trips[t.trip] = trips[t.trip] || { total: 0, from: t.date, to: t.date, cats: {}, curs: {} };
        tr.total += t.amount; if (t.date < tr.from) tr.from = t.date; if (t.date > tr.to) tr.to = t.date;
        tr.cats[t.sub || t.big] = (tr.cats[t.sub || t.big] || 0) + t.amount;
        if (t.currency && t.currency !== 'KRW') tr.curs[t.currency] = (tr.curs[t.currency] || 0) + Number(t.localAmount || 0);
      });
    });
    var names = Object.keys(trips).sort(function (a, b) { return trips[b].from.localeCompare(trips[a].from); });
    html += '<h3 style="margin:18px 4px 6px">여행별 지출</h3>';
    if (!names.length) html += '<div class="card faint">아직 여행 이름이 붙은 내역이 없어요. 여행 모드를 켜고 입력하면 여기서 여행별로 모아 볼 수 있어요.</div>';
    names.forEach(function (n) {
      var tr = trips[n];
      var days = Math.round((new Date(tr.to) - new Date(tr.from)) / 864e5) + 1;
      var top = Object.keys(tr.cats).sort(function (a, b) { return tr.cats[b] - tr.cats[a]; }).slice(0, 5);
      html += '<div class="card"><div class="row"><b>✈ ' + esc(n) + '</b><span class="spacer"></span><b class="num">' + won(tr.total) + '</b></div>' +
        '<div class="faint">' + tr.from + ' ~ ' + tr.to + ' · ' + days + '일 · 하루 평균 ' + wonShort(tr.total / days) + '</div>' +
        (Object.keys(tr.curs).length ? '<div class="faint">현지 통화: ' + Object.keys(tr.curs).map(function (c) { return esc(fmtLocal(tr.curs[c], c)); }).join(', ') + '</div>' : '') +
        '<div style="margin-top:8px">' + top.map(function (c) {
          return '<div class="hbar" style="cursor:default"><div class="lab">' + esc(c) + '</div><div class="track"><div class="fill" style="width:' + (tr.cats[c] / tr.cats[top[0]] * 100) + '%"></div></div><div class="val num">' + wonShort(tr.cats[c]) + '</div></div>';
        }).join('') + '</div></div>';
    });
    return html;
  }
  function bindTrips() {
    function upd() {
      cfg.travel = { on: $('#tOn').checked, currency: $('#tCur').value, trip: $('#tTrip').value.trim() };
      saveCfg(); showRate();
    }
    function showRate() {
      var c = $('#tCur').value; var el = $('#tRate');
      if (c === 'KRW') { el.textContent = ''; return; }
      getRate(c, today()).then(function (r) { el.textContent = '오늘 환율: 1 ' + c + ' = ' + r.rate.toLocaleString('ko-KR', { maximumFractionDigits: 4 }) + '원 · 10,000원 = ' + fmtLocal(10000 / r.rate, c); })
        .catch(function () { el.textContent = '환율을 불러오지 못했어요 (오프라인)'; });
    }
    $('#tOn').onchange = function () { upd(); toast(cfg.travel.on ? '여행 모드를 켰어요' : '여행 모드를 껐어요'); };
    $('#tCur').onchange = upd; $('#tTrip').onchange = upd;
    showRate();
  }

  // ── 설정 ──
  function renderSettings() {
    var demo = cfg.apiUrl === 'demo';
    var html = '<div class="card"><h3>서버 연결</h3>' +
      '<div class="field"><label>가계부 서버 주소 (Apps Script 웹 앱 URL)</label><input type="url" id="sUrl" value="' + esc(demo ? '' : cfg.apiUrl) + '" placeholder="https://script.google.com/macros/s/…/exec"></div>' +
      '<div class="field"><label>접속 코드</label><input type="password" id="sTok" value="' + esc(cfg.token) + '" autocomplete="off"></div>' +
      '<div class="actions"><button class="btn primary" id="sSave">저장하고 연결 확인</button></div>' +
      (demo ? '<p class="faint">지금은 데모 데이터로 보고 있어요. 서버 주소를 저장하면 실제 가계부로 바뀌어요.</p>' : '') + '</div>';
    if (configured()) {
      html += '<div class="card"><h3>나는 누구?</h3><p class="faint" style="margin-top:0">이 기기에서 입력하는 내역의 작성자</p><div class="chips">' +
        users().map(function (u) { return '<button class="chip' + (cfg.user === u ? ' on' : '') + '" data-user="' + esc(u) + '">' + esc(u) + '</button>'; }).join('') + '</div></div>';
      html += '<div class="card"><h3>동기화</h3>' +
        '<div class="set-row"><span>전송 대기 중</span><b>' + queue.length + '건</b></div>' +
        '<div class="set-row"><span>마지막 동기화</span><span class="muted">' + (LS.get('lastSync', 0) ? new Date(LS.get('lastSync')).toLocaleString('ko-KR') : '-') + '</span></div>' +
        (state.lastError ? '<div class="set-row"><span>오류</span><span class="muted">' + esc(state.lastError) + '</span></div>' : '') +
        '<div class="actions"><button class="btn" id="sSync">지금 동기화</button><button class="btn" id="sReload">분류·설정 새로고침</button></div>' +
        (boot && boot.sheetUrl ? '<div class="actions"><a class="btn" style="text-align:center;text-decoration:none" href="' + esc(boot.sheetUrl) + '" target="_blank" rel="noopener">구글 시트 열기</a></div>' : '') + '</div>';
      if (!demo) {
        html += '<div class="card"><h3>결제 자동 입력 (아이폰 단축어)</h3>' +
          '<p class="faint" style="margin-top:0">카드 결제 문자나 애플페이 결제를 자동으로 가계부에 넣어요. 단축어 자동화에 아래 두 값을 넣으면 돼요. 자세한 순서는 설치 안내서의 "단축어 설정" 부분을 보세요.</p>' +
          '<div class="field"><label>URL</label><div class="code" id="cUrl">' + esc(cfg.apiUrl) + '</div></div>' +
          '<div class="field"><label>보낼 내용(JSON) — 문자용</label><div class="code">{"token":"' + esc(cfg.token) + '","action":"sms","user":"' + esc(cfg.user) + '","text":<b>[단축어 입력]</b>}</div></div>' +
          '<div class="actions"><button class="btn" id="copyUrl">URL 복사</button><button class="btn" id="copyTok">접속 코드 복사</button></div></div>';
      }
      html += '<div class="card"><h3>앱 잠금</h3><div class="set-row"><span>비밀번호 잠금 <span class="faint">(이 기기만, 5분 이상 나갔다 오면 다시 잠김)</span></span>' +
        (LS.get('pin', '') ? '<button class="btn small" id="pinOff">끄기</button>' : '<button class="btn small" id="pinOn">켜기</button>') + '</div></div>';
      html += '<div class="card"><h3>기타</h3><div class="actions"><button class="btn danger" id="sClear">이 기기의 저장 데이터 지우기</button></div>' +
        '<p class="faint">구글 시트의 데이터는 지워지지 않아요. 이 기기의 임시 저장분과 연결 정보만 지워요.' + (queue.length ? ' <b>전송 대기 ' + queue.length + '건도 함께 지워져요.</b>' : '') + '</p></div>';
    }
    html += '<div class="faint" style="text-align:center">우리집 가계부 · v1.0</div>';
    return html;
  }
  function bindSettings() {
    $('#sSave').onclick = function () {
      var url = $('#sUrl').value.trim(), tok = $('#sTok').value.trim();
      if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) { toast('주소는 https://script.google.com/…/exec 형태여야 해요'); return; }
      var prev = { apiUrl: cfg.apiUrl, token: cfg.token };
      cfg.apiUrl = url; cfg.token = tok;
      if (prev.apiUrl === 'demo') { queue = []; LS.set('queue', []); cache = {}; Object.keys(localStorage).forEach(function (k) { if (k.indexOf('gb.tx.') === 0) localStorage.removeItem(k); }); }
      toast('연결 확인 중…');
      api('bootstrap').then(function (b) {
        saveCfg(); setBoot(b); toast('연결됐어요!'); state.tab = 'list'; return sync();
      }).catch(function (e) { cfg.apiUrl = prev.apiUrl; cfg.token = prev.token; toast('연결 실패: ' + e.message, 4000); });
    };
    $$('[data-user]').forEach(function (b) { b.onclick = function () { cfg.user = b.dataset.user; saveCfg(); render(); }; });
    var el;
    if ((el = $('#sSync'))) el.onclick = function () { sync(); };
    if ((el = $('#sReload'))) el.onclick = function () { refreshBoot().then(function () { toast('새로고침했어요'); }).catch(function (e) { toast(e.message); }); };
    if ((el = $('#pinOn'))) el.onclick = setPin;
    if ((el = $('#pinOff'))) el.onclick = function () { if (confirm('앱 잠금을 끌까요?')) { LS.del('pin'); LS.del('pinLen'); render(); toast('앱 잠금을 껐어요'); } };
    if ((el = $('#copyUrl'))) el.onclick = function () { copy(cfg.apiUrl); };
    if ((el = $('#copyTok'))) el.onclick = function () { copy(cfg.token); };
    if ((el = $('#sClear'))) el.onclick = function () {
      if (!confirm('이 기기의 저장 데이터와 연결 정보를 지울까요?' + (queue.length ? '\n전송 대기 ' + queue.length + '건도 사라져요.' : ''))) return;
      Object.keys(localStorage).forEach(function (k) { if (k.indexOf('gb.') === 0) localStorage.removeItem(k); });
      location.reload();
    };
  }
  function copy(s) {
    (navigator.clipboard ? navigator.clipboard.writeText(s) : Promise.reject()).then(function () { toast('복사했어요'); }, function () { prompt('복사하세요', s); });
  }

  // ───────────── 편의 기능 (달력·예산·리포트·문자 붙여넣기·계산기·잠금) ─────────────

  /** "12,000+3500" "3*4500" 같은 간단한 계산식 → 숫자 */
  function calcExpr(v) {
    var x = String(v == null ? '' : v).replace(/,/g, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').trim();
    if (!x) return 0;
    if (!/^[\d.+\-*/()\s]+$/.test(x)) return 0;
    x = x.replace(/[+\-*/.\s]+$/, '');
    if (!x) return 0;
    try {
      var r = Function('"use strict";return (' + x + ')')();
      return isFinite(r) ? Math.round(r * 100) / 100 : 0;
    } catch (e) { return 0; }
  }
  function wonTiny(n) {
    n = Math.round(n); var a = Math.abs(n);
    if (a >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '억';
    if (a >= 10000) return (n / 10000).toFixed(a >= 100000 ? 0 : 1).replace(/\.0$/, '') + '만';
    return n.toLocaleString('ko-KR');
  }
  function budgets() { return (boot && boot.budgets) || {}; }
  function allCachedTxs() {
    var out = [];
    Object.keys(cache).forEach(function (y) { out = out.concat(getYear(Number(y))); });
    return out;
  }
  /** 최근 120일 동안 2번 이상 쓴 내역 (빠른 입력용) */
  function frequentItems(n) {
    var since = ymd(new Date(Date.now() - 120 * 864e5));
    var agg = {};
    allCachedTxs().forEach(function (t) {
      if (t.date < since || t.kind === '수입' || !t.desc || !t.sub || t.big === '미분류') return;
      var k = t.desc + '|' + t.sub;
      var a = agg[k] = agg[k] || { desc: t.desc, kind: t.kind, big: t.big, sub: t.sub, method: t.method, amount: t.amount, n: 0, last: '' };
      a.n++; if (t.date >= a.last) { a.last = t.date; a.amount = t.amount; a.method = t.method || a.method; }
    });
    return Object.keys(agg).map(function (k) { return agg[k]; }).filter(function (a) { return a.n >= 2; })
      .sort(function (a, b) { return b.n - a.n || (b.last > a.last ? 1 : -1); }).slice(0, n);
  }
  /** 가맹점 이름 → 분류 추측 (예전 기록 → 자동분류 키워드) */
  function guessCategory(desc, descMap) {
    var d = String(desc || '').trim();
    if (!d) return null;
    var prev = (descMap || recentDescMap())[d];
    if (prev && prev.sub) return { kind: prev.kind, big: prev.big, sub: prev.sub };
    var u = d.toUpperCase();
    var rules = (boot && boot.rules) || [];
    for (var i = 0; i < rules.length; i++) {
      for (var j = 0; j < rules[i].keywords.length; j++) {
        var k = String(rules[i].keywords[j]).toUpperCase();
        if (k && u.indexOf(k) >= 0) return { kind: rules[i].kind, big: rules[i].big, sub: rules[i].sub };
      }
    }
    return null;
  }
  function monthAgg(ym, uptoDay) {
    var y = Number(ym.slice(0, 4));
    var r = { con: 0, non: 0, inc: 0, n: 0, bySub: {}, byBig: {}, byDesc: {}, max: null };
    getYear(y).forEach(function (t) {
      if (t.date.slice(0, 7) !== ym) return;
      if (uptoDay && Number(t.date.slice(8)) > uptoDay) return;
      if (t.kind === '수입') { r.inc += t.amount; return; }
      if (t.kind === '비소비') { r.non += t.amount; return; }
      r.con += t.amount; r.n++;
      r.bySub[t.sub || t.big] = (r.bySub[t.sub || t.big] || 0) + t.amount;
      r.byBig[t.big || '미분류'] = (r.byBig[t.big || '미분류'] || 0) + t.amount;
      r.byDesc[t.desc] = (r.byDesc[t.desc] || 0) + 1;
      if (!r.max || t.amount > r.max.amount) r.max = t;
    });
    return r;
  }
  function prevYm(ym) { var p = ym.split('-'); return ymOf(new Date(+p[0], +p[1] - 2, 1)); }
  function daysIn(ym) { var p = ym.split('-'); return new Date(+p[0], +p[1], 0).getDate(); }

  function monthInsight(con) {
    var isCur = state.ym === today().slice(0, 7);
    var upto = isCur ? Number(today().slice(8)) : 0;
    var prev = monthAgg(prevYm(state.ym), upto).con;
    if (!prev || !con) return '';
    var diff = con - prev, pct = Math.abs(diff / prev * 100).toFixed(0);
    return '<div class="insight">' + (isCur ? '지난달 같은 기간보다 ' : '지난달보다 ') + '소비성 지출을 <b>' + wonShort(Math.abs(diff)) + '원 ' +
      (diff >= 0 ? '더' : '덜') + '</b> 썼어요 <span class="' + (diff >= 0 ? 'up' : 'down') + '">' + (diff >= 0 ? '▲' : '▼') + pct + '%</span></div>';
  }

  function barHtml(used, limit) {
    var pct = limit ? used / limit * 100 : 0;
    var cls = pct > 100 ? 'over' : pct >= 80 ? 'warn' : 'ok';
    return '<div class="bar ' + cls + '"><i style="width:' + Math.min(100, pct).toFixed(1) + '%"></i></div>';
  }
  function budgetCard(all, ym) {
    var b = budgets();
    var keys = Object.keys(b);
    if (!keys.length) return '<div class="budget empty-b"><span>💰 한 달 예산을 정하면 남은 돈과 하루 사용 가능액을 알려 드려요</span><button class="btn small" id="budgetSet">예산 정하기</button></div>';
    var con = 0, byBig = {};
    all.forEach(function (t) { if (t.kind === '소비') { con += t.amount; byBig[t.big] = (byBig[t.big] || 0) + t.amount; } });
    var html = '<div class="budget">';
    var isCur = ym === today().slice(0, 7);
    if (b['전체']) {
      var left = b['전체'] - con, pct = con / b['전체'] * 100;
      var daysLeft = isCur ? daysIn(ym) - Number(today().slice(8)) + 1 : 0;
      html += '<div class="row"><b>이번 달 예산</b><span class="spacer"></span><span class="num">' + wonShort(con) + ' / ' + wonShort(b['전체']) + '</span><button class="link" id="budgetSet">수정</button></div>' +
        barHtml(con, b['전체']) +
        '<div class="faint">' + (left >= 0 ? '남은 예산 <b class="num">' + won(left) + '</b>' + (daysLeft > 0 ? ' · 하루 <b class="num">' + won(left / daysLeft) + '</b> 쓸 수 있어요' : '') :
          '⚠️ 예산을 <b class="num">' + won(-left) + '</b> 넘었어요') + ' (' + pct.toFixed(0) + '%)</div>';
    } else {
      html += '<div class="row"><b>분류별 예산</b><span class="spacer"></span><button class="link" id="budgetSet">수정</button></div>';
    }
    var bigKeys = keys.filter(function (k) { return k !== '전체'; })
      .sort(function (a, c) { return (byBig[c] || 0) / b[c] - (byBig[a] || 0) / b[a]; });
    bigKeys.forEach(function (k) {
      var u = byBig[k] || 0;
      html += '<div class="bb"><span class="lab">' + esc(k) + '</span>' + barHtml(u, b[k]) + '<span class="val num">' + wonTiny(u) + '/' + wonTiny(b[k]) + (u > b[k] ? ' ⚠️' : '') + '</span></div>';
    });
    return html + '</div>';
  }

  function calendarHtml(all) {
    var p = state.ym.split('-'), y = +p[0], mth = +p[1];
    var first = new Date(y, mth - 1, 1).getDay(), n = daysIn(state.ym);
    var spend = {}, inc = {};
    all.forEach(function (t) {
      var d = Number(t.date.slice(8));
      if (t.kind === '수입') inc[d] = (inc[d] || 0) + t.amount; else spend[d] = (spend[d] || 0) + t.amount;
    });
    var td = today();
    var h = '<div class="cal">' + DOW.map(function (d, i) { return '<div class="cal-h' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '') + '">' + d + '</div>'; }).join('');
    for (var i = 0; i < first; i++) h += '<div class="cal-cell blank"></div>';
    for (var d = 1; d <= n; d++) {
      var ds = state.ym + '-' + pad(d), dow = (first + d - 1) % 7;
      h += '<button type="button" class="cal-cell' + (ds === td ? ' today' : '') + (ds === state.calDay ? ' sel' : '') + '" data-day="' + ds + '">' +
        '<span class="dn' + (dow === 0 ? ' sun' : dow === 6 ? ' sat' : '') + '">' + d + '</span>' +
        (spend[d] ? '<span class="sp num">' + wonTiny(spend[d]) + '</span>' : '') +
        (inc[d] ? '<span class="in num">+' + wonTiny(inc[d]) + '</span>' : '') + '</button>';
    }
    return h + '</div>';
  }

  function openBudgetEditor() {
    var b = budgets();
    var bigs = [];
    cats().forEach(function (c) { if (c.kind === '소비' && bigs.indexOf(c.big) < 0) bigs.push(c.big); });
    // 최근 3달 평균 (참고용)
    var avg = {}, tot = 0, ym = state.ym;
    for (var i = 1; i <= 3; i++) {
      ym = prevYm(ym); var a = monthAgg(ym);
      tot += a.con; Object.keys(a.byBig).forEach(function (k) { avg[k] = (avg[k] || 0) + a.byBig[k]; });
    }
    function row(key, label) {
      var hint = key === '전체' ? tot / 3 : (avg[key] || 0) / 3;
      return '<div class="brow"><label>' + esc(label) + '<span class="faint">최근 3달 평균 ' + wonShort(hint) + '</span></label>' +
        '<input type="number" inputmode="numeric" data-bk="' + esc(key) + '" value="' + (b[key] || '') + '" placeholder="예산 없음"></div>';
    }
    var m = $('#modal');
    m.innerHTML = '<div class="sheet"><div class="sheet-head"><h2>한 달 예산</h2><button class="x" id="bClose">✕</button></div>' +
      '<p class="faint" style="margin-top:0">소비성 지출 기준이에요. 부부가 같은 예산을 보고, 구글 시트 "예산" 탭에 저장돼요. 비워 두면 그 항목은 예산이 없어요.</p>' +
      row('전체', '전체 (한 달 소비)') + '<div class="gl" style="margin:12px 0 4px">분류별 (선택)</div>' + bigs.map(function (k) { return row(k, k); }).join('') +
      '<div class="actions"><button class="btn primary" id="bSave">저장</button></div></div>';
    m.classList.remove('hidden');
    $('#bClose').onclick = closeModal;
    m.onclick = function (e) { if (e.target === m) closeModal(); };
    $('#bSave').onclick = function () {
      var out = {};
      $$('[data-bk]', m).forEach(function (inp) { var v = Number(inp.value); if (v > 0) out[inp.dataset.bk] = Math.round(v); });
      $('#bSave').disabled = true;
      api('saveBudgets', { budgets: out }).then(function (r) {
        boot.budgets = r.budgets || out; LS.set('boot', boot); closeModal(); render(); toast('예산을 저장했어요');
      }).catch(function (e) { $('#bSave').disabled = false; toast('저장 실패: ' + e.message + ' (인터넷 연결을 확인하세요)'); });
    };
  }

  /** 분석 탭: 월간 리포트 */
  function reportCard(ym) {
    var cur = monthAgg(ym), prev = monthAgg(prevYm(ym));
    if (!cur.n) return '';
    var p = ym.split('-');
    var h = '<div class="card rep"><h3>' + (+p[1]) + '월 소비 리포트</h3>';
    if (prev.con) {
      var diff = cur.con - prev.con;
      h += '<div class="rep-line">소비성 지출 <b class="num">' + won(cur.con) + '</b> · 지난달보다 <span class="' + (diff >= 0 ? 'up' : 'down') + '">' +
        (diff >= 0 ? '▲' : '▼') + wonShort(Math.abs(diff)) + '원</span></div>';
      var ch = Object.keys(cur.bySub).map(function (k) { return [k, cur.bySub[k] - (prev.bySub[k] || 0)]; })
        .filter(function (x) { return x[1] > 0; }).sort(function (a, c) { return c[1] - a[1]; }).slice(0, 3);
      if (ch.length) h += '<div class="rep-line">많이 늘어난 곳: ' + ch.map(function (x) { return '<b>' + esc(x[0]) + '</b> <span class="up">+' + wonShort(x[1]) + '</span>'; }).join(', ') + '</div>';
    } else {
      h += '<div class="rep-line">소비성 지출 <b class="num">' + won(cur.con) + '</b></div>';
    }
    var top = Object.keys(cur.bySub).sort(function (a, c) { return cur.bySub[c] - cur.bySub[a]; })[0];
    if (top) h += '<div class="rep-line">가장 많이 쓴 분류: <b>' + esc(top) + '</b> ' + wonShort(cur.bySub[top]) + '원 (' + (cur.bySub[top] / cur.con * 100).toFixed(0) + '%)</div>';
    var freq = Object.keys(cur.byDesc).sort(function (a, c) { return cur.byDesc[c] - cur.byDesc[a]; })[0];
    if (freq && cur.byDesc[freq] >= 2) h += '<div class="rep-line">가장 자주 간 곳: <b>' + esc(freq) + '</b> ' + cur.byDesc[freq] + '번</div>';
    if (cur.max) h += '<div class="rep-line">가장 큰 지출: <b>' + esc(cur.max.desc) + '</b> ' + won(cur.max.amount) + '</div>';
    var b = budgets()['전체'];
    if (b) h += '<div class="rep-line">예산 ' + wonShort(b) + '원 중 <b>' + (cur.con / b * 100).toFixed(0) + '%</b> 사용</div>';
    return h + '</div>';
  }

  // ── 문자 여러 건 붙여넣기 ──
  function openSmsPaste() {
    var m = $('#modal');
    m.innerHTML = '<div class="sheet"><div class="sheet-head"><h2>💬 카드 문자 붙여넣기</h2><button class="x" id="sClose">✕</button></div>' +
      '<p class="faint" style="margin-top:0">메시지 앱에서 카드 결제 문자를 길게 눌러 복사한 뒤 여기에 붙여 넣으세요. <b>여러 건을 한꺼번에</b> 붙여 넣어도 돼요. 앱 푸시로만 알림이 오는 카드는 알림 내용을 복사해 붙여 넣어도 돼요.</p>' +
      '<div class="field"><textarea id="smsText" style="min-height:140px" placeholder="[Web발신]\n현대카드 M 승인\n홍*동\n12,500원 일시불\n11/27 14:23\n스타벅스"></textarea></div>' +
      '<div class="actions"><button class="btn primary" id="smsParse">분석하기</button></div><div id="smsResult"></div></div>';
    m.classList.remove('hidden');
    $('#sClose').onclick = closeModal;
    m.onclick = function (e) { if (e.target === m) closeModal(); };
    var parsed = [];
    $('#smsParse').onclick = function () {
      var text = $('#smsText').value.replace(/\r/g, '');
      var chunks = text.split(/(?=\[Web발신\])/).map(function (x) { return x.trim(); }).filter(Boolean);
      if (chunks.length <= 1) chunks = text.split(/\n\s*\n/).map(function (x) { return x.trim(); }).filter(Boolean);
      var methodsFull = (boot && boot.methods) || Demo.boot().methods;
      var descMap = recentDescMap();
      var fails = 0;
      parsed = [];
      chunks.forEach(function (c) {
        var r = parseCardSms(c, methodsFull, new Date());
        if (!r.ok) { fails++; return; }
        r.cat = guessCategory(r.merchant, descMap);
        var y = Number(r.date.slice(0, 4));
        r.dup = getYear(y).some(function (t) {
          if (t.date !== r.date) return false;
          var same = r.currency === 'KRW' ? Math.abs(t.amount) === r.amount : (t.currency === r.currency && Math.abs(Number(t.localAmount)) === r.amount);
          return same && (!t.method || !r.method || t.method === r.method);
        });
        parsed.push(r);
      });
      var out = $('#smsResult');
      if (!parsed.length) { out.innerHTML = '<div class="empty">결제 문자를 찾지 못했어요' + (fails ? ' (' + fails + '건 인식 실패)' : '') + '</div>'; return; }
      out.innerHTML = '<div class="gl" style="margin:12px 0 4px">' + parsed.length + '건 찾음' + (fails ? ' · ' + fails + '건은 결제 문자가 아니라서 건너뜀' : '') + '</div>' +
        '<div class="txlist">' + parsed.map(function (r, i) {
          var amt = r.currency === 'KRW' ? won(r.amount) : fmtLocal(r.amount, r.currency);
          return '<label class="sms-row"><input type="checkbox" data-si="' + i + '"' + (r.dup ? '' : ' checked') + '>' +
            '<div class="main"><div class="d">' + esc(r.merchant) + (r.cancel ? ' <span class="badge warn">취소</span>' : '') + (r.dup ? ' <span class="badge wait">이미 있음</span>' : '') + '</div>' +
            '<div class="m">' + esc([r.date.slice(5).replace('-', '/') + (r.time ? ' ' + r.time : ''), r.method || '결제수단 모름', r.cat ? r.cat.sub : '분류 확인필요'].join(' · ')) + '</div></div>' +
            '<div class="a num">' + (r.cancel ? '-' : '') + esc(amt) + '</div></label>';
        }).join('') + '</div>' +
        '<div class="actions"><button class="btn primary" id="smsSave">선택한 내역 넣기</button></div>';
      $('#smsSave').onclick = saveParsed;
    };
    function saveParsed() {
      var picks = $$('[data-si]', m).filter(function (cb) { return cb.checked; }).map(function (cb) { return parsed[Number(cb.dataset.si)]; });
      if (!picks.length) { toast('선택한 내역이 없어요'); return; }
      $('#smsSave').disabled = true;
      Promise.all(picks.map(function (r) {
        if (r.currency === 'KRW') return Promise.resolve(null);
        return getRate(r.currency, r.date).catch(function () { return null; });
      })).then(function (rates) {
        picks.forEach(function (r, i) {
          var sign = r.cancel ? -1 : 1;
          var rate = rates[i] && !rates[i].stale ? rates[i].rate : null;
          enqueue({ type: 'save', tx: {
            id: uid(), date: r.date, kind: r.cat ? r.cat.kind : '소비', big: r.cat ? r.cat.big : '미분류', sub: r.cat ? r.cat.sub : '',
            desc: r.merchant + (r.cancel ? ' (승인취소)' : ''), currency: r.currency,
            amount: r.currency === 'KRW' ? sign * r.amount : (rate ? Math.round(sign * r.amount * rate) : 0),
            localAmount: r.currency === 'KRW' ? null : sign * r.amount, rate: rate,
            method: r.method || '', user: cfg.user, trip: cfg.travel.on ? cfg.travel.trip : '', memo: r.time ? '결제시각 ' + r.time : '',
            fixed: false, source: '문자', status: r.cat && r.method ? '' : '확인필요', createdAt: new Date().toISOString()
          } });
        });
        closeModal(); render(); sync(true);
        toast(picks.length + '건을 넣었어요');
      });
    }
  }

  // ── 앱 잠금 (이 기기 전용 비밀번호) ──
  function sha(text) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode('gagyebu:' + text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    });
  }
  var hiddenAt = 0;
  function lockIfNeeded() {
    if (!LS.get('pin', '') || sessionStorage.getItem('gb.unlocked') === '1') return;
    showLock();
  }
  function showLock() {
    if ($('#lock')) return;
    var el = document.createElement('div'); el.id = 'lock'; el.className = 'lock';
    var code = '';
    function draw(msg) {
      el.innerHTML = '<div class="lock-box"><div class="brand">우리집 가계부</div><div class="muted">' + (msg || '비밀번호를 입력하세요') + '</div>' +
        '<div class="dots">' + [0, 1, 2, 3, 4, 5].slice(0, Math.max(4, LS.get('pinLen', 4))).map(function (i) { return '<i class="' + (i < code.length ? 'on' : '') + '"></i>'; }).join('') + '</div>' +
        '<div class="pad">' + ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map(function (k) { return '<button type="button" data-p="' + k + '"' + (k ? '' : ' disabled') + '>' + k + '</button>'; }).join('') + '</div>' +
        '<button type="button" class="link" id="forgot">비밀번호를 잊었어요</button></div>';
      $$('[data-p]', el).forEach(function (b) {
        b.onclick = function () {
          var k = b.dataset.p;
          if (k === '⌫') code = code.slice(0, -1); else if (k) code += k;
          if (code.length >= LS.get('pinLen', 4)) {
            sha(code).then(function (h) {
              if (h === LS.get('pin', '')) { sessionStorage.setItem('gb.unlocked', '1'); el.remove(); }
              else { code = ''; draw('비밀번호가 달라요'); }
            });
          } else draw();
        };
      });
      $('#forgot', el).onclick = function () {
        if (!confirm('이 기기의 잠금과 저장 데이터를 지우고 다시 연결해야 해요. 구글 시트의 가계부 데이터는 그대로예요. 계속할까요?')) return;
        Object.keys(localStorage).forEach(function (k) { if (k.indexOf('gb.') === 0) localStorage.removeItem(k); });
        location.reload();
      };
    }
    draw();
    document.body.appendChild(el);
  }
  function setPin() {
    var a = prompt('새 비밀번호 (숫자 4~6자리)');
    if (a === null) return;
    if (!/^\d{4,6}$/.test(a)) { toast('숫자 4~6자리로 입력해 주세요'); return; }
    var b = prompt('한 번 더 입력하세요');
    if (a !== b) { toast('두 번 입력한 비밀번호가 달라요'); return; }
    sha(a).then(function (h) { LS.set('pin', h); LS.set('pinLen', a.length); sessionStorage.setItem('gb.unlocked', '1'); render(); toast('앱 잠금을 켰어요'); });
  }

  // ───────────── 데모 백엔드 (서버 없이 둘러보기) ─────────────
  var Demo = (function () {
    var CATS = [['소비', '가족', ['병원/약국', '고양이']], ['소비', '교통', ['항공권', '기차/버스', '대중교통/택시']], ['소비', '자동차', ['주유/주차', '차량유지관리']],
      ['소비', '미용', ['뷰티', '패션', '관리']], ['소비', '수리', ['수리비']], ['소비', '여행', ['숙박비', '액티비티/입장료']],
      ['소비', '생활', ['외식', '배달', '마트', '인터넷쇼핑(쿠팡)', '생필품/생활', '가전/가구']], ['소비', '기호', ['주류', '담배']],
      ['소비', '모임', ['친구/지인', '경조사/선물']], ['소비', '용돈', ['홍키용돈', '핸니용돈']],
      ['비소비', '비소비', ['세무사/종소세', '재산세/보유세', '세금', '공과금(전기/가스/수도)', '건보료', '연금', '보험료', '구독', '인터넷/핸드폰', '임대관리', '기타']],
      ['수입', '홍키', ['배당소득', '채권/이자']], ['수입', '핸니', ['배당소득', '채권/이자']], ['수입', '임대수익', ['201호', '301호', '401호', '상가']], ['수입', '기타소득', ['기타']]];
    function boot() {
      var c = []; CATS.forEach(function (g) { g[2].forEach(function (s) { c.push({ kind: g[0], big: g[1], sub: s }); }); });
      var kw = { '부산카드(홍)': ['BNK', '부산'], '현대카드(핸)': ['현대카드'], '비씨카드(핸)': ['BC', '비씨'] };
      return { categories: c, methods: ['부산카드(홍)', '현대카드(핸)', '비씨카드(핸)', '상품권/페이', '기타결제', '계좌이체', '현금'].map(function (n) { return { name: n, keywords: kw[n] || [] }; }),
        budgets: LS.get('demo.budgets', { '전체': 1500000, '생활': 700000 }),
        rules: [{ keywords: ['스타벅스', '카페', '커피'], kind: '소비', big: '생활', sub: '외식' }, { keywords: ['GS25', 'CU', '세븐일레븐', '이마트'], kind: '소비', big: '생활', sub: '마트' }],
        fixed: [{ desc: '건보료', amount: 650670, method: '계좌이체', kind: '비소비', big: '비소비', sub: '건보료' }, { desc: '관리비', amount: 0, method: '계좌이체', kind: '비소비', big: '비소비', sub: '공과금(전기/가스/수도)' },
          { desc: '유튜브프리미엄', amount: 13900, method: '비씨카드(핸)', kind: '비소비', big: '비소비', sub: '구독' }],
        users: ['홍키', '핸니'], currencies: ['KRW', 'USD', 'JPY', 'THB', 'EUR', 'CNY'], sheetUrl: '' };
    }
    function seed() {
      var out = [], y = new Date().getFullYear(), now = new Date();
      var spend = [['외식', '생활', ['스타벅스', '오리킹', '돈사돈', '빵집']], ['마트', '생활', ['이마트', 'GS25', '하나로마트']], ['배달', '생활', ['배달의민족', '땡겨요']],
        ['병원/약국', '가족', ['약국']], ['고양이', '가족', ['냥화장실/냥밥']], ['대중교통/택시', '교통', ['택시', '버스']], ['담배', '기호', ['담배']]];
      var r = 7; function rnd() { r = (r * 16807) % 2147483647; return r / 2147483647; }
      for (var m = 1; m <= 12; m++) {
        if (new Date(y, m - 1, 1) > now) break;
        for (var i = 0; i < 22; i++) {
          var d = 1 + Math.floor(rnd() * 28); var s = spend[Math.floor(rnd() * spend.length)];
          var date = y + '-' + pad(m) + '-' + pad(d); if (date > today()) continue;
          out.push({ id: 'd' + m + '_' + i, date: date, kind: '소비', big: s[1], sub: s[0], desc: s[2][Math.floor(rnd() * s[2].length)], amount: Math.round((5 + rnd() * 60)) * 1000, currency: 'KRW', method: ['부산카드(홍)', '비씨카드(핸)', '현대카드(핸)'][Math.floor(rnd() * 3)], user: rnd() > .5 ? '홍키' : '핸니', source: rnd() > .6 ? '문자' : '앱', status: '' });
        }
        out.push({ id: 'f' + m, date: y + '-' + pad(m) + '-01', kind: '비소비', big: '비소비', sub: '건보료', desc: '건보료', amount: 650670, currency: 'KRW', method: '계좌이체', user: '홍키', fixed: true, source: '앱' });
        out.push({ id: 'i' + m, date: y + '-' + pad(m) + '-05', kind: '수입', big: '임대수익', sub: '301호', desc: '301호', amount: 1300000, currency: 'KRW', method: '', user: '홍키', source: '앱' });
        out.push({ id: 'j' + m, date: y + '-' + pad(m) + '-10', kind: '수입', big: '임대수익', sub: '상가', desc: '상가', amount: 2640000, currency: 'KRW', method: '', user: '홍키', source: '앱' });
      }
      out.push({ id: 'tr1', date: y + '-01-10', kind: '소비', big: '여행', sub: '숙박비', desc: '아고다 올드타운', amount: 258560, currency: 'THB', localAmount: 6400, rate: 40.4, method: '부산카드(홍)', user: '홍키', trip: '치앙마이', source: '앱' });
      out.push({ id: 'tr2', date: y + '-01-11', kind: '소비', big: '생활', sub: '외식', desc: '카오소이', amount: 4040, currency: 'THB', localAmount: 100, rate: 40.4, method: '현금', user: '핸니', trip: '치앙마이', source: '앱' });
      out.push({ id: 'tr3', date: y + '-01-12', kind: '소비', big: '여행', sub: '액티비티/입장료', desc: '도이인타논', amount: 97212, currency: 'THB', localAmount: 2400, rate: 40.5, method: '부산카드(홍)', user: '홍키', trip: '치앙마이', source: '앱' });
      out.push({ id: 'rv1', date: today(), kind: '소비', big: '미분류', sub: '', desc: '새로운가게', amount: 33000, currency: 'KRW', method: '비씨카드(핸)', user: '핸니', source: '문자', status: '확인필요' });
      return out;
    }
    function db() { return LS.get('demo.db', null) || (LS.set('demo.db', seed()), LS.get('demo.db')); }
    function reset() { LS.del('demo.db'); }
    function handle(action, p) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          var all = db();
          if (action === 'bootstrap') return resolve(Object.assign({ ok: true }, boot()));
          if (action === 'list') return resolve({ ok: true, txs: all.filter(function (t) { return t.date.slice(0, 4) === String(p.year); }), years: [new Date().getFullYear()] });
          if (action === 'add' || action === 'update') {
            var t = p.tx; if (t.currency !== 'KRW' && t.localAmount && !t.rate) { t.rate = fxCache['last.' + t.currency] || 1; t.amount = Math.round(t.localAmount * t.rate); }
            all = all.filter(function (x) { return x.id !== t.id; }); all.push(t); LS.set('demo.db', all); return resolve({ ok: true, saved: [t] });
          }
          if (action === 'saveBudgets') { LS.set('demo.budgets', p.budgets || {}); return resolve({ ok: true, budgets: p.budgets || {} }); }
          if (action === 'delete') { LS.set('demo.db', all.filter(function (x) { return x.id !== p.id; })); return resolve({ ok: true, deleted: 1 }); }
          resolve({ ok: true });
        }, 120);
      });
    }
    return { handle: handle, boot: boot, reset: reset };
  })();

  // ───────────── 시작 ─────────────
  $$('#tabbar button').forEach(function (b) {
    b.onclick = function () {
      if (b.dataset.tab === 'add') { if (configured()) openForm(); else { state.tab = 'settings'; render(); } return; }
      state.tab = b.dataset.tab; render();
      if (b.dataset.tab === 'stats') sync(true);
    };
  });
  $('#syncBtn').onclick = function () { sync(); };
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') sync(true); });
  window.addEventListener('online', function () { sync(true); });
  state.years = LS.get('years', []);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 5 * 60 * 1000 && LS.get('pin', '')) { sessionStorage.removeItem('gb.unlocked'); lockIfNeeded(); }
  });
  lockIfNeeded();
  render();
  if (configured()) sync(true);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
})();
