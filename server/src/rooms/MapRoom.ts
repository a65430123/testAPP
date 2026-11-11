// 地圖房間：一張地圖一個房間。移動、聊天、傳送都在這裡由伺服器判定。

import { Room, ServerError, type Client } from 'colyseus';
import {
  advanceMove,
  CHAT_MIN_INTERVAL_MS,
  CLOSE_CODE,
  createMoveState,
  currentTile,
  findPath,
  inBounds,
  isWalkable,
  MOVE_MIN_INTERVAL_MS,
  MSG,
  PLAYER_MOVE_SPEED,
  portalAt,
  ROOM_MAX_CLIENTS,
  sanitizeChatText,
  SERVER_TICK_MS,
  type ChatChannel,
  type ChatMessage,
  type JoinMapOptions,
  type MoveRejectMessage,
  type MoveState,
  type SystemMessage,
  type TransferMessage,
} from '@starmemory/shared';
import { getAccountByToken, type Account } from '../accounts';
import { getMap, type GameMap } from '../maps';
import { MapState, PlayerState } from './schema';

/** 世界頻道在各房間之間轉送用的主題名稱 */
const WORLD_CHAT_TOPIC = 'chat:world';
/** 送出切換地圖通知後，用戶端最多有多久時間離開房間（毫秒） */
const TRANSFER_TIMEOUT_MS = 5000;

/** 每位玩家只存在伺服器、不同步給用戶端的資料 */
interface PlayerRuntime {
  account: Account;
  client: Client;
  state: PlayerState;
  move: MoveState;
  lastMoveAt: number;
  lastChatAt: number;
  /** 已踩到傳送點、正在等用戶端換房間 */
  transferring: boolean;
}

export class MapRoom extends Room<{ state: MapState }> {
  override maxClients = ROOM_MAX_CLIENTS;
  override patchRate = SERVER_TICK_MS;
  override state = new MapState();

  private map!: GameMap;
  private readonly runtimes = new Map<string, PlayerRuntime>();
  private readonly onWorldChat = (message: ChatMessage): void => {
    this.broadcast(MSG.chat, message);
  };

  override async onCreate(options: { mapId?: string }): Promise<void> {
    const map = typeof options.mapId === 'string' ? getMap(options.mapId) : undefined;
    if (!map) {
      throw new ServerError(400, `不存在的地圖：${String(options.mapId)}`);
    }
    this.map = map;
    this.state.mapId = map.id;

    this.onMessage(MSG.move, (client, message: unknown) => this.handleMove(client, message));
    this.onMessage(MSG.chat, (client, message: unknown) => this.handleChat(client, message));
    this.setSimulationInterval((deltaMs) => this.tick(deltaMs), SERVER_TICK_MS);
    await this.presence.subscribe(WORLD_CHAT_TOPIC, this.onWorldChat);
  }

  /** 驗證憑證，並確認角色真的位於這張地圖（用戶端不能自己決定要進哪張地圖） */
  override onAuth(_client: Client, options: Partial<JoinMapOptions>): Account {
    const account = getAccountByToken(options?.token);
    if (!account) {
      throw new ServerError(401, '登入已失效，請重新登入');
    }
    if (account.mapId !== this.map.id) {
      throw new ServerError(403, '角色不在這張地圖');
    }
    return account;
  }

  override onJoin(client: Client, _options: unknown, account: Account): void {
    // 同一帳號已在線上：把舊連線踢掉
    account.kick?.();

    // 存檔位置若已不可站立（例如地圖改版），退回預設出生點
    if (!isWalkable(this.map.grid, Math.floor(account.x), Math.floor(account.y))) {
      account.x = this.map.spawn.x;
      account.y = this.map.spawn.y;
    }

    const state = new PlayerState();
    state.name = account.name;
    state.x = account.x;
    state.y = account.y;
    this.state.players.set(client.sessionId, state);

    this.runtimes.set(client.sessionId, {
      account,
      client,
      state,
      move: createMoveState(account.x, account.y),
      lastMoveAt: 0,
      lastChatAt: 0,
      transferring: false,
    });
    account.activeSessionId = client.sessionId;
    account.kick = () => client.leave(CLOSE_CODE.duplicateLogin);

    this.sendSystem(`${account.name} 來到了${this.map.displayName}`, client);
  }

  override onLeave(client: Client): void {
    const runtime = this.runtimes.get(client.sessionId);
    if (!runtime) {
      return;
    }
    this.runtimes.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
    const { account } = runtime;
    // 只有在這條連線仍是帳號的有效連線時才清除，避免把新連線的資料清掉
    if (account.activeSessionId === client.sessionId) {
      account.activeSessionId = null;
      account.kick = null;
    }
  }

  override onDispose(): void {
    this.presence.unsubscribe(WORLD_CHAT_TOPIC, this.onWorldChat);
  }

  // ------------------------------------------------------------ 訊息處理

  /** 移動要求：只接受「目標格」，路徑與實際位置都由伺服器計算 */
  private handleMove(client: Client, message: unknown): void {
    const runtime = this.runtimes.get(client.sessionId);
    if (!runtime || runtime.transferring) {
      return;
    }
    const now = Date.now();
    if (now - runtime.lastMoveAt < MOVE_MIN_INTERVAL_MS) {
      return; // 送太快，直接忽略
    }
    runtime.lastMoveAt = now;

    const target = message as { x?: unknown; y?: unknown } | null;
    const x = target?.x;
    const y = target?.y;
    const valid =
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      inBounds(this.map.grid, x as number, y as number) &&
      isWalkable(this.map.grid, x as number, y as number);
    const path = valid
      ? findPath(this.map.grid, currentTile(runtime.move), { x: x as number, y: y as number })
      : null;
    if (!path) {
      const reject: MoveRejectMessage = { x: runtime.move.x, y: runtime.move.y };
      client.send(MSG.moveReject, reject);
      return;
    }
    runtime.move.path = path;
  }

  private handleChat(client: Client, message: unknown): void {
    const runtime = this.runtimes.get(client.sessionId);
    if (!runtime) {
      return;
    }
    const payload = message as { channel?: unknown; text?: unknown } | null;
    const text = sanitizeChatText(payload?.text);
    if (!text) {
      return;
    }
    const now = Date.now();
    if (now - runtime.lastChatAt < CHAT_MIN_INTERVAL_MS) {
      const warn: SystemMessage = { text: '發言太頻繁，請稍候再試' };
      client.send(MSG.system, warn);
      return;
    }
    runtime.lastChatAt = now;

    const channel: ChatChannel = payload?.channel === 'world' ? 'world' : 'map';
    const chat: ChatMessage = {
      channel,
      sessionId: client.sessionId,
      name: runtime.account.name,
      text,
    };
    if (channel === 'world') {
      // 透過 presence 發佈，所有地圖房間（包含自己）都會收到並轉送給房內玩家
      this.presence.publish(WORLD_CHAT_TOPIC, chat);
    } else {
      this.broadcast(MSG.chat, chat);
    }
  }

  // ------------------------------------------------------------ 模擬

  /** 每個 tick 推進所有玩家的移動，並檢查是否踩到傳送點 */
  private tick(deltaMs: number): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.transferring) {
        continue;
      }
      const { move, state, account } = runtime;
      if (!advanceMove(move, deltaMs / 1000, PLAYER_MOVE_SPEED)) {
        continue;
      }
      state.x = move.x;
      state.y = move.y;
      account.x = move.x;
      account.y = move.y;

      const tile = currentTile(move);
      const portal = portalAt(this.map.portals, tile.x, tile.y);
      if (portal) {
        this.startTransfer(runtime, portal.targetMap, portal.targetX, portal.targetY);
      }
    }
  }

  /** 把角色的存檔位置改到目標地圖，通知用戶端改連那張地圖的房間 */
  private startTransfer(runtime: PlayerRuntime, mapId: string, tileX: number, tileY: number): void {
    const { account, client } = runtime;
    runtime.transferring = true;
    runtime.move.path = [];
    account.mapId = mapId;
    account.x = tileX + 0.5;
    account.y = tileY + 0.5;

    const transfer: TransferMessage = { mapId };
    client.send(MSG.transfer, transfer);
    // 用戶端遲遲不離開就強制中斷，避免角色卡在舊房間
    this.clock.setTimeout(() => {
      if (this.runtimes.get(client.sessionId) === runtime) {
        client.leave(CLOSE_CODE.transferTimeout);
      }
    }, TRANSFER_TIMEOUT_MS);
  }

  private sendSystem(text: string, except?: Client): void {
    const message: SystemMessage = { text };
    this.broadcast(MSG.system, message, except ? { except } : undefined);
  }
}
