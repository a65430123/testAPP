// 組隊、公會、好友：處理用戶端的 social 訊息。
// 隊伍在記憶體中（social/party.ts），公會與好友存在資料庫（db/social.ts）。

import type { Client } from 'colyseus';
import {
  FRIEND_MAX,
  GUILD_CREATE_COST,
  GUILD_MAX_MEMBERS,
  INVITE_TTL_MS,
  MSG,
  validateName,
  type ChatMessage,
  type FriendsMessage,
  type GuildMessage,
  type SocialInviteMessage,
  type SocialKind,
  type SocialMember,
} from '@starmemory/shared';
import {
  addFriendPair,
  addGuildMember,
  deleteGuild,
  getGuild,
  GuildNameTakenError,
  insertGuild,
  listFriends,
  listGuildMembers,
  removeFriendPair,
  removeGuildMember,
  type MemberRow,
} from '../db/social';
import type { PlayerRuntime } from '../rooms/runtime';
import { hub } from '../social/hub';
import { partyManager } from '../social/party';
import type { ItemController } from './ItemController';

export interface SocialHost {
  actingPlayer(client: Client): PlayerRuntime | null;
  getRuntime(sessionId: string): PlayerRuntime | undefined;
  sendSystemTo(client: Client, text: string): void;
}

interface Invite {
  fromId: number;
  fromName: string;
  /** 公會邀請：要加入的公會 */
  guild?: { id: number; name: string };
  expireAt: number;
}

/** 等待回應的邀請：「種類:被邀請者的角色編號」→ 邀請內容（每種邀請一次只保留最新的一筆） */
const invites = new Map<string, Invite>();

const KIND_NAME: Record<SocialKind, string> = { party: '組隊', guild: '公會', friend: '好友' };

function toMember(row: MemberRow, leaderId: number | null): SocialMember {
  const live = hub.get(row.characterId);
  return {
    characterId: row.characterId,
    name: row.name,
    level: live?.level ?? row.level,
    online: live !== undefined,
    mapId: live?.mapId ?? '',
    leader: row.characterId === leaderId,
  };
}

export class SocialController {
  constructor(
    private readonly host: SocialHost,
    private readonly items: ItemController,
  ) {}

  handle(client: Client, message: unknown): void {
    const runtime = this.host.actingPlayer(client);
    const payload = message as { action?: unknown; [key: string]: unknown } | null;
    if (!runtime || typeof payload?.action !== 'string') {
      return;
    }
    // 各操作都可能查資料庫；錯誤集中在這裡處理，不讓房間因為一次失敗而出問題
    this.dispatch(runtime, payload.action, payload).catch((err: unknown) => {
      console.error(`[social] 角色 ${runtime.record.name} 的操作 ${String(payload.action)} 失敗：`, err);
      this.host.sendSystemTo(client, '操作失敗，請稍後再試');
    });
  }

  private async dispatch(runtime: PlayerRuntime, action: string, payload: Record<string, unknown>): Promise<void> {
    const { client, record } = runtime;
    const say = (text: string): void => this.host.sendSystemTo(client, text);
    switch (action) {
      case 'refresh':
        partyManager.sendTo(record.id);
        await this.sendGuild(runtime);
        await this.sendFriends(record.id);
        return;
      case 'invite':
        await this.invite(runtime, payload.kind, payload.targetId);
        return;
      case 'respond':
        await this.respond(runtime, payload.kind, payload.accept === true);
        return;
      case 'partyLeave':
        partyManager.leave(record.id);
        return;
      case 'partyKick': {
        const error = typeof payload.characterId === 'number' ? partyManager.kick(record.id, payload.characterId) : '找不到對象';
        if (error) {
          say(error);
        }
        return;
      }
      case 'guildCreate':
        this.guildCreate(runtime, payload.name);
        return;
      case 'guildLeave':
        await this.guildLeave(runtime);
        return;
      case 'guildKick':
        await this.guildKick(runtime, payload.characterId);
        return;
      case 'guildDisband':
        await this.guildDisband(runtime);
        return;
      case 'friendRemove':
        if (typeof payload.characterId === 'number') {
          await removeFriendPair(record.id, payload.characterId);
          await this.sendFriends(record.id);
          await this.sendFriends(payload.characterId);
        }
        return;
    }
  }

  // ------------------------------------------------------------ 邀請與回應

  private async invite(runtime: PlayerRuntime, kind: unknown, targetId: unknown): Promise<void> {
    const { client, record } = runtime;
    const say = (text: string): void => this.host.sendSystemTo(client, text);
    const target = typeof targetId === 'string' ? this.host.getRuntime(targetId) : undefined;
    if ((kind !== 'party' && kind !== 'guild' && kind !== 'friend') || !target || target === runtime) {
      return;
    }
    const invite: Invite = { fromId: record.id, fromName: record.name, expireAt: Date.now() + INVITE_TTL_MS };

    if (kind === 'party') {
      const error = partyManager.inviteError(record.id, target.record.id);
      if (error) {
        say(error);
        return;
      }
    } else if (kind === 'guild') {
      const guild = record.guild ? await getGuild(record.guild.id) : undefined;
      if (!guild || guild.leaderId !== record.id) {
        say('只有會長可以邀請成員');
        return;
      }
      if (target.record.guild) {
        say('對方已經有公會了');
        return;
      }
      invite.guild = { id: guild.id, name: guild.name };
    } else {
      const friends = await listFriends(record.id);
      if (friends.some((f) => f.characterId === target.record.id)) {
        say('你們已經是好友了');
        return;
      }
      if (friends.length >= FRIEND_MAX) {
        say('好友名單已滿');
        return;
      }
    }

    invites.set(`${kind}:${target.record.id}`, invite);
    const message: SocialInviteMessage = { kind, fromName: record.name, ...(invite.guild ? { detail: invite.guild.name } : {}) };
    target.client.send(MSG.socialInvite, message);
    say(`已向 ${target.record.name} 送出${KIND_NAME[kind]}邀請`);
  }

  private async respond(runtime: PlayerRuntime, kind: unknown, accept: boolean): Promise<void> {
    const { client, record } = runtime;
    const say = (text: string): void => this.host.sendSystemTo(client, text);
    if (kind !== 'party' && kind !== 'guild' && kind !== 'friend') {
      return;
    }
    const key = `${kind}:${record.id}`;
    const invite = invites.get(key);
    invites.delete(key);
    if (!invite || Date.now() > invite.expireAt) {
      say('邀請已經失效');
      return;
    }
    const from = hub.get(invite.fromId);
    if (!accept) {
      from?.send(MSG.system, { text: `${record.name} 婉拒了${KIND_NAME[kind]}邀請` });
      return;
    }

    if (kind === 'party') {
      if (!from) {
        say('對方已經離線');
        return;
      }
      const error = partyManager.join(
        { characterId: from.characterId, name: from.name, level: from.level },
        { characterId: record.id, name: record.name, level: record.level },
      );
      if (error) {
        say(error);
      }
      return;
    }

    if (kind === 'guild') {
      const guild = invite.guild;
      if (!guild || record.guild) {
        say('無法加入公會');
        return;
      }
      if (!(await addGuildMember(guild.id, record.id, GUILD_MAX_MEMBERS))) {
        say('公會人數已滿或已不存在');
        return;
      }
      hub.get(record.id)?.setGuild(guild);
      await this.notifyGuild(guild.id, `${record.name} 加入了公會`);
      return;
    }

    await addFriendPair(record.id, invite.fromId);
    await this.sendFriends(record.id);
    await this.sendFriends(invite.fromId);
    from?.send(MSG.system, { text: `${record.name} 成為你的好友` });
    say(`${invite.fromName} 成為你的好友`);
  }

  // ------------------------------------------------------------ 公會

  /** 建立公會：扣星幣、建立公會、寫入紀錄都在同一個資料庫交易內 */
  private guildCreate(runtime: PlayerRuntime, rawName: unknown): void {
    const { client, record } = runtime;
    const say = (text: string): void => this.host.sendSystemTo(client, text);
    const invalid = validateName(rawName);
    if (invalid) {
      say(invalid.replace('角色名稱', '公會名稱'));
      return;
    }
    const name = (rawName as string).trim();
    this.items.run(runtime, async () => {
      if (record.guild) {
        say('你已經有公會了');
        return;
      }
      if (record.coins < GUILD_CREATE_COST) {
        say(`建立公會需要 ${GUILD_CREATE_COST} 星幣`);
        return;
      }
      let guildId = 0;
      try {
        await this.items.commit(
          [{ runtime, coinsDelta: -GUILD_CREATE_COST }],
          [{ action: 'guild_create', characterId: record.id, coins: -GUILD_CREATE_COST, detail: { name } }],
          async (db) => {
            guildId = await insertGuild(db, name, record.id);
          },
        );
      } catch (err) {
        if (err instanceof GuildNameTakenError) {
          say('這個公會名稱已經有人使用');
          return;
        }
        throw err;
      }
      hub.get(record.id)?.setGuild({ id: guildId, name });
      say(`公會「${name}」成立了！`);
      await this.sendGuild(runtime);
    });
  }

  private async guildLeave(runtime: PlayerRuntime): Promise<void> {
    const { client, record } = runtime;
    const guild = record.guild ? await getGuild(record.guild.id) : undefined;
    if (!guild) {
      return;
    }
    if (guild.leaderId === record.id) {
      this.host.sendSystemTo(client, '會長不能直接退出，請先解散公會');
      return;
    }
    await removeGuildMember(guild.id, record.id);
    hub.get(record.id)?.setGuild(null);
    await this.notifyGuild(guild.id, `${record.name} 退出了公會`);
  }

  private async guildKick(runtime: PlayerRuntime, characterId: unknown): Promise<void> {
    const { client, record } = runtime;
    const guild = record.guild ? await getGuild(record.guild.id) : undefined;
    if (!guild || guild.leaderId !== record.id || typeof characterId !== 'number' || characterId === record.id) {
      this.host.sendSystemTo(client, '只有會長可以請離成員');
      return;
    }
    if (!(await removeGuildMember(guild.id, characterId))) {
      return;
    }
    const target = hub.get(characterId);
    target?.setGuild(null);
    target?.send(MSG.system, { text: `你被請離了公會「${guild.name}」` });
    await this.notifyGuild(guild.id);
  }

  private async guildDisband(runtime: PlayerRuntime): Promise<void> {
    const { client, record } = runtime;
    const guild = record.guild ? await getGuild(record.guild.id) : undefined;
    if (!guild || guild.leaderId !== record.id) {
      this.host.sendSystemTo(client, '只有會長可以解散公會');
      return;
    }
    const members = await listGuildMembers(guild.id);
    await deleteGuild(guild.id);
    for (const member of members) {
      const live = hub.get(member.characterId);
      live?.setGuild(null);
      live?.send(MSG.system, { text: `公會「${guild.name}」已解散` });
    }
  }

  /** 把公會內容傳給本人 */
  async sendGuild(runtime: PlayerRuntime): Promise<void> {
    const guild = runtime.record.guild ? await getGuild(runtime.record.guild.id) : undefined;
    const message: GuildMessage = guild
      ? { guild: { id: guild.id, name: guild.name, members: (await listGuildMembers(guild.id)).map((m) => toMember(m, guild.leaderId)) } }
      : { guild: null };
    runtime.client.send(MSG.guild, message);
  }

  /** 把公會的最新名單傳給所有在線上的成員，可附帶一則系統訊息 */
  private async notifyGuild(guildId: number, text?: string): Promise<void> {
    const guild = await getGuild(guildId);
    if (!guild) {
      return;
    }
    const members = (await listGuildMembers(guildId)).map((m) => toMember(m, guild.leaderId));
    const message: GuildMessage = { guild: { id: guild.id, name: guild.name, members } };
    for (const member of members) {
      const live = hub.get(member.characterId);
      live?.send(MSG.guild, message);
      if (text) {
        live?.send(MSG.system, { text });
      }
    }
  }

  // ------------------------------------------------------------ 好友

  private async sendFriends(characterId: number): Promise<void> {
    const live = hub.get(characterId);
    if (!live) {
      return;
    }
    const message: FriendsMessage = { friends: (await listFriends(characterId)).map((f) => toMember(f, null)) };
    live.send(MSG.friends, message);
  }

  // ------------------------------------------------------------ 隊伍與公會頻道

  /**
   * 把隊伍或公會頻道的發言傳給對應的成員（可能在別的地圖）。
   * @returns 是否有送出；沒有隊伍或公會時為 false
   */
  routeChat(runtime: PlayerRuntime, chat: ChatMessage): boolean {
    const { record } = runtime;
    if (chat.channel === 'party') {
      const members = partyManager.memberIds(record.id);
      if (!members) {
        return false;
      }
      for (const id of members) {
        hub.get(id)?.send(MSG.chat, chat);
      }
      return true;
    }
    if (chat.channel === 'guild') {
      const guildId = record.guild?.id;
      if (!guildId) {
        return false;
      }
      for (const live of hub.values()) {
        if (live.guildId === guildId) {
          live.send(MSG.chat, chat);
        }
      }
      return true;
    }
    return false;
  }
}
