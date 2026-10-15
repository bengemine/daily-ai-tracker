#!/usr/bin/env node
'use strict';

const { createControlServer } = require('./src/control-server');

const portArg = process.argv.indexOf('--port');
const requestedPort = portArg >= 0 ? Number(process.argv[portArg + 1]) : 0;
const { server, token, host } = createControlServer();

server.listen(requestedPort, host, () => {
  const address = server.address();
  const url = `http://${host}:${address.port}/`;
  console.log(`Daily Tracker Control Room: ${url}`);
  console.log('This page is local-only. Press Ctrl+C to stop it.');
  console.log(`Control token: ${token.slice(0, 6)}…`);
  if (!process.argv.includes('--no-open')) {
    // cmd.exe also works from WSL through Windows interop.
    try {
      const child = require('child_process').spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => { /* URL is printed above */ });
      child.unref();
    } catch { /* URL is printed when automatic opening is unavailable */ }
  }
});
