// backend/models/Log.js
const mongoose = require('mongoose');

const logSchema = new mongoose.Schema({
  username: { type: String, required: true },
  action:   { type: String, required: true },
  timestamp:{ type: Date,   default: Date.now }
});

module.exports = mongoose.model('Log', logSchema);
