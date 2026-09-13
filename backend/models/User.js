// backend/models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  email:    { type: String, unique: true, sparse: true, default: null },
  hash:     { type: String, required: true },
  sessionVersion: { type: Number, default: 0, min: 0 }
});

module.exports = mongoose.model('User', userSchema);
