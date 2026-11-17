# 網頁伺服器：API ＋ public/ 的網頁。在專案根目錄 build（docker compose 會處理）。
FROM node:22-alpine
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server ./
COPY public /app/public
EXPOSE 3000
CMD ["node", "index.js"]
