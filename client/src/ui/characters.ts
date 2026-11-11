// 選角／建立角色畫面（HTML，蓋在遊戲畫布上方）

import { CLASSES, getClassDef, NAME_MAX_LENGTH, validateName, type CharacterSummary } from '@starmemory/shared';
import { mapDisplayName } from '../assets';
import { ApiError, createCharacter, fetchCharacters, type Auth } from '../net/session';

/** 建立元素的小工具：文字一律用 textContent 設定，避免把玩家取的名字當成 HTML */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/**
 * 顯示選角畫面。
 * @returns 玩家選擇的角色；選擇登出或憑證已失效時回傳 'logout'
 */
export function showCharacterSelect(auth: Auth): Promise<CharacterSummary | 'logout'> {
  const overlay = el('div', 'overlay');
  const panel = el('div', 'panel wide');
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  return new Promise((resolve) => {
    const finish = (result: CharacterSummary | 'logout'): void => {
      overlay.remove();
      resolve(result);
    };

    const render = (characters: CharacterSummary[], maxCharacters: number, error = ''): void => {
      panel.replaceChildren();
      panel.appendChild(el('h1', undefined, '選擇角色'));
      panel.appendChild(el('p', undefined, `帳號：${auth.username}`));

      // 已有的角色
      const list = el('div', 'char-list');
      for (const character of characters) {
        const card = el('button', 'char-card');
        card.type = 'button';
        card.appendChild(el('strong', undefined, character.name));
        card.appendChild(
          el('span', undefined, `Lv.${character.level} ${getClassDef(character.classId)?.name ?? character.classId}`),
        );
        card.appendChild(el('span', 'muted', mapDisplayName(character.mapId)));
        card.addEventListener('click', () => finish(character));
        list.appendChild(card);
      }
      if (characters.length === 0) {
        list.appendChild(el('p', 'muted', '還沒有角色，請先建立一個。'));
      }
      panel.appendChild(list);

      // 建立新角色
      if (characters.length < maxCharacters) {
        const form = el('form', 'char-create');
        form.autocomplete = 'off';
        form.appendChild(el('h2', undefined, `建立新角色（${characters.length}/${maxCharacters}）`));
        const nameInput = el('input');
        nameInput.type = 'text';
        nameInput.maxLength = NAME_MAX_LENGTH;
        nameInput.placeholder = '角色名稱';
        form.appendChild(nameInput);

        const classBox = el('div', 'class-list');
        let selectedClass = CLASSES[0]!.id;
        const description = el('p', 'muted', CLASSES[0]!.description);
        for (const cls of CLASSES) {
          const button = el('button', cls.id === selectedClass ? 'active' : '', cls.name);
          button.type = 'button';
          button.addEventListener('click', () => {
            selectedClass = cls.id;
            description.textContent = cls.description;
            for (const other of classBox.children) {
              other.classList.toggle('active', other === button);
            }
          });
          classBox.appendChild(button);
        }
        form.appendChild(classBox);
        form.appendChild(description);

        const submit = el('button', 'primary', '建立角色');
        submit.type = 'submit';
        form.appendChild(submit);
        const errorBox = el('div', 'error', error);
        errorBox.setAttribute('role', 'alert');
        form.appendChild(errorBox);

        form.addEventListener('submit', (event) => {
          event.preventDefault();
          const name = nameInput.value.trim();
          const invalid = validateName(name);
          if (invalid) {
            errorBox.textContent = invalid;
            return;
          }
          submit.disabled = true;
          createCharacter(auth, name, selectedClass).then(
            () => void load(),
            (err: unknown) => {
              if (err instanceof ApiError && err.status === 401) {
                finish('logout');
                return;
              }
              errorBox.textContent = err instanceof Error ? err.message : '建立失敗';
              submit.disabled = false;
            },
          );
        });
        panel.appendChild(form);
      } else {
        panel.appendChild(el('p', 'muted', `角色數已達上限（${maxCharacters}）`));
      }

      const logout = el('button', 'link', '登出');
      logout.type = 'button';
      logout.addEventListener('click', () => finish('logout'));
      panel.appendChild(logout);
    };

    const load = async (): Promise<void> => {
      panel.replaceChildren(el('p', undefined, '讀取角色中…'));
      try {
        const data = await fetchCharacters(auth);
        render(data.characters, data.maxCharacters);
      } catch (err) {
        // 憑證失效（過期或伺服器重設金鑰）：回到登入畫面
        if (err instanceof ApiError && err.status === 401) {
          finish('logout');
          return;
        }
        panel.replaceChildren(
          el('p', 'error', err instanceof Error ? err.message : '讀取失敗'),
        );
        const retry = el('button', 'primary', '重試');
        retry.type = 'button';
        retry.addEventListener('click', () => void load());
        panel.appendChild(retry);
      }
    };
    void load();
  });
}
