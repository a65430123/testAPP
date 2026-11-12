// 管理後台（獨立頁面 /admin.html）：線上人數、查帳號、封鎖、發道具、公告、安全事件、操作紀錄。
// 所有操作都呼叫 /api/admin/*，權限由伺服器判斷；這個頁面本身不含任何機密。

import {
  DEFAULT_SERVER_PORT,
  EQUIP_SLOT_NAME,
  EQUIP_SLOTS,
  getClassDef,
  getItemDef,
  itemDisplayName,
  ITEMS,
  type InventoryItem,
} from '@starmemory/shared';

const SERVER_URL: string =
  import.meta.env.VITE_SERVER_URL ?? `${location.protocol}//${location.hostname}:${DEFAULT_SERVER_PORT}`;
const TOKEN_KEY = 'starmemory.admin.token';

// ------------------------------------------------------------ 小工具

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function button(label: string, onClick: () => void, className?: string): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function formatTime(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString('zh-TW', { hour12: false }) : '—';
}

/** 建立表格；每一格可以是文字或元素 */
function table(headers: string[], rows: Array<Array<string | Node>>): HTMLElement {
  const wrap = el('div', 'scroll');
  const t = el('table');
  const head = el('tr');
  for (const h of headers) {
    head.appendChild(el('th', undefined, h));
  }
  t.appendChild(head);
  for (const row of rows) {
    const tr = el('tr');
    for (const cell of row) {
      const td = el('td');
      td.append(cell);
      tr.appendChild(td);
    }
    t.appendChild(tr);
  }
  if (rows.length === 0) {
    const tr = el('tr');
    const td = el('td', 'muted', '沒有資料');
    td.colSpan = headers.length;
    tr.appendChild(td);
    t.appendChild(tr);
  }
  wrap.appendChild(t);
  return wrap;
}

let token = sessionStorage.getItem(TOKEN_KEY) ?? '';
let staff: { username: string; role: string } | null = null;

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, '無法連線到伺服器');
  }
  const data = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || data === null) {
    throw new ApiError(response.status, data?.error ?? `伺服器回應錯誤（${response.status}）`);
  }
  return data;
}

const app = document.getElementById('app') as HTMLDivElement;

// ------------------------------------------------------------ 登入

function renderLogin(message = ''): void {
  staff = null;
  if (refreshTimer) {
    window.clearInterval(refreshTimer);
  }
  const form = el('form', 'card login');
  form.appendChild(el('h2', undefined, '星憶旅團 管理後台'));
  const username = el('input');
  username.placeholder = '帳號';
  username.autocomplete = 'username';
  const password = el('input');
  password.type = 'password';
  password.placeholder = '密碼';
  password.autocomplete = 'current-password';
  const submit = el('button', 'primary', '登入');
  submit.type = 'submit';
  const note = el('div', 'message', message);
  form.append(username, password, submit, note);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit.disabled = true;
    void (async () => {
      try {
        const auth = await api<{ token: string }>('POST', '/api/login', { username: username.value.trim(), password: password.value });
        token = auth.token;
        staff = await api<{ username: string; role: string }>('GET', '/api/admin/me');
        sessionStorage.setItem(TOKEN_KEY, token);
        renderShell();
      } catch (err) {
        token = '';
        note.textContent = err instanceof Error ? err.message : '登入失敗';
        submit.disabled = false;
      }
    })();
  });
  app.replaceChildren(form);
  username.focus();
}

// ------------------------------------------------------------ 外框與分頁

type Tab = 'overview' | 'accounts' | 'announce' | 'events' | 'log';
const TABS: Array<[Tab, string]> = [
  ['overview', '總覽'],
  ['accounts', '帳號'],
  ['announce', '公告'],
  ['events', '安全事件'],
  ['log', '操作紀錄'],
];
let currentTab: Tab = 'overview';
let refreshTimer = 0;
let content: HTMLElement;

function renderShell(): void {
  const header = el('header');
  header.appendChild(el('h1', undefined, '星憶旅團 管理後台'));
  const nav = el('nav');
  for (const [tab, label] of TABS) {
    nav.appendChild(button(label, () => showTab(tab), tab === currentTab ? 'active' : undefined));
  }
  header.appendChild(nav);
  header.appendChild(el('span', 'who', `${staff?.username}（${staff?.role === 'admin' ? '管理員' : 'GM'}）`));
  header.appendChild(
    button('登出', () => {
      token = '';
      sessionStorage.removeItem(TOKEN_KEY);
      renderLogin();
    }),
  );
  content = el('main');
  app.replaceChildren(header, content);
  showTab(currentTab);
}

function showTab(tab: Tab): void {
  currentTab = tab;
  if (refreshTimer) {
    window.clearInterval(refreshTimer);
    refreshTimer = 0;
  }
  app.querySelectorAll('nav button').forEach((b, index) => b.classList.toggle('active', TABS[index]?.[0] === tab));
  const render = { overview: renderOverview, accounts: renderAccounts, announce: renderAnnounce, events: renderEvents, log: renderLog }[tab];
  run(render);
}

/** 執行一個會呼叫 API 的畫面函式；權限失效時回到登入畫面，其他錯誤顯示在畫面上 */
function run(action: () => Promise<void>): void {
  action().catch((err: unknown) => {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      sessionStorage.removeItem(TOKEN_KEY);
      renderLogin(err.message);
      return;
    }
    content.replaceChildren(el('div', 'card message', err instanceof Error ? err.message : '發生錯誤'));
  });
}

// ------------------------------------------------------------ 總覽

interface Overview {
  online: number;
  maps: Array<{ mapId: string; name: string; count: number }>;
  players: Array<{ characterId: number; name: string; level: number; mapId: string }>;
  uptimeSec: number;
  memoryMb: number;
}

async function renderOverview(): Promise<void> {
  const draw = async (): Promise<void> => {
    const data = await api<Overview>('GET', '/api/admin/overview');
    const stats = el('div', 'stats');
    const stat = (value: string, label: string): void => {
      const box = el('div', 'stat');
      box.append(el('b', undefined, value), el('span', undefined, label));
      stats.appendChild(box);
    };
    stat(String(data.online), '線上人數');
    stat(`${Math.floor(data.uptimeSec / 3600)} 時 ${Math.floor((data.uptimeSec % 3600) / 60)} 分`, '已運作');
    stat(`${data.memoryMb} MB`, '記憶體');

    const maps = el('div', 'card');
    maps.appendChild(el('h2', undefined, '各地圖人數'));
    maps.appendChild(table(['地圖', '代號', '人數'], data.maps.map((m) => [m.name, m.mapId, String(m.count)])));

    const players = el('div', 'card');
    players.appendChild(el('h2', undefined, '線上角色'));
    players.appendChild(
      table(
        ['角色', '等級', '地圖', ''],
        data.players.map((p) => [
          p.name,
          String(p.level),
          p.mapId,
          button('查看', () => {
            currentTab = 'accounts';
            showTab('accounts');
            run(() => renderCharacter(p.characterId));
          }),
        ]),
      ),
    );
    if (currentTab === 'overview') {
      content.replaceChildren(stats, el('p', 'muted', '每 5 秒自動更新'), maps, players);
    }
  };
  await draw();
  refreshTimer = window.setInterval(() => run(draw), 5000);
}

// ------------------------------------------------------------ 帳號

interface AccountRow {
  id: number;
  username: string;
  role: string;
  bannedUntil: number | null;
  banReason: string | null;
  createdAt: number;
  lastLoginAt: number | null;
  characters: Array<{ id: number; name: string; classId: string; level: number; mapId: string; coins: number; online: boolean }>;
}

let lastKeyword = '';

async function renderAccounts(): Promise<void> {
  const search = el('form', 'card row');
  const input = el('input');
  input.placeholder = '帳號、角色名稱或帳號編號';
  input.value = lastKeyword;
  input.style.flex = '1';
  const submit = el('button', 'primary', '搜尋');
  submit.type = 'submit';
  search.append(input, submit);
  const results = el('div');
  search.addEventListener('submit', (event) => {
    event.preventDefault();
    lastKeyword = input.value.trim();
    run(() => drawAccounts(results));
  });
  content.replaceChildren(search, results);
  await drawAccounts(results);
  input.focus();
}

async function drawAccounts(results: HTMLElement): Promise<void> {
  const data = await api<{ accounts: AccountRow[] }>('GET', `/api/admin/accounts?q=${encodeURIComponent(lastKeyword)}`);
  results.replaceChildren();
  if (data.accounts.length === 0) {
    results.appendChild(el('div', 'card muted', '找不到符合的帳號'));
  }
  for (const account of data.accounts) {
    const card = el('div', 'card');
    const title = el('div', 'row');
    title.appendChild(el('h2', undefined, `${account.username}（#${account.id}）`));
    if (account.role !== 'player') {
      title.appendChild(el('span', 'tag warn', account.role === 'admin' ? '管理員' : 'GM'));
    }
    if (account.bannedUntil) {
      title.appendChild(el('span', 'tag banned', `封鎖至 ${formatTime(account.bannedUntil)}`));
    }
    card.appendChild(title);
    card.appendChild(
      el('div', 'muted', `註冊 ${formatTime(account.createdAt)}　最後登入 ${formatTime(account.lastLoginAt)}${account.banReason ? `　封鎖原因：${account.banReason}` : ''}`),
    );
    card.appendChild(
      table(
        ['角色', '職業', '等級', '地圖', '星幣', '狀態', ''],
        account.characters.map((c) => [
          `${c.name}（#${c.id}）`,
          getClassDef(c.classId)?.name ?? c.classId,
          String(c.level),
          c.mapId,
          c.coins.toLocaleString(),
          c.online ? el('span', 'tag online', '線上') : el('span', 'muted', '離線'),
          button('查看', () => run(() => renderCharacter(c.id))),
        ]),
      ),
    );

    // 封鎖／解除封鎖
    const actions = el('div', 'row');
    const message = el('span', 'message');
    if (account.bannedUntil) {
      actions.appendChild(
        button('解除封鎖', () => {
          void api('POST', '/api/admin/unban', { accountId: account.id }).then(
            () => run(() => drawAccounts(results)),
            (err: Error) => (message.textContent = err.message),
          );
        }),
      );
    } else {
      const hours = el('select');
      for (const [value, label] of [['1', '1 小時'], ['24', '1 天'], ['168', '7 天'], ['720', '30 天'], ['0', '永久']] as const) {
        const option = el('option', undefined, label);
        option.value = value;
        hours.appendChild(option);
      }
      const reason = el('input');
      reason.placeholder = '封鎖原因（必填，玩家登入時會看到）';
      reason.style.flex = '1';
      actions.append(
        hours,
        reason,
        button(
          '封鎖',
          () => {
            if (!reason.value.trim()) {
              message.textContent = '請填寫原因';
              return;
            }
            if (!window.confirm(`確定要封鎖帳號「${account.username}」嗎？在線上的角色會立刻被踢下線。`)) {
              return;
            }
            void api('POST', '/api/admin/ban', { accountId: account.id, hours: Number(hours.value), reason: reason.value.trim() }).then(
              () => run(() => drawAccounts(results)),
              (err: Error) => (message.textContent = err.message),
            );
          },
          'danger',
        ),
      );
    }
    actions.appendChild(message);
    card.appendChild(actions);
    results.appendChild(card);
  }
}

// ------------------------------------------------------------ 角色詳細資料與發放道具

interface CharacterDetail {
  character: {
    id: number; accountId: number; name: string; classId: string; level: number; exp: number; coins: number;
    mapId: string; x: number; y: number; statPoints: number; guild: string | null; online: boolean;
    stats: Record<string, number>;
  };
  inventory: InventoryItem[];
  equipment: InventoryItem[];
  itemLog: Array<{ createdAt: number; action: string; itemId: string | null; quantity: number; coins: number; otherCharacterId: number | null; detail: unknown }>;
}

async function renderCharacter(characterId: number): Promise<void> {
  const data = await api<CharacterDetail>('GET', `/api/admin/characters/${characterId}`);
  const c = data.character;
  const back = button('← 回到帳號列表', () => showTab('accounts'));

  const info = el('div', 'card');
  const title = el('div', 'row');
  title.appendChild(el('h2', undefined, `${c.name}（#${c.id}）`));
  title.appendChild(c.online ? el('span', 'tag online', '線上') : el('span', 'tag', '離線'));
  info.appendChild(title);
  info.appendChild(
    el(
      'div',
      undefined,
      `${getClassDef(c.classId)?.name ?? c.classId}　Lv.${c.level}　經驗 ${c.exp}　星幣 ${c.coins.toLocaleString()}　` +
        `位置 ${c.mapId} (${Math.floor(c.x)}, ${Math.floor(c.y)})　公會 ${c.guild ?? '無'}`,
    ),
  );
  info.appendChild(
    el('div', 'muted', `力量 ${c.stats.pow}　迅捷 ${c.stats.swf}　體魄 ${c.stats.con}　靈智 ${c.stats.mnd}　專注 ${c.stats.foc}　機運 ${c.stats.for}　未分配 ${c.statPoints}`),
  );
  if (c.online) {
    info.appendChild(el('div', 'muted', '角色在線上：位置、經驗與打怪星幣顯示的是最近一次存檔的值，道具則是即時的。'));
  }

  const items = el('div', 'card');
  items.appendChild(el('h2', undefined, '裝備與背包'));
  items.appendChild(
    table(
      ['位置', '道具', '數量', '編號'],
      [
        ...data.equipment.map((i) => [EQUIP_SLOT_NAME[EQUIP_SLOTS[i.slot]!] ?? '裝備', itemDisplayName(i), String(i.quantity), el('code', undefined, i.uid)]),
        ...data.inventory.map((i) => [`背包 ${i.slot + 1}`, itemDisplayName(i), String(i.quantity), el('code', undefined, i.uid)]),
      ],
    ),
  );

  // 發放道具（只有管理員）
  const grant = el('div', 'card');
  grant.appendChild(el('h2', undefined, '發放道具或星幣'));
  if (staff?.role !== 'admin') {
    grant.appendChild(el('div', 'muted', '只有管理員可以發放。'));
  } else {
    const row = el('div', 'row');
    const item = el('select');
    const none = el('option', undefined, '（不發道具）');
    none.value = '';
    item.appendChild(none);
    for (const def of ITEMS) {
      const option = el('option', undefined, `${def.name}（${def.id}）`);
      option.value = def.id;
      item.appendChild(option);
    }
    const quantity = el('input');
    quantity.type = 'number';
    quantity.min = '1';
    quantity.max = '999';
    quantity.value = '1';
    quantity.style.width = '70px';
    const coins = el('input');
    coins.type = 'number';
    coins.placeholder = '星幣（可為負）';
    coins.style.width = '130px';
    const reason = el('input');
    reason.placeholder = '原因（必填，會寫進紀錄）';
    reason.style.flex = '1';
    const message = el('div', 'message');
    row.append(
      item,
      quantity,
      coins,
      reason,
      button(
        '發放',
        () => {
          const body = {
            characterId: c.id,
            itemId: item.value || undefined,
            quantity: item.value ? Number(quantity.value) : undefined,
            coins: coins.value ? Number(coins.value) : undefined,
            reason: reason.value.trim(),
          };
          void api<{ online: boolean }>('POST', '/api/admin/grant', body).then(
            () => run(() => renderCharacter(c.id)),
            (err: Error) => (message.textContent = err.message),
          );
        },
        'primary',
      ),
    );
    grant.append(row, message);
  }

  const logCard = el('div', 'card');
  logCard.appendChild(el('h2', undefined, '最近 50 筆道具異動'));
  logCard.appendChild(
    table(
      ['時間', '操作', '道具', '數量', '星幣', '對方', '細節'],
      data.itemLog.map((l) => [
        formatTime(l.createdAt),
        l.action,
        l.itemId ? (getItemDef(l.itemId)?.name ?? l.itemId) : '',
        l.quantity ? String(l.quantity) : '',
        l.coins ? String(l.coins) : '',
        l.otherCharacterId ? `#${l.otherCharacterId}` : '',
        el('code', undefined, l.detail ? JSON.stringify(l.detail) : ''),
      ]),
    ),
  );
  content.replaceChildren(back, info, items, grant, logCard);
}

// ------------------------------------------------------------ 公告

async function renderAnnounce(): Promise<void> {
  const card = el('div', 'card');
  card.appendChild(el('h2', undefined, '全伺服器公告'));
  card.appendChild(el('p', 'muted', '送出後所有線上玩家的畫面上方會顯示這則公告（最多 200 個字）。'));
  const text = el('textarea');
  text.maxLength = 200;
  const message = el('div', 'message');
  card.append(
    text,
    button(
      '發布公告',
      () => {
        if (!text.value.trim()) {
          message.textContent = '請輸入公告內容';
          return;
        }
        void api<{ online: number }>('POST', '/api/admin/announce', { text: text.value.trim() }).then(
          (result) => {
            message.textContent = `已發布（當時線上 ${result.online} 人）`;
            text.value = '';
          },
          (err: Error) => (message.textContent = err.message),
        );
      },
      'primary',
    ),
    message,
  );
  content.replaceChildren(card);
}

// ------------------------------------------------------------ 安全事件與操作紀錄

const LEVEL_LABEL: Record<string, string> = { info: '紀錄', warn: '留意', alert: '警示' };

async function renderEvents(): Promise<void> {
  const data = await api<{
    events: Array<{ createdAt: number; level: string; kind: string; accountId: number | null; characterId: number | null; message: string; detail: unknown }>;
  }>('GET', '/api/admin/events');
  const card = el('div', 'card');
  const head = el('div', 'row');
  head.append(el('h2', undefined, '最近 200 筆安全事件'), button('重新整理', () => run(renderEvents)));
  card.appendChild(head);
  card.appendChild(
    table(
      ['時間', '等級', '種類', '內容', '角色', '細節'],
      data.events.map((e) => [
        formatTime(e.createdAt),
        el('span', `tag ${e.level}`, LEVEL_LABEL[e.level] ?? e.level),
        e.kind,
        e.message,
        e.characterId ? button(`#${e.characterId}`, () => run(() => renderCharacter(e.characterId!))) : '',
        el('code', undefined, e.detail ? JSON.stringify(e.detail) : ''),
      ]),
    ),
  );
  content.replaceChildren(card);
}

async function renderLog(): Promise<void> {
  const data = await api<{
    entries: Array<{ createdAt: number; adminUsername: string; action: string; targetAccountId: number | null; targetCharacterId: number | null; detail: unknown }>;
  }>('GET', '/api/admin/log');
  const card = el('div', 'card');
  card.appendChild(el('h2', undefined, '最近 200 筆 GM 操作'));
  card.appendChild(
    table(
      ['時間', '操作者', '操作', '對象', '細節'],
      data.entries.map((e) => [
        formatTime(e.createdAt),
        e.adminUsername,
        e.action,
        [e.targetAccountId ? `帳號 #${e.targetAccountId}` : '', e.targetCharacterId ? `角色 #${e.targetCharacterId}` : ''].filter(Boolean).join(' '),
        el('code', undefined, e.detail ? JSON.stringify(e.detail) : ''),
      ]),
    ),
  );
  content.replaceChildren(card);
}

// ------------------------------------------------------------ 啟動：有保存的憑證就先試著用

if (token) {
  api<{ username: string; role: string }>('GET', '/api/admin/me').then(
    (me) => {
      staff = me;
      renderShell();
    },
    () => renderLogin(),
  );
} else {
  renderLogin();
}
