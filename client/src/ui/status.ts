// 個人狀態（HP／SP／經驗條）與素質視窗（HTML，蓋在遊戲畫布左上角）

import {
  getClassDef,
  STAT_KEYS,
  STAT_MAX,
  statCost,
  type SelfMessage,
  type Stats,
} from '@starmemory/shared';

const STAT_LABEL: Record<keyof Stats, string> = {
  pow: '力量',
  swf: '迅捷',
  con: '體魄',
  mnd: '靈智',
  foc: '專注',
  for: '機運',
};

export type AllocHandler = (stat: keyof Stats) => void;

export class StatusPanel {
  private readonly root: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly bars: Record<'hp' | 'sp' | 'exp', { fill: HTMLDivElement; text: HTMLSpanElement }>;
  private readonly toggle: HTMLButtonElement;
  private readonly statBox: HTMLDivElement;
  private allocHandler: AllocHandler | null = null;

  constructor(
    private readonly name: string,
    private readonly classId: string,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'status';
    this.root.innerHTML = `
      <div class="st-title"></div>
      <div class="st-bar st-hp"><div class="st-fill"></div><span></span></div>
      <div class="st-bar st-sp"><div class="st-fill"></div><span></span></div>
      <div class="st-bar st-exp"><div class="st-fill"></div><span></span></div>
      <button type="button" class="st-toggle">素質</button>
      <div class="st-stats" hidden></div>`;
    document.body.appendChild(this.root);
    this.title = this.root.querySelector('.st-title') as HTMLDivElement;
    const bar = (cls: string): { fill: HTMLDivElement; text: HTMLSpanElement } => ({
      fill: this.root.querySelector(`.${cls} .st-fill`) as HTMLDivElement,
      text: this.root.querySelector(`.${cls} span`) as HTMLSpanElement,
    });
    this.bars = { hp: bar('st-hp'), sp: bar('st-sp'), exp: bar('st-exp') };
    this.toggle = this.root.querySelector('.st-toggle') as HTMLButtonElement;
    this.statBox = this.root.querySelector('.st-stats') as HTMLDivElement;
    this.toggle.addEventListener('click', () => {
      this.statBox.hidden = !this.statBox.hidden;
    });
    this.title.textContent = name;
  }

  /** 設定按下「＋」時要呼叫的函式（切換地圖後會換成新房間的） */
  onAlloc(handler: AllocHandler | null): void {
    this.allocHandler = handler;
  }

  /** 以伺服器傳來的個人數值重畫 */
  update(self: SelfMessage): void {
    const cls = getClassDef(this.classId);
    this.title.textContent = `Lv.${self.level} ${this.name}（${cls?.name ?? this.classId}）`;
    this.setBar('hp', self.hp, self.maxHp, `HP ${self.hp} / ${self.maxHp}`);
    this.setBar('sp', self.sp, self.maxSp, `SP ${self.sp} / ${self.maxSp}`);
    const percent = self.expNext > 0 ? ((self.exp / self.expNext) * 100).toFixed(1) : '0';
    this.setBar('exp', self.exp, self.expNext, `EXP ${percent}%`);
    // 有未分配的點數時在按鈕上提示
    this.toggle.textContent = self.statPoints > 0 ? `素質（${self.statPoints}）` : '素質';
    this.toggle.classList.toggle('has-points', self.statPoints > 0);
    this.renderStats(self);
  }

  private setBar(key: 'hp' | 'sp' | 'exp', value: number, max: number, text: string): void {
    const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    this.bars[key].fill.style.width = `${ratio * 100}%`;
    this.bars[key].text.textContent = text;
  }

  private renderStats(self: SelfMessage): void {
    const box = this.statBox;
    box.replaceChildren();
    const head = document.createElement('div');
    head.className = 'st-points';
    head.textContent = `可分配點數：${self.statPoints}`;
    box.appendChild(head);

    for (const key of STAT_KEYS) {
      const value = self.stats[key];
      const cost = statCost(value);
      const row = document.createElement('div');
      row.className = 'st-row';
      const label = document.createElement('span');
      label.textContent = `${STAT_LABEL[key]} ${value}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `＋（${cost} 點）`;
      button.disabled = value >= STAT_MAX || self.statPoints < cost;
      button.addEventListener('click', () => this.allocHandler?.(key));
      row.append(label, button);
      box.appendChild(row);
    }

    // 含裝備加成的戰鬥數值（由伺服器計算）
    const derived = document.createElement('div');
    derived.className = 'st-derived';
    derived.textContent =
      `物攻 ${self.atk}　魔攻 ${self.matk}　物防 ${self.def}　魔防 ${self.mdef}\n` +
      `命中 ${self.hit}　迴避 ${self.eva}　暴擊 ${self.crit.toFixed(1)}%\n` +
      `攻擊間隔 ${(self.attackIntervalMs / 1000).toFixed(2)} 秒`;
    box.appendChild(derived);
  }

  destroy(): void {
    this.root.remove();
  }
}
