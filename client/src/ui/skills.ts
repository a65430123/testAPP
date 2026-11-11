// 技能列（HTML，蓋在遊戲畫布下方中央）

import { getClassDef, getSkillDef, type SkillDef } from '@starmemory/shared';

export type SkillUseHandler = (skill: SkillDef) => void;

interface SkillButton {
  skill: SkillDef;
  button: HTMLButtonElement;
  cooldown: HTMLSpanElement;
  readyAt: number;
}

export class SkillBar {
  private readonly root: HTMLDivElement;
  private readonly buttons: SkillButton[] = [];
  private useHandler: SkillUseHandler | null = null;
  private level = 1;
  private sp = 0;
  private readonly timer: number;

  constructor(classId: string) {
    this.root = document.createElement('div');
    this.root.id = 'skills';
    document.body.appendChild(this.root);

    for (const skillId of getClassDef(classId)?.skills ?? []) {
      const skill = getSkillDef(skillId);
      if (!skill) {
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.title = `${skill.description}\n消耗 SP ${skill.spCost}，冷卻 ${skill.cooldownMs / 1000} 秒`;
      const name = document.createElement('strong');
      name.textContent = skill.name;
      const cost = document.createElement('small');
      cost.textContent = `SP ${skill.spCost}`;
      const cooldown = document.createElement('span');
      cooldown.className = 'sk-cd';
      button.append(name, cost, cooldown);
      const entry: SkillButton = { skill, button, cooldown, readyAt: 0 };
      button.addEventListener('click', () => {
        this.useHandler?.(skill);
        button.blur();
      });
      this.buttons.push(entry);
      this.root.appendChild(button);
    }
    this.timer = window.setInterval(() => this.refresh(), 100);
    this.refresh();
  }

  /** 設定按下技能時要呼叫的函式（切換地圖後會換成新房間的） */
  onUse(handler: SkillUseHandler | null): void {
    this.useHandler = handler;
  }

  /** 更新等級與 SP，用來判斷按鈕能不能按 */
  setState(level: number, sp: number): void {
    this.level = level;
    this.sp = sp;
    this.refresh();
  }

  /** 伺服器確認技能已施放：開始顯示冷卻 */
  startCooldown(skillId: string): void {
    const entry = this.buttons.find((b) => b.skill.id === skillId);
    if (entry) {
      entry.readyAt = performance.now() + entry.skill.cooldownMs;
      this.refresh();
    }
  }

  private refresh(): void {
    const now = performance.now();
    for (const { skill, button, cooldown, readyAt } of this.buttons) {
      const remaining = readyAt - now;
      const locked = this.level < skill.requiredLevel;
      cooldown.textContent = locked ? `Lv.${skill.requiredLevel}` : remaining > 0 ? (remaining / 1000).toFixed(1) : '';
      button.disabled = locked || remaining > 0 || this.sp < skill.spCost;
    }
  }

  destroy(): void {
    window.clearInterval(this.timer);
    this.root.remove();
  }
}
