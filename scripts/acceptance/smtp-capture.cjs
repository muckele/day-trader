'use strict';
const net = require('node:net');
const tls = require('node:tls');
// Loopback-only SMTP boundary. The production Nodemailer transport performs real
// EHLO/STARTTLS, envelope and DATA exchanges with a locally trusted test cert.
async function startSmtpCapture({ key, cert }) {
  const messages = [], sockets = new Set();
  let failures = 0;
  const secureContext = tls.createSecureContext({ key, cert });
  function attach(socket, upgraded = false) {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = '', data = false, message = [];
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\r\n')) {
        const index = buffer.indexOf('\r\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (data) {
          if (line === '.') { data = false; if (failures > 0) { failures--; socket.write('451 4.3.0 temporary fixture failure\r\n'); } else { messages.push(message.join('\r\n')); socket.write('250 2.0.0 captured\r\n'); } message = []; }
          else message.push(line.replace(/^\.\./, '.'));
          continue;
        }
        if (/^(EHLO|HELO) /i.test(line)) socket.write(upgraded ? '250-localhost\r\n250 8BITMIME\r\n' : '250-localhost\r\n250 STARTTLS\r\n');
        else if (line === 'STARTTLS' && !upgraded) {
          socket.write('220 Ready to start TLS\r\n'); socket.removeAllListeners('data');
          attach(new tls.TLSSocket(socket, { isServer: true, secureContext }), true); return;
        } else if (/^(MAIL FROM:|RCPT TO:|RSET|NOOP)/i.test(line)) socket.write('250 OK\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 End with dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 Bye\r\n');
        else socket.write('502 Unsupported command\r\n');
      }
    });
    if (!upgraded) socket.write('220 localhost fixture SMTP\r\n');
  }
  const server = net.createServer(socket => attach(socket));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, messages, failNext(count = 1) { failures = count; }, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { startSmtpCapture };
