import Phaser from 'phaser';
import {
  advanceMove,
  buildCollisionGrid,
  cleanGid,
  createMoveState,
  currentTile,
  findPath,
  findSpawn,
  getTileLayer,
  getTileset,
  inBounds,
  isMoving,
  MAP_LAYER,
  mapGeometry,
  mapWorldBounds,
  nearestWalkable,
  PLAYER_MOVE_SPEED,
  SPAWN_PLAYER,
  tileCenterToWorld,
  tileToWorld,
  worldToTile,
  type CollisionGrid,
  type IsoGeometry,
  type MoveState,
  type TiledMap,
  type TilePoint,
} from '@starmemory/shared';
import { MAPS, PLAYER_FRAME, TEXTURE } from '../assets';

/** 按住滑鼠時每隔多久重新指定一次目的地（毫秒） */
const HOLD_RETARGET_MS = 200;
/** 鏡頭邊界在地圖外額外保留的空間（像素） */
const CAMERA_PADDING = 120;
/** 玩家圖的放大倍率 */
const PLAYER_SCALE = 1.5;
/** 地面層的繪製深度（永遠在所有物件之下） */
const GROUND_DEPTH = -100000;

const ANIM = {
  idleFront: 'player_idle_front',
  idleBack: 'player_idle_back',
  walkFront: 'player_walk_front',
  walkBack: 'player_walk_back',
} as const;

/** 世界場景：顯示一張 Tiled 斜視角地圖，處理點擊移動、碰撞與鏡頭跟隨（單機，不連線） */
export class WorldScene extends Phaser.Scene {
  private mapData!: TiledMap;
  private geo!: IsoGeometry;
  private grid!: CollisionGrid;
  private move!: MoveState;
  private player!: Phaser.GameObjects.Sprite;
  private marker!: Phaser.GameObjects.Graphics;
  private hud!: Phaser.GameObjects.Text;
  private facingBack = false;
  private lastRetargetAt = 0;

  constructor() {
    super('World');
  }

  create(data: { mapId: string }): void {
    const mapData = MAPS[data.mapId];
    if (!mapData) {
      throw new Error(`找不到地圖：${data.mapId}`);
    }
    this.mapData = mapData;
    this.geo = mapGeometry(mapData);
    this.grid = buildCollisionGrid(mapData);

    this.createGround(data.mapId);
    this.createProps();
    this.createPlayer();
    this.createMarker();
    this.createHud();
    this.setupCamera();
    this.setupInput();
  }

  // ------------------------------------------------------------ 建立場景內容

  /** 地面層：交給 Phaser 的斜視角圖磚層繪製 */
  private createGround(mapKey: string): void {
    const map = this.make.tilemap({ key: mapKey });
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

  /** 物件層（樹、石頭、灌木）：每格建立一個圖片物件，依畫面 y 排序，才能正確前後遮擋 */
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

  private createPlayer(): void {
    const spawn = findSpawn(this.mapData, SPAWN_PLAYER) ?? {
      x: this.mapData.width / 2 + 0.5,
      y: this.mapData.height / 2 + 0.5,
    };
    this.move = createMoveState(spawn.x, spawn.y);

    this.anims.create({
      key: ANIM.idleFront,
      frames: [{ key: TEXTURE.player, frame: 0 }],
    });
    this.anims.create({
      key: ANIM.idleBack,
      frames: [{ key: TEXTURE.player, frame: 3 }],
    });
    this.anims.create({
      key: ANIM.walkFront,
      frames: this.anims.generateFrameNumbers(TEXTURE.player, { frames: [1, 0, 2, 0] }),
      frameRate: 8,
      repeat: -1,
    });
    this.anims.create({
      key: ANIM.walkBack,
      frames: this.anims.generateFrameNumbers(TEXTURE.player, { frames: [4, 3, 5, 3] }),
      frameRate: 8,
      repeat: -1,
    });

    const pos = tileToWorld(this.move.x, this.move.y, this.geo);
    this.player = this.add
      .sprite(pos.x, pos.y, TEXTURE.player, 0)
      .setOrigin(0.5, PLAYER_FRAME.footY / PLAYER_FRAME.height)
      .setScale(PLAYER_SCALE)
      .setDepth(pos.y);
    this.player.play(ANIM.idleFront);
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
    this.marker.setDepth(GROUND_DEPTH + 1);
    this.marker.setVisible(false);
  }

  private createHud(): void {
    this.hud = this.add
      .text(12, 10, '', {
        fontSize: '14px',
        color: '#ffffff',
        backgroundColor: 'rgba(0,0,0,0.45)',
        padding: { x: 8, y: 6 },
      })
      .setScrollFactor(0)
      .setDepth(1000000);
    this.updateHud();
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
    cam.startFollow(this.player, true, 0.15, 0.15);
    cam.setRoundPixels(true);
  }

  private setupInput(): void {
    this.input.on(Phaser.Input.Events.POINTER_DOWN, (pointer: Phaser.Input.Pointer) => {
      this.lastRetargetAt = this.time.now;
      this.moveToWorldPoint(pointer.worldX, pointer.worldY);
    });
  }

  // ------------------------------------------------------------ 移動

  /** 把畫面上的點換算成格子，尋路後開始移動 */
  private moveToWorldPoint(worldX: number, worldY: number): void {
    const t = worldToTile(worldX, worldY, this.geo);
    let target: TilePoint | null = { x: Math.floor(t.x), y: Math.floor(t.y) };
    if (!inBounds(this.grid, target.x, target.y)) {
      return;
    }
    // 點到障礙物（樹、水面）時改走到最近的可行走格
    target = nearestWalkable(this.grid, target);
    if (!target) {
      return;
    }
    const path = findPath(this.grid, currentTile(this.move), target);
    if (!path) {
      return;
    }
    this.move.path = path;
    this.showMarker(target);
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

  override update(time: number, delta: number): void {
    // 按住滑鼠（或手指）時持續朝游標位置移動
    const pointer = this.input.activePointer;
    if (pointer.isDown && time - this.lastRetargetAt >= HOLD_RETARGET_MS) {
      this.lastRetargetAt = time;
      const world = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
      this.moveToWorldPoint(world.x, world.y);
    }

    const prevX = this.player.x;
    const prevY = this.player.y;
    const moved = advanceMove(this.move, delta / 1000, PLAYER_MOVE_SPEED);
    if (moved) {
      const pos = tileToWorld(this.move.x, this.move.y, this.geo);
      this.player.setPosition(pos.x, pos.y).setDepth(pos.y);
      this.updateFacing(pos.x - prevX, pos.y - prevY);
      this.updateHud();
    }
    this.updateAnimation();
  }

  /** 依畫面上的移動方向決定面向：往上走顯示背面，往左走水平翻轉 */
  private updateFacing(dx: number, dy: number): void {
    if (Math.abs(dy) > 0.01) {
      this.facingBack = dy < 0;
    }
    if (Math.abs(dx) > 0.01) {
      this.player.setFlipX(dx < 0);
    }
  }

  private updateAnimation(): void {
    const moving = isMoving(this.move);
    const key = moving
      ? this.facingBack
        ? ANIM.walkBack
        : ANIM.walkFront
      : this.facingBack
        ? ANIM.idleBack
        : ANIM.idleFront;
    this.player.play(key, true);
  }

  private updateHud(): void {
    const tile = currentTile(this.move);
    this.hud.setText(`嫩芽草原　座標 (${tile.x}, ${tile.y})\n點擊或按住地面移動`);
  }
}
