FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 DATA_DIR=/app/data PORT=3000
EXPOSE 3000
CMD ["node", "src/server.mjs"]
