import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const deleted = await prisma.session.deleteMany({ where: { shop: "scented-candles-xavknapz.myshopify.com" } });
console.log(`✅ Deleted ${deleted.count} session(s).`);
await prisma.$disconnect();
