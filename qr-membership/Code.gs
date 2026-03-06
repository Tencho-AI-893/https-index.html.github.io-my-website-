/*************************************************
 * QRデジタル会員証（Google Apps Script）
 * - members / visits シートで運用
 * - Googleフォーム送信時に会員情報を自動作成
 * - token付きURLで会員証表示
 * - 会員証画面からチェックイン記録
 *************************************************/

const CONFIG = {
  MEMBERS_SHEET: 'members',
  VISITS_SHEET: 'visits',
  DEFAULT_RANK: 'Bronze',
  MEMBER_PREFIX: 'KM',
  MEMBER_DIGITS: 6,
  EXPIRE_DAYS: 365,
  // 初回デプロイ後にウェブアプリURLへ差し替えてください
  WEB_APP_URL: 'PASTE_YOUR_WEB_APP_URL_HERE',
};

/**
 * 初期セットアップ：シートのヘッダーを作成
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const members = ss.getSheetByName(CONFIG.MEMBERS_SHEET) || ss.insertSheet(CONFIG.MEMBERS_SHEET);
  if (members.getLastRow() === 0) {
    members.appendRow(['member_id', 'nickname', 'expires_at', 'rank', 'token', 'card_url', 'created_at']);
  }

  const visits = ss.getSheetByName(CONFIG.VISITS_SHEET) || ss.insertSheet(CONFIG.VISITS_SHEET);
  if (visits.getLastRow() === 0) {
    visits.appendRow(['timestamp', 'member_id', 'nickname', 'rank']);
  }
}

/**
 * フォーム送信時トリガー
 * e.namedValues['ニックネーム'][0] を前提に会員登録
 */
function onFormSubmit(e) {
  setupSheets();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const membersSheet = ss.getSheetByName(CONFIG.MEMBERS_SHEET);

  const nickname = getNicknameFromEvent_(e);
  const memberId = generateNextMemberId_(membersSheet);
  const token = generateSecureToken_();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + CONFIG.EXPIRE_DAYS * 24 * 60 * 60 * 1000);
  const rank = CONFIG.DEFAULT_RANK;
  const cardUrl = `${CONFIG.WEB_APP_URL}?t=${encodeURIComponent(token)}`;

  membersSheet.appendRow([
    memberId,
    nickname,
    formatDate_(expiresAt),
    rank,
    token,
    cardUrl,
    createdAt,
  ]);

  // 任意：フォーム回答シートに会員情報を書き戻したい場合
  // 回答シートに列を追加し、ここで setValue() してください。
}

/**
 * 会員証表示（GET /exec?t=token）
 */
function doGet(e) {
  const token = (e && e.parameter && e.parameter.t) ? String(e.parameter.t) : '';
  const member = findMemberByToken_(token);

  const template = HtmlService.createTemplateFromFile('Card');

  if (!member) {
    template.member = null;
    return template
      .evaluate()
      .setTitle('会員証が見つかりません')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  const today = new Date();
  const expiresDate = new Date(member.expires_at);
  const daysLeft = Math.ceil((expiresDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  template.member = {
    member_id: member.member_id,
    nickname: member.nickname,
    expires_at: member.expires_at,
    rank: member.rank,
    card_url: member.card_url,
    qr_url: buildQrUrl_(member.card_url),
    today: formatDate_(today),
    days_left: daysLeft,
  };

  return template
    .evaluate()
    .setTitle(`会員証 ${member.nickname}`)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * チェックイン記録（POST）
 * action=checkin&t=token
 */
function doPost(e) {
  const action = (e.parameter.action || '').toLowerCase();

  if (action !== 'checkin') {
    return jsonResponse_({ ok: false, message: 'invalid action' });
  }

  const token = String(e.parameter.t || '');
  const member = findMemberByToken_(token);

  if (!member) {
    return jsonResponse_({ ok: false, message: 'member not found' });
  }

  recordVisit_(member);
  return jsonResponse_({ ok: true, message: 'checked in' });
}

/**
 * トークン再発行（漏洩時対応）
 * 例: regenToken('KM000123')
 */
function regenToken(memberId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const membersSheet = ss.getSheetByName(CONFIG.MEMBERS_SHEET);
  if (!membersSheet) throw new Error('membersシートがありません');

  const values = membersSheet.getDataRange().getValues();
  if (values.length < 2) throw new Error('会員データがありません');

  for (let r = 1; r < values.length; r++) {
    if (String(values[r][0]) === memberId) {
      const newToken = generateSecureToken_();
      const newCardUrl = `${CONFIG.WEB_APP_URL}?t=${encodeURIComponent(newToken)}`;

      membersSheet.getRange(r + 1, 5).setValue(newToken);   // token
      membersSheet.getRange(r + 1, 6).setValue(newCardUrl); // card_url

      return { member_id: memberId, token: newToken, card_url: newCardUrl };
    }
  }

  throw new Error(`member_id ${memberId} が見つかりません`);
}

/********************
 * private helpers
 ********************/

function getNicknameFromEvent_(e) {
  if (!e || !e.namedValues) return 'NoName';

  // フォーム項目名を「ニックネーム」にする想定
  if (e.namedValues['ニックネーム'] && e.namedValues['ニックネーム'][0]) {
    return String(e.namedValues['ニックネーム'][0]).trim() || 'NoName';
  }

  // 予備：最初の回答値をニックネーム扱い
  const keys = Object.keys(e.namedValues);
  if (keys.length > 0) {
    const value = e.namedValues[keys[0]][0];
    return String(value || '').trim() || 'NoName';
  }

  return 'NoName';
}

function generateNextMemberId_(membersSheet) {
  const lastRow = membersSheet.getLastRow();

  let nextNumber = 1;
  if (lastRow >= 2) {
    const lastMemberId = String(membersSheet.getRange(lastRow, 1).getValue());
    const matched = lastMemberId.match(/(\d+)$/);
    if (matched) nextNumber = Number(matched[1]) + 1;
  }

  return `${CONFIG.MEMBER_PREFIX}${String(nextNumber).padStart(CONFIG.MEMBER_DIGITS, '0')}`;
}

function generateSecureToken_() {
  const uuid = Utilities.getUuid().replace(/-/g, '');
  const random = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  return `${uuid}${random}`;
}

function findMemberByToken_(token) {
  if (!token) return null;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.MEMBERS_SHEET);
  if (!sheet) return null;

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return null;

  for (let r = 1; r < values.length; r++) {
    if (String(values[r][4]) === token) {
      return {
        member_id: values[r][0],
        nickname: values[r][1],
        expires_at: values[r][2],
        rank: values[r][3],
        token: values[r][4],
        card_url: values[r][5],
        created_at: values[r][6],
      };
    }
  }

  return null;
}

function recordVisit_(member) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.VISITS_SHEET);
  if (!sheet) throw new Error('visitsシートがありません');

  sheet.appendRow([
    new Date(),
    member.member_id,
    member.nickname,
    member.rank,
  ]);
}

function buildQrUrl_(text) {
  const encoded = encodeURIComponent(text);
  return `https://chart.googleapis.com/chart?cht=qr&chs=260x260&chl=${encoded}`;
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function formatDate_(date) {
  return Utilities.formatDate(new Date(date), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
