try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch (e) {}

const { readData: readLocal, writeData: writeLocal } = require('../data-store');
const { readData: readRemote, writeData: writeRemote } = require('../firebase-admin');

const DATA_SETS = ['users', 'courses', 'subscriptions', 'announcements', 'reviews'];

async function seed() {
  console.log('Starting Firebase seed...');
  for (const key of DATA_SETS) {
    try {
      const data = await readLocal(key);
      console.log(`  ${key}: ${Array.isArray(data) ? data.length + ' items' : 'object'} loaded`);
      await writeRemote(key, data);
      console.log(`  ${key}: uploaded successfully`);
    } catch (e) {
      console.error(`  ${key}: error -`, e.message);
    }
  }
  console.log('Seed complete!');
}

seed().then(() => process.exit(0));
