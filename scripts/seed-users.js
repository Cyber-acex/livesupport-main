import { prisma } from '../db/database-prisma.js';

async function seedUsers() {
  try {
    console.log('🌱 Starting user seed...\n');

    const usersToCreate = [
      { email: 'admin@livesupport.com', password: 'admin123', name: 'Admin User', role: 'admin' },
      { email: 'cyberincognito15@gmail.com', password: '110089', name: 'Cyber', role: 'admin' },
      { email: 'agent1@livesupport.com', password: 'password123', name: 'John Agent', role: 'agent' },
      { email: 'agent2@livesupport.com', password: 'password123', name: 'Jane Staff', role: 'agent' },
      { email: 'viewer@livesupport.com', password: 'password123', name: 'View Only', role: 'viewer' },
      { email: 'support@livesupport.com', password: 'password123', name: 'Support Agent', role: 'agent' }
    ];

    for (const user of usersToCreate) {
      const existing = await prisma.user.findFirst({ where: { email: user.email } });
      if (existing) {
        console.log(`✅ User already exists: ${user.email}`);
        continue;
      }
      const created = await prisma.user.create({ data: user });
      console.log(`✅ Created user: ${created.email} (${created.role})`);
    }

    console.log('\n🎉 User seed completed successfully!');
    console.log('Test credentials:');
    console.log('  Admin: admin@livesupport.com / admin123');
    console.log('  Agent: agent1@livesupport.com / password123');
  } catch (error) {
    console.error('❌ Seed error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

seedUsers();