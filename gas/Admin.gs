/**
 * 町会LINE 配信管理画面(Admin.html)のサーバー側処理
 *
 * スクリプトプロパティ
 *   ADMIN_EMAILS       : この画面を使えるGoogleアカウントのメールアドレス(複数はカンマ区切り)
 *   ADMIN_LINE_USER_ID : 「自分にテスト送信」の宛先になる管理者のLINEユーザーID
 *   LINE_MESSAGING_CHANNEL_ACCESS_TOKEN : Messaging APIのチャネルアクセストークン(Code.gs と共通)
 *   LINE_IMAGE_FOLDER_ID : 配信画像を保存するGoogleドライブのフォルダID(画像を使う場合)
 *
 * 画面から呼ばれる関数(admin で始まるもの)は、必ず最初に requireAdmin_() で利用者を確認する。
 * 抽出は Code.gs の findUserIds_、送信は sendMulticastMessages_ をそのまま使う。
 * 画像を使う場合は、初回に checkImageFolder() を1回実行して、ドライブの権限を承認する。
 */

// 班の選択肢。フォーム側(config.js の HAN_OPTIONS)を変えたら、ここも同じ内容にする。
// ここに無い班名でも、登録者シートに存在すれば画面の選択肢に自動で追加される。
const ADMIN_HAN_OPTIONS = ['1班', '2班', '3班', '4班', '5班', '6班', '7班', '8班', '9班', '10班', '11班', '12班', '13班'];

const HISTORY_SHEET_NAME = '配信履歴';
const HISTORY_HEADERS = ['配信日時', '配信種別', '指定条件', '対象人数', 'メッセージ本文', '送信結果', 'Messaging APIレスポンス', '実行者',
  '画像数', '画像ファイル名', 'Google DriveファイルID'];
// 画像を1枚だけ送れた頃の、画像数の列の見出し
const HISTORY_LEGACY_IMAGE_HEADER = '画像';
// LINEのテキストメッセージ1通の上限
const MESSAGE_MAX_LENGTH = 5000;
const HISTORY_RESPONSE_MAX_LENGTH = 2000;
const USER_ID_PATTERN = /^U[0-9a-f]{32}$/;

// 画像。LINEの上限は本体10MB・プレビュー1MB(JPEGまたはPNG)。画面側で長辺 IMAGE_MAX_SIDE 以下のJPEGに変換してから受け取る。
// 1回の送信は5メッセージまでなので、画像は4枚まで(画像4枚+本文1件)
const IMAGE_MAX_COUNT = 4;
const MESSAGES_MAX_COUNT = 5;
const IMAGE_MAX_SIDE = 2048;
const IMAGE_PREVIEW_SIDE = 800;
const IMAGE_UPLOAD_MAX_BYTES = 3 * 1024 * 1024;
const IMAGE_REJECT_SIDE = 4096;
const LINE_ORIGINAL_MAX_BYTES = 10 * 1024 * 1024;
const LINE_PREVIEW_MAX_BYTES = 1024 * 1024;
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'];

// ---------------------------------------------------------------------------
// 利用者の確認
// ---------------------------------------------------------------------------

function activeEmail_() {
  return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
}

function adminEmails_() {
  const value = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS') || '';
  return value.split(/[\s,、;]+/).map(function (v) { return v.trim().toLowerCase(); }).filter(Boolean);
}

/** ログイン中のGoogleアカウントが ADMIN_EMAILS に含まれるときだけ true。確認できない場合は false。 */
function isAdmin_() {
  const email = activeEmail_();
  return Boolean(email) && adminEmails_().indexOf(email) !== -1;
}

function requireAdmin_() {
  if (!isAdmin_()) throw new Error('この操作を行う権限がありません。');
}

/** doGet から呼ばれる。管理者には画面を、それ以外には権限がない旨だけを返す。 */
function adminPage_() {
  if (!isAdmin_()) {
    const email = activeEmail_();
    const detail = email
      ? 'ログイン中のアカウント(' + email + ')は、管理者として登録されていません。'
      : 'ログイン中のGoogleアカウントを確認できませんでした。';
    const template = HtmlService.createTemplate(
      '<p style="font-family:sans-serif;padding:24px;line-height:1.8">この画面を利用する権限がありません。<br><?= detail ?></p>'
    );
    template.detail = detail;
    return template.evaluate().setTitle('町会LINE 配信管理');
  }
  return HtmlService.createHtmlOutputFromFile('Admin')
    .setTitle('町会LINE 配信管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---------------------------------------------------------------------------
// 画面から呼ばれる関数
// ---------------------------------------------------------------------------

/** 画面の初期表示に必要な選択肢と、設定の状態を返す。秘密の値は返さない。 */
function adminGetOptions() {
  requireAdmin_();
  const props = PropertiesService.getScriptProperties();
  return {
    ages: AGE_OPTIONS,
    hans: hanOptions_(),
    household: Object.values(HOUSEHOLD_OPTIONS),
    maxLength: MESSAGE_MAX_LENGTH,
    registered: findUserIds_({}).length,
    testReady: USER_ID_PATTERN.test(String(props.getProperty('ADMIN_LINE_USER_ID') || '').trim()),
    sendReady: Boolean(props.getProperty('LINE_MESSAGING_CHANNEL_ACCESS_TOKEN')),
    image: {
      ready: Boolean(String(props.getProperty('LINE_IMAGE_FOLDER_ID') || '').trim()),
      maxCount: IMAGE_MAX_COUNT,
      maxSide: IMAGE_MAX_SIDE,
      maxBytes: IMAGE_UPLOAD_MAX_BYTES,
    },
  };
}

/** 対象人数を確認する。送信は行わない。 */
function adminCountTargets(selection) {
  requireAdmin_();
  const normalized = normalizeSelection_(selection);
  const ids = resolveTargets_(normalized);
  const summary = describeSelection_(normalized);
  console.log('対象確認 条件: ' + summary + ' / 対象人数: ' + ids.length + '人');
  ids.forEach(function (id, i) { console.log((i + 1) + ': ' + id); });
  return { count: ids.length, summary: summary };
}

/**
 * 管理者1人(ADMIN_LINE_USER_ID)だけにテスト送信する。
 * @param {{text: string, images: Array<{fileId: string}>}|string} input 本文だけの文字列でも受け付ける
 */
function adminSendTest(input) {
  requireAdmin_();
  const content = normalizeContent_(input);
  const adminId = String(PropertiesService.getScriptProperties().getProperty('ADMIN_LINE_USER_ID') || '').trim();
  if (!USER_ID_PATTERN.test(adminId)) {
    throw new Error('スクリプトプロパティ ADMIN_LINE_USER_ID が正しく設定されていないため、テスト送信できません。');
  }
  return deliver_('テスト', '管理者1人(テスト送信)', [adminId], content);
}

/**
 * 本番送信。画面の確認画面で「送信する」を押したときだけ呼ばれる。
 * @param {{selection: Object, text: string, images: Array<{fileId: string}>, expectedCount: number, requestId: string}} request
 */
function adminSend(request) {
  requireAdmin_();
  const req = request || {};
  const normalized = normalizeSelection_(req.selection);
  const content = normalizeContent_({ text: req.text, images: req.images, image: req.image });
  const expectedCount = Number(req.expectedCount);
  const requestId = String(req.requestId || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId)) throw new Error('送信内容が正しくありません。画面を読み込み直してください。');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('ほかの処理が実行中です。少し待ってからもう一度お試しください。');
  try {
    // 同じ確認画面からの送信は1回だけ受け付ける(二重クリックや再送信の対策)
    const cache = CacheService.getScriptCache();
    const cacheKey = 'admin-send-' + requestId;
    if (cache.get(cacheKey)) throw new Error('この送信はすでに実行されています。二重送信を防ぐため中止しました。');

    const ids = resolveTargets_(normalized);
    if (ids.length === 0) throw new Error('対象者が0人のため、送信していません。');
    if (ids.length !== expectedCount) {
      throw new Error('対象人数が確認時(' + expectedCount + '人)から ' + ids.length + '人に変わっています。送信していません。もう一度「対象人数を確認」を押してください。');
    }
    cache.put(cacheKey, '1', 21600);
    return deliver_('本番', describeSelection_(normalized), ids, content);
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// 条件と本文
// ---------------------------------------------------------------------------

/** 登録者シートに実際に入っている値を、見出し名で指定した列から重複なしで取り出す。 */
function distinctColumnValues_(headerName) {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  const column = headers.indexOf(headerName);
  if (column === -1) return [];
  const values = [];
  sheet.getRange(2, column + 1, lastRow - 1, 1).getValues().forEach(function (row) {
    const value = String(row[0]).trim();
    if (value && values.indexOf(value) === -1) values.push(value);
  });
  return values;
}

function hanOptions_() {
  const options = ADMIN_HAN_OPTIONS.slice();
  distinctColumnValues_('班').forEach(function (value) {
    if (options.indexOf(value) === -1) options.push(value);
  });
  return options;
}

/** 画面から届いた条件を検証し、{ ages, hans, household } の形にそろえる。 */
function normalizeSelection_(selection) {
  const source = selection || {};
  const pick = function (values, allowed, label) {
    if (values === undefined || values === null) return [];
    if (!Array.isArray(values)) throw new Error(label + 'の指定が正しくありません。');
    const result = [];
    values.forEach(function (value) {
      if (allowed.indexOf(value) === -1) throw new Error(label + 'の指定が正しくありません。画面を読み込み直してください。');
      if (result.indexOf(value) === -1) result.push(value);
    });
    return result;
  };
  return {
    ages: pick(source.ages, AGE_OPTIONS, '年代'),
    hans: pick(source.hans, hanOptions_(), '班'),
    household: pick(source.household, Object.values(HOUSEHOLD_OPTIONS), '世帯属性'),
  };
}

function describeSelection_(normalized) {
  const parts = [];
  if (normalized.ages.length) parts.push('年代: ' + normalized.ages.join('・'));
  if (normalized.hans.length) parts.push('班: ' + normalized.hans.join('・'));
  if (normalized.household.length) parts.push('世帯属性: ' + normalized.household.join('・'));
  return parts.length ? parts.join(' / ') : '全登録者';
}

/**
 * 条件に合うLINEユーザーIDを返す。
 * 同じ項目の中は「どれか」、項目どうしは「すべて」。何も指定しなければ全登録者。
 */
function resolveTargets_(normalized) {
  const base = {};
  if (normalized.ages.length) base['年代'] = normalized.ages;
  if (normalized.hans.length) base['班'] = normalized.hans;
  if (normalized.household.length === 0) return findUserIds_(base);

  // 世帯属性は列が分かれているので、列ごとに抽出して合わせる(どれかに○がある世帯)
  const ids = [];
  normalized.household.forEach(function (header) {
    const conditions = Object.assign({}, base);
    conditions[header] = CHECK_MARK;
    findUserIds_(conditions).forEach(function (id) {
      if (ids.indexOf(id) === -1) ids.push(id);
    });
  });
  return ids;
}

/**
 * 画面から届いた本文と画像の指定を検証し、{ text, images } の形にそろえる。
 * 本文と画像のどちらか一方は必須。画像は { fileId } の配列で、IMAGE_MAX_COUNT 枚まで。配列の順に送信する。
 * 画像の実体の確認は、送信直前に resolveImage_ が行う。
 */
function normalizeContent_(input) {
  const source = typeof input === 'string' ? { text: input } : (input || {});
  const rawText = source.text === undefined || source.text === null ? '' : source.text;
  if (typeof rawText !== 'string') throw new Error('メッセージ本文が正しくありません。');
  const text = rawText.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  const hasText = Boolean(text.trim());
  if (text.length > MESSAGE_MAX_LENGTH) throw new Error('メッセージ本文が長すぎます(' + MESSAGE_MAX_LENGTH + '文字まで)。');

  // 画像1枚だけの頃の指定方法({ image: { fileId } })も受け付ける
  let list = source.images;
  if (list === undefined || list === null) list = source.image ? [source.image] : [];
  if (!Array.isArray(list)) throw new Error('画像の指定が正しくありません。画像を選び直してください。');
  if (list.length > IMAGE_MAX_COUNT) throw new Error('画像は最大' + IMAGE_MAX_COUNT + '枚までです。送信していません。');
  const images = list.map(function (item) {
    const fileId = String((item && item.fileId) || '');
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(fileId)) throw new Error('画像の指定が正しくありません。画像を選び直してください。');
    return { fileId: fileId };
  });

  if (!hasText && images.length === 0) throw new Error('メッセージ本文と画像がどちらも空のため、送信していません。');
  return { text: hasText ? text : '', images: images };
}

// ---------------------------------------------------------------------------
// 送信と配信履歴
// ---------------------------------------------------------------------------

/**
 * 送信して、結果を配信履歴に記録する。成功・失敗・例外のどの場合も記録する。
 * 画像は、全部がLINEから取得できることを送信の直前に確認し、1枚でも確認できなければ送信しない。
 * 画像1、画像2、…、本文の順に届く。
 * @param {{text: string, images: Array<{fileId: string}>}} content normalizeContent_ の戻り値
 */
function deliver_(type, summary, userIds, content) {
  let outcome;
  const resolved = [];
  try {
    content.images.forEach(function (item, i) {
      try {
        resolved.push(resolveImage_(item.fileId));
      } catch (err) {
        throw new Error('画像' + (i + 1) + ': ' + err.message);
      }
    });
    const messages = resolved.map(function (image) {
      return { type: 'image', originalContentUrl: image.urls.original, previewImageUrl: image.urls.preview };
    });
    if (content.text) messages.push({ type: 'text', text: content.text });
    if (messages.length > MESSAGES_MAX_COUNT) throw new Error('1回に送れるのは' + MESSAGES_MAX_COUNT + '件までです。送信していません。');

    const result = sendMulticastMessages_(userIds, messages);
    const apiResponse = result.responses.map(function (r, i) { return (i + 1) + '回目: ' + r.status + ' ' + r.body; }).join('\n');
    if (result.failed === 0 && result.sent > 0) {
      outcome = { ok: true, label: '成功(' + result.sent + '人)', message: result.sent + '人に送信しました。', apiResponse: apiResponse };
    } else if (result.sent > 0) {
      outcome = {
        ok: false,
        label: '一部失敗(送信済み ' + result.sent + '人 / 未送信 ' + result.failed + '人)',
        message: '途中で失敗しました。送信済み ' + result.sent + '人 / 未送信 ' + result.failed + '人。配信履歴を確認してください。',
        apiResponse: apiResponse,
      };
    } else {
      outcome = { ok: false, label: '失敗(送信 0人)', message: '送信に失敗しました。誰にも送信されていません。配信履歴を確認してください。', apiResponse: apiResponse };
    }
  } catch (err) {
    outcome = { ok: false, label: 'エラー', message: '送信できませんでした: ' + err.message, apiResponse: String(err.message) };
  }

  try {
    const imageRecords = content.images.map(function (item, i) {
      return { name: resolved[i] ? resolved[i].name : '(確認できませんでした)', fileId: item.fileId };
    });
    recordHistory_(type, summary, userIds.length, content.text, outcome.label, outcome.apiResponse, imageRecords);
  } catch (err) {
    console.error('配信履歴の記録に失敗しました: ' + err.message);
    outcome.message += '(配信履歴の記録に失敗しました)';
  }
  return { ok: outcome.ok, message: outcome.message };
}

/** 先頭が = + - @ の文字列が、スプレッドシートで数式として扱われないようにする。 */
function safeCell_(value) {
  const text = String(value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

/**
 * @param {Array<{name: string, fileId: string}>} imageRecords 送信した順の画像。画像なしは空の配列。
 *   ファイル名とファイルIDは、1つのセルに改行区切りで記録する。
 */
function recordHistory_(type, summary, count, body, resultLabel, apiResponse, imageRecords) {
  const spreadsheet = getSheet_().getParent();
  let sheet = spreadsheet.getSheetByName(HISTORY_SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(HISTORY_SHEET_NAME);
  const imageColumn = HISTORY_HEADERS.indexOf('画像数') + 1;
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HISTORY_HEADERS.length).setValues([HISTORY_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange(2, 1, sheet.getMaxRows() - 1, 1).setNumberFormat('yyyy/mm/dd hh:mm:ss');
  } else if (sheet.getLastColumn() < HISTORY_HEADERS.length) {
    // 画像の列が無い古い履歴シートには、右側に見出しを足す(既存の列と行はそのまま)
    const from = sheet.getLastColumn() + 1;
    sheet.getRange(1, from, 1, HISTORY_HEADERS.length - from + 1).setValues([HISTORY_HEADERS.slice(from - 1)]).setFontWeight('bold');
  } else if (String(sheet.getRange(1, imageColumn, 1, 1).getValues()[0][0]).trim() === HISTORY_LEGACY_IMAGE_HEADER) {
    // 見出しだけを「画像」から「画像数」に直す。過去の行(あり / なし)は書き換えない。
    sheet.getRange(1, imageColumn, 1, 1).setValues([['画像数']]);
  }
  const images = imageRecords || [];
  sheet.appendRow([
    new Date(),
    type,
    safeCell_(summary),
    count,
    safeCell_(body),
    safeCell_(resultLabel),
    safeCell_(String(apiResponse || '').slice(0, HISTORY_RESPONSE_MAX_LENGTH)),
    activeEmail_() || '(確認できません)',
    images.length,
    safeCell_(images.map(function (image) { return image.name; }).join('\n')),
    safeCell_(images.map(function (image) { return image.fileId; }).join('\n')),
  ]);
}

// ---------------------------------------------------------------------------
// 画像
// ---------------------------------------------------------------------------

/** 初回に1回だけ手動で実行する。ドライブの権限を承認し、画像の保存先フォルダを確認する。 */
function checkImageFolder() {
  const folder = imageFolder_();
  console.log('画像の保存先: ' + folder.getName() + ' / ' + folder.getUrl());
}

function imageFolder_() {
  const folderId = String(PropertiesService.getScriptProperties().getProperty('LINE_IMAGE_FOLDER_ID') || '').trim();
  if (!folderId) throw new Error('スクリプトプロパティ LINE_IMAGE_FOLDER_ID が設定されていません。');
  try {
    return DriveApp.getFolderById(folderId);
  } catch (err) {
    throw new Error('画像の保存先フォルダ(LINE_IMAGE_FOLDER_ID)を開けません。フォルダIDを確認してください。');
  }
}

/**
 * ドライブのファイルを、LINEのサーバーが画像として直接取得できるURLにする。
 * 通常の共有URL(drive.google.com/file/d/.../view)はHTMLのページなので使えない。
 * 配信方法を変えるとき(別の保存先にするなど)は、この関数だけを差し替える。
 */
function imageUrls_(fileId) {
  const base = 'https://lh3.googleusercontent.com/d/' + encodeURIComponent(fileId);
  return { original: base + '=s' + IMAGE_MAX_SIDE, preview: base + '=s' + IMAGE_PREVIEW_SIDE };
}

/** 画像データの先頭を見て、形式と大きさを調べる。JPEG・PNG以外は null。 */
function detectImage_(bytes) {
  const u = function (i) { return bytes[i] & 0xff; };
  const length = bytes.length;
  if (length > 24 && u(0) === 0x89 && u(1) === 0x50 && u(2) === 0x4e && u(3) === 0x47 && u(4) === 0x0d && u(5) === 0x0a && u(6) === 0x1a && u(7) === 0x0a) {
    return {
      mime: 'image/png',
      extension: 'png',
      width: u(16) * 16777216 + u(17) * 65536 + u(18) * 256 + u(19),
      height: u(20) * 16777216 + u(21) * 65536 + u(22) * 256 + u(23),
    };
  }
  if (length > 4 && u(0) === 0xff && u(1) === 0xd8) {
    let offset = 2;
    while (offset + 9 < length) {
      if (u(offset) !== 0xff) { offset++; continue; }
      const marker = u(offset + 1);
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }
      // SOF0〜SOF15(DHT・JPG・DAC を除く)に画像の大きさが入っている
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: 'image/jpeg', extension: 'jpg', height: u(offset + 5) * 256 + u(offset + 6), width: u(offset + 7) * 256 + u(offset + 8) };
      }
      offset += 2 + u(offset + 2) * 256 + u(offset + 3);
    }
  }
  return null;
}

/** URLが、指定サイズ以下のJPEGまたはPNGとして、ログインなしで取得できるかを確認する。 */
function checkImageUrl_(url, maxBytes) {
  let res;
  try {
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (err) {
    return '取得できませんでした(' + err.message + ')';
  }
  const status = res.getResponseCode();
  if (status !== 200) return 'レスポンスコード ' + status;
  const headers = res.getHeaders();
  const typeKey = Object.keys(headers).filter(function (key) { return key.toLowerCase() === 'content-type'; })[0];
  const contentType = String(typeKey ? headers[typeKey] : '').split(';')[0].trim().toLowerCase();
  if (IMAGE_MIME_TYPES.indexOf(contentType) === -1) return '画像として返されませんでした(' + (contentType || '種類不明') + ')';
  const bytes = res.getContent();
  if (!detectImage_(bytes)) return '画像として返されませんでした';
  if (bytes.length > maxBytes) return 'ファイルサイズが大きすぎます(' + Math.ceil(bytes.length / 1024) + 'KB)';
  return '';
}

/**
 * 画像の本体とプレビューのURLが、LINEの条件を満たして取得できるかを確認する。
 * 共有設定が反映されるまで少し時間がかかることがあるため、数回まで試す。
 * @return {string} 問題がなければ空文字。問題があればその内容。
 */
function verifyImageUrls_(fileId, attempts) {
  const urls = imageUrls_(fileId);
  let problem = '';
  for (let i = 0; i < attempts; i++) {
    if (i > 0) Utilities.sleep(2000);
    problem = checkImageUrl_(urls.original, LINE_ORIGINAL_MAX_BYTES) || checkImageUrl_(urls.preview, LINE_PREVIEW_MAX_BYTES);
    if (!problem) return '';
  }
  return problem;
}

/**
 * 画面で選んだ画像を検査してドライブの専用フォルダに保存し、LINEから取得できることを確認する。
 * 確認できなかった画像は使わせない(保存したファイルはゴミ箱に移す)。
 * @param {{base64: string, name: string}} upload 画面側でJPEGに変換した画像(Base64)と、元のファイル名
 */
function adminUploadImage(upload) {
  requireAdmin_();
  const source = upload || {};
  if (typeof source.base64 !== 'string' || !source.base64) throw new Error('画像を受け取れませんでした。もう一度選び直してください。');
  if (source.base64.length > IMAGE_UPLOAD_MAX_BYTES * 1.4) throw new Error('画像のファイルサイズが大きすぎます。');

  let bytes;
  try {
    bytes = Utilities.base64Decode(source.base64);
  } catch (err) {
    throw new Error('画像を受け取れませんでした。もう一度選び直してください。');
  }
  if (bytes.length > IMAGE_UPLOAD_MAX_BYTES) throw new Error('画像のファイルサイズが大きすぎます。');
  const info = detectImage_(bytes);
  if (!info) throw new Error('JPEGまたはPNGの画像だけを使えます。');
  if (info.width < 1 || info.height < 1 || info.width > IMAGE_REJECT_SIDE || info.height > IMAGE_REJECT_SIDE) {
    throw new Error('画像の大きさが正しくありません(縦横 ' + IMAGE_REJECT_SIDE + 'px まで)。');
  }

  const folder = imageFolder_();
  const baseName = String(source.name || '').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 40) || 'image';
  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd-HHmmss');
  const fileName = stamp + '-' + Utilities.getUuid().slice(0, 4) + '_' + baseName + '.' + info.extension;

  const file = folder.createFile(Utilities.newBlob(bytes, info.mime, fileName));
  let problem;
  try {
    // LINEのサーバーはログインできないので、リンクを知っていれば見られる設定にする
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    problem = verifyImageUrls_(file.getId(), 5);
  } catch (err) {
    problem = err.message;
  }
  if (problem) {
    file.setTrashed(true);
    console.error('画像URLの確認に失敗: ' + problem);
    throw new Error('画像を保存しましたが、LINEから取得できる状態にできませんでした(' + problem + ')。この画像は使えません。');
  }
  console.log('画像を保存しました: ' + fileName + ' / ' + file.getId());
  return { fileId: file.getId(), name: fileName, url: imageUrls_(file.getId()).original };
}

/**
 * 送信に使う画像を確認する。専用フォルダにある画像で、LINEから取得できる場合だけ通す。
 * @return {{fileId: string, name: string, urls: {original: string, preview: string}}}
 */
function resolveImage_(fileId) {
  const folderId = imageFolder_().getId();
  let file;
  try {
    file = DriveApp.getFileById(fileId);
  } catch (err) {
    throw new Error('画像ファイルが見つかりません。画像を選び直してください。');
  }
  let inFolder = false;
  const parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === folderId) inFolder = true;
  }
  if (!inFolder || file.isTrashed() || IMAGE_MIME_TYPES.indexOf(file.getMimeType()) === -1) {
    throw new Error('この画像は配信に使えません。画像を選び直してください。');
  }
  const problem = verifyImageUrls_(fileId, 2);
  if (problem) throw new Error('画像をLINEから取得できる状態か確認できませんでした(' + problem + ')。送信していません。');
  return { fileId: fileId, name: file.getName(), urls: imageUrls_(fileId) };
}
