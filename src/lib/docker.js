'use strict';

/**
 * The smallest useful Docker Engine client: GET requests over the local unix
 * socket, JSON back.
 *
 * Localizer only ever reads from Docker — nothing here can start, stop or change
 * a container. The socket itself is another matter: anything that can open it
 * can control Docker, and mounting it read-only does not restrict the API. That
 * trade-off is spelled out in the README.
 */

const fs = require('fs');
const http = require('http');

const DEFAULT_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const TIMEOUT_MS = 8000;
const MAX_BYTES = 32 * 1024 * 1024;

function available(socketPath = DEFAULT_SOCKET) {
  try {
    return fs.statSync(socketPath).isSocket();
  } catch {
    return false;
  }
}

function get(apiPath, { socketPath = DEFAULT_SOCKET, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path: apiPath,
      method: 'GET',
      headers: { host: 'docker', accept: 'application/json' },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy(Object.assign(new Error('Docker returned an unexpectedly large response.'), { status: 502 }));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          reject(Object.assign(new Error(`Docker answered ${res.statusCode}: ${text.slice(0, 160)}`), { status: 502 }));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(Object.assign(new Error('Docker returned something that is not JSON.'), { status: 502 }));
        }
      });
      res.on('error', reject);
    });

    req.setTimeout(timeout, () => {
      req.destroy(Object.assign(new Error('Docker did not answer in time.'), { status: 504 }));
    });

    req.on('error', (err) => {
      const friendly = {
        EACCES: `Permission denied reading ${socketPath}. The container must run as root to use it.`,
        ECONNREFUSED: `Nothing is answering on ${socketPath}. Is Docker running?`,
        ENOENT: `There is no Docker socket at ${socketPath}.`,
      }[err.code];
      reject(Object.assign(new Error(friendly || err.message), { status: err.status || 502 }));
    });

    req.end();
  });
}

module.exports = { DEFAULT_SOCKET, available, get };
