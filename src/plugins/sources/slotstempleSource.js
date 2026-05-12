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

const name = 'slotstemple';
const HOMEPAGE_URL = 'https://www.slotstemple.com/';
const FAST_NAVIGATION_WAIT = 'networkidle2';
const HIGH_CONFIDENCE_MATCH_SCORE = 140;
const NAV_TIMEOUT = 10000;
const SEARCH_TOGGLE_SELECTOR = 'body > div.game-page.inner-max-width > nav > div > div.nav.navbar-header-top > div.desktop-only.top-left > div.search-toggle';
const SEARCH_INPUT_SELECTOR = 'input#search, input[name="search"]';
const SEARCH_RESULTS_SELECTOR = 'ul.nav-search-result li > a, .st-search-autocomplete a, .st-search-results a';

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

  return cleaned;
}

function extractLayoutFromContextText(text) {
  const source = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!source) {
    return null;
  }

  const isPlausible = (a, b) => {
    const reels = Number(a);
    const rows = Number(b);
    return reels >= 1 && reels <= 12 && rows >= 1 && rows <= 12;
  };

  const patterns = [
    /\b(\d+)\s*(?:by|x|-)\s*(\d+)\s*(?:grid|board|layout|gaming area|game area)\b/i,
    /\b(?:grid|board|layout|gaming area|game area)\s*(?:of|is|:)\s*(\d+)\s*(?:by|x|-)\s*(\d+)\b/i,
    /\b(\d+)\s*reels?\b[^\d]{0,20}\b(\d+)\s*rows?\b/i,
    /\b(\d+)\s*rows?\b[^\d]{0,20}\b(\d+)\s*reels?\b/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match) {
      continue;
    }

    let reels = match[1];
    let rows = match[2];
    if (/rows?\b[^\d]{0,20}\b\d+\s*reels?/i.test(match[0])) {
      reels = match[2];
      rows = match[1];
    }

    if (isPlausible(reels, rows)) {
      return `${reels}x${rows}`;
    }
  }

  return null;
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

async function tryClickCookieButtons(page) {
  const clickConsentOnce = async () => {
    await page.evaluate(() => {
      const clickable = Array.from(document.querySelectorAll('button, [role="button"], a, span'));
      const labels = [
        'accept all cookies',
        'accept essential cookies',
        'accept all',
        'accept',
        'agree',
        'ok',
        'consent',
        'close'
      ];

      for (const node of clickable) {
        const text = (node.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (!text) {
          continue;
        }
        if (labels.some((label) => text.includes(label))) {
          node.click();
          return;
        }
      }
    }).catch(() => {});
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await clickConsentOnce();
    await sleep(200);
  }
}

async function openSearchUi(page) {
  const selectors = [
    SEARCH_TOGGLE_SELECTOR,
    '.search-toggle',
    'div.search-toggle'
  ];

  for (const selector of selectors) {
    const found = await page.$(selector).catch(() => null);
    if (!found) {
      continue;
    }

    await found.click().catch(() => {});
    await sleep(300);

    const input = await page.$(SEARCH_INPUT_SELECTOR).catch(() => null);
    if (input) {
      return true;
    }
  }

  return false;
}

async function fillSearchAndReadCandidates(page, term) {
  await page.$eval(SEARCH_INPUT_SELECTOR, (input) => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await sleep(100);
  await page.focus(SEARCH_INPUT_SELECTOR);
  await page.type(SEARCH_INPUT_SELECTOR, term);

  const POLL_INTERVAL = 100;
  const POLL_TIMEOUT = 3000;
  const pollStart = Date.now();
  let dropdownReady = false;
  while (Date.now() - pollStart < POLL_TIMEOUT) {
    await sleep(POLL_INTERVAL);
    dropdownReady = await page.$(SEARCH_RESULTS_SELECTOR).then((el) => el !== null).catch(() => false);
    if (dropdownReady) {
      break;
    }
  }

  if (!dropdownReady) {
    await page.waitForSelector(SEARCH_RESULTS_SELECTOR, { timeout: 2000 }).catch(() => {});
  }

  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('ul.nav-search-result li > a, .st-search-autocomplete a, .st-search-results a'));
    const parsed = [];

    const deriveTitleFromHref = (href) => {
      try {
        const slug = new URL(href, window.location.origin).pathname.split('/').filter(Boolean).pop() || '';
        if (!slug) {
          return '';
        }
        return slug
          .replace(/[-_]+/g, ' ')
          .replace(/\b\w/g, (m) => m.toUpperCase());
      } catch (_) {
        return '';
      }
    };

    const getTitle = (node, href) => {
      const titleNode =
        node.querySelector('.gameinfo-name, .title, .game-title, h3, h4, strong') ||
        node.closest('li, article, div')?.querySelector('.gameinfo-name, .title, .game-title, h3, h4, strong');
      const imageNode = node.querySelector('img[alt]') || node.closest('li, article, div')?.querySelector('img[alt]');
      const fromNode = (titleNode && titleNode.textContent) || (imageNode && imageNode.getAttribute('alt')) || node.textContent || '';
      const normalized = fromNode.replace(/\s+/g, ' ').trim();
      return normalized || deriveTitleFromHref(href);
    };

    for (const row of rows) {
      const href = row.href || row.getAttribute('href') || '';
      if (!href || !/^https?:\/\/www\.slotstemple\.com\/(slots|free-slots)\/[^/?#]+\/?$/i.test(href)) {
        continue;
      }

      const title = getTitle(row, href);
      if (!title) {
        continue;
      }

      parsed.push({ title, href });
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
}

async function tryDirectSlotUrl(browser, game) {
  const slug = slugify(game);
  if (!slug) {
    return [];
  }

  const paths = [
    `https://www.slotstemple.com/slots/${slug}/`,
    `https://www.slotstemple.com/free-slots/${slug}/`
  ];

  for (const url of paths) {
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: FAST_NAVIGATION_WAIT, timeout: NAV_TIMEOUT });
      await tryClickCookieButtons(page);
      await sleep(400);
      await page.waitForSelector('tr.game-info-table-row', { timeout: 8000 }).catch(() => {});

      const valid = await page.evaluate(() => {
        const bodyText = (document.body.textContent || '').toLowerCase();
        const titleText = (document.title || '').toLowerCase();
        const path = (window.location.pathname || '').toLowerCase();
        const is404 = bodyText.includes('page not found') || titleText.includes('404');

        const headingText = (document.querySelector('h1')?.textContent || '').toLowerCase();
        const policyPage = /cookies\s*policy|privacy\s*policy|terms\s*(and|&)\s*conditions/.test(headingText) ||
          /cookies\s*policy|privacy\s*policy|terms\s*(and|&)\s*conditions/.test(titleText) ||
          /\/cookies\b|\/privacy\b|\/gdpr\b|\/terms\b/.test(path);

        const labels = Array.from(document.querySelectorAll('tr.game-info-table-row th, tr.game-info-table-row th.game-info-table-column'))
          .map((th) => (th.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim());
        const hasSlotData = labels.some((l) => l.includes('slot name')) &&
          labels.some((l) => l.includes('rtp')) &&
          labels.some((l) => l.includes('paylines')) &&
          labels.some((l) => l.includes('reels'));

        return !is404 && !policyPage && hasSlotData;
      });

      if (!valid) {
        continue;
      }

      const title = await page.evaluate(() => {
        const slotNameHeader = Array.from(document.querySelectorAll('tr.game-info-table-row th, tr.game-info-table-row th.game-info-table-column'))
          .find((th) => /slot\s*name\s*:?/i.test((th.textContent || '').trim()));
        if (slotNameHeader) {
          const row = slotNameHeader.closest('tr');
          const valueCell = row ? row.querySelector('td.game-info-table-column, td') : null;
          const slotName = (valueCell?.textContent || '').replace(/\s+/g, ' ').trim();
          if (slotName) {
            return slotName;
          }
        }

        const h1 = document.querySelector('h1');
        return h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : document.title.replace(/\s+/g, ' ').trim();
      });

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
    await tryClickCookieButtons(page);
    await sleep(300);
    await page.waitForSelector('tbody, tr.game-info-table-row', { timeout: 8000 }).catch(() => {});

    const data = await page.evaluate(() => {
      const h1 = document.querySelector('h1');
      const title = h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : '';

      const titleText = (document.title || '').toLowerCase();
      const headingText = title.toLowerCase();
      const policyPage = /cookies\s*policy|privacy\s*policy|terms\s*(and|&)\s*conditions/.test(headingText) ||
        /cookies\s*policy|privacy\s*policy|terms\s*(and|&)\s*conditions/.test(titleText);

      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const requiredLabels = ['slot name', 'rtp', 'paylines', 'reels', 'themes'];
      const tbodies = Array.from(document.querySelectorAll('tbody'));

      const tableCandidates = tbodies
        .map((tbody) => {
          const rows = Array.from(tbody.querySelectorAll('tr.game-info-table-row, tr'));
          const map = {};

          for (const row of rows) {
            const th = row.querySelector('th.game-info-table-column, th');
            const td = row.querySelector('td.game-info-table-column, td');
            if (!th || !td) {
              continue;
            }

            const rawLabel = normalize(th.textContent || '').replace(/:$/, '');
            const label = rawLabel.toLowerCase();
            const value = normalize(td.textContent || '');
            if (!label || !value) {
              continue;
            }

            map[label] = value;
          }

          const labels = Object.keys(map);
          const score = requiredLabels.reduce((acc, label) => acc + (labels.some((rowLabel) => rowLabel.includes(label)) ? 1 : 0), 0);

          return {
            map,
            score,
            text: normalize(tbody.textContent || '')
          };
        })
        .filter((entry) => entry.score >= 4)
        .sort((a, b) => b.score - a.score || a.text.length - b.text.length);

      const bestTable = tableCandidates[0] || { map: {}, score: 0, text: '' };

      const bodyText = (document.body.textContent || '').replace(/\s+/g, ' ').trim();

      return {
        title,
        slotDataText: bestTable.text,
        slotDataMap: bestTable.map,
        bodyText,
        policyPage,
        hasSlotData: bestTable.score >= 4,
        path: (window.location.pathname || '').toLowerCase()
      };
    });

    if (data.policyPage || /\/cookies\b|\/privacy\b|\/gdpr\b|\/terms\b/.test(data.path || '') || !data.hasSlotData) {
      return {
        source: name,
        title: data.title || hit.title,
        url: hit.href,
        error: 'Non-slot page content',
        buy_feature: 'No',
        match_score: 0
      };
    }

    const getMapped = (key) => {
      const entries = Object.entries(data.slotDataMap || {});
      const found = entries.find(([label]) => label.includes(key));
      return found ? textOrNull(found[1]) : null;
    };

    const slotName = getMapped('slot name');
    const paylines = getMapped('paylines');
    const reels = getMapped('reels');
    const rows = getMapped('rows');
    const themes = getMapped('themes');
    const features = getMapped('features');

    const combinedText = [data.slotDataText, data.bodyText].join(' ');
    const layoutFromPanel = reels && rows ? `${reels}x${rows}` : null;
    const explicitLayout = getMapped('layout');
    const multiDimLayoutMatch = combinedText.match(/\b\d+(?:\s*(?:[xX]|by|-)\s*\d+){2,}\b/i);
    const contextualLayout = extractLayoutFromContextText(combinedText);
    const inferredLayout = inferLayoutFromText(combinedText);

    let rawLayout = null;
    if (explicitLayout) {
      rawLayout = explicitLayout;
    } else if (layoutFromPanel) {
      rawLayout = layoutFromPanel;
    } else if (multiDimLayoutMatch && multiDimLayoutMatch[0]) {
      rawLayout = multiDimLayoutMatch[0];
    } else if (contextualLayout) {
      rawLayout = contextualLayout;
    } else if (inferredLayout) {
      rawLayout = inferredLayout;
    }

    const layout = normalizeLayout(rawLayout);

    const buyFeature = /buy\s*feature|bonus\s*buy/i.test(data.bodyText) || /buy\s*feature|bonus\s*buy/i.test(features || '')
      ? 'yes'
      : 'No';

    const extractedTitle = slotName || data.title || hit.title;
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
      betways: textOrNull(paylines),
      features: textOrNull(features),
      theme: textOrNull(themes),
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

async function scrapeSlotsTemple(game, options = {}) {
  const debugTerms = Boolean(options.debugTerms);
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(HOMEPAGE_URL, { waitUntil: FAST_NAVIGATION_WAIT, timeout: NAV_TIMEOUT });
    await tryClickCookieButtons(page);
    await openSearchUi(page);
    await page.waitForSelector(SEARCH_INPUT_SELECTOR, { timeout: 10000 });

    const terms = buildFallbackTerms(game);
    const { candidates: collectedCandidates, termAttempts } = await collectCandidatesAcrossTerms(
      terms,
      async (term) => fillSearchAndReadCandidates(page, term),
      { debugTerms, maxCandidatePoolSize: MAX_CANDIDATE_POOL_SIZE }
    );

    let rankedCandidates = rankCandidatesForGame(game, collectedCandidates);
    let picked = pickCandidatesForDetails(rankedCandidates);
    const topCandidate = rankedCandidates[0] || null;
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
        rankedCandidates = rankCandidatesForGame(game, directHits);
        picked = rankedCandidates;
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

    return {
      acceptedHits,
      closestMatch: buildClosestMatch(rankedCandidates[0] || picked[0] || null),
      debug: buildDebugPayload(debugTerms, termAttempts, picked)
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
      const result = await scrapeSlotsTemple(gameName);
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
          title: result.closestMatch ? `Closest: ${result.closestMatch.title}` : 'No games found.',
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
