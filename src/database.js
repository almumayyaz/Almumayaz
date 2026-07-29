const { PrismaClient } = require('@prisma/client');

let _prisma = null;

function getPrisma() {
  if (_prisma) return _prisma;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  let adapter = null;
  const urlHost = new URL(connectionString).hostname;
  // Neon serverless: use @prisma/adapter-neon
  if (urlHost.includes('neon') || process.env.PRISMA_ADAPTER === 'neon') {
    const { PrismaNeon } = require('@prisma/adapter-neon');
    adapter = new PrismaNeon({ connectionString });
  } else {
    // Regular PostgreSQL: use @prisma/adapter-pg
    const { PrismaPg } = require('@prisma/adapter-pg');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString });
    adapter = new PrismaPg(pool);
  }

  _prisma = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
  return _prisma;
}

async function disconnectPrisma() {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
}

module.exports = { getPrisma, disconnectPrisma };
