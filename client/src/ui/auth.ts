// 登入／註冊畫面（HTML 表單，蓋在遊戲畫布上方）

import {
  PASSWORD_MAX_LENGTH,
  USERNAME_MAX_LENGTH,
  validatePassword,
  validateUsername,
} from '@starmemory/shared';
import { login, register, type Auth } from '../net/session';

type Mode = 'login' | 'register';

/** 顯示登入／註冊畫面，成功後移除畫面並回傳帳號憑證 */
export function showAuth(): Promise<Auth> {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <form class="panel" autocomplete="on">
      <h1>星憶旅團</h1>
      <div class="tabs">
        <button type="button" data-mode="login" class="active">登入</button>
        <button type="button" data-mode="register">註冊</button>
      </div>
      <input name="username" type="text" maxlength="${USERNAME_MAX_LENGTH}" placeholder="帳號（英數與底線）" autocomplete="username" />
      <input name="password" type="password" maxlength="${PASSWORD_MAX_LENGTH}" placeholder="密碼（至少 8 個字元）" autocomplete="current-password" />
      <input name="confirm" type="password" maxlength="${PASSWORD_MAX_LENGTH}" placeholder="再輸入一次密碼" autocomplete="new-password" hidden />
      <button type="submit" class="primary">登入</button>
      <div class="error" role="alert"></div>
    </form>`;
  document.body.appendChild(overlay);

  const form = overlay.querySelector('form') as HTMLFormElement;
  const username = form.elements.namedItem('username') as HTMLInputElement;
  const password = form.elements.namedItem('password') as HTMLInputElement;
  const confirm = form.elements.namedItem('confirm') as HTMLInputElement;
  const submit = form.querySelector('button.primary') as HTMLButtonElement;
  const errorBox = form.querySelector('.error') as HTMLDivElement;
  const tabs = [...form.querySelectorAll<HTMLButtonElement>('.tabs button')];

  let mode: Mode = 'login';
  const setMode = (next: Mode): void => {
    mode = next;
    for (const tab of tabs) {
      tab.classList.toggle('active', tab.dataset.mode === mode);
    }
    confirm.hidden = mode === 'login';
    password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    submit.textContent = mode === 'login' ? '登入' : '註冊';
    errorBox.textContent = '';
  };
  for (const tab of tabs) {
    tab.addEventListener('click', () => setMode(tab.dataset.mode as Mode));
  }
  username.focus();

  return new Promise<Auth>((resolve) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = username.value.trim();
      // 註冊時先在本機檢查格式；登入時交給伺服器判斷，避免洩漏規則以外的資訊
      let invalid: string | null = null;
      if (mode === 'register') {
        invalid = validateUsername(name) ?? validatePassword(password.value);
        if (!invalid && password.value !== confirm.value) {
          invalid = '兩次輸入的密碼不一致';
        }
      } else if (!name || !password.value) {
        invalid = '請輸入帳號與密碼';
      }
      if (invalid) {
        errorBox.textContent = invalid;
        return;
      }
      errorBox.textContent = '';
      submit.disabled = true;
      const action = mode === 'login' ? login(name, password.value) : register(name, password.value);
      action.then(
        (auth) => {
          overlay.remove();
          resolve({ token: auth.token, username: auth.username });
        },
        (err: unknown) => {
          errorBox.textContent = err instanceof Error ? err.message : '發生錯誤';
          submit.disabled = false;
        },
      );
    });
  });
}
