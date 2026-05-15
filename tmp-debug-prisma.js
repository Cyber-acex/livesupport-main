import { db } from './db/database-prisma.js';
db.query("INSERT INTO tickets (ticket_type, subject, customer_name, customer_phone, assignee, priority, status, content, tags, sla_due) VALUES ('Debug', 'Debug', 'Debug', '000', 'Debug', 'Medium', 'Open', 'Debug content', '[]', '2026-05-15 00:00:00') RETURNING id", [], (err, result) => {
  console.log('ERR', err);
  console.log('RESULT', result);
  process.exit(0);
});
