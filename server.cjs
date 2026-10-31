'use strict';
const { createApp } = require('./server/app.cjs');
const portIndex = process.argv.indexOf('--port');
const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : process.env.PORT || 4319);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a port between 1 and 65535.');
const app = createApp();
app.server.on('error', error => { process.stderr.write(error.code === 'EADDRINUSE' ? 'Port ' + port + ' is already in use.\n' : error.message + '\n'); process.exitCode = 1; });
app.server.listen(port, '127.0.0.1', () => process.stdout.write('NeuroSphere is ready at http://127.0.0.1:' + port + '\n'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
