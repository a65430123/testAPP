// 登入畫面（HTML 表單，蓋在遊戲畫布上方）

import { NAME_MAX_LENGTH, validateName } from '@starmemory/shared';
import { login, type Session } from '../net/session';

const LAST_NAME_KEY = 'starmemory.lastName';

function loadLastName(): string {
  try {
    return localStorage.getItem(LAST_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveLastName(name: string): void {
  try {
    localStorage.setItem(LAST_NAME_KEY, name);
  } catch {
    // 無痕模式等情況下無法儲存，忽略即可
  }
}

/** 顯示登入畫面，登入成功後移除畫面並回傳連線資訊 */
export function showLogin(): Promise<Session> {
  const overlay = document.createElement('div');
  overlay.id = 'login';
  overlay.innerHTML = `
    <form class="login-box" autocomplete="off">
      <h1>星憶旅團</h1>
      <p>輸入角色名稱開始冒險</p>
      <input name="name" type="text" maxlength="${NAME_MAX_LENGTH}" placeholder="角色名稱" />
      <button type="submit">進入遊戲</button>
      <div class="login-error" role="alert"></div>
    </form>`;
  document.body.appendChild(overlay);

  const form = overlay.querySelector('form') as HTMLFormElement;
  const input = overlay.querySelector('input') as HTMLInputElement;
  const button = overlay.querySelector('button') as HTMLButtonElement;
  const errorBox = overlay.querySelector('.login-error') as HTMLDivElement;
  input.value = loadLastName();
  input.focus();

  return new Promise<Session>((resolve) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = input.value.trim();
      const invalid = validateName(name);
      if (invalid) {
        errorBox.textContent = invalid;
        return;
      }
      errorBox.textContent = '';
      button.disabled = true;
      button.textContent = '登入中…';
      login(name).then(
        (session) => {
          saveLastName(session.name);
          overlay.remove();
          resolve(session);
        },
        (err: unknown) => {
          errorBox.textContent = err instanceof Error ? err.message : '登入失敗';
          button.disabled = false;
          button.textContent = '進入遊戲';
        },
      );
    });
  });
}
