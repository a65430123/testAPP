// 社交介面（HTML）：點玩家時的選單、邀請提示、隊伍／公會／好友面板

import {
  GUILD_CREATE_COST,
  MSG,
  NAME_MAX_LENGTH,
  type FriendsMessage,
  type GuildMessage,
  type PartyMessage,
  type SocialInviteMessage,
  type SocialKind,
  type SocialMember,
  type SocialRequest,
} from '@starmemory/shared';
import { mapDisplayName } from '../assets';
import { el } from './dom';

const KIND_TEXT: Record<SocialKind, string> = { party: '邀請你組隊', guild: '邀請你加入公會', friend: '想加你為好友' };

export class SocialUi {
  private readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly menu: HTMLDivElement;
  private readonly prompt: HTMLDivElement;
  private send: ((type: string, message?: unknown) => void) | null = null;
  private party: PartyMessage = { members: [] };
  private guild: GuildMessage = { guild: null };
  private friends: FriendsMessage = { friends: [] };

  /** @param myCharacterId 自己的角色編號（用來判斷自己是不是隊長／會長） */
  constructor(private readonly myCharacterId: number) {
    this.root = el('div');
    this.root.id = 'social';
    const toggle = el('button', 'inv-toggle', '社交');
    toggle.type = 'button';
    this.body = el('div', 'inv-body');
    this.body.hidden = true;
    this.root.append(toggle, this.body);
    toggle.addEventListener('click', () => {
      this.body.hidden = !this.body.hidden;
    });

    this.menu = el('div', 'float-box');
    this.menu.id = 'player-menu';
    this.menu.hidden = true;
    this.prompt = el('div', 'float-box');
    this.prompt.id = 'social-prompt';
    this.prompt.hidden = true;
    document.body.append(this.root, this.menu, this.prompt);
    this.render();
  }

  /** 進入房間後呼叫：之後的操作都送到這個房間，並向伺服器要一次最新內容 */
  bind(send: (type: string, message?: unknown) => void): void {
    this.send = send;
    this.request({ action: 'refresh' });
  }

  unbind(): void {
    this.send = null;
    this.menu.hidden = true;
    this.prompt.hidden = true;
  }

  private request(request: SocialRequest): void {
    this.send?.(MSG.social, request);
  }

  // ------------------------------------------------------------ 來自伺服器

  onParty(message: PartyMessage): void {
    this.party = message;
    this.render();
  }

  onGuild(message: GuildMessage): void {
    this.guild = message;
    this.render();
  }

  onFriends(message: FriendsMessage): void {
    this.friends = message;
    this.render();
  }

  /** 有人邀請：顯示接受／拒絕 */
  onInvite(message: SocialInviteMessage): void {
    const detail = message.detail ? `「${message.detail}」` : '';
    this.prompt.replaceChildren(el('span', undefined, `${message.fromName} ${KIND_TEXT[message.kind]}${detail}`));
    const answer = (accept: boolean): void => {
      this.prompt.hidden = true;
      this.request({ action: 'respond', kind: message.kind, accept });
    };
    const yes = el('button', 'primary', '接受');
    yes.type = 'button';
    yes.addEventListener('click', () => answer(true));
    const no = el('button', undefined, '拒絕');
    no.type = 'button';
    no.addEventListener('click', () => answer(false));
    this.prompt.append(yes, no);
    this.prompt.hidden = false;
  }

  // ------------------------------------------------------------ 點玩家時的選單

  /**
   * 顯示對某位玩家可以做的事。
   * @param onTrade 選了「交易」時呼叫（交易由道具介面處理）
   */
  showPlayerMenu(targetId: string, name: string, onTrade: () => void): void {
    this.menu.replaceChildren(el('span', undefined, name));
    const add = (label: string, action: () => void): void => {
      const button = el('button', undefined, label);
      button.type = 'button';
      button.addEventListener('click', () => {
        this.menu.hidden = true;
        action();
      });
      this.menu.appendChild(button);
    };
    add('交易', onTrade);
    add('邀請組隊', () => this.request({ action: 'invite', kind: 'party', targetId }));
    add('加好友', () => this.request({ action: 'invite', kind: 'friend', targetId }));
    if (this.isGuildLeader()) {
      add('邀請入會', () => this.request({ action: 'invite', kind: 'guild', targetId }));
    }
    add('取消', () => undefined);
    this.menu.hidden = false;
  }

  private isGuildLeader(): boolean {
    return this.guild.guild?.members.some((m) => m.leader && m.characterId === this.myCharacterId) ?? false;
  }

  // ------------------------------------------------------------ 面板

  private memberRow(member: SocialMember, action?: { label: string; run: () => void }): HTMLDivElement {
    const row = el('div', member.online ? 'soc-row' : 'soc-row offline');
    const where = member.online ? mapDisplayName(member.mapId) : '離線';
    row.append(
      el('span', 'soc-name', `${member.leader ? '★ ' : ''}${member.name}`),
      el('span', 'soc-info', `Lv.${member.level}　${where}`),
    );
    if (action) {
      const button = el('button', undefined, action.label);
      button.type = 'button';
      button.addEventListener('click', action.run);
      row.appendChild(button);
    }
    return row;
  }

  private button(label: string, run: () => void): HTMLButtonElement {
    const button = el('button', 'soc-action', label);
    button.type = 'button';
    button.addEventListener('click', run);
    return button;
  }

  private render(): void {
    const me = this.myCharacterId;
    this.body.replaceChildren();

    // 隊伍
    const members = this.party.members;
    this.body.appendChild(el('div', 'inv-title', `隊伍${members.length > 0 ? `（${members.length} 人）` : ''}`));
    if (members.length === 0) {
      this.body.appendChild(el('div', 'inv-empty', '沒有隊伍。點其他玩家可以邀請組隊。'));
    } else {
      const iAmLeader = members.some((m) => m.leader && m.characterId === me);
      for (const member of members) {
        const kick =
          iAmLeader && member.characterId !== me
            ? { label: '請離', run: () => this.request({ action: 'partyKick', characterId: member.characterId }) }
            : undefined;
        this.body.appendChild(this.memberRow(member, kick));
      }
      this.body.appendChild(this.button('離開隊伍', () => this.request({ action: 'partyLeave' })));
    }

    // 公會
    const guild = this.guild.guild;
    this.body.appendChild(el('div', 'inv-title', guild ? `公會「${guild.name}」（${guild.members.length} 人）` : '公會'));
    if (!guild) {
      const form = el('form', 'soc-form');
      const input = el('input');
      input.type = 'text';
      input.maxLength = NAME_MAX_LENGTH;
      input.placeholder = '公會名稱';
      input.addEventListener('keydown', (event) => event.stopPropagation());
      const create = el('button', undefined, `建立（${GUILD_CREATE_COST} 星幣）`);
      create.type = 'submit';
      form.append(input, create);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (input.value.trim()) {
          this.request({ action: 'guildCreate', name: input.value.trim() });
        }
      });
      this.body.appendChild(form);
    } else {
      const iAmLeader = this.isGuildLeader();
      for (const member of guild.members) {
        const kick =
          iAmLeader && member.characterId !== me
            ? { label: '請離', run: () => this.request({ action: 'guildKick', characterId: member.characterId }) }
            : undefined;
        this.body.appendChild(this.memberRow(member, kick));
      }
      this.body.appendChild(
        iAmLeader
          ? this.button('解散公會', () => {
              if (window.confirm(`確定要解散公會「${guild.name}」嗎？`)) {
                this.request({ action: 'guildDisband' });
              }
            })
          : this.button('退出公會', () => this.request({ action: 'guildLeave' })),
      );
    }

    // 好友
    const friends = this.friends.friends;
    this.body.appendChild(el('div', 'inv-title', `好友（${friends.length}）`));
    if (friends.length === 0) {
      this.body.appendChild(el('div', 'inv-empty', '還沒有好友。點其他玩家可以加好友。'));
    }
    for (const friend of friends) {
      this.body.appendChild(
        this.memberRow(friend, {
          label: '刪除',
          run: () => this.request({ action: 'friendRemove', characterId: friend.characterId }),
        }),
      );
    }
  }
}
