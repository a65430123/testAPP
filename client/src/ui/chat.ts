// 聊天視窗（HTML，蓋在遊戲畫布左下角）。用 HTML 輸入框才能正常使用中文輸入法。

import { CHAT_CHANNEL_LABEL, CHAT_MAX_LENGTH, sanitizeChatText, type ChatChannel } from '@starmemory/shared';

/** 訊息紀錄最多保留幾行 */
const MAX_LINES = 80;

export type ChatSendHandler = (channel: ChatChannel, text: string) => void;

export class ChatBox {
  private readonly root: HTMLDivElement;
  private readonly log: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly channelSelect: HTMLSelectElement;
  private sendHandler: ChatSendHandler | null = null;
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // 在遊戲畫面按 Enter 會把游標移到聊天輸入框
    if (event.key === 'Enter' && document.activeElement !== this.input) {
      event.preventDefault();
      this.input.focus();
    }
  };

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'chat';
    this.root.innerHTML = `
      <div class="chat-log"></div>
      <form class="chat-form" autocomplete="off">
        <select aria-label="頻道">
          <option value="map">${CHAT_CHANNEL_LABEL.map}</option>
          <option value="world">${CHAT_CHANNEL_LABEL.world}</option>
        </select>
        <input type="text" maxlength="${CHAT_MAX_LENGTH}" placeholder="按 Enter 輸入訊息" />
      </form>`;
    document.body.appendChild(this.root);

    this.log = this.root.querySelector('.chat-log') as HTMLDivElement;
    this.input = this.root.querySelector('input') as HTMLInputElement;
    this.channelSelect = this.root.querySelector('select') as HTMLSelectElement;
    const form = this.root.querySelector('form') as HTMLFormElement;

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = sanitizeChatText(this.input.value);
      this.input.value = '';
      if (!text) {
        this.input.blur();
        return;
      }
      this.sendHandler?.(this.channelSelect.value as ChatChannel, text);
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.input.blur();
      }
      // 輸入文字時不要讓按鍵事件傳到遊戲
      event.stopPropagation();
    });
    document.addEventListener('keydown', this.onKeyDown);
  }

  /** 設定送出訊息時要呼叫的函式（切換地圖後會換成新房間的） */
  onSend(handler: ChatSendHandler | null): void {
    this.sendHandler = handler;
  }

  addChat(channel: ChatChannel, name: string, text: string): void {
    this.addLine(`chat-${channel}`, `[${CHAT_CHANNEL_LABEL[channel]}] ${name}：${text}`);
  }

  addSystem(text: string): void {
    this.addLine('chat-system', `[系統] ${text}`);
  }

  private addLine(className: string, text: string): void {
    const line = document.createElement('div');
    line.className = className;
    // 一律用 textContent，避免玩家輸入的內容被當成 HTML 執行
    line.textContent = text;
    this.log.appendChild(line);
    while (this.log.childElementCount > MAX_LINES) {
      this.log.firstElementChild?.remove();
    }
    this.log.scrollTop = this.log.scrollHeight;
  }

  destroy(): void {
    document.removeEventListener('keydown', this.onKeyDown);
    this.root.remove();
  }
}
