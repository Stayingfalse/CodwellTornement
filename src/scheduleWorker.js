// Runs scheduler.generateSchedule off the main thread (it takes seconds and
// would otherwise freeze the bot). See generateScheduleAsync in scheduler.js.
const { parentPort, workerData } = require('worker_threads');
const { generateSchedule } = require('./scheduler');

try {
  parentPort.postMessage({ ok: true, rounds: generateSchedule(workerData.players, workerData.options) });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.stack || String(error) });
}
