class StorageMetrics {
  constructor() {
    this._counters = {
      uploadCount: 0,
      deleteCount: 0,
      failedUploads: 0,
      failedDeletes: 0,
      bytesUploaded: 0,
      bytesDeleted: 0
    };
    this._timings = {
      totalUploadTime: 0,
      totalDeleteTime: 0
    };
  }

  recordUpload(durationMs, bytes) {
    this._counters.uploadCount++;
    this._counters.bytesUploaded += bytes;
    this._timings.totalUploadTime += durationMs;
  }

  recordDelete(durationMs, bytes) {
    this._counters.deleteCount++;
    this._counters.bytesDeleted += bytes;
    this._timings.totalDeleteTime += durationMs;
  }

  recordFailedUpload() {
    this._counters.failedUploads++;
  }

  recordFailedDelete() {
    this._counters.failedDeletes++;
  }

  getCounters() {
    return { ...this._counters };
  }

  getAverages() {
    const avg = (total, count) => count > 0 ? Math.round(total / count) : 0;
    return {
      averageUploadTime: avg(this._timings.totalUploadTime, this._counters.uploadCount),
      averageDeleteTime: avg(this._timings.totalDeleteTime, this._counters.deleteCount)
    };
  }

  snapshot() {
    return {
      ...this._counters,
      ...this.getAverages()
    };
  }

  reset() {
    this._counters = {
      uploadCount: 0, deleteCount: 0, failedUploads: 0, failedDeletes: 0,
      bytesUploaded: 0, bytesDeleted: 0
    };
    this._timings = { totalUploadTime: 0, totalDeleteTime: 0 };
  }
}

module.exports = { StorageMetrics };
