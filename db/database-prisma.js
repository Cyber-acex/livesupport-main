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

function convertSqlPlaceholders(sql) {
  let paramIndex = 0;
  return sql.replace(/\?/g, () => `$${++paramIndex}`);
}

const db = {
  query(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }

    const paramsArray = Array.isArray(params)
      ? params
      : params !== undefined && params !== null
      ? [params]
      : [];

    setImmediate(async () => {
      try {
        const sqlUpper = sql.toUpperCase().trim();
        const convertedSql = convertSqlPlaceholders(sql);
        const result = await pool.query(convertedSql, paramsArray);

        if (sqlUpper.startsWith('SELECT')) {
          if (callback) callback(null, result.rows);
          return;
        }

        if (sqlUpper.startsWith('INSERT') || sqlUpper.startsWith('UPDATE') || sqlUpper.startsWith('DELETE')) {
          if (/RETURNING\s+/i.test(sql)) {
            if (callback) callback(null, result.rows);
            return;
          }
          if (callback) callback(null, { affectedRows: result.rowCount });
          return;
        }

        if (callback) callback(null, result);
      } catch (error) {
        console.error('Database query error:', error.message, { sql: sql.substring(0, 100), params: paramsArray });
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