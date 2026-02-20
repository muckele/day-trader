const roboEngine = require('./roboTraderEngine');

function startRoboScheduler({ intervalMs = 60 * 1000 } = {}) {
  if (process.env.ROBO_SCHEDULER_DISABLED === 'true') {
    return () => {};
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await roboEngine.runSchedulerTick();
    } catch (err) {
      console.error('Robo scheduler tick failed:', err.message);
    } finally {
      running = false;
    }
  };

  // slight startup delay to avoid competing with cold-start tasks
  const startTimeout = setTimeout(() => {
    tick();
  }, 5000);
  const timer = setInterval(tick, intervalMs);

  return () => {
    clearTimeout(startTimeout);
    clearInterval(timer);
  };
}

module.exports = {
  startRoboScheduler
};
