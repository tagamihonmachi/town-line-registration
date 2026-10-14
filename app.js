'use strict';

(function () {
  const config = window.APP_CONFIG || {};
  const REQUEST_TIMEOUT_MS = 30000;
  const REAUTH_FLAG = 'registration-reauth';

  // config.js がダミー値のままならLIFFを使わず、画面確認用のプレビュー表示にする
  const isPreview =
    !config.LIFF_ID || !config.GAS_URL || /x{4,}/i.test(config.LIFF_ID) || /X{8,}/.test(config.GAS_URL);

  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const submitButton = $('submit');
  let submitting = false;

  function showFatal(message) {
    $('loading').hidden = true;
    form.hidden = true;
    $('fatal').textContent = message;
    $('fatal').hidden = false;
  }

  function renderHanOptions() {
    const options = Array.isArray(config.HAN_OPTIONS) ? config.HAN_OPTIONS : [];
    const container = $('han-choices');
    for (const name of options) {
      const label = document.createElement('label');
      label.className = 'choice';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'han';
      input.value = name;
      const text = document.createElement('span');
      text.textContent = name;
      label.append(input, text);
      container.append(label);
    }
    return options.length > 0;
  }

  function isTokenFresh() {
    const decoded = liff.getDecodedIDToken();
    return Boolean(liff.getIDToken() && decoded && decoded.exp * 1000 > Date.now() + 10000);
  }

  // IDトークンの期限切れ時は、ログアウトして読み込み直すと新しいトークンが発行される
  function reauthenticate() {
    if (sessionStorage.getItem(REAUTH_FLAG)) {
      sessionStorage.removeItem(REAUTH_FLAG);
      showFatal('ログイン情報を更新できませんでした。この画面を一度閉じて、もう一度開いてください。');
      return;
    }
    sessionStorage.setItem(REAUTH_FLAG, '1');
    liff.logout();
    location.reload();
  }

  async function initLiff() {
    await liff.init({ liffId: config.LIFF_ID });
    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: location.href });
      return false;
    }
    if (!isTokenFresh()) {
      reauthenticate();
      return false;
    }
    sessionStorage.removeItem(REAUTH_FLAG);
    return true;
  }

  function setFieldError(name, message) {
    const field = $('field-' + name);
    const error = $('error-' + name);
    field.classList.toggle('has-error', Boolean(message));
    error.textContent = message || '';
    error.hidden = !message;
  }

  function setFormError(message) {
    $('form-error').textContent = message || '';
    $('form-error').hidden = !message;
  }

  function readAnswers() {
    const data = new FormData(form);
    return {
      age: data.get('age') || '',
      han: data.get('han') || '',
      household: data.getAll('household'),
    };
  }

  function validate(answers) {
    const errors = {
      age: answers.age ? '' : '年代を1つ選んでください。',
      han: answers.han ? '' : '班を1つ選んでください。',
    };
    setFieldError('age', errors.age);
    setFieldError('han', errors.han);

    const firstInvalid = Object.keys(errors).find((name) => errors[name]);
    if (!firstInvalid) {
      setFormError('');
      return true;
    }
    setFormError('まだ選ばれていない項目があります。赤い枠の項目を確認してください。');
    $('field-' + firstInvalid).scrollIntoView({ behavior: 'smooth', block: 'start' });
    return false;
  }

  async function postToServer(payload, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || REQUEST_TIMEOUT_MS);
    try {
      // text/plain で送るとプリフライトが発生せず、Apps Script がそのまま受け取れる
      const res = await fetch(config.GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function showDone(updated) {
    form.hidden = true;
    $('done-note').textContent = updated ? '登録内容を更新しました。' : '';
    $('done').hidden = false;
    $('close').hidden = isPreview || !liff.isInClient();
    $('done-title').focus();
    window.scrollTo(0, 0);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const answers = readAnswers();
    if (!validate(answers)) return;

    if (isPreview) {
      showDone(false);
      return;
    }
    if (!isTokenFresh()) {
      reauthenticate();
      return;
    }

    submitting = true;
    submitButton.disabled = true;
    submitButton.textContent = '送信中です…';

    let completed = false;
    try {
      const result = await postToServer({ idToken: liff.getIDToken(), ...answers });
      if (result.ok) {
        completed = true;
        showDone(result.updated);
      } else if (result.code === 'TOKEN_EXPIRED') {
        reauthenticate();
        return;
      } else {
        setFormError(result.message || '登録できませんでした。時間をおいてもう一度お試しください。');
      }
    } catch (err) {
      setFormError('通信に失敗しました。電波の良い場所で、もう一度「登録する」を押してください。');
    } finally {
      if (!completed) {
        submitting = false;
        submitButton.disabled = false;
        submitButton.textContent = '登録する';
      }
    }
  }

  function check(name, value) {
    const input = Array.from(form.elements[name] instanceof RadioNodeList ? form.elements[name] : [form.elements[name]])
      .find((element) => element && element.value === value);
    if (input) input.checked = true;
    return Boolean(input);
  }

  // 登録済みの人には、前回の内容を選んだ状態で表示する。取得できなくても、空のフォームでそのまま使える。
  async function loadRegistration() {
    $('loading').textContent = '登録内容を確認しています…';
    try {
      const result = await postToServer({ action: 'get', idToken: liff.getIDToken() }, 15000);
      const saved = result && result.ok && result.registration;
      if (!saved) return;
      check('age', saved.age);
      check('han', saved.han);
      (saved.household || []).forEach((value) => check('household', value));
      $('lead').textContent = '前回の登録内容を表示しています。変更したい項目を選び直して、いちばん下の「登録する」を押してください。';
    } catch (err) {
      // 前回の内容が表示できないだけなので、何もしない
    }
  }

  async function main() {
    if (!renderHanOptions()) {
      showFatal('設定に問題があります(班の選択肢がありません)。管理者にお知らせください。');
      return;
    }

    if (isPreview) {
      $('preview-banner').hidden = false;
    } else {
      try {
        if (!(await initLiff())) return;
        await loadRegistration();
      } catch (err) {
        showFatal('画面を開けませんでした。LINEアプリからもう一度開いてください。');
        return;
      }
    }

    form.addEventListener('submit', handleSubmit);
    form.addEventListener('change', (event) => {
      if (event.target.name === 'age' || event.target.name === 'han') setFieldError(event.target.name, '');
    });
    $('close').addEventListener('click', () => liff.closeWindow());

    $('loading').hidden = true;
    form.hidden = false;
  }

  main();
})();
