function createExecutionReadiness() {
  let state = { ready: false, indexesReady: false, writeReady: false, checkedAt: null };
  let generation = 0;
  return {
    invalidate() { generation += 1; state = { ...state, ready: false, indexesReady: false, writeReady: false }; },
    snapshot() { return { ...state }; },
    assertReady() {
      if (!state.ready) {
        const error = new Error('Execution is not ready: database write and required indexes must be verified.');
        error.code = 'EXECUTION_NOT_READY';
        error.status = 503;
        throw error;
      }
    },
    async bootstrap(indexBootstrap, writeProbe) {
      const version = ++generation;
      state = { ready: false, indexesReady: false, writeReady: false, checkedAt: new Date() };
      try {
        const indexes = await indexBootstrap();
        if (!indexes.length || indexes.some(index => !index.ok)) return false;
        await writeProbe();
        if (version !== generation) return false;
        state = { ready: true, indexesReady: true, writeReady: true, checkedAt: new Date() };
        return true;
      } catch { return false; }
    }
  };
}
const executionReadiness = createExecutionReadiness();
module.exports = { createExecutionReadiness, executionReadiness };
