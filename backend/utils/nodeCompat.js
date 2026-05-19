function ensureSlowBufferCompat() {
  try {
    const buffer = require('buffer');
    if (!buffer.SlowBuffer) {
      buffer.SlowBuffer = buffer.Buffer;
    }
  } catch (_err) {
    // If Node's buffer module cannot be loaded, let the downstream require fail normally.
  }
}

module.exports = {
  ensureSlowBufferCompat
};
