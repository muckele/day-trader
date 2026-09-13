function safeErrorResponse() {
  // Provider errors can contain full credential-bearing request objects and URLs.
  return { status: 500, message: 'Unexpected server error.' };
}
module.exports = { safeErrorResponse };
