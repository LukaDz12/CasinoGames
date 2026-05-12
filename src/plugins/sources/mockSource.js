const name = 'mock-source';

async function fetchByIds(ids) {
  return ids.map((id, index) => ({
    id,
    title: `Game ${id}`,
    layout: index % 2 === 0 ? '5x3' : '6x4',
    betways: index % 2 === 0 ? '20 lines' : '243 ways',
    buy_feature: index % 3 === 0 ? 'yes' : 'No',
    theme: index % 2 === 0 ? 'myth' : 'adventure',
    features: 'wild, scatter',
    url: `https://example.com/game/${encodeURIComponent(id)}`,
    match_score: 90 - index
  }));
}

module.exports = {
  name,
  fetchByIds
};
