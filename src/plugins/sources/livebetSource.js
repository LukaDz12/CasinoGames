const {
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
} = require('../../core/search-utils');
const { getBrowser } = require('../../core/browser');

const name = 'livebet';
const HOMEPAGE_URL = 'https://www.livebet.com/';
const FAST_NAVIGATION_WAIT = 'networkidle2';
const HIGH_CONFIDENCE_MATCH_SCORE = 140;
const NAV_TIMEOUT = 30000;
const SEARCH_BUTTON_SELECTOR = 'button[data-name="search-navbar"], #search-container button, button[class*="search" i]';
const SEARCH_INPUT_SELECTOR = '#search-input, input#search-input';
const SEARCH_RESULTS_PANEL_SELECTOR = '#search-results';
const SEARCH_RESULTS_SELECTOR = '#search-results li';

function textOrNull(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function normalizeLayout(value) {
  const layout = textOrNull(value);
  if (!layout) {
    return null;
  }

  const cleaned = layout
    .replace(/^[\s\-:]+|[\s\-:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const chainMatch = cleaned.match(/\d+(?:\s*(?:[xX]|by|-)\s*\d+)+/i);
  if (chainMatch) {
    const parts = chainMatch[0].match(/\d+/g);
    if (parts && parts.length >= 2) {
      return parts.join('x');
    }
  }

  const reelsRowsMatch = cleaned.match(/(\d+)\s*reels?\b[^\d]{0,20}(\d+)\s*rows?\b/i);
  if (reelsRowsMatch) {
    return `${reelsRowsMatch[1]}x${reelsRowsMatch[2]}`;
  }

  const rowsReelsMatch = cleaned.match(/(\d+)\s*rows?\b[^\d]{0,20}(\d+)\s*reels?\b/i);
  if (rowsReelsMatch) {
    return `${rowsReelsMatch[2]}x${rowsReelsMatch[1]}`;
  }

  return cleaned;
}

function extractLabelValue(text, label, nextLabels = []) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) {
    return null;
  }

  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedNext = nextLabels
    .filter((next) => next && next !== label)
    .map((next) => next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  const stopPattern = escapedNext.length > 0 ? `(?=\\b(?:${escapedNext.join('|')})\\s*:|$)` : '$';
  const pattern = new RegExp(`\\b${escapedLabel}\\s*:\\s*([\\s\\S]*?)${stopPattern}`, 'i');
  const match = source.match(pattern);
  return match ? textOrNull(match[1]) : null;
}

function isConsistentTitle(expected, actual) {
  const expectedTokens = String(expected || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const actualTokens = String(actual || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (expectedTokens.length === 0 || actualTokens.length === 0) {
    return false;
  }
  const overlap = expectedTokens.filter((token) => actualTokens.includes(token)).length;
  return overlap >= Math.max(2, Math.ceil(expectedTokens.length * 0.5));
}

async function isCloudflareChallengePage(page) {
  return page.evaluate(() => {
    const title = (document.title || '').toLowerCase();
    const text = (document.body && document.body.textContent ? document.body.textContent : '').toLowerCase();
    const hasChallengeScript = Boolean(document.querySelector('script[data-cf-beacon], script[src*="/cdn-cgi/challenge-platform"], script[src*="challenge-platform"]'));

    return (
      title.includes('just a moment') ||
      text.includes('verify you are human') ||
      text.includes('performing security verification') ||
      text.includes('enable javascript and cookies to continue') ||
      text.includes('cf-mitigated') ||
      hasChallengeScript
    );
  }).catch(() => false);
}

async function openSearchUi(page) {
  const existingInput = await page.$(SEARCH_INPUT_SELECTOR).catch(() => null);
  if (existingInput) {
    return true;
  }

  const selectors = [
    SEARCH_BUTTON_SELECTOR,
    'button[data-name*="search" i]',
    'button[aria-label*="search" i]',
    'button[class*="search" i]'
  ];

  for (const selector of selectors) {
    const found = await page.$(selector).catch(() => null);
    if (!found) {
      continue;
    }

    await found.click().catch(() => {});
    await sleep(250);

    const input = await page.$(SEARCH_INPUT_SELECTOR).catch(() => null);
    if (input) {
      return true;
    }
  }

  return false;
}

async function closeSearchResultsIfOpen(page) {
  const wasOpen = await page.evaluate((panelSelector, inputSelector) => {
    const panel = document.querySelector(panelSelector);
    const input = document.querySelector(inputSelector);

    if (input) {
      input.blur();
    }

    if (!panel) {
      return false;
    }

    const open = !panel.classList.contains('hidden');
    if (!open) {
      return false;
    }

    panel.classList.add('hidden');
    panel.setAttribute('aria-hidden', 'true');
    return true;
  }, SEARCH_RESULTS_PANEL_SELECTOR, SEARCH_INPUT_SELECTOR).catch(() => false);

  if (!wasOpen) {
    return;
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.mouse.click(5, 5).catch(() => {});
  await sleep(80);
}

async function fillSearchAndReadCandidates(page, term) {
  await page.$eval(SEARCH_INPUT_SELECTOR, (input) => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await sleep(120);
  await page.focus(SEARCH_INPUT_SELECTOR);
  await page.type(SEARCH_INPUT_SELECTOR, term);

  const POLL_INTERVAL = 120;
  const POLL_TIMEOUT = 3000;
  const start = Date.now();
  let foundResults = false;

  while (Date.now() - start < POLL_TIMEOUT) {
    await sleep(POLL_INTERVAL);
    foundResults = await page.evaluate((panelSel, itemSel) => {
      const panel = document.querySelector(panelSel);
      if (!panel) {
        return false;
      }

      const hiddenByClass = panel.classList.contains('hidden');
      const visible = !hiddenByClass && panel.childElementCount > 0;
      if (!visible) {
        return false;
      }

      const items = Array.from(document.querySelectorAll(itemSel));
      if (items.length === 0) {
        return false;
      }

      return items.some((li) => {
        const text = (li.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim();
        return text && !text.includes('no results found');
      });
    }, SEARCH_RESULTS_PANEL_SELECTOR, SEARCH_RESULTS_SELECTOR).catch(() => false);
    if (foundResults) {
      break;
    }
  }

  if (!foundResults) {
    await page.waitForSelector(SEARCH_RESULTS_SELECTOR, { timeout: 2000 }).catch(() => {});
  }

  const candidates = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#search-results li'));
    const parsed = [];

    const isLikelyGameLink = (href) => {
      if (!href) {
        return false;
      }

      let url;
      try {
        url = new URL(href, window.location.origin);
      } catch (_) {
        return false;
      }

      if (!/livebet\.com$/i.test(url.hostname)) {
        return false;
      }

      const path = url.pathname.toLowerCase();
      if (path === '/' || path.startsWith('/login') || path.startsWith('/register') || path.startsWith('/sports')) {
        return false;
      }

      return /slot|casino|game/.test(path);
    };

    for (const row of rows) {
      const rowText = (row.textContent || '').replace(/\s+/g, ' ').trim();
      if (!rowText || /no results found/i.test(rowText)) {
        continue;
      }

      const anchor = row.querySelector('a[href]') || row.closest('a[href]');
      const href =
        (anchor && (anchor.href || anchor.getAttribute('href'))) ||
        row.getAttribute('data-url') ||
        row.getAttribute('data-href') ||
        row.getAttribute('data-link') ||
        '';

      if (!isLikelyGameLink(href)) {
        continue;
      }

      const titleNode =
        (anchor && anchor.querySelector('.title, .name, h3, h4, strong')) ||
        row.querySelector('.title, .name, h3, h4, strong');

      const imageTitle =
        (anchor && anchor.querySelector('img[alt]') && anchor.querySelector('img[alt]').getAttribute('alt')) ||
        (row.querySelector('img[alt]') && row.querySelector('img[alt]').getAttribute('alt')) ||
        '';

      const title = (imageTitle || (titleNode && titleNode.textContent) || rowText).replace(/\s+/g, ' ').trim();
      if (!title || title.length < 2) {
        continue;
      }

      let absoluteHref = href;
      try {
        absoluteHref = new URL(href, window.location.origin).href;
      } catch (_) {
        // Keep original href if URL construction fails.
      }

      parsed.push({ title, href: absoluteHref });
    }

    const deduped = [];
    const seen = new Set();
    for (const item of parsed) {
      if (seen.has(item.href)) {
        continue;
      }
      seen.add(item.href);
      deduped.push(item);
    }

    return deduped;
  });

  await closeSearchResultsIfOpen(page);
  return candidates;
}

async function tryDirectSlotUrl(browser, game) {
  const slug = slugify(game);
  if (!slug) {
    return [];
  }

  const paths = [
    `https://www.livebet.com/slots/${slug}`,
    `https://www.livebet.com/casino/${slug}`,
    `https://www.livebet.com/game/${slug}`
  ];

  for (const url of paths) {
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: FAST_NAVIGATION_WAIT, timeout: NAV_TIMEOUT });
      const valid = await page.evaluate(() => {
        const body = (document.body.textContent || '').toLowerCase();
        const title = (document.title || '').toLowerCase();
        const is404 = body.includes('page not found') || title.includes('404');
        return !is404;
      });

      if (!valid) {
        continue;
      }

      const title = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        return (h1 ? h1.textContent : document.title).replace(/\s+/g, ' ').trim();
      });

      if (!title) {
        continue;
      }

      return [{ title, href: url }];
    } catch (_) {
      // Try next path.
    } finally {
      await page.close();
    }
  }

  return [];
}

async function scrapeSlotDetail(browser, game, hit) {
  const page = await browser.newPage();

  try {
    await page.goto(hit.href, { waitUntil: FAST_NAVIGATION_WAIT, timeout: NAV_TIMEOUT });
    await sleep(300);
    await page.waitForSelector('div.section.casino-game, .section.casino-game, table', { timeout: 8000 }).catch(() => {});

    const data = await page.evaluate(() => {
      const normalize = (v) => (v || '').replace(/\s+/g, ' ').trim();

      const section = document.querySelector('div.section.casino-game') || document.querySelector('.section.casino-game');
      const scope = section || document;

      const heading = scope.querySelector('h1, h2.title-main, h2, h3');
      const title = normalize((heading && heading.textContent) || document.title || '')
        .replace(/\s+Slot\s+Demo\s+RTP,\s*Review\s*&\s*More$/i, '')
        .trim();

      const rows = Array.from(scope.querySelectorAll('table tr, tr.text-left, tr'));
      const map = {};
      for (const row of rows) {
        const left = row.querySelector('th, td:first-child, .label, .key');
        const right = row.querySelector('td:last-child, .value');
        if (!left || !right || left === right) {
          continue;
        }

        const label = normalize(left.textContent || '').replace(/:$/, '').toLowerCase();
        const value = normalize(right.textContent || '');
        if (!label || !value) {
          continue;
        }

        map[label] = value;
      }

      const bodyText = normalize((scope.textContent || document.body.textContent || ''));

      return {
        title,
        map,
        bodyText,
        hasGameSection: Boolean(section)
      };
    });

    if (!data.hasGameSection) {
      return {
        source: name,
        title: hit.title,
        url: hit.href,
        error: 'Game detail section missing',
        buy_feature: 'No',
        match_score: hit.matchScore
      };
    }

    const getMapped = (key) => {
      const entries = Object.entries(data.map || {});
      const found = entries.find(([label]) => label.includes(key));
      return found ? textOrNull(found[1]) : null;
    };

    const layoutFromBody = extractLabelValue(data.bodyText, 'Layout', ['Paylines', 'Theme', 'Features', 'Provider', 'RTP']);
    const paylinesFromBody = extractLabelValue(data.bodyText, 'Paylines', ['Theme', 'Features', 'Provider', 'RTP']);
    const themeFromBody = extractLabelValue(data.bodyText, 'Theme', ['Features', 'Provider', 'RTP', 'Layout']);
    const featuresFromBody = extractLabelValue(data.bodyText, 'Features', ['Theme', 'Provider', 'RTP', 'Layout']);

    const explicitLayout = getMapped('layout');
    const panelLayout = getMapped('reels') && getMapped('rows') ? `${getMapped('reels')}x${getMapped('rows')}` : null;
    const inferredLayout = inferLayoutFromText(data.bodyText);

    let rawLayout = null;
    if (explicitLayout) {
      rawLayout = explicitLayout;
    } else if (panelLayout) {
      rawLayout = panelLayout;
    } else if (layoutFromBody) {
      rawLayout = layoutFromBody;
    } else if (inferredLayout) {
      rawLayout = inferredLayout;
    }

    const layout = normalizeLayout(rawLayout);

    const betways = getMapped('betways') || getMapped('ways') || getMapped('lines') || getMapped('paylines') || paylinesFromBody;
    const features = getMapped('features') || featuresFromBody;
    const theme = getMapped('theme') || getMapped('themes') || themeFromBody;
    const buyFeature = /buy\s*feature|bonus\s*buy/i.test(data.bodyText) || /buy\s*feature|bonus\s*buy/i.test(features || '')
      ? 'yes'
      : 'No';

    const extractedTitle = data.title || hit.title;
    if (!isConsistentTitle(game, extractedTitle)) {
      return {
        source: name,
        title: extractedTitle,
        url: hit.href,
        error: `Content mismatch for ${game}`,
        buy_feature: 'No',
        match_score: 0
      };
    }

    return {
      source: name,
      title: extractedTitle,
      url: hit.href,
      layout,
      betways: textOrNull(betways),
      features: textOrNull(features),
      theme: textOrNull(theme),
      buy_feature: buyFeature,
      match_score: hit.matchScore
    };
  } catch (error) {
    return {
      source: name,
      title: hit.title,
      url: hit.href,
      error: error.message,
      buy_feature: 'No',
      match_score: hit.matchScore
    };
  } finally {
    await page.close();
  }
}

async function scrapeLivebet(game, options = {}) {
  const debugTerms = Boolean(options.debugTerms);
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(HOMEPAGE_URL, { waitUntil: FAST_NAVIGATION_WAIT, timeout: NAV_TIMEOUT });

    if (await isCloudflareChallengePage(page)) {
      return {
        acceptedHits: [],
        closestMatch: null,
        debug: buildDebugPayload(debugTerms, [], []),
        error: 'Blocked by Cloudflare challenge'
      };
    }

    await openSearchUi(page);
    await page.waitForSelector(SEARCH_INPUT_SELECTOR, { timeout: 10000 });

    const terms = buildFallbackTerms(game);
    const { candidates: collectedCandidates, termAttempts } = await collectCandidatesAcrossTerms(
      terms,
      async (term) => fillSearchAndReadCandidates(page, term),
      { debugTerms, maxCandidatePoolSize: MAX_CANDIDATE_POOL_SIZE }
    );

    const ranked = rankCandidatesForGame(game, collectedCandidates);
    let picked = pickCandidatesForDetails(ranked);
    const topCandidate = ranked[0] || null;
    if (topCandidate && Number(topCandidate.matchScore) >= HIGH_CONFIDENCE_MATCH_SCORE) {
      picked = [topCandidate];
    }

    if (picked.length === 0) {
      const directHits = await tryDirectSlotUrl(browser, game);
      if (directHits.length > 0) {
        if (debugTerms) {
          termAttempts.push({
            term: '[direct-url-fallback]',
            matchesFound: directHits.length,
            sampleTitles: directHits.slice(0, 3).map((item) => item.title)
          });
        }
        picked = rankCandidatesForGame(game, directHits);
      }
    }

    const hits = await Promise.all(picked.map((hit) => scrapeSlotDetail(browser, game, hit)));
    const normalizedHits = hits.map((hit) => ({
      ...hit,
      matchScore: Number(hit.match_score || 0)
    }));
    const acceptedHits = filterAcceptedHits(normalizedHits).map(({ matchScore, ...rest }) => ({
      ...rest,
      match_score: matchScore
    }));
    const closestCandidate = ranked[0] || picked[0] || null;

    return {
      acceptedHits,
      closestMatch: buildClosestMatch(closestCandidate),
      debug: buildDebugPayload(debugTerms, termAttempts, picked)
    };
  } catch (error) {
    const cloudflareBlocked = await isCloudflareChallengePage(page);
    return {
      acceptedHits: [],
      closestMatch: null,
      debug: buildDebugPayload(debugTerms, [], []),
      error: cloudflareBlocked ? 'Blocked by Cloudflare challenge' : error.message
    };
  } finally {
    await page.close();
  }
}

async function fetchByIds(ids) {
  const rows = [];

  for (const id of ids) {
    const gameName = String(id || '').trim();
    if (!gameName) {
      continue;
    }

    try {
      const result = await scrapeLivebet(gameName);
      if ((result.acceptedHits || []).length > 0) {
        const best = result.acceptedHits.sort((a, b) => Number(b.match_score) - Number(a.match_score))[0];
        rows.push({
          id: gameName,
          source: name,
          title: best.title || '',
          layout: best.layout || '',
          betways: best.betways || '',
          buy_feature: best.buy_feature || 'No',
          theme: best.theme || '',
          features: best.features || '',
          url: best.url || '',
          match_score: Number(best.match_score || 0)
        });
      } else {
        rows.push({
          id: gameName,
          source: name,
          title: result.closestMatch ? `Closest: ${result.closestMatch.title}` : (result.error || 'No games found.'),
          layout: '',
          betways: '',
          buy_feature: '',
          theme: '',
          features: '',
          url: result.closestMatch ? result.closestMatch.url || '' : '',
          match_score: result.closestMatch ? Number(result.closestMatch.score || 0) : 0
        });
      }
    } catch (error) {
      rows.push({
        id: gameName,
        source: name,
        title: `Error: ${error.message}`,
        layout: '',
        betways: '',
        buy_feature: '',
        theme: '',
        features: '',
        url: '',
        match_score: 0
      });
    }
  }

  return rows;
}

module.exports = {
  name,
  fetchByIds
};
