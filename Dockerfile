FROM node:20-slim as builder
WORKDIR /usr/src/app
COPY package.json .
COPY package-lock.json* .
RUN npm ci

FROM node:20-slim
WORKDIR /usr/src/app
COPY --from=builder /usr/src/app/ /usr/src/app/
COPY . .
RUN chown -R 1000:1000 /usr/src/app
USER 1000
CMD ["npx", "quartz", "build", "--serve"]
