# 試玩與小規模部署用的映像檔：打包用戶端，並由遊戲伺服器同時提供網頁、API 與遊戲連線（單一連接埠 2567）。
FROM node:22-bookworm-slim

WORKDIR /app

# 先只複製套件清單再安裝，程式碼變動時可以重用這一層的快取
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY shared shared
COPY client client
COPY server server
RUN npm run build

ENV PORT=2567
EXPOSE 2567
# 以非 root 身分執行
USER node
CMD ["npm", "run", "server"]
