const name = 'passthrough-service';

async function process(rows) {
  return rows;
}

module.exports = {
  name,
  process
};
