import Phaser from 'phaser';
import {
  advanceMove,
  buildCollisionGrid,
  cleanGid,
  CLOSE_CODE,
  createMoveState,
  currentTile,
  findPath,
  findNpcs,
  findPortals,
  getMonsterDef,
  getNpcDef,
  getTileLayer,
  getTileset,
  inBounds,
  isMoving,
  MAP_LAYER,
  mapGeometry,
  mapWorldBounds,
  MOVE_MIN_INTERVAL_MS,
  MSG,
  nearestWalkable,
  NPC_RANGE,
  PICKUP_RANGE,
  PLAYER_MOVE_SPEED,
  REVIVE_DELAY_MS,
  SERVER_TICK_MS,
  SnapshotBuffer,
  tileCenterToWorld,
  tileToWorld,
  worldToTile,
  type AllocStatRequest,
  type AttackRequest,
  type ChatChannel,
  type ChatMessage,
  type ChatSendMessage,
  type FriendsMessage,
  type GuildMessage,
  type PartyMessage,
  type QuestsMessage,
  type SocialInviteMessage,
  type CollisionGrid,
  type CombatEvent,
  type InventoryMessage,
  type IsoGeometry,
  type MoveRejectMessage,
  type MoveRequest,
  type MoveState,
  type PickupRequest,
  type SelfMessage,
  type SkillDef,
  type SkillRequest,
  type StorageMessage,
  type Stats,
  type SystemMessage,
  type TiledMap,
  type TilePoint,
  type TradeEndMessage,
  type TradeInviteMessage,
  type TradeStateMessage,
  type TransferMessage,
} from '@starmemory/shared';
import { mapDisplayName, MAPS, MONSTER_FRAME, PLAYER_FRAME, REGISTRY, TEXTURE } from '../assets';
import { DropEntity } from '../entities/DropEntity';
import { ENTITY_KEY, ENTITY_KIND, MonsterEntity } from '../entities/MonsterEntity';
import { NpcEntity } from '../entities/NpcEntity';
import { PlayerEntity } from '../entities/PlayerEntity';
import {
  joinMap,
  stateCallbacks,
  type DropView,
  type MapRoomConnection,
  type MonsterView,
  type PlayerView,
  type Session,
} from '../net/session';
import type { ChatBox } from '../ui/chat';
import type { ItemUi } from '../ui/ItemUi';
import type { QuestUi } from '../ui/quests';
import type { SocialUi } from '../ui/social';
import type { SkillBar } from '../ui/skills';
import type { StatusPanel } from '../ui/status';

/** 按住滑鼠時每隔多久重新指定一次目的地（毫秒） */
const HOLD_RETARGET_MS = 200;
/** 用戶端送出移動指令的最短間隔，略大於伺服器的限制，避免因網路抖動被伺服器忽略 */
const MOVE_SEND_INTERVAL_MS = MOVE_MIN_INTERVAL_MS + 40;
/** 其他玩家與魔物的畫面比伺服器資料晚這麼久（毫秒），取樣點前後才有資料可內插 */
const INTERP_DELAY_MS = SERVER_TICK_MS * 2;
/** 自己的預測位置與伺服器位置相差超過這個距離（格）就直接拉回 */
const SNAP_DISTANCE = 2.5;
/** 停下後若與伺服器位置有小誤差，等伺服器也停下這麼久（毫秒）後再慢慢修正 */
const SETTLE_DELAY_MS = 250;
/** 撿取時比伺服器的距離限制多留一點餘裕（格） */
const PICKUP_MARGIN = 0.3;
/** 鏡頭邊界在地圖外額外保留的空間（像素） */
const CAMERA_PADDING = 120;
/** 地面層的繪製深度（永遠在所有物件之下） */
const GROUND_DEPTH = -100000;
/** 介面文字的繪製深度 */
const UI_DEPTH = 1000000;

/** 其他玩家：畫面物件 + 位置插值緩衝 */
interface RemotePlayer {
  entity: PlayerEntity;
  buffer: SnapshotBuffer;
  /** 最後一次收到的伺服器位置，用來分辨這次變動是不是位置變動 */
  lastX: number;
  lastY: number;
}

interface RemoteMonster {
  entity: MonsterEntity;
  buffer: SnapshotBuffer;
  lastX: number;
  lastY: number;
}

/**
 * 世界場景：顯示一張地圖並連上該地圖的房間。
 * - 自己走路：點擊後先在本機預測移動（立即有反應），再以伺服器位置校正
 * - 自己戰鬥：點魔物後由伺服器帶著角色追擊與普攻，用戶端改為跟隨伺服器位置
 * - 其他玩家與魔物：依伺服器位置插值顯示
 * - 踩到傳送點或倒地復活時由伺服器通知，重啟本場景並改連另一張地圖的房間
 */
export class WorldScene extends Phaser.Scene {
  private mapId!: string;
  private mapData!: TiledMap;
  private geo!: IsoGeometry;
  private grid!: CollisionGrid;
  private session!: Session;
  private chat!: ChatBox;
  private itemUi!: ItemUi;
  private socialUi!: SocialUi;
  private questUi!: QuestUi;
  private statusPanel!: StatusPanel;
  private skillBar!: SkillBar;

  private room: MapRoomConnection | null = null;
  private local: PlayerEntity | null = null;
  private move: MoveState | null = null;
  private readonly remotes = new Map<string, RemotePlayer>();
  private readonly monsters = new Map<string, RemoteMonster>();
  private readonly drops = new Map<string, DropEntity>();

  /** 伺服器認定的自己位置，以及最後一次變動的時間 */
  private serverX = 0;
  private serverY = 0;
  private serverChangedAt = 0;
  /** true：位置完全跟隨伺服器（戰鬥中由伺服器帶著走）；false：本機預測 */
  private serverDriven = false;
  private readonly selfBuffer = new SnapshotBuffer(SERVER_TICK_MS);
  /** 最後一次要求前往的目標格 */
  private lastTarget: TilePoint | null = null;
  /** 因送出間隔限制而暫存、尚未送給伺服器的目標格 */
  private pendingTarget: TilePoint | null = null;
  /** 正在走過去準備撿的掉落物 */
  private pendingPickup: string | null = null;
  /** 正在走過去準備交談的 NPC */
  private pendingNpc: string | null = null;
  /** 這張地圖上各 NPC 的位置（格座標） */
  private readonly npcPositions = new Map<string, { x: number; y: number }>();
  /** 目前選取的魔物 */
  private selectedKey: string | null = null;
  private lastSendAt = 0;
  private lastRetargetAt = 0;
  /** 這次按下滑鼠是點在地面上（按住可持續移動） */
  private holdingGround = false;
  private level = 0;
  private dead = false;
  private transferring = false;
  private closed = false;

  private marker!: Phaser.GameObjects.Graphics;
  private targetRing!: Phaser.GameObjects.Graphics;
  private hud!: Phaser.GameObjects.Text;
  private status!: Phaser.GameObjects.Text;

  constructor() {
    super('World');
  }

  /** 場景每次（重新）啟動時重設狀態 */
  init(): void {
    this.room = null;
    this.local = null;
    this.move = null;
    this.remotes.clear();
    this.monsters.clear();
    this.drops.clear();
    this.serverDriven = false;
    this.lastTarget = null;
    this.pendingTarget = null;
    this.pendingPickup = null;
    this.pendingNpc = null;
    this.npcPositions.clear();
    this.selectedKey = null;
    this.lastSendAt = 0;
    this.lastRetargetAt = 0;
    this.holdingGround = false;
    this.level = 0;
    this.dead = false;
    this.transferring = false;
    this.closed = false;
  }

  create(data: { mapId: string }): void {
    const mapData = MAPS[data.mapId];
    if (!mapData) {
      throw new Error(`找不到地圖：${data.mapId}`);
    }
    this.mapId = data.mapId;
    this.mapData = mapData;
    this.geo = mapGeometry(mapData);
    this.grid = buildCollisionGrid(mapData);
    this.session = this.registry.get(REGISTRY.session) as Session;
    this.chat = this.registry.get(REGISTRY.chat) as ChatBox;
    this.itemUi = this.registry.get(REGISTRY.itemUi) as ItemUi;
    this.socialUi = this.registry.get(REGISTRY.socialUi) as SocialUi;
    this.questUi = this.registry.get(REGISTRY.questUi) as QuestUi;
    this.statusPanel = this.registry.get(REGISTRY.status) as StatusPanel;
    this.skillBar = this.registry.get(REGISTRY.skills) as SkillBar;

    this.createGround();
    this.createProps();
    this.createPortals();
    this.createNpcs();
    this.createMarkers();
    this.createUi();
    this.setupCamera();
    this.setupInput();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.onShutdown());
    this.cameras.main.fadeIn(250);
    void this.connect();
  }

  // ------------------------------------------------------------ 建立場景內容

  /** 地面層：交給 Phaser 的斜視角圖磚層繪製 */
  private createGround(): void {
    const map = this.make.tilemap({ key: this.mapId });
    const tileset = map.addTilesetImage(MAP_LAYER.ground, TEXTURE.ground);
    if (!tileset) {
      throw new Error('地面圖磚集載入失敗');
    }
    // shared 的座標系以格 (0,0) 的上頂點為原點，而 Phaser 以該格圖片的左上角為準，所以往左移半格寬
    const layer = map.createLayer(MAP_LAYER.ground, tileset, -this.geo.tileWidth / 2, 0);
    if (!layer) {
      throw new Error('地面圖層建立失敗');
    }
    layer.setDepth(GROUND_DEPTH);
    // 放寬裁切範圍，避免斜視角圖層在鏡頭邊緣漏畫
    layer.setCullPadding(4, 4);
  }

  /** 物件層（樹、石頭、小屋…）：每格建立一個圖片物件，依畫面 y 排序，才能正確前後遮擋 */
  private createProps(): void {
    const layer = getTileLayer(this.mapData, MAP_LAYER.props);
    const tileset = getTileset(this.mapData, MAP_LAYER.props);
    if (!layer || !tileset) {
      return;
    }
    const halfH = this.geo.tileHeight / 2;
    for (let ty = 0; ty < layer.height; ty++) {
      for (let tx = 0; tx < layer.width; tx++) {
        const gid = cleanGid(layer.data[ty * layer.width + tx] ?? 0);
        if (gid === 0) {
          continue;
        }
        const center = tileCenterToWorld(tx, ty, this.geo);
        // 圖片底邊中央對齊該格菱形的下頂點（與 Tiled 的顯示方式一致）
        this.add
          .image(center.x, center.y + halfH, TEXTURE.props, gid - tileset.firstgid)
          .setOrigin(0.5, 1)
          .setDepth(center.y);
      }
    }
  }

  /** 傳送點：在地面畫出發亮的菱形與目的地名稱（實際傳送由伺服器判定） */
  private createPortals(): void {
    const halfW = this.geo.tileWidth / 2;
    const halfH = this.geo.tileHeight / 2;
    for (const portal of findPortals(this.mapData)) {
      const glow = this.add.graphics().setDepth(GROUND_DEPTH + 1);
      glow.fillStyle(0xb48cff, 0.55);
      glow.lineStyle(2, 0xe6d8ff, 0.9);
      for (let ty = Math.floor(portal.y); ty < portal.y + portal.height; ty++) {
        for (let tx = Math.floor(portal.x); tx < portal.x + portal.width; tx++) {
          const c = tileCenterToWorld(tx, ty, this.geo);
          glow.beginPath();
          glow.moveTo(c.x, c.y - halfH);
          glow.lineTo(c.x + halfW, c.y);
          glow.lineTo(c.x, c.y + halfH);
          glow.lineTo(c.x - halfW, c.y);
          glow.closePath();
          glow.fillPath();
          glow.strokePath();
        }
      }
      this.tweens.add({ targets: glow, alpha: 0.45, duration: 900, yoyo: true, repeat: -1 });

      const center = tileCenterToWorld(
        portal.x + portal.width / 2 - 0.5,
        portal.y + portal.height / 2 - 0.5,
        this.geo,
      );
      this.add
        .text(center.x, center.y - 30, `往 ${mapDisplayName(portal.targetMap)}`, {
          fontSize: '14px',
          color: '#f1e8ff',
          stroke: '#3a2a66',
          strokeThickness: 4,
        })
        .setOrigin(0.5, 1)
        .setDepth(UI_DEPTH - 1);
    }
  }

  /** NPC：位置來自地圖的 npcs 物件層，內容來自資料表 */
  private createNpcs(): void {
    for (const placement of findNpcs(this.mapData)) {
      const def = getNpcDef(placement.npcId);
      if (!def) {
        continue;
      }
      this.npcPositions.set(def.id, { x: placement.x, y: placement.y });
      new NpcEntity(this, this.geo, def, placement.x, placement.y);
    }
  }

  /** 目的地標記（會淡出的菱形）與攻擊目標標記（魔物腳下的紅圈） */
  private createMarkers(): void {
    const halfW = this.geo.tileWidth / 2;
    const halfH = this.geo.tileHeight / 2;
    this.marker = this.add.graphics();
    this.marker.lineStyle(2, 0xffffff, 0.9);
    this.marker.fillStyle(0xffffff, 0.25);
    this.marker.beginPath();
    this.marker.moveTo(0, -halfH);
    this.marker.lineTo(halfW, 0);
    this.marker.lineTo(0, halfH);
    this.marker.lineTo(-halfW, 0);
    this.marker.closePath();
    this.marker.fillPath();
    this.marker.strokePath();
    this.marker.setDepth(GROUND_DEPTH + 2).setVisible(false);

    this.targetRing = this.add.graphics();
    this.targetRing.lineStyle(2, 0xff5a4a, 0.95);
    this.targetRing.strokeEllipse(0, 0, 44, 20);
    this.targetRing.setDepth(GROUND_DEPTH + 3).setVisible(false);
  }

  private createUi(): void {
    this.hud = this.add
      .text(12, 10, '', {
        fontSize: '14px',
        color: '#ffffff',
        backgroundColor: 'rgba(0,0,0,0.45)',
        padding: { x: 8, y: 6 },
      })
      .setScrollFactor(0)
      .setDepth(UI_DEPTH);

    // 畫面中央的狀態訊息（連線中、倒地、斷線…）
    this.status = this.add
      .text(0, 0, '連線中…', {
        fontSize: '20px',
        color: '#ffffff',
        backgroundColor: 'rgba(0,0,0,0.6)',
        padding: { x: 16, y: 10 },
        align: 'center',
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(UI_DEPTH + 1);
    this.layoutStatus();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.layoutStatus, this);
    this.updateHud();
  }

  private layoutStatus(): void {
    this.status.setPosition(this.scale.width / 2, this.scale.height / 2);
  }

  private setupCamera(): void {
    const bounds = mapWorldBounds(this.mapData.width, this.mapData.height, this.geo);
    const cam = this.cameras.main;
    cam.setBounds(
      bounds.x - CAMERA_PADDING,
      bounds.y - CAMERA_PADDING,
      bounds.width + CAMERA_PADDING * 2,
      bounds.height + CAMERA_PADDING * 2,
    );
    cam.setRoundPixels(true);
    // 連線完成前先看地圖中央
    cam.centerOn(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  }

  private setupInput(): void {
    this.input.on(
      Phaser.Input.Events.POINTER_DOWN,
      (pointer: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => {
        // 點到魔物、掉落物、NPC 或其他玩家：交給對應的處理，不當成移動
        const hit = over.find((obj) => obj.getData(ENTITY_KIND) !== undefined);
        if (hit) {
          this.holdingGround = false;
          const key = hit.getData(ENTITY_KEY) as string;
          const kind = hit.getData(ENTITY_KIND) as string;
          if (kind === 'monster') {
            this.attackMonster(key);
          } else if (kind === 'drop') {
            this.pickUpDrop(key);
          } else if (kind === 'npc') {
            this.talkToNpc(key);
          } else if (kind === 'player') {
            const name = this.remotes.get(key)?.entity.name;
            if (name && !this.dead) {
              this.socialUi.showPlayerMenu(key, name, () => this.itemUi.askTrade(key, name));
            }
          }
          return;
        }
        this.holdingGround = true;
        this.lastRetargetAt = this.time.now;
        this.requestMoveTo(pointer.worldX, pointer.worldY);
      },
    );
  }

  // ------------------------------------------------------------ 連線

  private async connect(): Promise<void> {
    let room: MapRoomConnection;
    try {
      room = await joinMap(this.session, this.mapId);
    } catch (err) {
      this.showFatal(`無法進入地圖：${err instanceof Error ? err.message : '未知錯誤'}\n請重新整理頁面`);
      return;
    }
    // 等待連線期間場景已被關閉（極少見），直接離開房間
    if (this.closed) {
      void room.leave();
      return;
    }
    this.room = room;

    const players = stateCallbacks(room, 'players');
    players.onAdd((player, sessionId) => {
      if (sessionId === room.sessionId) {
        this.addLocalPlayer(player);
      } else {
        this.addRemotePlayer(sessionId, player);
      }
      players.onChange(player, () => this.onPlayerChanged(sessionId, player));
    });
    players.onRemove((_player, sessionId) => {
      this.remotes.get(sessionId)?.entity.destroy();
      this.remotes.delete(sessionId);
    });

    const monsters = stateCallbacks(room, 'monsters');
    monsters.onAdd((monster, key) => {
      this.addMonster(key, monster);
      monsters.onChange(monster, () => this.onMonsterChanged(key, monster));
    });
    monsters.onRemove((_monster, key) => this.removeMonster(key));

    const drops = stateCallbacks(room, 'drops');
    drops.onAdd((drop, key) => this.addDrop(key, drop));
    drops.onRemove((_drop, key) => {
      this.drops.get(key)?.destroy();
      this.drops.delete(key);
      if (this.pendingPickup === key) {
        this.pendingPickup = null;
      }
    });

    room.onMessage(MSG.chat, (message: ChatMessage) => this.onChat(message));
    room.onMessage(MSG.system, (message: SystemMessage) => this.chat.addSystem(message.text));
    room.onMessage(MSG.moveReject, (message: MoveRejectMessage) => this.onMoveRejected(message));
    room.onMessage(MSG.transfer, (message: TransferMessage) => void this.onTransfer(message));
    room.onMessage(MSG.inventory, (message: InventoryMessage) => {
      this.itemUi.onInventory(message);
      // 收集類任務的數量以背包為準
      this.questUi.setItemCounter((itemId) =>
        message.items.filter((i) => i.itemId === itemId).reduce((n, i) => n + i.quantity, 0),
      );
    });
    room.onMessage(MSG.quests, (message: QuestsMessage) => this.questUi.onQuests(message));
    room.onMessage(MSG.party, (message: PartyMessage) => this.socialUi.onParty(message));
    room.onMessage(MSG.guild, (message: GuildMessage) => this.socialUi.onGuild(message));
    room.onMessage(MSG.friends, (message: FriendsMessage) => this.socialUi.onFriends(message));
    room.onMessage(MSG.socialInvite, (message: SocialInviteMessage) => this.socialUi.onInvite(message));
    room.onMessage(MSG.storage, (message: StorageMessage) => this.itemUi.onStorage(message));
    room.onMessage(MSG.tradeRequest, (message: TradeInviteMessage) => this.itemUi.onTradeInvite(message));
    room.onMessage(MSG.tradeState, (message: TradeStateMessage) => this.itemUi.onTradeState(message));
    room.onMessage(MSG.tradeEnd, (message: TradeEndMessage) => this.itemUi.onTradeEnd(message));
    room.onMessage(MSG.self, (message: SelfMessage) => this.onSelf(message));
    room.onMessage(MSG.combat, (event: CombatEvent) => this.onCombat(event));
    room.onLeave((code: number) => this.onRoomLeave(code));

    // 介面元件的操作都轉成訊息送給伺服器
    this.chat.onSend((channel: ChatChannel, text: string) => {
      room.send(MSG.chat, { channel, text } satisfies ChatSendMessage);
    });
    this.itemUi.bind(
      (type, message) => room.send(type, message),
      (text) => this.chat.addSystem(text),
    );
    this.questUi.bind((type, message) => room.send(type, message));
    this.statusPanel.onAlloc((stat: keyof Stats) => {
      room.send(MSG.allocStat, { stat } satisfies AllocStatRequest);
    });
    this.skillBar.onUse((skill: SkillDef) => this.useSkill(skill));

    this.chat.addSystem(`已進入 ${mapDisplayName(this.mapId)}`);
    // 處理函式都註冊好了，向伺服器要一次背包、個人數值、任務，以及隊伍、公會、好友
    room.send(MSG.inventory);
    this.socialUi.bind((type, message) => room.send(type, message));
  }

  // ------------------------------------------------------------ 玩家

  private addLocalPlayer(player: PlayerView): void {
    this.move = createMoveState(player.x, player.y);
    this.serverX = player.x;
    this.serverY = player.y;
    this.serverChangedAt = this.time.now;
    this.level = player.level;
    this.local = new PlayerEntity(this, this.geo, player.name, player.level, player.x, player.y, true);
    this.local.setInfo(player.name, player.level, player.guild);
    this.local.setHp(player.hp, player.maxHp);
    this.cameras.main.startFollow(this.local.sprite, true, 0.15, 0.15);
    this.status.setVisible(false);
  }

  private addRemotePlayer(sessionId: string, player: PlayerView): void {
    const buffer = new SnapshotBuffer(SERVER_TICK_MS);
    buffer.reset(performance.now(), player.x, player.y);
    const entity = new PlayerEntity(this, this.geo, player.name, player.level, player.x, player.y, false);
    entity.setInfo(player.name, player.level, player.guild);
    entity.setHp(player.hp, player.maxHp);
    entity.makeClickable(sessionId);
    this.remotes.set(sessionId, { entity, buffer, lastX: player.x, lastY: player.y });
  }

  /** 伺服器同步了某位玩家的新狀態（位置、等級或 HP） */
  private onPlayerChanged(sessionId: string, player: PlayerView): void {
    if (sessionId === this.room?.sessionId) {
      this.onLocalChanged(player);
      return;
    }
    const remote = this.remotes.get(sessionId);
    if (!remote) {
      return;
    }
    remote.entity.setInfo(player.name, player.level, player.guild);
    remote.entity.setHp(player.hp, player.maxHp);
    if (player.x !== remote.lastX || player.y !== remote.lastY) {
      remote.lastX = player.x;
      remote.lastY = player.y;
      remote.buffer.push(performance.now(), player.x, player.y);
    }
  }

  private onLocalChanged(player: PlayerView): void {
    const local = this.local;
    if (!local) {
      return;
    }
    local.setInfo(player.name, player.level, player.guild);
    local.setHp(player.hp, player.maxHp);
    if (player.level > this.level && this.level > 0) {
      this.showFloat(local.sprite.x, local.sprite.y - 90, 'LEVEL UP!', '#ffe14d', 22);
    }
    this.level = player.level;

    if (player.x !== this.serverX || player.y !== this.serverY) {
      this.serverX = player.x;
      this.serverY = player.y;
      this.serverChangedAt = this.time.now;
      this.selfBuffer.push(performance.now(), player.x, player.y);
    }

    const dead = player.hp <= 0;
    if (dead && !this.dead) {
      // 倒地：停止一切操作，位置交給伺服器
      this.enterServerDriven();
      this.selectMonster(null);
      this.pendingPickup = null;
      this.status
        .setText(`你被擊倒了\n${REVIVE_DELAY_MS / 1000} 秒後復活`)
        .setVisible(true);
      this.layoutStatus();
    } else if (!dead && this.dead) {
      this.status.setVisible(false);
    }
    this.dead = dead;
  }

  private onSelf(message: SelfMessage): void {
    this.statusPanel.update(message);
    this.skillBar.setState(message.level, message.sp);
    this.questUi.setLevel(message.level);
  }

  // ------------------------------------------------------------ 魔物與掉落物

  private addMonster(key: string, monster: MonsterView): void {
    const def = getMonsterDef(monster.monsterId);
    if (!def) {
      return; // 用戶端的資料表比伺服器舊：略過不認得的魔物
    }
    const buffer = new SnapshotBuffer(SERVER_TICK_MS);
    buffer.reset(performance.now(), monster.x, monster.y);
    const entity = new MonsterEntity(this, this.geo, key, def, monster.x, monster.y);
    entity.setHp(monster.hp, monster.maxHp);
    this.monsters.set(key, { entity, buffer, lastX: monster.x, lastY: monster.y });
  }

  private onMonsterChanged(key: string, monster: MonsterView): void {
    const remote = this.monsters.get(key);
    if (!remote) {
      return;
    }
    remote.entity.setHp(monster.hp, monster.maxHp);
    if (monster.x !== remote.lastX || monster.y !== remote.lastY) {
      remote.lastX = monster.x;
      remote.lastY = monster.y;
      remote.buffer.push(performance.now(), monster.x, monster.y);
    }
  }

  private removeMonster(key: string): void {
    const remote = this.monsters.get(key);
    if (!remote) {
      return;
    }
    this.monsters.delete(key);
    if (this.selectedKey === key) {
      this.selectMonster(null);
    }
    // 淡出後移除（先取消點擊，避免點到正在消失的魔物）
    const { entity } = remote;
    entity.sprite.disableInteractive();
    this.tweens.add({
      targets: entity.sprite,
      alpha: 0,
      duration: 250,
      onComplete: () => entity.destroy(),
    });
  }

  private addDrop(key: string, drop: DropView): void {
    const mine = drop.owner === '' || drop.owner === this.room?.sessionId;
    this.drops.set(key, new DropEntity(this, this.geo, key, drop.itemId, drop.x, drop.y, mine));
  }

  private selectMonster(key: string | null): void {
    this.selectedKey = key;
    this.targetRing.setVisible(key !== null);
  }

  // ------------------------------------------------------------ 戰鬥操作

  /** 點魔物：選為目標並開始攻擊。之後由伺服器帶著角色追擊與普攻。 */
  private attackMonster(key: string): void {
    if (!this.room || !this.move || this.dead || this.transferring || !this.monsters.has(key)) {
      return;
    }
    this.selectMonster(key);
    this.pendingPickup = null;
    this.enterServerDriven();
    this.room.send(MSG.attack, { targetId: key } satisfies AttackRequest);
  }

  /** 按技能：傷害技能需要先選好目標；對自己施放的技能直接送出 */
  private useSkill(skill: SkillDef): void {
    if (!this.room || this.dead || this.transferring) {
      return;
    }
    if (skill.type === 'heal') {
      this.room.send(MSG.skill, { skillId: skill.id } satisfies SkillRequest);
      return;
    }
    if (!this.selectedKey) {
      this.chat.addSystem('請先點選一隻魔物作為目標');
      return;
    }
    // 施放後伺服器會接著自動普攻（可能帶著角色移動），所以改為跟隨伺服器位置
    this.enterServerDriven();
    this.room.send(MSG.skill, { skillId: skill.id, targetId: this.selectedKey } satisfies SkillRequest);
  }

  /** 點掉落物：夠近就直接撿，否則先走過去 */
  private pickUpDrop(key: string): void {
    const drop = this.drops.get(key);
    if (!drop || !this.room || !this.move || this.dead || this.transferring) {
      return;
    }
    if (this.inPickupRange(drop)) {
      this.room.send(MSG.pickup, { dropId: key } satisfies PickupRequest);
      return;
    }
    const world = tileToWorld(drop.tileX, drop.tileY, this.geo);
    this.requestMoveTo(world.x, world.y);
    this.pendingPickup = key;
  }

  /** 點 NPC：夠近就直接開啟視窗，否則先走到他旁邊 */
  private talkToNpc(npcId: string): void {
    const npc = this.npcPositions.get(npcId);
    if (!npc || !this.room || !this.move || this.dead || this.transferring) {
      return;
    }
    if (this.inNpcRange(npc)) {
      this.itemUi.openNpc(npcId);
      return;
    }
    // 走到 NPC 前方（畫面下方）那一格
    const world = tileToWorld(npc.x, npc.y + 1, this.geo);
    this.requestMoveTo(world.x, world.y);
    this.pendingNpc = npcId;
  }

  private inNpcRange(npc: { x: number; y: number }): boolean {
    return Math.hypot(this.serverX - npc.x, this.serverY - npc.y) <= NPC_RANGE - 0.3;
  }

  /** 以伺服器認定的位置判斷（伺服器也是用它的位置檢查距離） */
  private inPickupRange(drop: DropEntity): boolean {
    return Math.hypot(this.serverX - drop.tileX, this.serverY - drop.tileY) <= PICKUP_RANGE - PICKUP_MARGIN;
  }

  /** 改為跟隨伺服器位置：從目前畫面上的位置開始，平滑接到伺服器送來的位置 */
  private enterServerDriven(): void {
    if (this.serverDriven || !this.move) {
      return;
    }
    this.serverDriven = true;
    this.move.path = [];
    this.lastTarget = null;
    this.pendingTarget = null;
    this.selfBuffer.reset(performance.now(), this.move.x, this.move.y);
    this.selfBuffer.push(performance.now() + SERVER_TICK_MS, this.serverX, this.serverY);
  }

  /** 戰鬥事件：在目標頭上跳出傷害數字 */
  private onCombat(event: CombatEvent): void {
    const myId = this.room?.sessionId;
    const targetIsMe = event.targetId === myId;
    const monster = this.monsters.get(event.targetId);
    const player = targetIsMe ? this.local : this.remotes.get(event.targetId)?.entity;
    const sprite = monster?.entity.sprite ?? player?.sprite;
    if (sprite) {
      const height = monster ? MONSTER_FRAME.footY : PLAYER_FRAME.footY * 1.5;
      const x = sprite.x + Phaser.Math.Between(-8, 8);
      const y = sprite.y - height - 8;
      if (event.type === 'miss') {
        this.showFloat(x, y, 'MISS', '#c0c0c0', 14);
      } else if (event.type === 'heal') {
        this.showFloat(x, y, `+${event.amount}`, '#7dff8a', 16);
      } else {
        const color = targetIsMe ? '#ff6b5e' : event.crit ? '#ffd23f' : '#ffffff';
        this.showFloat(x, y, event.crit ? `${event.amount}!` : `${event.amount}`, color, event.crit ? 22 : 16);
        monster?.entity.flash();
        player?.flash();
      }
    }
    // 伺服器確認我的技能已施放：開始冷卻計時
    if (event.sourceId === myId && event.skillId) {
      this.skillBar.startCooldown(event.skillId);
    }
  }

  /** 往上飄並淡出的文字 */
  private showFloat(x: number, y: number, text: string, color: string, size: number): void {
    const label = this.add
      .text(x, y, text, {
        fontSize: `${size}px`,
        fontStyle: 'bold',
        color,
        stroke: '#000000',
        strokeThickness: 4,
      })
      .setOrigin(0.5, 1)
      .setDepth(UI_DEPTH - 2);
    this.tweens.add({
      targets: label,
      y: y - 36,
      alpha: 0,
      duration: 800,
      ease: 'Quad.easeOut',
      onComplete: () => label.destroy(),
    });
  }

  // ------------------------------------------------------------ 聊天、拒絕、傳送、斷線

  private onChat(message: ChatMessage): void {
    this.chat.addChat(message.channel, message.name, message.text);
    // 地圖頻道的發言同時顯示在角色頭上
    if (message.channel === 'map') {
      const entity =
        message.sessionId === this.room?.sessionId ? this.local : this.remotes.get(message.sessionId)?.entity;
      entity?.say(message.text);
    }
  }

  /** 伺服器拒絕了移動要求：回到伺服器認定的位置 */
  private onMoveRejected(message: MoveRejectMessage): void {
    if (!this.move) {
      return;
    }
    this.move.x = message.x;
    this.move.y = message.y;
    this.move.path = [];
    this.lastTarget = null;
    this.pendingTarget = null;
    this.pendingPickup = null;
    this.local?.setTilePosition(message.x, message.y);
  }

  /** 伺服器通知切換地圖：離開目前房間，重啟場景並連到新地圖的房間 */
  private async onTransfer(message: TransferMessage): Promise<void> {
    if (this.transferring) {
      return;
    }
    this.transferring = true;
    this.session.mapId = message.mapId;
    this.detachUi();
    const room = this.room;
    this.room = null;
    this.cameras.main.fadeOut(200);
    try {
      room?.removeAllListeners();
      await room?.leave();
    } catch {
      // 離開失敗不影響切換；伺服器逾時後會自行中斷舊連線
    }
    this.scene.restart({ mapId: message.mapId });
  }

  private onRoomLeave(code: number): void {
    if (this.transferring || this.closed) {
      return;
    }
    this.room = null;
    this.detachUi();
    const reason = code === CLOSE_CODE.duplicateLogin ? '此角色已在其他地方登入' : '與伺服器的連線已中斷';
    this.showFatal(`${reason}\n請重新整理頁面`);
  }

  /** 讓介面元件不再對已經離開的房間送訊息 */
  private detachUi(): void {
    this.chat.onSend(null);
    this.itemUi.unbind();
    this.socialUi.unbind();
    this.questUi.unbind();
    this.statusPanel.onAlloc(null);
    this.skillBar.onUse(null);
  }

  private showFatal(text: string): void {
    this.status.setText(text).setVisible(true);
    this.layoutStatus();
  }

  private onShutdown(): void {
    this.closed = true;
    this.scale.off(Phaser.Scale.Events.RESIZE, this.layoutStatus, this);
    if (this.room) {
      this.room.removeAllListeners();
      void this.room.leave();
      this.room = null;
    }
  }

  // ------------------------------------------------------------ 自己的移動

  /** 把畫面上的點換算成目標格，先在本機開始走，並通知伺服器。移動會取消攻擊。 */
  private requestMoveTo(worldX: number, worldY: number): void {
    if (!this.move || !this.room || this.transferring || this.dead) {
      return;
    }
    const t = worldToTile(worldX, worldY, this.geo);
    const clicked = { x: Math.floor(t.x), y: Math.floor(t.y) };
    if (!inBounds(this.grid, clicked.x, clicked.y)) {
      return;
    }
    // 點到障礙物（樹、水面）時改走到最近的可行走格
    const target = nearestWalkable(this.grid, clicked);
    if (!target) {
      return;
    }
    // 已經正在前往同一格就不必重複要求
    if (
      !this.serverDriven &&
      isMoving(this.move) &&
      this.lastTarget?.x === target.x &&
      this.lastTarget.y === target.y
    ) {
      return;
    }
    const path = findPath(this.grid, currentTile(this.move), target);
    if (!path) {
      return;
    }
    // 回到本機預測：從目前畫面上的位置出發
    this.serverDriven = false;
    this.pendingPickup = null;
    this.pendingNpc = null;
    this.move.path = path;
    this.lastTarget = target;
    this.pendingTarget = target;
    this.flushPendingMove();
    this.showMarker(target);
  }

  /** 在送出間隔允許時，把最新的目標格送給伺服器 */
  private flushPendingMove(): void {
    if (!this.pendingTarget || !this.room) {
      return;
    }
    const now = performance.now();
    if (now - this.lastSendAt < MOVE_SEND_INTERVAL_MS) {
      return;
    }
    this.room.send(MSG.move, { x: this.pendingTarget.x, y: this.pendingTarget.y } satisfies MoveRequest);
    this.lastSendAt = now;
    this.pendingTarget = null;
  }

  private showMarker(tile: TilePoint): void {
    const center = tileCenterToWorld(tile.x, tile.y, this.geo);
    this.tweens.killTweensOf(this.marker);
    this.marker.setPosition(center.x, center.y).setAlpha(1).setVisible(true);
    this.tweens.add({
      targets: this.marker,
      alpha: 0,
      duration: 600,
      delay: 200,
      onComplete: () => this.marker.setVisible(false),
    });
  }

  /** 更新自己的位置：戰鬥中跟隨伺服器，其餘時間本機預測並以伺服器位置校正 */
  private updateLocal(time: number, deltaMs: number): void {
    const move = this.move;
    const local = this.local;
    if (!move || !local) {
      return;
    }

    if (this.serverDriven) {
      const pos = this.selfBuffer.sample(performance.now() - INTERP_DELAY_MS);
      if (pos) {
        move.x = pos.x;
        move.y = pos.y;
      }
    } else {
      advanceMove(move, deltaMs / 1000, PLAYER_MOVE_SPEED);
      const error = Math.hypot(move.x - this.serverX, move.y - this.serverY);
      if (error > SNAP_DISTANCE) {
        // 差太多（例如網路卡住）：直接拉回伺服器位置，再從那裡重新走向原本的目標
        move.x = this.serverX;
        move.y = this.serverY;
        const path = this.lastTarget ? findPath(this.grid, currentTile(move), this.lastTarget) : null;
        move.path = path ?? [];
      } else if (!isMoving(move) && error > 0.001 && time - this.serverChangedAt > SETTLE_DELAY_MS) {
        // 雙方都停下後仍有小誤差：平滑地靠向伺服器位置
        const k = Math.min(1, (deltaMs / 1000) * 10);
        move.x += (this.serverX - move.x) * k;
        move.y += (this.serverY - move.y) * k;
      }
    }

    local.setTilePosition(move.x, move.y);
    local.updateAnimation();
  }

  // ------------------------------------------------------------ 每一幀

  override update(time: number, delta: number): void {
    // 按住地面時持續朝游標位置移動
    const pointer = this.input.activePointer;
    if (!pointer.isDown) {
      this.holdingGround = false;
    } else if (this.holdingGround && time - this.lastRetargetAt >= HOLD_RETARGET_MS) {
      this.lastRetargetAt = time;
      const world = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
      this.requestMoveTo(world.x, world.y);
    }
    this.flushPendingMove();

    this.updateLocal(time, delta);

    // 走到掉落物旁邊了：撿起來
    if (this.pendingPickup && this.room) {
      const drop = this.drops.get(this.pendingPickup);
      if (!drop) {
        this.pendingPickup = null;
      } else if (this.inPickupRange(drop)) {
        this.room.send(MSG.pickup, { dropId: this.pendingPickup } satisfies PickupRequest);
        this.pendingPickup = null;
      }
    }

    // 走到 NPC 旁邊了：開啟視窗
    if (this.pendingNpc) {
      const npc = this.npcPositions.get(this.pendingNpc);
      if (!npc) {
        this.pendingNpc = null;
      } else if (this.inNpcRange(npc)) {
        this.itemUi.openNpc(this.pendingNpc);
        this.pendingNpc = null;
      }
    }

    // 其他玩家與魔物：取「稍早一點」的時間點做插值
    const renderTime = performance.now() - INTERP_DELAY_MS;
    for (const remote of this.remotes.values()) {
      const pos = remote.buffer.sample(renderTime);
      if (pos) {
        remote.entity.setTilePosition(pos.x, pos.y);
      }
      remote.entity.updateAnimation();
    }
    for (const remote of this.monsters.values()) {
      const pos = remote.buffer.sample(renderTime);
      if (pos) {
        remote.entity.setTilePosition(pos.x, pos.y);
      }
    }

    // 目標標記跟著被選取的魔物
    const selected = this.selectedKey ? this.monsters.get(this.selectedKey) : undefined;
    if (selected) {
      this.targetRing.setPosition(selected.entity.sprite.x, selected.entity.sprite.y);
    }

    this.updateHud();
  }

  private updateHud(): void {
    const name = mapDisplayName(this.mapId);
    if (!this.move) {
      this.hud.setText(name);
      return;
    }
    const tile = currentTile(this.move);
    const online = this.remotes.size + 1;
    this.hud.setText(
      `${name}　座標 (${tile.x}, ${tile.y})　本圖 ${online} 人\n點地面移動、點魔物攻擊、點掉落物撿取、點 NPC 交談、點玩家交易`,
    );
  }
}
