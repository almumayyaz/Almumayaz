const { readData, writeData } = require('./firebase-admin');

(async () => {
  try {
    const data = await readData('zoomCredentials');
    if (!data) {
      console.log('No zoomCredentials data found.');
    } else {
      const keys = Object.keys(data);
      console.log('Found zoomCredentials for users:', keys);
    }
    await writeData('zoomCredentials', null);
    console.log('Cleared all zoomCredentials data.');
  } catch (e) {
    console.error('Error clearing zoomCredentials:', e.message);
  }
  process.exit(0);
})();
