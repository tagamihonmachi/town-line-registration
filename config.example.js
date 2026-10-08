// 設定ファイルの見本です。このファイルをコピーして config.js を作り、値を書き換えてください。
// ここに書く値はブラウザから誰でも見える「公開してよい値」だけです。
// Channel Secret やチャネルアクセストークンは絶対に書かないでください。
window.APP_CONFIG = {
  // LIFFアプリのID(LINE Developers > LINE Loginチャネル > LIFF)
  LIFF_ID: '0000000000-xxxxxxxx',

  // Google Apps Script ウェブアプリのURL(末尾が /exec のもの)
  GAS_URL: 'https://script.google.com/macros/s/XXXXXXXXXXXXXXXXXXXXXXXX/exec',

  // 「班」の選択肢。増減・名称変更はここを書き換えるだけで反映されます(各20文字以内)。
  HAN_OPTIONS: ['1班', '2班', '3班', '4班', '5班', '6班', '7班', '8班', '9班', '10班', '11班', '12班', '13班'],
};
