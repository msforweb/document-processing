import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const passwordHash = await bcrypt.hash('demo-password', 12);
  const organization = await prisma.organization.upsert({
    where: { id: 'demo-organization' },
    update: {},
    create: { id: 'demo-organization', name: 'Demo Fintech' },
  });

  await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {
      organizationId: organization.id,
      name: 'Demo Admin',
      passwordHash,
      role: UserRole.ADMIN,
    },
    create: {
      organizationId: organization.id,
      email: 'admin@example.com',
      name: 'Demo Admin',
      passwordHash,
      role: UserRole.ADMIN,
    },
  });
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
