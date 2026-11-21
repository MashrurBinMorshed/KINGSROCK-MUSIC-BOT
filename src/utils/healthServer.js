'use strict';

const http = require('node:http');
const { Status } = require('discord.js');

/**
 * Optional health endpoint (HEALTH_PORT > 0). Binds to 127.0.0.1 by default
 * so it is only reachable from the server itself, e.g.:
 *   curl -s http://127.0.0.1:8080/health
 * Returns 200 when connected to the Discord gateway, 503 otherwise.
 * No polling or timers: it only does work when requested.
 */
function startHealthServer({ port, host, client, music, logger, startedAt = Date.now() }) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || (req.url !== '/health' && req.url !== '/')) {
      res.writeHead(404).end();
      return;
    }
    const ready = client.isReady() && client.ws.status === Status.Ready;
    const mem = process.memoryUsage();
    const body = {
      status: ready ? 'ok' : 'degraded',
      gateway: Status[client.ws.status] ?? client.ws.status,
      pingMs: client.ws.ping,
      guilds: client.guilds.cache.size,
      activePlayers: music.size,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      memoryMb: { rss: +(mem.rss / 1048576).toFixed(1), heapUsed: +(mem.heapUsed / 1048576).toFixed(1) },
    };
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  });
  server.on('error', (err) => logger.error(`Health server error: ${err.message}`));
  server.listen(port, host, () => logger.info(`Health endpoint on http://${host}:${port}/health`));
  return server;
}

module.exports = { startHealthServer };
