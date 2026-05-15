import mysql from 'mysql2/promise';

async function run(){
  const db = await mysql.createConnection({host: process.env.DB_HOST||'localhost', user: process.env.DB_USER||'root', password: process.env.DB_PASSWORD||'', database: process.env.DB_NAME||'livesupport'});
  try{
    const [rows] = await db.execute('SELECT id, email, name FROM users WHERE email = ?', ['support@livesupport.com']);
    console.log(JSON.stringify(rows));
  }catch(e){
    console.error('ERROR', e.message);
  }finally{
    await db.end();
  }
}
run();
