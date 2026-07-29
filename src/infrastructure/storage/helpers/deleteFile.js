async function deleteFile(storage, objectKey) {
  return storage.delete(objectKey);
}

async function deleteFiles(storage, objectKeys) {
  const results = [];
  for (const key of objectKeys) {
    try {
      const result = await storage.delete(key);
      results.push({ objectKey: key, success: result });
    } catch (e) {
      results.push({ objectKey: key, success: false, error: e.message });
    }
  }
  return results;
}

module.exports = { deleteFile, deleteFiles };
