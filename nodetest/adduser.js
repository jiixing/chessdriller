import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const newUser = await prisma.user.create({
    data: {
      lichessUsername: 'new_user',
      lichessAccessToken: 'access_token',
      lichessAccessTokenFetchedAt: new Date(),
      lichessAccessTokenExpiresIn: 3600,
      lastRepertoireUpdateCheck: new Date(),
      settingsStudyDisplayLineSource: false,
    },
  });

  console.log('User created:', newUser);
}

main()
  .catch((e) => {
    throw e;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });