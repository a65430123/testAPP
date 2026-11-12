// 隊伍：存在伺服器記憶體中，跨地圖有效。登出即離隊，伺服器重啟時全部解散。

import { MSG, PARTY_MAX_MEMBERS, type PartyMessage, type SocialMember } from '@starmemory/shared';
import { hub } from './hub';

/** 切換地圖時角色會短暫離線；超過這段時間沒有回來就視為離隊（毫秒） */
const TRANSFER_GRACE_MS = 30_000;

interface Party {
  leaderId: number;
  /** 角色編號 → 名稱與等級（成員短暫離線時仍能顯示） */
  members: Map<number, { name: string; level: number }>;
}

const partyOf = new Map<number, Party>();
/** 正在切換地圖的成員 → 最晚要回來的時間 */
const pendingTransfer = new Map<number, number>();

function describe(party: Party): PartyMessage {
  const members: SocialMember[] = [...party.members].map(([characterId, info]) => {
    const live = hub.get(characterId);
    return {
      characterId,
      name: live?.name ?? info.name,
      level: live?.level ?? info.level,
      online: live !== undefined,
      mapId: live?.mapId ?? '',
      leader: characterId === party.leaderId,
    };
  });
  return { members };
}

/** 把隊伍的最新內容傳給所有在線上的成員 */
function notify(party: Party): void {
  const message = describe(party);
  for (const characterId of party.members.keys()) {
    hub.get(characterId)?.send(MSG.party, message);
  }
}

function remove(characterId: number): void {
  const party = partyOf.get(characterId);
  if (!party) {
    return;
  }
  party.members.delete(characterId);
  partyOf.delete(characterId);
  pendingTransfer.delete(characterId);
  hub.get(characterId)?.send(MSG.party, { members: [] } satisfies PartyMessage);

  // 只剩一個人就解散
  if (party.members.size <= 1) {
    for (const last of party.members.keys()) {
      partyOf.delete(last);
      hub.get(last)?.send(MSG.party, { members: [] } satisfies PartyMessage);
    }
    party.members.clear();
    return;
  }
  // 隊長離開：由最早加入的成員接任
  if (party.leaderId === characterId) {
    party.leaderId = party.members.keys().next().value!;
  }
  notify(party);
}

// 定期清除切換地圖後沒有回來的成員
setInterval(() => {
  const now = Date.now();
  for (const [characterId, deadline] of pendingTransfer) {
    if (now >= deadline && !hub.get(characterId)) {
      remove(characterId);
    }
  }
}, 5_000).unref();

export const partyManager = {
  /** 同隊所有成員的角色編號（包含自己）；沒有隊伍時回傳 null */
  memberIds(characterId: number): number[] | null {
    const party = partyOf.get(characterId);
    return party ? [...party.members.keys()] : null;
  },

  isLeader(characterId: number): boolean {
    return partyOf.get(characterId)?.leaderId === characterId;
  },

  /**
   * 檢查能不能邀請。
   * @returns 可以時回傳 null，否則回傳原因
   */
  inviteError(inviterId: number, targetId: number): string | null {
    const party = partyOf.get(inviterId);
    if (partyOf.has(targetId)) {
      return '對方已經有隊伍了';
    }
    if (party && party.leaderId !== inviterId) {
      return '只有隊長可以邀請';
    }
    if (party && party.members.size >= PARTY_MAX_MEMBERS) {
      return '隊伍已滿';
    }
    return null;
  },

  /** 對方接受邀請：加入邀請者的隊伍（邀請者還沒有隊伍時建立一個） */
  join(
    inviter: { characterId: number; name: string; level: number },
    member: { characterId: number; name: string; level: number },
  ): string | null {
    const error = this.inviteError(inviter.characterId, member.characterId);
    if (error) {
      return error;
    }
    let party = partyOf.get(inviter.characterId);
    if (!party) {
      party = { leaderId: inviter.characterId, members: new Map() };
      party.members.set(inviter.characterId, { name: inviter.name, level: inviter.level });
      partyOf.set(inviter.characterId, party);
    }
    party.members.set(member.characterId, { name: member.name, level: member.level });
    partyOf.set(member.characterId, party);
    notify(party);
    return null;
  },

  leave(characterId: number): void {
    remove(characterId);
  },

  kick(leaderId: number, targetId: number): string | null {
    const party = partyOf.get(leaderId);
    if (!party || party.leaderId !== leaderId) {
      return '只有隊長可以請離隊員';
    }
    if (targetId === leaderId || !party.members.has(targetId)) {
      return '對方不在隊伍中';
    }
    remove(targetId);
    return null;
  },

  /** 傳送隊伍內容給某位玩家（沒有隊伍時傳空的） */
  sendTo(characterId: number): void {
    const party = partyOf.get(characterId);
    hub.get(characterId)?.send(MSG.party, party ? describe(party) : ({ members: [] } satisfies PartyMessage));
  },

  /** 玩家進入房間（登入或切換地圖完成） */
  onOnline(characterId: number): void {
    pendingTransfer.delete(characterId);
    const party = partyOf.get(characterId);
    if (party) {
      notify(party);
    }
  },

  /** 玩家離開房間：切換地圖時保留隊伍一小段時間，其他情況（登出、斷線）直接離隊 */
  onOffline(characterId: number, transferring: boolean): void {
    const party = partyOf.get(characterId);
    if (!party) {
      return;
    }
    if (transferring) {
      pendingTransfer.set(characterId, Date.now() + TRANSFER_GRACE_MS);
      notify(party);
    } else {
      remove(characterId);
    }
  },
};
