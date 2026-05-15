import dotenv from 'dotenv';
dotenv.config({ override: true });
import mysql from 'mysql2/promise';
import { prisma } from '../db/database-prisma.js';

const MYSQL_CONNECTION_URL = process.env.OLD_MYSQL_DATABASE_URL;
const MYSQL_HOST = process.env.MYSQL_HOST || 'localhost';
const MYSQL_PORT = process.env.MYSQL_PORT || '3306';
const MYSQL_USER = process.env.MYSQL_USER || 'root';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || '';
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'livesupport';

async function parseConnectionUrl(url) {
  try {
    const urlObj = new URL(url.replace('mysql://', 'http://'));
    return {
      host: urlObj.hostname,
      user: decodeURIComponent(urlObj.username),
      password: decodeURIComponent(urlObj.password),
      port: urlObj.port || '3306',
      database: urlObj.pathname.substring(1)
    };
  } catch (error) {
    throw new Error('Invalid connection URL format. Expected: mysql://user:password@host:port/database');
  }
}

async function migrateUsersFromMySQL() {
  console.log('🔄 Starting user migration from MySQL to PostgreSQL...\n');

  let mysqlConnection;
  try {
    let config;
    if (MYSQL_CONNECTION_URL) {
      config = await parseConnectionUrl(MYSQL_CONNECTION_URL);
    } else if (MYSQL_HOST && MYSQL_USER && MYSQL_DATABASE) {
      config = {
        host: MYSQL_HOST,
        port: MYSQL_PORT,
        user: MYSQL_USER,
        password: MYSQL_PASSWORD,
        database: MYSQL_DATABASE
      };
    } else {
      throw new Error('No MySQL connection info provided. Set OLD_MYSQL_DATABASE_URL or MYSQL_HOST+MYSQL_USER+MYSQL_DATABASE.');
    }

    console.log(`📍 Connecting to MySQL: ${config.host}/${config.database}`);
    mysqlConnection = await mysql.createConnection({
      host: config.host,
      port: config.port || '3306',
      user: config.user,
      password: config.password,
      database: config.database
    });
    console.log('✅ Connected to MySQL\n');

    const [users] = await mysqlConnection.query('SELECT * FROM users');
    if (!users || users.length === 0) {
      console.log('⚠️  No users found in old MySQL database');
      await mysqlConnection.end();
      return;
    }

    console.log(`📦 Found ${users.length} users to migrate\n`);
    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    for (const user of users) {
      try {
        const existing = await prisma.user.findFirst({ where: { email: user.email } });
        if (existing) {
          console.log(`⏭️  Skipped (already exists): ${user.email}`);
          skipCount++;
          continue;
        }
        const createdUser = await prisma.user.create({
          data: {
            email: user.email,
            password: user.password,
            name: user.name || user.email,
            role: user.role || 'agent',
            disabled: user.disabled ? true : false
          }
        });
        console.log(`✅ Migrated: ${createdUser.email} (ID: ${createdUser.id})`);
        successCount++;
      } catch (error) {
        console.error(`❌ Error migrating ${user.email}:`, error.message);
        errorCount++;
      }
    }

    console.log('\n📊 Migration Summary:');
    console.log(`   ✅ Successfully migrated: ${successCount}`);
    console.log(`   ⏭️  Already existed: ${skipCount}`);
    console.log(`   ❌ Errors: ${errorCount}`);

    await mysqlConnection.end();
    await prisma.$disconnect();
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    if (mysqlConnection) await mysqlConnection.end();
    await prisma.$disconnect();
    process.exit(1);
  }
}

if (MYSQL_CONNECTION_URL && MYSQL_CONNECTION_URL.includes('user:password')) {
  console.error('❌ Error: Please update the MYSQL_CONNECTION_URL in this script');
  console.error('   Format: mysql://username:password@hostname:port/database_name');
  process.exit(1);
}

migrateUsersFromMySQL();