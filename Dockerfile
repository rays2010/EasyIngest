FROM docker.1ms.run/library/node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN apk add --no-cache unzip p7zip unrar
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
