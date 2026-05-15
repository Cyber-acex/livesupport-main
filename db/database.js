import mysql from 'mysql2'
import dotenv from 'dotenv';

dotenv.config({ override: true });

let db
let connectDatabase
let config

if (process.env.DATABASE_URL) {
  const prismaModule = await import('./database-prisma.js')
  db = prismaModule.db
  connectDatabase = prismaModule.connectDatabase
  config = prismaModule.config
} else {
  const mysqlDb = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'livesupport'
  })

  db = mysqlDb
  config = { usePostgres: false }

  connectDatabase = (callback) => {
    mysqlDb.connect((err) => {
      if (err) {
        console.error('❌ MySQL connection error:', err.message)
        if (callback) callback(err)
      } else {
        console.log('✅ MySQL connection is ready')
        if (callback) callback()
      }
    })
  }
}

export { db, connectDatabase, config }
