require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool, types } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

let prisma = null;
let pool = null;

function getClient() {
  if (!prisma) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const adapter = new PrismaPg(pool);
    prisma = new PrismaClient({ adapter });
  }
  return prisma;
}

async function disconnect() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getClient, disconnect };
