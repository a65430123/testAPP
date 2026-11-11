// 地圖房間：一張地圖一個房間。移動、聊天、傳送、存檔都在這裡由伺服器處理。

import { Room, ServerError, type Client } from 'colyseus';
import {
  addItemToInventory,
  advanceMove,
  AUTOSAVE_INTERVAL_MS,
  CHAT_MIN_INTERVAL_MS,
  CLOSE_CODE,
  createMoveState,
  currentTile,
  findPath,
  getItemDef,
  inBounds,
  isWalkable,
  MAX_LEVEL,
  MOVE_MIN_INTERVAL_MS,
  MSG,
  PLAYER_MOVE_SPEED,
  portalAt,
  ROOM_MAX_CLIENTS,
  sanitizeChatText,
  SERVER_TICK_MS,
  type ChatChannel,
  type ChatMessage,
  type InventoryMessage,
  type JoinMapOptions,
  type MoveRejectMessage,
  type MoveState,
  type SystemMessage,
  type TransferMessage,
} from '@starmemory/shared';
import { verifyToken } from '../auth';
import { config } from '../config';
import { loadCharacter, saveCharacter, type CharacterRecord } from '../db/characters';
import { getMap, type GameMap } from '../maps';
import { clearOnline, getOnline, setOnline, type OnlineEntry } from '../online';
import { MapState, PlayerState } from './schema';

/** 世界頻道在各房間之間轉送用的主題名稱 */
const WORLD_CHAT_TOPIC = 'chat:world';
/** 送出切換地圖通知後，用戶端最多有多久時間離開房間（毫秒） */
const TRANSFER_TIMEOUT_MS = 5000;
/** 同一玩家要求背包內容的最短間隔（毫秒） */
const INVENTORY_REQUEST_MIN_INTERVAL_MS = 1000;
/** 踢掉舊連線時，最多等它的離線存檔多久（毫秒） */
const KICK_WAIT_MS = 5000;

/** 每位玩家只存在伺服器、不同步給用戶端的資料 */
interface PlayerRuntime {
  /** 角色資料（記憶體中的最新狀態，存檔時寫回資料庫） */
  record: CharacterRecord;
  client: Client;
  state: PlayerState;
  move: MoveState;
  lastMoveAt: number;
  lastChatAt: number;
  lastInventoryRequestAt: number;
  /** 位置、等級等資料自上次存檔後有變動 */
  dirty: boolean;
  /** 背包自上次存檔後有變動 */
  inventoryDirty: boolean;
  /** 已踩到傳送點、正在等用戶端換房間 */
  transferring: boolean;
  /** 傳送時已經存過檔，離開房間時不必再存 */
  savedForTransfer: boolean;
  online: OnlineEntry;
  /** 離線存檔完成時呼叫，讓等待中的新連線繼續 */
  resolveLeft: () => void;
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
    this.onMessage(MSG.inventory, (client) => this.handleInventoryRequest(client));
    this.setSimulationInterval((deltaMs) => this.tick(deltaMs), SERVER_TICK_MS);
    this.clock.setInterval(() => this.autosave(), AUTOSAVE_INTERVAL_MS);
    await this.presence.subscribe(WORLD_CHAT_TOPIC, this.onWorldChat);
  }

  /**
   * 驗證 JWT、從資料庫載入角色，並確認：角色屬於這個帳號、角色真的位於這張地圖。
   * 用戶端不能自己決定要進哪張地圖或使用別人的角色。
   */
  override async onAuth(_client: Client, options: Partial<JoinMapOptions>): Promise<CharacterRecord> {
    const identity = verifyToken(options?.token);
    if (!identity) {
      throw new ServerError(401, '登入已失效，請重新登入');
    }
    const characterId = options?.characterId;
    if (typeof characterId !== 'number' || !Number.isInteger(characterId)) {
      throw new ServerError(400, '未指定角色');
    }

    // 同一帳號已有角色在線上：先踢掉舊連線並等它存檔完成，才不會讀到舊資料
    const existing = getOnline(identity.accountId);
    if (existing) {
      await existing.kick();
    }

    const record = await loadCharacter(characterId);
    if (!record || record.accountId !== identity.accountId) {
      throw new ServerError(403, '角色不存在');
    }
    if (record.mapId !== this.map.id) {
      throw new ServerError(403, '角色不在這張地圖');
    }
    return record;
  }

  override onJoin(client: Client, _options: unknown, record: CharacterRecord): void {
    // 兩條連線幾乎同時通過驗證的情況：只讓第一條進來
    if (getOnline(record.accountId)) {
      throw new ServerError(409, '此帳號已有角色在線上');
    }

    // 存檔位置若已不可站立（例如地圖改版），退回預設出生點
    let dirty = false;
    if (!isWalkable(this.map.grid, Math.floor(record.x), Math.floor(record.y))) {
      record.x = this.map.spawn.x;
      record.y = this.map.spawn.y;
      dirty = true;
    }

    const state = new PlayerState();
    state.name = record.name;
    state.classId = record.classId;
    state.level = record.level;
    state.x = record.x;
    state.y = record.y;
    this.state.players.set(client.sessionId, state);

    let resolveLeft: () => void = () => undefined;
    const left = new Promise<void>((resolve) => {
      resolveLeft = resolve;
    });
    const online: OnlineEntry = {
      characterId: record.id,
      kick: () => {
        client.leave(CLOSE_CODE.duplicateLogin);
        // 等離線存檔完成；萬一卡住，逾時後仍放行
        return Promise.race([left, new Promise<void>((resolve) => setTimeout(resolve, KICK_WAIT_MS))]);
      },
    };
    setOnline(record.accountId, online);

    this.runtimes.set(client.sessionId, {
      record,
      client,
      state,
      move: createMoveState(record.x, record.y),
      lastMoveAt: 0,
      lastChatAt: 0,
      lastInventoryRequestAt: 0,
      dirty,
      inventoryDirty: false,
      transferring: false,
      savedForTransfer: false,
      online,
      resolveLeft,
    });

    this.sendSystem(`${record.name} 來到了${this.map.displayName}`, client);
  }

  /** 離線存檔：玩家離開房間（關閉網頁、斷線、被踢、伺服器關機）時立即寫入資料庫 */
  override async onLeave(client: Client): Promise<void> {
    const runtime = this.runtimes.get(client.sessionId);
    if (!runtime) {
      return;
    }
    this.runtimes.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
    try {
      if (!runtime.savedForTransfer) {
        await saveCharacter(runtime.record, true);
      }
    } catch (err) {
      console.error(`[room ${this.map.id}] 角色 ${runtime.record.name} 離線存檔失敗：`, err);
    } finally {
      clearOnline(runtime.record.accountId, runtime.online);
      runtime.resolveLeft();
    }
  }

  override onDispose(): void {
    this.presence.unsubscribe(WORLD_CHAT_TOPIC, this.onWorldChat);
  }

  // ------------------------------------------------------------ 存檔

  /** 定時存檔：只寫入自上次存檔後有變動的角色 */
  private autosave(): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.transferring || (!runtime.dirty && !runtime.inventoryDirty)) {
        continue;
      }
      const withInventory = runtime.inventoryDirty;
      // 先清除旗標：存檔期間若又有變動，會重新被標記，下一輪再存
      runtime.dirty = false;
      runtime.inventoryDirty = false;
      saveCharacter(runtime.record, withInventory).catch((err: unknown) => {
        // 失敗就把旗標設回來，下一輪重試
        runtime.dirty = true;
        runtime.inventoryDirty = runtime.inventoryDirty || withInventory;
        console.error(`[room ${this.map.id}] 角色 ${runtime.record.name} 定時存檔失敗：`, err);
      });
    }
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
      this.sendSystemTo(client, '發言太頻繁，請稍候再試');
      return;
    }
    runtime.lastChatAt = now;

    // GM 指令只在伺服器設定開啟時有效；未開啟時當成一般聊天內容
    if (config.gmCommands && text.startsWith('/gm ')) {
      this.handleGmCommand(runtime, text.slice(4).trim());
      return;
    }

    const channel: ChatChannel = payload?.channel === 'world' ? 'world' : 'map';
    const chat: ChatMessage = {
      channel,
      sessionId: client.sessionId,
      name: runtime.record.name,
      text,
    };
    if (channel === 'world') {
      // 透過 presence 發佈，所有地圖房間（包含自己）都會收到並轉送給房內玩家
      this.presence.publish(WORLD_CHAT_TOPIC, chat);
    } else {
      this.broadcast(MSG.chat, chat);
    }
  }

  /** 用戶端準備好接收後會要求一次背包內容（之後有變動時由伺服器主動傳送） */
  private handleInventoryRequest(client: Client): void {
    const runtime = this.runtimes.get(client.sessionId);
    if (!runtime) {
      return;
    }
    const now = Date.now();
    if (now - runtime.lastInventoryRequestAt < INVENTORY_REQUEST_MIN_INTERVAL_MS) {
      return;
    }
    runtime.lastInventoryRequestAt = now;
    this.sendInventory(client, runtime.record);
  }

  /**
   * 開發與測試用的 GM 指令（戰鬥系統完成前，用來驗證等級與背包的存檔）：
   *   /gm level <等級>           設定等級
   *   /gm item <道具代號> [數量]  取得道具
   */
  private handleGmCommand(runtime: PlayerRuntime, command: string): void {
    const { record, client, state } = runtime;
    const [name, ...args] = command.split(/\s+/);
    if (name === 'level') {
      const level = Number(args[0]);
      if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
        this.sendSystemTo(client, `等級需為 1–${MAX_LEVEL} 的整數`);
        return;
      }
      record.level = level;
      record.exp = 0;
      state.level = level;
      runtime.dirty = true;
      this.sendSystemTo(client, `等級已設為 ${level}`);
      return;
    }
    if (name === 'item') {
      const def = getItemDef(args[0] ?? '');
      const quantity = args[1] === undefined ? 1 : Number(args[1]);
      if (!def) {
        this.sendSystemTo(client, `沒有這個道具：${args[0] ?? ''}`);
        return;
      }
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
        this.sendSystemTo(client, '數量需為 1–999 的整數');
        return;
      }
      if (!addItemToInventory(record.inventory, def.id, quantity)) {
        this.sendSystemTo(client, '背包放不下');
        return;
      }
      runtime.inventoryDirty = true;
      this.sendInventory(client, record);
      this.sendSystemTo(client, `取得 ${def.name} ×${quantity}`);
      return;
    }
    this.sendSystemTo(client, '可用指令：/gm level <等級>、/gm item <道具代號> [數量]');
  }

  // ------------------------------------------------------------ 模擬

  /** 每個 tick 推進所有玩家的移動，並檢查是否踩到傳送點 */
  private tick(deltaMs: number): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.transferring) {
        continue;
      }
      const { move, state, record } = runtime;
      if (!advanceMove(move, deltaMs / 1000, PLAYER_MOVE_SPEED)) {
        continue;
      }
      state.x = move.x;
      state.y = move.y;
      record.x = move.x;
      record.y = move.y;
      runtime.dirty = true;

      const tile = currentTile(move);
      const portal = portalAt(this.map.portals, tile.x, tile.y);
      if (portal) {
        void this.startTransfer(runtime, portal.targetMap, portal.targetX, portal.targetY);
      }
    }
  }

  /**
   * 傳送：把角色的位置改到目標地圖並立即存檔，存檔成功後才通知用戶端改連那張地圖的房間
   * （新房間會從資料庫載入角色，所以必須先存好）。
   */
  private async startTransfer(runtime: PlayerRuntime, mapId: string, tileX: number, tileY: number): Promise<void> {
    const { record, client } = runtime;
    const before = { mapId: record.mapId, x: record.x, y: record.y };
    runtime.transferring = true;
    runtime.move.path = [];
    record.mapId = mapId;
    record.x = tileX + 0.5;
    record.y = tileY + 0.5;

    try {
      await saveCharacter(record, true);
    } catch (err) {
      // 存檔失敗就取消傳送，角色留在原地
      console.error(`[room ${this.map.id}] 角色 ${record.name} 傳送存檔失敗：`, err);
      record.mapId = before.mapId;
      record.x = before.x;
      record.y = before.y;
      runtime.transferring = false;
      this.sendSystemTo(client, '傳送失敗，請稍後再試');
      return;
    }
    if (this.runtimes.get(client.sessionId) !== runtime) {
      return; // 存檔期間玩家已離線
    }
    runtime.savedForTransfer = true;
    runtime.dirty = false;
    runtime.inventoryDirty = false;

    const transfer: TransferMessage = { mapId };
    client.send(MSG.transfer, transfer);
    // 用戶端遲遲不離開就強制中斷，避免角色卡在舊房間
    this.clock.setTimeout(() => {
      if (this.runtimes.get(client.sessionId) === runtime) {
        client.leave(CLOSE_CODE.transferTimeout);
      }
    }, TRANSFER_TIMEOUT_MS);
  }

  // ------------------------------------------------------------ 傳送訊息

  /** 把背包內容傳給本人（背包是私人資料，不放在同步狀態裡） */
  private sendInventory(client: Client, record: CharacterRecord): void {
    const message: InventoryMessage = { items: record.inventory, coins: record.coins };
    client.send(MSG.inventory, message);
  }

  private sendSystem(text: string, except?: Client): void {
    const message: SystemMessage = { text };
    this.broadcast(MSG.system, message, except ? { except } : undefined);
  }

  private sendSystemTo(client: Client, text: string): void {
    const message: SystemMessage = { text };
    client.send(MSG.system, message);
  }
}
