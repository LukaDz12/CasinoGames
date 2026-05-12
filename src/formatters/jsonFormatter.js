function formatJson(payload) {
  return JSON.stringify(payload, null, 2);
}

module.exports = {
  formatJson
};
