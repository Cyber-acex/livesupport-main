import dotenv from 'dotenv';
dotenv.config({ override: true });
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

function convertSqlPlaceholders(sql, params) {
  let paramIndex = 0;
  return sql.replace(/\?/g, () => {
    const param = params?.[paramIndex++];
    if (param === null || param === undefined) return 'NULL';
    if (typeof param === 'string') return `'${param.replace(/'/g, "''")}'`;
    if (typeof param === 'number') return param.toString();
    if (typeof param === 'boolean') return param ? '1' : '0';
    if (param instanceof Date) return `'${param.toISOString()}'`;
    return String(param);
  });
}

const db = {
  query(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    } else if (!Array.isArray(params)) {
      params = params ? [params] : [];
    }

    setImmediate(async () => {
      try {
        const sqlUpper = sql.toUpperCase().trim();

        if (sqlUpper.startsWith('CREATE') || sqlUpper.startsWith('ALTER') || sqlUpper.startsWith('DROP')) {
          if (callback) callback(null, { ok: true });
          return;
        }

        const convertedSql = convertSqlPlaceholders(sql, params);

        if (sqlUpper.startsWith('SELECT')) {
          const result = await prisma.$queryRawUnsafe(convertedSql);
          if (callback) callback(null, result);
          return;
        }

        if (sqlUpper.startsWith('INSERT') || sqlUpper.startsWith('UPDATE') || sqlUpper.startsWith('DELETE')) {
          const result = await prisma.$executeRawUnsafe(convertedSql);
          if (callback) callback(null, { affectedRows: result });
          return;
        }

        if (callback) callback(null, { ok: true });
      } catch (error) {
        console.error('Database query error:', error.message, { sql: sql.substring(0, 100), params });
        if (callback) callback(error);
      }
    });
  },
  promise() {
    return {
      query(sql, params) {
        return new Promise((resolve, reject) => {
          db.query(sql, params, (err, result) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
      }
    };
  }
};

async function connectDatabase(callback) {
  try {
    await prisma.$connect();
    console.log('✅ Prisma connection is ready');
    if (callback) callback();
  } catch (error) {
    console.error('❌ Prisma connection error:', error.message);
    if (callback) callback(error);
  }
}

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

const config = { usePostgres: true };

export { db, prisma, connectDatabase, config };