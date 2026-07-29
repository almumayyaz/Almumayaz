const path = require('path');

function getStaticConfig() {
  return [
    {
      path: '/',
      directory: path.join(__dirname, '..', '..', 'public'),
      options: { maxAge: '7d' }
    }
  ];
}

function getUploadsDir() {
  return path.join(__dirname, '..', '..', 'uploads');
}

module.exports = { getStaticConfig, getUploadsDir };
