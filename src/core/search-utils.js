const MIN_OUTPUT_MATCH_SCORE = 50;
const MIN_DETAIL_SCRAPE_SCORE = 20;
const MAX_CANDIDATE_POOL_SIZE = 10;
const MAX_SELECTED_CANDIDATES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length > 1);
}

function slugify(value) {
  return normalizeText(value).replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function inferLayoutFromText(input) {
  const text = String(input || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return null;
  }

  const isPlausibleLayout = (reels, rows) => {
    const reelsCount = Number(reels);
    const rowsCount = Number(rows);
    return reelsCount >= 1 && reelsCount <= 12 && rowsCount >= 1 && rowsCount <= 12;
  };

  const directPatterns = [
    /\b(?:game area|layout|grid|setup)\b[^\d]{0,30}(\d+)\s*[xX-]\s*(\d+)\b/i,
    /\b(\d+)\s*[xX-]\s*(\d+)\b/,
    /\b(\d+)\s*[- ]?reels?\b[^\d]{0,20}(\d+)\s*[- ]?rows?\b/i,
    /\b(\d+)\s*[- ]?rows?\b[^\d]{0,20}(\d+)\s*[- ]?reels?\b/i,
    /\b(\d+)\s*[- ]?reel\b[^\d]{0,6},?\s*(\d+)\s*[- ]?row\b/i,
    /\b(\d+)\s*[- ]?row\b[^\d]{0,6},?\s*(\d+)\s*[- ]?reel\b/i
  ];

  for (const pattern of directPatterns) {
    const match = text.match(pattern);
    if (!match) {
      continue;
    }

    let reels = match[1];
    let rows = match[2];
    if (/rows?/i.test(match[0]) && /reels?/i.test(match[0]) && /^\b\d+\s*[- ]?rows?/i.test(match[0])) {
      reels = match[2];
      rows = match[1];
    }

    if (isPlausibleLayout(reels, rows)) {
      return `${reels}x${rows}`;
    }
  }

  const reelsMatch = text.match(/\b(\d+)\s*[- ]?reels?\b/i);
  const rowsMatch = text.match(/\b(\d+)\s*[- ]?rows?\b/i);
  if (reelsMatch && rowsMatch && isPlausibleLayout(reelsMatch[1], rowsMatch[1])) {
    return `${reelsMatch[1]}x${rowsMatch[1]}`;
  }

  return null;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function buildFallbackTerms(game) {
  const terms = [game];
  const sanitized = game.replace(/[^a-zA-Z0-9\s]/g, '').trim();
  if (sanitized && sanitized !== game) {
    terms.push(sanitized);
  }

  const words = game.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    terms.push(words.slice(0, 2).join(' '));
    terms.push(words.slice(-2).join(' '));
  }

  if (words.length >= 3) {
    for (let index = 0; index < words.length - 1; index += 1) {
      terms.push(`${words[index]} ${words[index + 1]}`);
    }
  }

  const normalized = normalizeText(game).split(' ').filter(Boolean);
  if (normalized.length >= 2) {
    terms.push(normalized.slice(0, 2).join(' '));
    terms.push(normalized.slice(-2).join(' '));
  }

  return uniqueBy(
    terms.map((term) => term.trim()).filter(Boolean),
    (term) => term.toLowerCase()
  );
}

function scoreCandidate(game, candidate) {
  const gameTokens = tokenize(game);
  const title = candidate.title || '';
  const url = candidate.href || '';
  const titleTokens = tokenize(title);
  const titleText = normalizeText(title);
  const gameText = normalizeText(game);

  let score = 0;

  if (titleText === gameText) {
    score += 100;
  }

  if (titleText.includes(gameText) && gameText.length > 3) {
    score += 40;
  }

  if (gameText.includes(titleText) && titleText.length > 3) {
    score += 30;
  }

  const overlap = gameTokens.filter((token) => titleTokens.includes(token)).length;
  score += overlap * 12;

  const pathSlug = (url.split('/').pop() || '').toLowerCase();
  const gameSlug = slugify(game);
  if (pathSlug === gameSlug) {
    score += 70;
  } else if (pathSlug.includes(gameSlug) && gameSlug.length > 3) {
    score += 35;
  }

  return score;
}

async function collectCandidatesAcrossTerms(terms, findCandidatesForTerm, options = {}) {
  const debugTerms = Boolean(options.debugTerms);
  const maxCandidatePoolSize = options.maxCandidatePoolSize || MAX_CANDIDATE_POOL_SIZE;
  const termAttempts = [];
  let candidates = [];

  for (const term of terms) {
    const found = await findCandidatesForTerm(term);
    const taggedFound = found.map((item) => ({ ...item, term }));

    if (debugTerms) {
      termAttempts.push({
        term,
        matchesFound: taggedFound.length,
        sampleTitles: taggedFound.slice(0, 3).map((item) => item.title)
      });
    }

    candidates = candidates.concat(taggedFound);
    if (candidates.length >= maxCandidatePoolSize) {
      break;
    }
  }

  return { candidates, termAttempts };
}

function rankCandidatesForGame(game, candidates, scoreFn = scoreCandidate) {
  return uniqueBy(candidates, (candidate) => candidate.href)
    .map((candidate) => ({
      ...candidate,
      matchScore: scoreFn(game, candidate)
    }))
    .sort((a, b) => b.matchScore - a.matchScore);
}

function pickCandidatesForDetails(candidates, options = {}) {
  const minDetailScrapeScore = options.minDetailScrapeScore || MIN_DETAIL_SCRAPE_SCORE;
  const maxSelectedCandidates = options.maxSelectedCandidates || MAX_SELECTED_CANDIDATES;

  const strongMatches = candidates.filter((candidate) => candidate.matchScore >= minDetailScrapeScore);
  if (strongMatches.length > 0) {
    return strongMatches.slice(0, maxSelectedCandidates);
  }

  return candidates.slice(0, Math.min(2, maxSelectedCandidates));
}

function buildClosestMatch(candidate) {
  if (!candidate) {
    return null;
  }

  return {
    title: candidate.title,
    url: candidate.href,
    score: candidate.matchScore,
    term: candidate.term || null
  };
}

function filterAcceptedHits(hits, minOutputMatchScore = MIN_OUTPUT_MATCH_SCORE) {
  return hits.filter((hit) => Number(hit.matchScore) >= minOutputMatchScore);
}

function buildDebugPayload(enabled, termAttempts, selectedCandidates) {
  if (!enabled) {
    return null;
  }

  return {
    termAttempts,
    selectedCandidates: selectedCandidates.map((candidate) => ({
      term: candidate.term || null,
      title: candidate.title,
      href: candidate.href,
      matchScore: candidate.matchScore
    }))
  };
}

module.exports = {
  MAX_CANDIDATE_POOL_SIZE,
  buildClosestMatch,
  buildDebugPayload,
  buildFallbackTerms,
  collectCandidatesAcrossTerms,
  filterAcceptedHits,
  inferLayoutFromText,
  pickCandidatesForDetails,
  rankCandidatesForGame,
  sleep,
  slugify
};
