function getAccountIdForUser(user = {}) {
  const rawId = user.username || user.userId || user.sub || user.id || user._id;
  const value = String(rawId || '').trim();
  return value ? `user:${value}` : 'default';
}

function getRequestAccountId(req = {}) {
  return getAccountIdForUser(req.user || {});
}

module.exports = {
  getAccountIdForUser,
  getRequestAccountId
};
