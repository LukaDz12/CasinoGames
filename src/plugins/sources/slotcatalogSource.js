const {
  MAX_CANDIDATE_POOL_SIZE,
  buildClosestMatch,
  buildDebugPayload,
  buildFallbackTerms,
  collectCandidatesAcrossTerms,
  filterAcceptedHits,
  pickCandidatesForDetails,
  rankCandidatesForGame,
  sleep,
  slugify
} = require('../../core/search-utils');
const { getBrowser } = require('../../core/browser');

const name = 'slotcatalog';
const FAST_NAVIGATION_WAIT = 'networkidle2';
const HIGH_CONFIDENCE_MATCH_SCORE = 140;
const NAV_TIMEOUT = 10000;

async function tryClickCookieButtons(page) {
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const labels = ['accept', 'agree', 'ok', 'consent'];
    for (const button of buttons) {
      const text = (button.textContent || '').toLowerCase();
      if (labels.some((label) => text.includes(label))) {
        button.click();
        return;
      }
    }
  });
}

async function tryDismissModal(page) {
  await page.evaluate(() => {
    const selectors = [
      '[aria-label="Close"]',
      'button[title="Close"]',
      '.fancybox-item.fancybox-close',
      '.close',
      '.modal-close',
      '.signup-close'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) {
        el.click();
        break;
      }
    }
  });
}

async function fillSearchAndReadCandidates(page, term) {
  await page.$eval('#selsearch', (input) => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await sleep(250);
  await page.focus('#selsearch');
  await page.type('#selsearch', term);
  await sleep(900);

  await page.waitForSelector('.tt-menu', { timeout: 5000 }).catch(() => {});

  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.tt-menu .tt-suggestion, .tt-menu a, .tt-menu [role="option"]'));
    const parsed = [];

    for (const row of rows) {
      const anchor = row.tagName === 'A' ? row : row.querySelector('a');
      const href =
        (anchor && anchor.href) ||
        row.getAttribute('data-href') ||
        row.getAttribute('href') ||
        '';

      if (!href || !href.includes('/en/slots/')) {
        continue;
      }

      const titleNode = row.querySelector('.tt-highlight, .tt-title, .title') || row;
      const title = (titleNode.textContent || row.textContent || '').replace(/\s+/g, ' ').trim();
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

  const url = `https://slotcatalog.com/en/slots/${slug}`;
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: FAST_NAVIGATION_WAIT, timeout: NAV_TIMEOUT });
    await page.waitForSelector('th.propLeft, table', { timeout: 8000 }).catch(() => {});
    const valid = await page.evaluate(() => {
      const is404 = document.title.toLowerCase().includes('404') || document.body.textContent.toLowerCase().includes('page not found');
      const hasSlotTable = document.querySelector('th.propLeft') !== null;
      return !is404 && hasSlotTable;
    });

    if (!valid) {
      return [];
    }

    const title = await page.evaluate(() => {
      const h1 = document.querySelector('h1');
      if (h1 && h1.textContent.trim()) {
        return h1.textContent.replace(/\s+/g, ' ').trim();
      }
      return document.title.replace(/\s+/g, ' ').trim();
    });

    return [{ title, href: url }];
  } catch (_) {
    return [];
  } finally {
    await page.close();
  }
}

async function scrapeSlotDetail(browser, hit) {
  const page = await browser.newPage();
  try {
    await page.goto(hit.href, { waitUntil: FAST_NAVIGATION_WAIT, timeout: NAV_TIMEOUT });
    await tryDismissModal(page);
    await sleep(600);
    await page.waitForSelector('th.propLeft, table', { timeout: 10000 });

    const data = await page.evaluate(() => {
      const result = {
        title: null,
        layout: null,
        layoutEvidence: null,
        betways: null,
        features: null,
        theme: null,
        buyFeature: 'No'
      };

      const titleNode = document.querySelector('h1');
      if (titleNode) {
        result.title = titleNode.textContent.replace(/\s+/g, ' ').trim();
      }

      const rows = Array.from(document.querySelectorAll('tr'));
      for (const row of rows) {
        const left = row.querySelector('th.propLeft, th, td.propLeft, td:first-child');
        const right = row.querySelector('td.propRight, td:last-child');
        if (!left || !right || left === right) {
          continue;
        }

        const label = (left.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const value = (right.textContent || '').replace(/\s+/g, ' ').trim();
        if (!value) {
          continue;
        }

        if (label.includes('layout')) {
          result.layout = value;
          result.layoutEvidence = 'direct_field';
        } else if (label.includes('betways') || label.includes('ways') || label.includes('lines')) {
          result.betways = value;
        } else if (label.includes('features')) {
          result.features = value;
        } else if (label.includes('theme')) {
          result.theme = value;
        }
      }

      const propRightCells = Array.from(document.querySelectorAll('td.propRight')).map((td) => td.textContent.replace(/\s+/g, ' ').trim());
      for (const text of propRightCells) {
        if (!result.features && /^features\s*:/i.test(text)) {
          result.features = text.replace(/^features\s*:/i, '').trim();
        }
        if (!result.theme && /^theme\s*:/i.test(text)) {
          result.theme = text.replace(/^theme\s*:/i, '').trim();
        }
      }

      const bodyText = (document.body.textContent || '').toLowerCase();
      const featuresText = (result.features || '').toLowerCase();
      if (/buy\s*feature|bonus\s*buy/.test(bodyText) || /buy\s*feature|bonus\s*buy/.test(featuresText)) {
        result.buyFeature = 'yes';
      }

      return result;
    });

    return {
      source: name,
      title: data.title || hit.title,
      url: hit.href,
      layout: data.layout,
      layoutEvidence: data.layoutEvidence,
      betways: data.betways,
      features: data.features,
      theme: data.theme,
      buy_feature: data.buyFeature,
      match_score: hit.matchScore
    };
  } catch (_error) {
    return {
      source: name,
      title: hit.title,
      url: hit.href,
      layout: null,
      layoutEvidence: null,
      betways: null,
      features: null,
      theme: null,
      buy_feature: 'No',
      match_score: hit.matchScore
    };
  } finally {
    await page.close();
  }
}

async function scrapeForGame(gameName, options = {}) {
  const debugTerms = Boolean(options.debugTerms);
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto('https://slotcatalog.com/en/The-Best-Slots', {
      waitUntil: FAST_NAVIGATION_WAIT,
      timeout: NAV_TIMEOUT
    });

    await tryClickCookieButtons(page);
    await tryDismissModal(page);
    await page.waitForSelector('#selsearch', { timeout: 10000 });

    const terms = buildFallbackTerms(gameName);

    const { candidates: collectedCandidates, termAttempts } = await collectCandidatesAcrossTerms(
      terms,
      async (term) => fillSearchAndReadCandidates(page, term),
      { debugTerms, maxCandidatePoolSize: MAX_CANDIDATE_POOL_SIZE }
    );

    const candidates = rankCandidatesForGame(gameName, collectedCandidates);
    let picked = pickCandidatesForDetails(candidates);
    const topCandidate = candidates[0] || null;
    if (topCandidate && Number(topCandidate.matchScore) >= HIGH_CONFIDENCE_MATCH_SCORE) {
      picked = [topCandidate];
    }

    if (picked.length === 0) {
      const directHit = await tryDirectSlotUrl(browser, gameName);
      if (directHit.length > 0) {
        if (debugTerms) {
          termAttempts.push({
            term: '[direct-url-fallback]',
            matchesFound: directHit.length,
            sampleTitles: directHit.slice(0, 3).map((item) => item.title)
          });
        }
        picked = rankCandidatesForGame(gameName, directHit);
      }
    }

    const hits = await Promise.all(picked.map((hit) => scrapeSlotDetail(browser, hit)));
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
      closestMatch: buildClosestMatch(candidates[0] || picked[0] || null),
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
      const result = await scrapeForGame(gameName);
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
