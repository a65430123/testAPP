import Phaser from 'phaser';
import {
  advanceMove,
  buildCollisionGrid,
  cleanGid,
  CLOSE_CODE,
  createMoveState,
  currentTile,
  findPath,
  findPortals,
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
  PLAYER_MOVE_SPEED,
  SERVER_TICK_MS,
  SnapshotBuffer,
  tileCenterToWorld,
  worldToTile,
  type ChatChannel,
  type ChatMessage,
  type ChatSendMessage,
  type CollisionGrid,
  type InventoryMessage,
  type IsoGeometry,
  type MoveRejectMessage,
  type MoveRequest,
  type MoveState,
  type SystemMessage,
  type TiledMap,
  type TilePoint,
  type TransferMessage,
} from '@starmemory/shared';
import { mapDisplayName, MAPS, REGISTRY, TEXTURE } from '../assets';
import { PlayerEntity } from '../entities/PlayerEntity';
import {
  joinMap,
  playerCallbacks,
  type MapRoomConnection,
  type PlayerView,
  type Session,
} from '../net/session';
import type { ChatBox } from '../ui/chat';
import type { InventoryPanel } from '../ui/inventory';

/** 按住滑鼠時每隔多久重新指定一次目的地（毫秒） */
const HOLD_RETARGET_MS = 200;
/** 用戶端送出移動指令的最短間隔，略大於伺服器的限制，避免因網路抖動被伺服器忽略 */
const MOVE_SEND_INTERVAL_MS = MOVE_MIN_INTERVAL_MS + 40;
/** 其他玩家的畫面比伺服器資料晚這麼久（毫秒），取樣點前後才有資料可內插 */
const INTERP_DELAY_MS = SERVER_TICK_MS * 2;
/** 自己的預測位置與伺服器位置相差超過這個距離（格）就直接拉回 */
const SNAP_DISTANCE = 2.5;
/** 停下後若與伺服器位置有小誤差，等伺服器也停下這麼久（毫秒）後再慢慢修正 */
const SETTLE_DELAY_MS = 250;
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

/**
 * 世界場景：顯示一張地圖並連上該地圖的房間。
 * - 自己：點擊後先在本機預測移動（立即有反應），再以伺服器位置校正
 * - 其他玩家：依伺服器位置插值顯示
 * - 踩到傳送點時由伺服器通知，重啟本場景並改連另一張地圖的房間
 */
export class WorldScene extends Phaser.Scene {
  private mapId!: string;
  private mapData!: TiledMap;
  private geo!: IsoGeometry;
  private grid!: CollisionGrid;
  private session!: Session;
  private chat!: ChatBox;
  private inventory!: InventoryPanel;

  private room: MapRoomConnection | null = null;
  private local: PlayerEntity | null = null;
  private move: MoveState | null = null;
  private readonly remotes = new Map<string, RemotePlayer>();

  /** 伺服器認定的自己位置，以及最後一次變動的時間 */
  private serverX = 0;
  private serverY = 0;
  private serverChangedAt = 0;
  /** 最後一次要求前往的目標格 */
  private lastTarget: TilePoint | null = null;
  /** 因送出間隔限制而暫存、尚未送給伺服器的目標格 */
  private pendingTarget: TilePoint | null = null;
  private lastSendAt = 0;
  private lastRetargetAt = 0;
  private transferring = false;
  private closed = false;

  private marker!: Phaser.GameObjects.Graphics;
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
    this.lastTarget = null;
    this.pendingTarget = null;
    this.lastSendAt = 0;
    this.lastRetargetAt = 0;
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
    this.inventory = this.registry.get(REGISTRY.inventory) as InventoryPanel;

    this.createGround();
    this.createProps();
    this.createPortals();
    this.createMarker();
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

  /** 目的地標記：一個會淡出的菱形 */
  private createMarker(): void {
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
    this.marker.setDepth(GROUND_DEPTH + 2);
    this.marker.setVisible(false);
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

    // 畫面中央的狀態訊息（連線中、斷線…）
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
    this.input.on(Phaser.Input.Events.POINTER_DOWN, (pointer: Phaser.Input.Pointer) => {
      this.lastRetargetAt = this.time.now;
      this.requestMoveTo(pointer.worldX, pointer.worldY);
    });
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

    const callbacks = playerCallbacks(room);
    callbacks.onAdd((player, sessionId) => {
      if (sessionId === room.sessionId) {
        this.addLocalPlayer(player);
      } else {
        this.addRemotePlayer(sessionId, player);
      }
      callbacks.onChange(player, () => this.onPlayerChanged(sessionId, player));
      this.updateHud();
    });
    callbacks.onRemove((_player, sessionId) => {
      this.remotes.get(sessionId)?.entity.destroy();
      this.remotes.delete(sessionId);
      this.updateHud();
    });

    room.onMessage(MSG.chat, (message: ChatMessage) => this.onChat(message));
    room.onMessage(MSG.system, (message: SystemMessage) => this.chat.addSystem(message.text));
    room.onMessage(MSG.moveReject, (message: MoveRejectMessage) => this.onMoveRejected(message));
    room.onMessage(MSG.transfer, (message: TransferMessage) => void this.onTransfer(message));
    room.onMessage(MSG.inventory, (message: InventoryMessage) => this.inventory.update(message));
    room.onLeave((code: number) => this.onRoomLeave(code));

    this.chat.onSend((channel: ChatChannel, text: string) => {
      const message: ChatSendMessage = { channel, text };
      room.send(MSG.chat, message);
    });
    this.chat.addSystem(`已進入 ${mapDisplayName(this.mapId)}`);
    // 處理函式都註冊好了，向伺服器要一次背包內容
    room.send(MSG.inventory);
  }

  private addLocalPlayer(player: PlayerView): void {
    this.move = createMoveState(player.x, player.y);
    this.serverX = player.x;
    this.serverY = player.y;
    this.serverChangedAt = this.time.now;
    this.local = new PlayerEntity(this, this.geo, player.name, player.level, player.x, player.y, true);
    this.cameras.main.startFollow(this.local.sprite, true, 0.15, 0.15);
    this.status.setVisible(false);
  }

  private addRemotePlayer(sessionId: string, player: PlayerView): void {
    const buffer = new SnapshotBuffer(SERVER_TICK_MS);
    buffer.reset(performance.now(), player.x, player.y);
    this.remotes.set(sessionId, {
      entity: new PlayerEntity(this, this.geo, player.name, player.level, player.x, player.y, false),
      buffer,
      lastX: player.x,
      lastY: player.y,
    });
  }

  /** 伺服器同步了某位玩家的新狀態（位置或等級） */
  private onPlayerChanged(sessionId: string, player: PlayerView): void {
    if (sessionId === this.room?.sessionId) {
      this.local?.setInfo(player.name, player.level);
      if (player.x !== this.serverX || player.y !== this.serverY) {
        this.serverX = player.x;
        this.serverY = player.y;
        this.serverChangedAt = this.time.now;
      }
      return;
    }
    const remote = this.remotes.get(sessionId);
    if (!remote) {
      return;
    }
    remote.entity.setInfo(player.name, player.level);
    if (player.x !== remote.lastX || player.y !== remote.lastY) {
      remote.lastX = player.x;
      remote.lastY = player.y;
      remote.buffer.push(performance.now(), player.x, player.y);
    }
  }

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
    this.local?.setTilePosition(message.x, message.y);
  }

  /** 伺服器通知切換地圖：離開目前房間，重啟場景並連到新地圖的房間 */
  private async onTransfer(message: TransferMessage): Promise<void> {
    if (this.transferring) {
      return;
    }
    this.transferring = true;
    this.session.mapId = message.mapId;
    this.chat.onSend(null);
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
    this.chat.onSend(null);
    const reason = code === CLOSE_CODE.duplicateLogin ? '此角色已在其他地方登入' : '與伺服器的連線已中斷';
    this.showFatal(`${reason}\n請重新整理頁面`);
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

  /** 把畫面上的點換算成目標格，先在本機開始走，並通知伺服器 */
  private requestMoveTo(worldX: number, worldY: number): void {
    if (!this.move || !this.room || this.transferring) {
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
    if (isMoving(this.move) && this.lastTarget?.x === target.x && this.lastTarget.y === target.y) {
      return;
    }
    const path = findPath(this.grid, currentTile(this.move), target);
    if (!path) {
      return;
    }
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
    const request: MoveRequest = { x: this.pendingTarget.x, y: this.pendingTarget.y };
    this.room.send(MSG.move, request);
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

  /** 本機預測移動，並以伺服器位置校正 */
  private updateLocal(time: number, deltaMs: number): void {
    const move = this.move;
    const local = this.local;
    if (!move || !local) {
      return;
    }
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

    local.setTilePosition(move.x, move.y);
    local.updateAnimation();
  }

  // ------------------------------------------------------------ 每一幀

  override update(time: number, delta: number): void {
    // 按住滑鼠（或手指）時持續朝游標位置移動
    const pointer = this.input.activePointer;
    if (pointer.isDown && time - this.lastRetargetAt >= HOLD_RETARGET_MS) {
      this.lastRetargetAt = time;
      const world = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
      this.requestMoveTo(world.x, world.y);
    }
    this.flushPendingMove();

    this.updateLocal(time, delta);

    // 其他玩家：取「稍早一點」的時間點做插值
    const renderTime = performance.now() - INTERP_DELAY_MS;
    for (const remote of this.remotes.values()) {
      const pos = remote.buffer.sample(renderTime);
      if (pos) {
        remote.entity.setTilePosition(pos.x, pos.y);
      }
      remote.entity.updateAnimation();
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
    this.hud.setText(`${name}　座標 (${tile.x}, ${tile.y})　本圖 ${online} 人\n點擊或按住地面移動，Enter 聊天`);
  }
}
