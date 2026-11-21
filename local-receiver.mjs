import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.env.RECEIVER_STATE_PATH || './local-receiver.sqlite');
db.exec('CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
const save = db.prepare('INSERT INTO messages VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET payload = excluded.payload');
const list = db.prepare('SELECT payload FROM messages ORDER BY rowid DESC LIMIT 100');

createServer(async (request, response) => {
  if (request.url !== '/slack/messages') return response.writeHead(404).end();
  if (request.method === 'GET') {
    return response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      .end(JSON.stringify(list.all().map(row => JSON.parse(row.payload)), null, 2));
  }
  if (request.method !== 'POST') return response.writeHead(405).end();
  let message;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 512_000) return response.writeHead(413).end();
      chunks.push(chunk);
    }
    message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return response.writeHead(400).end(); }
  if (message?.schemaVersion !== 1 || typeof message.id !== 'string' || !message.id || typeof message.text !== 'string') {
    return response.writeHead(400).end();
  }
  try { save.run(message.id, JSON.stringify(message)); }
  catch { return response.writeHead(500).end(); }
  response.writeHead(204).end();
}).listen(4319, '127.0.0.1', () => console.log('Local receiver ready at http://127.0.0.1:4319/slack/messages'));
