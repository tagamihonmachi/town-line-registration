/**
 * 町会LINE 利用者登録フォームのバックエンド(Google Apps Script)
 *
 * スクリプトプロパティ(プロジェクトの設定 > スクリプト プロパティ)
 *   LINE_LOGIN_CHANNEL_ID               : LINE LoginチャネルのチャネルID(必須)
 *   SPREADSHEET_ID                      : 保存先スプレッドシートのID(スプレッドシートから作成したスクリプトなら不要)
 *   LINE_MESSAGING_CHANNEL_ACCESS_TOKEN : Messaging APIのチャネルアクセストークン(配信に必要)
 *   ADMIN_EMAILS                        : 配信管理画面を使えるGoogleアカウント(Admin.gs を参照)
 *   ADMIN_LINE_USER_ID                  : テスト送信の宛先になる管理者のLINEユーザーID(Admin.gs を参照)
 *   LINE_IMAGE_FOLDER_ID                : 配信画像を保存するGoogleドライブのフォルダID(Admin.gs を参照)
 *
 * 初回は setup() を1回実行して、権限の承認と見出し行の作成を行ってください。
 */

const SHEET_NAME = '登録者';
const VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
const MAX_BODY_LENGTH = 5000;

const AGE_OPTIONS = ['20代以下', '30代', '40代', '50代', '60代', '70代以上'];
// フォームから送られるキーと、スプレッドシートの列見出しの対応
const HOUSEHOLD_OPTIONS = { preschool: '未就学児', elementary: '小学生', juniorHigh: '中学生', senior: '65歳以上' };
// 「所属」は現在フォームから外している。戻すときは { kodomokai: '子ども会', yakuin: '町会役員' } のように指定する
const GROUP_OPTIONS = {};

const HEADERS = ['LINEユーザーID', '年代', '班']
  .concat(Object.values(HOUSEHOLD_OPTIONS), Object.values(GROUP_OPTIONS), ['登録日時', '更新日時']);
const CHECK_MARK = '○';

function doPost(e) {
  try {
    const body = parseBody_(e);
    // フォームを開いたときに、本人の前回の登録内容を返す(IDトークンで本人確認してから)
    if (body.action === 'get') {
      return json_({ ok: true, registration: findRegistration_(verifyIdToken_(body.idToken)) });
    }
    const answers = validateAnswers_(body);
    const userId = verifyIdToken_(body.idToken);
    const updated = saveRegistration_(userId, answers);
    return json_({ ok: true, updated: updated });
  } catch (err) {
    if (err.code) return json_({ ok: false, code: err.code, message: err.message });
    console.error(err);
    return json_({ ok: false, code: 'INTERNAL', message: 'サーバーでエラーが発生しました。時間をおいてもう一度お試しください。' });
  }
}

// ブラウザでURLを開いたときの動作確認用。?page=admin のときだけ配信管理画面(Admin.gs)を返す。
function doGet(e) {
  if (e && e.parameter && e.parameter.page === 'admin') return adminPage_();
  return json_({ ok: true, service: 'registration' });
}

/** 初回に1回だけ手動で実行する。権限の承認と見出し行の作成を行う。 */
function setup() {
  getChannelId_();
  UrlFetchApp.fetch(VERIFY_URL, { method: 'post', payload: {}, muteHttpExceptions: true });
  const sheet = getSheet_();
  console.log('準備ができました。保存先: ' + sheet.getParent().getUrl());
}

function appError_(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function parseBody_(e) {
  const text = e && e.postData && e.postData.contents;
  if (!text || text.length > MAX_BODY_LENGTH) throw appError_('BAD_REQUEST', '送信内容が正しくありません。');
  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw appError_('BAD_REQUEST', '送信内容が正しくありません。');
  }
  if (!body || typeof body !== 'object' || typeof body.idToken !== 'string' || !body.idToken) {
    throw appError_('BAD_REQUEST', '送信内容が正しくありません。');
  }
  return body;
}

function validateAnswers_(body) {
  if (AGE_OPTIONS.indexOf(body.age) === -1) throw appError_('INVALID_INPUT', '年代を1つ選んでください。');

  // 班の選択肢はフォーム側(config.js)で管理するため、ここでは形式だけを確認する。
  // 先頭の = + - @ は、スプレッドシートで数式として扱われるのを防ぐために拒否する。
  const han = typeof body.han === 'string' ? body.han.trim() : '';
  if (!han || han.length > 20 || /^[=+\-@]/.test(han) || /[\u0000-\u001f]/.test(han)) {
    throw appError_('INVALID_INPUT', '班を1つ選んでください。');
  }

  return {
    age: body.age,
    han: han,
    household: pickKnown_(body.household, HOUSEHOLD_OPTIONS, '世帯属性'),
    groups: pickKnown_(body.groups, GROUP_OPTIONS, '所属'),
  };
}

function pickKnown_(values, options, fieldName) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values) || values.some(function (v) { return !Object.prototype.hasOwnProperty.call(options, v); })) {
    throw appError_('INVALID_INPUT', fieldName + 'の内容が正しくありません。');
  }
  return values;
}

function getChannelId_() {
  const channelId = PropertiesService.getScriptProperties().getProperty('LINE_LOGIN_CHANNEL_ID');
  if (!channelId) throw new Error('スクリプトプロパティ LINE_LOGIN_CHANNEL_ID が設定されていません。');
  return channelId.trim();
}

/** IDトークンをLINE Platformで検証し、LINEユーザーID(sub)を返す。 */
function verifyIdToken_(idToken) {
  const channelId = getChannelId_();
  const res = UrlFetchApp.fetch(VERIFY_URL, {
    method: 'post',
    payload: { id_token: idToken, client_id: channelId },
    muteHttpExceptions: true,
  });

  let data = {};
  try {
    data = JSON.parse(res.getContentText());
  } catch (err) {}

  if (res.getResponseCode() !== 200) {
    const description = String(data.error_description || '');
    console.warn('IDトークン検証に失敗: ' + res.getResponseCode() + ' ' + description);
    if (/expired/i.test(description)) throw appError_('TOKEN_EXPIRED', 'ログインの有効期限が切れました。');
    throw appError_('TOKEN_INVALID', '本人確認ができませんでした。LINEアプリからもう一度開いてください。');
  }
  if (data.aud !== channelId || data.iss !== 'https://access.line.me' || !/^U[0-9a-f]{32}$/.test(data.sub || '')) {
    throw appError_('TOKEN_INVALID', '本人確認ができませんでした。LINEアプリからもう一度開いてください。');
  }
  return data.sub;
}

function getSheet_() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  const spreadsheet = spreadsheetId ? SpreadsheetApp.openById(spreadsheetId.trim()) : SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('保存先のスプレッドシートが見つかりません。SPREADSHEET_ID を設定してください。');

  const sheet = spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange(2, HEADERS.length - 1, sheet.getMaxRows() - 1, 2).setNumberFormat('yyyy/mm/dd hh:mm:ss');
  }
  return sheet;
}

/**
 * LINEユーザーIDの登録内容を、フォームの選択肢の形で返す。未登録なら null。
 * @return {?{age: string, han: string, household: string[]}}
 */
function findRegistration_(userId) {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const lastColumn = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function (h) { return String(h).trim(); });
  const rows = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  const row = rows.find(function (r) { return r[0] === userId; });
  if (!row) return null;
  const cell = function (header) {
    const column = headers.indexOf(header);
    return column === -1 ? '' : String(row[column]).trim();
  };
  return {
    age: cell('年代'),
    han: cell('班'),
    household: Object.keys(HOUSEHOLD_OPTIONS).filter(function (key) { return cell(HOUSEHOLD_OPTIONS[key]) === CHECK_MARK; }),
  };
}

/**
 * 同じLINEユーザーIDの行があれば更新し、なければ追加する。
 * @return {boolean} 既存行を更新した場合は true
 */
function saveRegistration_(userId, answers) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw appError_('BUSY', 'ただいま混み合っています。少し待ってからもう一度お試しください。');
  try {
    const sheet = getSheet_();
    const now = new Date();
    const mark = function (selected, options) {
      return Object.keys(options).map(function (key) { return selected.indexOf(key) === -1 ? '' : CHECK_MARK; });
    };
    const answerCells = [answers.age, answers.han].concat(mark(answers.household, HOUSEHOLD_OPTIONS), mark(answers.groups, GROUP_OPTIONS));

    const lastRow = sheet.getLastRow();
    const ids = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues() : [];
    const index = ids.findIndex(function (row) { return row[0] === userId; });

    if (index === -1) {
      sheet.appendRow([userId].concat(answerCells, [now, now]));
      return false;
    }
    const rowNumber = index + 2;
    sheet.getRange(rowNumber, 2, 1, answerCells.length).setValues([answerCells]);
    sheet.getRange(rowNumber, HEADERS.length).setValue(now);
    return true;
  } finally {
    lock.releaseLock();
  }
}

/**
 * テスト送信。エディタから手動で実行する。
 * 「登録者」シートの最初の1人に、Messaging API の push message でテキストを1通送る。
 * スクリプトプロパティ LINE_MESSAGING_CHANNEL_ACCESS_TOKEN が必要。
 */
function sendTestMessage() {
  const token = PropertiesService.getScriptProperties().getProperty('LINE_MESSAGING_CHANNEL_ACCESS_TOKEN');
  if (!token) {
    console.error('スクリプトプロパティ LINE_MESSAGING_CHANNEL_ACCESS_TOKEN が設定されていません。送信していません。');
    return;
  }

  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  const ids = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues() : [];
  const first = ids.find(function (row) { return /^U[0-9a-f]{32}$/.test(row[0]); });
  if (!first) {
    console.error('「登録者」シートにLINEユーザーIDが見つかりません。送信していません。');
    return;
  }
  const userId = first[0];
  console.log('送信先: ' + userId.slice(0, 6) + '…(登録者シートの最初の1人)');

  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token.trim() },
    payload: JSON.stringify({
      to: userId,
      messages: [{ type: 'text', text: '町会LINE テスト配信です。' }],
    }),
    muteHttpExceptions: true,
  });

  const status = res.getResponseCode();
  console.log('レスポンスコード: ' + status);
  if (status === 200) {
    console.log('送信に成功しました。');
  } else {
    console.error('送信に失敗しました。エラー内容: ' + res.getContentText());
  }
}

/**
 * 「登録者」シートから、条件に合うLINEユーザーIDを抽出する(送信はしない)。
 *
 * 条件は { 列見出し: 値 } の形で指定する。
 *   { '小学生': '○' }                      小学生がいる人
 *   { '班': '3班' }                        3班の人
 *   { '年代': ['30代', '40代'] }           30代または40代(配列は「どれか」)
 *   { '班': '3班', '65歳以上': '○' }       3班で、かつ65歳以上の方がいる人(複数指定は「すべて」)
 *   {}                                     登録者全員
 *
 * @param {Object} conditions
 * @return {string[]} LINEユーザーIDの配列
 */
function findUserIds_(conditions) {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function (h) { return String(h).trim(); });

  const idColumn = headers.indexOf(HEADERS[0]);
  if (idColumn === -1) throw new Error('見出し「' + HEADERS[0] + '」の列が見つかりません。');

  // 条件を [列番号, 許可する値の一覧] に変換する。見出しの書き間違いはここでエラーにする。
  const filters = Object.keys(conditions || {}).map(function (name) {
    const column = headers.indexOf(name);
    if (column === -1) throw new Error('条件に指定した見出し「' + name + '」の列が見つかりません。');
    const allowed = [].concat(conditions[name]).map(function (v) { return String(v).trim(); });
    return { column: column, allowed: allowed };
  });

  const rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues() : [];
  const ids = [];
  rows.forEach(function (row) {
    const userId = String(row[idColumn]).trim();
    if (!/^U[0-9a-f]{32}$/.test(userId) || ids.indexOf(userId) !== -1) return;
    const matched = filters.every(function (f) { return f.allowed.indexOf(String(row[f.column]).trim()) !== -1; });
    if (matched) ids.push(userId);
  });
  return ids;
}

// ---------------------------------------------------------------------------
// 属性別配信
// 配信の条件と本文はここで指定する。確認用・送信用の両方がこの設定を使う。
// 条件の書き方は findUserIds_ の説明を参照(例: { '班': '3班' }、{ '年代': ['30代', '40代'] })。
// ---------------------------------------------------------------------------
const DELIVERY = {
  conditions: { '小学生': CHECK_MARK },
  text: '町会LINE 属性別配信テストです。',
};

const MULTICAST_URL = 'https://api.line.me/v2/bot/message/multicast';
// multicast で1回に指定できる宛先の上限
const MULTICAST_MAX_RECIPIENTS = 500;

/** 【確認用】エディタから手動で実行する。DELIVERY の条件に合う人をログに出す(送信はしない)。 */
function logElementaryTargets() {
  const ids = findUserIds_(DELIVERY.conditions);
  console.log('条件: ' + JSON.stringify(DELIVERY.conditions));
  console.log('本文: ' + DELIVERY.text);
  console.log('対象人数: ' + ids.length + '人');
  ids.forEach(function (id, i) { console.log((i + 1) + ': ' + id); });
}

/** 【本番送信用】エディタから手動で実行する。DELIVERY の条件に合う人へ、DELIVERY の本文を送信する。 */
function sendToElementaryTargets() {
  sendToTargets_(DELIVERY.conditions, DELIVERY.text);
}

/** 条件に合う登録者を抽出し、テキストを一括送信する。対象が0人なら送信しない。 */
function sendToTargets_(conditions, text) {
  const ids = findUserIds_(conditions);
  console.log('条件: ' + JSON.stringify(conditions));
  console.log('対象人数: ' + ids.length + '人');
  if (ids.length === 0) {
    console.log('対象者がいないため、送信していません。');
    return;
  }
  sendMulticast_(ids, text);
}

/**
 * LINEユーザーIDの一覧へ、multicast でテキストを一括送信する。
 * 重複と不正なIDを取り除き、上限人数ごとに分割して送る。途中で失敗したら、そこで中止する。
 * @return {{sent: number, failed: number, responses: Array<{status: number, body: string}>}}
 *   送信できた人数、送信できなかった人数、分割送信ごとのAPIレスポンス
 */
function sendMulticast_(userIds, text) {
  if (!text || !String(text).trim()) throw new Error('本文が空です。送信していません。');
  return sendMulticastMessages_(userIds, [{ type: 'text', text: String(text) }]);
}

/**
 * sendMulticast_ の本体。テキスト以外(画像など)も送れるよう、メッセージの配列を受け取る。
 * @param {string[]} userIds
 * @param {Object[]} messages Messaging API のメッセージオブジェクト(1〜5件)。配列の順に届く。
 */
function sendMulticastMessages_(userIds, messages) {
  const token = PropertiesService.getScriptProperties().getProperty('LINE_MESSAGING_CHANNEL_ACCESS_TOKEN');
  if (!token) throw new Error('スクリプトプロパティ LINE_MESSAGING_CHANNEL_ACCESS_TOKEN が設定されていません。送信していません。');
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 5) throw new Error('送信するメッセージが正しくありません。送信していません。');

  const valid = [];
  let invalidCount = 0;
  let duplicateCount = 0;
  userIds.forEach(function (value) {
    const id = String(value).trim();
    if (!/^U[0-9a-f]{32}$/.test(id)) invalidCount++;
    else if (valid.indexOf(id) !== -1) duplicateCount++;
    else valid.push(id);
  });
  if (invalidCount || duplicateCount) {
    console.log('除外: 不正なID ' + invalidCount + '件、重複 ' + duplicateCount + '件');
  }
  if (valid.length === 0) {
    console.log('送信できる宛先がないため、送信していません。');
    return { sent: 0, failed: 0, responses: [] };
  }

  const batchCount = Math.ceil(valid.length / MULTICAST_MAX_RECIPIENTS);
  console.log('送信人数: ' + valid.length + '人(' + batchCount + '回に分けて送信)');

  let sent = 0;
  const responses = [];
  for (let i = 0; i < batchCount; i++) {
    const batch = valid.slice(i * MULTICAST_MAX_RECIPIENTS, (i + 1) * MULTICAST_MAX_RECIPIENTS);
    const res = UrlFetchApp.fetch(MULTICAST_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token.trim() },
      payload: JSON.stringify({ to: batch, messages: messages }),
      muteHttpExceptions: true,
    });
    const status = res.getResponseCode();
    responses.push({ status: status, body: res.getContentText() });
    console.log((i + 1) + '/' + batchCount + '回目(' + batch.length + '人) レスポンスコード: ' + status);
    if (status !== 200) {
      console.error('送信に失敗しました。エラー内容: ' + res.getContentText());
      console.error('ここで中止しました。送信済み: ' + sent + '人 / 未送信: ' + (valid.length - sent) + '人');
      return { sent: sent, failed: valid.length - sent, responses: responses };
    }
    sent += batch.length;
  }
  console.log('送信に成功しました。合計: ' + sent + '人');
  return { sent: sent, failed: 0, responses: responses };
}
