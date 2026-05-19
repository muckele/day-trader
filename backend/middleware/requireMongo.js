const mongoState = require('../utils/mongoState');

module.exports = function requireMongo(req, res, next) {
  if (mongoState.isMongoReady()) {
    return next();
  }

  return res.status(503).json(mongoState.createMongoUnavailablePayload());
};
