// Future operator-authorized preflight building block. No automatic execution,
// model imports, connection establishment, mutation, or default injection.
async function readProtectiveWork(db, now = new Date()) {
  return {
    activeProtectionLeases: await db.collection('orderprotectionlocks').countDocuments({ expiresAt: { $gt: now } }, { maxTimeMS: 1000 }),
    positionCloseStates: await db.collection('positioncloses').aggregate([
      { $group: { _id: '$state', count: { $sum: 1 } } }
    ], { maxTimeMS: 1000 }).toArray(),
    activePositionCloses: await db.collection('positioncloses').countDocuments({ active: true }, { maxTimeMS: 1000 })
  };
}
module.exports = { readProtectiveWork };
