/**
 * 町会LINE 利用者登録フォームのバックエンド(Google Apps Script)
 *
 * スクリプトプロパティ(プロジェクトの設定 > スクリプト プロパティ)
 *   LINE_LOGIN_CHANNEL_ID : LINE LoginチャネルのチャネルID(必須)
 *   SPREADSHEET_ID        : 保存先スプレッドシートのID(スプレッドシートから作成したスクリプトなら不要)
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

// ブラウザでURLを開いたときの動作確認用
function doGet() {
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
