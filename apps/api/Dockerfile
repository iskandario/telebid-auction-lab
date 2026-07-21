FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY tools/load/package.json tools/load/package.json
RUN npm install
COPY tsconfig.base.json ./
COPY apps/api apps/api
RUN npm run build -w @telebid/api

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
EXPOSE 8080
CMD ["node", "dist/main.js"]
