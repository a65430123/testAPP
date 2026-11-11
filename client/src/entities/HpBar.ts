import Phaser from 'phaser';

/** 顯示在角色或魔物頭上的血條 */
export class HpBar {
  private readonly graphics: Phaser.GameObjects.Graphics;
  private ratio = 1;

  constructor(
    scene: Phaser.Scene,
    private readonly width: number,
    private readonly color: number,
    depth: number,
  ) {
    this.graphics = scene.add.graphics().setDepth(depth);
    this.redraw();
  }

  set(hp: number, maxHp: number): void {
    const ratio = maxHp > 0 ? Phaser.Math.Clamp(hp / maxHp, 0, 1) : 0;
    if (ratio !== this.ratio) {
      this.ratio = ratio;
      this.redraw();
    }
  }

  setPosition(x: number, y: number): void {
    this.graphics.setPosition(x, y);
  }

  setVisible(visible: boolean): void {
    this.graphics.setVisible(visible);
  }

  private redraw(): void {
    const g = this.graphics;
    const half = this.width / 2;
    g.clear();
    g.fillStyle(0x000000, 0.65);
    g.fillRect(-half - 1, -1, this.width + 2, 6);
    g.fillStyle(this.color, 1);
    g.fillRect(-half, 0, Math.round(this.width * this.ratio), 4);
  }

  destroy(): void {
    this.graphics.destroy();
  }
}
