// 建立 HTML 元素的小工具，以及道具說明文字

import {
  EQUIP_TYPE_NAME,
  getItemDef,
  type Bonus,
  type ItemStack,
  type Stats,
} from '@starmemory/shared';

/** 建立元素；文字一律用 textContent 設定，避免把玩家取的名字當成 HTML */
export function el<K extends keyof HTMLElementTagNameMap>(
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

const STAT_NAME: Record<keyof Stats, string> = {
  pow: '力量',
  swf: '迅捷',
  con: '體魄',
  mnd: '靈智',
  foc: '專注',
  for: '機運',
};

/** 把加成寫成一行文字，例如「物攻 +12　MaxHP +20」 */
export function bonusText(bonus: Bonus): string {
  const parts: string[] = [];
  const add = (label: string, value: number | undefined, suffix = ''): void => {
    if (value) {
      parts.push(`${label} +${value}${suffix}`);
    }
  };
  add('物攻', bonus.atk);
  add('魔攻', bonus.matk);
  add('物防', bonus.def);
  add('魔防', bonus.mdef);
  add('MaxHP', bonus.maxHp);
  add('MaxSP', bonus.maxSp);
  add('命中', bonus.hit);
  add('迴避', bonus.eva);
  add('暴擊', bonus.crit, '%');
  add('HP 回復', bonus.hpRegenPct, '%');
  for (const [key, value] of Object.entries(bonus.stats ?? {})) {
    add(STAT_NAME[key as keyof Stats], value);
  }
  return parts.join('　');
}

/** 滑鼠停在道具上時顯示的說明 */
export function itemTooltip(item: ItemStack): string {
  const def = getItemDef(item.itemId);
  if (!def) {
    return item.itemId;
  }
  const lines = [def.description];
  if (def.equip) {
    lines.push(`${EQUIP_TYPE_NAME[def.equip.type]}　需求等級 ${def.equip.reqLevel}`);
    const stats = bonusText(def.equip);
    if (stats) {
      lines.push(stats);
    }
    if (item.refine > 0) {
      lines.push(`精煉 +${item.refine}`);
    }
    if (item.cardSlots > 0) {
      const cards = item.cards.map((id) => getItemDef(id)?.name ?? id).join('、') || '空';
      lines.push(`卡槽 ${item.cards.length}/${item.cardSlots}：${cards}`);
    }
  }
  lines.push(`賣價 ${def.sellPrice}`);
  return lines.join('\n');
}
