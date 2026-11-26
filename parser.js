/* apps-script/Parser.gs 와 같은 코드 (카드 문자 해석) — 앱에서 '문자 붙여넣기'에 사용 */
/**
 * 카드 결제 문자 / 애플페이 거래 파서 (순수 함수 — 시트에 의존하지 않음)
 *
 * parseCardSms(text, methods, now) → { ok, reason?, date, time, amount, currency, merchant, method, cancel }
 * parseApplePay({amount, merchant, card}, methods, now) → 같은 형태
 *
 * methods: [{ name: '현대카드(핸)', keywords: ['현대카드'] }, ...]
 */

var CURRENCY_CODES = ('USD EUR JPY CNY GBP THB VND PHP MYR SGD IDR TWD HKD AUD NZD CAD CHF MXN BRL ARS CLP COP PEN BOB ' +
  'CUP CUC UYU PYG ZAR NAD BWP ZMW ZWL TZS KES ETB EGP JOD TRY AED SAR QAR INR NPR LKR MVR KHR LAK MMK MNT ' +
  'KZT UZS RUB PLN CZK HUF SEK NOK DKK ISK MAD TND SCR MUR MGA KRW').split(' ');

var CURRENCY_SYMBOLS = [
  ['US$', 'USD'], ['A$', 'AUD'], ['C$', 'CAD'], ['NZ$', 'NZD'], ['HK$', 'HKD'], ['S$', 'SGD'], ['NT$', 'TWD'],
  ['₩', 'KRW'], ['￦', 'KRW'], ['€', 'EUR'], ['£', 'GBP'], ['฿', 'THB'], ['₫', 'VND'], ['₱', 'PHP'],
  ['円', 'JPY'], ['元', 'CNY'], ['¥', 'JPY'], ['$', 'USD']
];

// 금액/누적 등 가맹점이 아닌 줄을 거르는 패턴
var NON_MERCHANT = /(누적|잔액|한도|포인트|일시불|할부|승인|취소|결제예정|님$|\*|^\d{1,2}\/\d{1,2}|^\d{1,2}:\d{2}|[\d,]+\s*원|Web발신|카드\(|체크)/;

function toNumber_(s) {
  return Number(String(s).replace(/,/g, ''));
}

function matchMethod_(text, methods) {
  var t = String(text || '').toUpperCase();
  for (var i = 0; i < methods.length; i++) {
    var kws = methods[i].keywords || [];
    for (var j = 0; j < kws.length; j++) {
      var k = String(kws[j]).trim().toUpperCase();
      if (k && t.indexOf(k) >= 0) return methods[i].name;
    }
  }
  return '';
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function fmtDate_(d) {
  return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate());
}

/** 'MM/DD' → 'YYYY-MM-DD' (연말/연초 경계 처리) */
function resolveDate_(month, day, now) {
  var y = now.getFullYear();
  // 1월에 받은 12월 문자 → 작년
  if (month - (now.getMonth() + 1) > 6) y -= 1;
  return y + '-' + pad2_(month) + '-' + pad2_(day);
}

/** 문자열에서 통화+금액 찾기. 외화가 있으면 외화 우선 */
function findAmount_(text) {
  var codes = CURRENCY_CODES.join('|');
  // 1) "USD 12.50" / "USD12.50"
  var re1 = new RegExp('\\b(' + codes + ')\\s?([\\d,]+(?:\\.\\d+)?)');
  // 2) "12.50 USD" / "12.50USD"
  var re2 = new RegExp('([\\d,]+(?:\\.\\d+)?)\\s?(' + codes + ')\\b');
  var lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/누적|잔액|한도/.test(line)) continue;
    var m = line.match(re1);
    if (m && m[1] !== 'KRW') return { currency: m[1], amount: toNumber_(m[2]) };
    m = line.match(re2);
    if (m && m[2] !== 'KRW') return { currency: m[2], amount: toNumber_(m[1]) };
  }
  // 3) 원화 "12,500원"
  for (var k = 0; k < lines.length; k++) {
    if (/누적|잔액|한도|포인트/.test(lines[k])) continue;
    var w = lines[k].match(/([\d,]+)\s*원/);
    if (w) return { currency: 'KRW', amount: toNumber_(w[1]) };
  }
  // 4) KRW 12,500
  var kr = text.match(/KRW\s?([\d,]+(?:\.\d+)?)/);
  if (kr) return { currency: 'KRW', amount: toNumber_(kr[1]) };
  return null;
}

function parseCardSms(text, methods, now) {
  now = now || new Date();
  methods = methods || [];
  var raw = String(text || '');
  var t = raw.replace(/\[Web발신\]/g, '').replace(/\r/g, '').trim();
  if (!t) return { ok: false, reason: '빈 문자' };
  if (!/(승인|결제|사용|출금)/.test(t)) return { ok: false, reason: '결제 문자가 아님' };
  if (/(거절|실패|인증번호)/.test(t)) return { ok: false, reason: '거절/인증 문자' };

  // 한 줄로 온 문자는 공백 기준으로 줄을 나눔 (날짜/금액/누적 앞에서 끊기)
  if (t.indexOf('\n') < 0) {
    t = t.replace(/\s+(?=\d{1,2}\/\d{1,2}\s)/g, '\n')
         .replace(/\s+(?=[\d,]+(?:\.\d+)?\s?원)/g, '\n')
         .replace(/\s+(?=누적|잔액)/g, '\n')
         .replace(/(\d{1,2}:\d{2})\s+/g, '$1\n');
  }

  var cancel = /취소/.test(t);
  var amt = findAmount_(t);
  if (!amt || !(amt.amount > 0)) return { ok: false, reason: '금액을 찾지 못함' };

  var date = fmtDate_(now), time = '';
  var dm = t.match(/(\d{1,2})\/(\d{1,2})\s*(\d{1,2}):(\d{2})/) || t.match(/(\d{1,2})\/(\d{1,2})/);
  if (dm) {
    date = resolveDate_(Number(dm[1]), Number(dm[2]), now);
    if (dm[3]) time = pad2_(Number(dm[3])) + ':' + dm[4];
  }

  // 가맹점: 날짜/시간 이후의 첫 일반 줄 → 없으면 전체에서 첫 일반 줄
  var lines = t.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  var merchant = '';
  var afterIdx = -1;
  for (var i = 0; i < lines.length; i++) {
    if (/\d{1,2}\/\d{1,2}/.test(lines[i])) { afterIdx = i; break; }
  }
  var candidates = afterIdx >= 0 ? lines.slice(afterIdx) : lines;
  for (var j = 0; j < candidates.length && !merchant; j++) {
    var c = candidates[j]
      .replace(/\d{1,2}\/\d{1,2}\s*(\d{1,2}:\d{2})?/, '')
      .replace(/(누적|잔액).*$/, '')
      .trim();
    if (!c) continue;
    if (NON_MERCHANT.test(c)) continue;
    if (/^[\d,.\s]+$/.test(c)) continue;
    if (new RegExp('^(' + CURRENCY_CODES.join('|') + ')\\b').test(c)) continue;
    merchant = c;
  }
  if (!merchant) {
    for (var k = 0; k < lines.length && !merchant; k++) {
      if (!NON_MERCHANT.test(lines[k]) && !/^[\d,.\s]+$/.test(lines[k])) merchant = lines[k];
    }
  }

  return {
    ok: true,
    date: date,
    time: time,
    amount: amt.amount,
    currency: amt.currency,
    merchant: merchant || '(가맹점 미확인)',
    method: (/(출금|이체)/.test(t) && !/카드/.test(t)) ? '계좌이체' : matchMethod_(t, methods),
    cancel: cancel
  };
}

/** 애플페이 '거래' 자동화 입력 파싱. amount 예: "₩12,500", "$12.50", "THB 350.00", "12,500" */
function parseApplePay(input, methods, now) {
  now = now || new Date();
  var a = String(input.amount || '').trim();
  var currency = '';
  var codeMatch = a.match(new RegExp('(' + CURRENCY_CODES.join('|') + ')'));
  if (codeMatch) currency = codeMatch[1];
  if (!currency) {
    for (var i = 0; i < CURRENCY_SYMBOLS.length; i++) {
      if (a.indexOf(CURRENCY_SYMBOLS[i][0]) >= 0) { currency = CURRENCY_SYMBOLS[i][1]; break; }
    }
  }
  if (!currency) currency = input.currency || 'KRW';
  var num = a.match(/[\d.,]+/);
  if (!num) return { ok: false, reason: '금액을 찾지 못함' };
  var s = num[0];
  // 유럽식 "12,50" 처리: 콤마 하나 + 뒤 2자리 → 소수점
  if (/^\d+,\d{2}$/.test(s)) s = s.replace(',', '.');
  var amount = toNumber_(s);
  if (!(amount > 0)) return { ok: false, reason: '금액이 0' };
  var cardText = String(input.card || '') + ' ' + String(input.pass || '');
  return {
    ok: true,
    date: fmtDate_(now),
    time: pad2_(now.getHours()) + ':' + pad2_(now.getMinutes()),
    amount: amount,
    currency: currency,
    merchant: String(input.merchant || '').trim() || '(가맹점 미확인)',
    method: matchMethod_(cardText, methods) || matchMethod_('애플페이 ' + cardText, methods),
    cancel: false
  };
}
