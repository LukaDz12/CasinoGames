const { validateFormat, validateIds } = require('./contracts');
const { sourcePlugins, servicePlugins } = require('../plugins/registry');

function formatLayoutForCsv(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  // Avoid spreadsheet auto-casting values like "5-3" into dates.
  if (/^\d+(?:\s*-\s*\d+)+$/.test(text)) {
    return text
      .split('-')
      .map((part) => part.trim())
      .filter(Boolean)
      .join('x');
  }

  return text;
}

function withTimeout(promise, ms, timeoutMessage) {
  // Protect the pipeline from hanging source scrapers.
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(timeoutMessage)), ms);
    })
  ]);
}

async function runSourceWithRetry(source, ids, context, options) {
  const retries = Number(options.sourceRetries || 1);
  const timeoutMs = Number(options.sourceTimeoutMs || 90000);
  const maxAttempts = Math.max(1, retries + 1);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // Each source gets timeout + retry envelope; first successful batch wins.
      const result = await withTimeout(
        source.fetchByIds(ids, { ...context, attempt, maxAttempts }),
        timeoutMs,
        `Source ${source.name} timed out after ${timeoutMs}ms`
      );
      return result;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }
    }
  }

  throw lastError || new Error(`Source ${source.name} failed`);
}

async function collectFromSources(ids, context, reportProgress) {
  const rows = [];
  const totalSources = sourcePlugins.length;

  for (const [sourceIndex, source] of sourcePlugins.entries()) {
    if (typeof source.fetchByIds !== 'function') {
      continue;
    }

    reportProgress({
      phase: 'collecting-sources',
      message: `Scraping ${source.name} (${sourceIndex + 1}/${totalSources})`,
      source: source.name,
      sourceIndex: sourceIndex + 1,
      totalSources
    });

    let sourceRows = [];
    try {
      // Source contract: fetchByIds returns rows for all requested ids.
      sourceRows = await runSourceWithRetry(source, ids, context, {
        sourceRetries: context.sourceRetries,
        sourceTimeoutMs: context.sourceTimeoutMs
      });
    } catch (error) {
      // Keep pipeline alive: on source failure emit placeholder rows instead of aborting full job.
      for (const id of ids) {
        rows.push({
          id,
          source: source.name,
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
      continue;
    }

    reportProgress({
      phase: 'collecting-sources',
      message: `Finished ${source.name} (${sourceRows.length} rows)`,
      source: source.name,
      sourceIndex: sourceIndex + 1,
      totalSources,
      rowsFound: sourceRows.length
    });

    for (const row of sourceRows || []) {
      rows.push({
        id: String(row.id || '').trim(),
        source: source.name,
        title: row.title || '',
        layout: row.layout || '',
        layoutEvidence: row.layoutEvidence || null,
        betways: row.betways || '',
        buy_feature: row.buy_feature || 'No',
        theme: row.theme || '',
        features: row.features || '',
        url: row.url || '',
        match_score: Number(row.match_score || 0)
      });
    }
  }

  return rows;
}

async function applyServices(rows, context, reportProgress) {
  let current = rows;
  const totalServices = servicePlugins.length;

  for (const [serviceIndex, service] of servicePlugins.entries()) {
    if (typeof service.process !== 'function') {
      continue;
    }
    reportProgress({
      phase: 'applying-services',
      message: `Applying ${service.name} (${serviceIndex + 1}/${totalServices})`,
      service: service.name,
      serviceIndex: serviceIndex + 1,
      totalServices
    });
    // Services mutate/enrich normalized source rows before final ranking.
    current = await service.process(current, context);
  }

  return current;
}

function getNumericCount(value) {
  const nums = String(value || '').match(/\d+/g);
  return nums ? nums.length : 0;
}

function getLayoutEvidenceRank(evidence) {
  const normalized = String(evidence || '').trim().toLowerCase();
  if (normalized === 'direct_field') {
    return 4;
  }
  if (normalized === 'structured_numeric') {
    return 3;
  }
  if (normalized === 'context_extracted') {
    return 2;
  }
  if (normalized === 'inferred') {
    return 1;
  }
  return 0;
}

function getLayoutQuality(layout) {
  const value = String(layout || '').trim();
  if (!value) {
    return 0;
  }

  const numberCount = getNumericCount(value);
  if (numberCount >= 2) {
    return 100 + numberCount;
  }

  return 10;
}

function getBetwaysQuality(value) {
  const text = String(value || '').trim();
  if (!text) {
    return 0;
  }

  const hasNumber = /\d/.test(text);
  const hasWaysOrLines = /ways|lines|paylines/i.test(text);
  if (hasNumber && hasWaysOrLines) {
    return 100;
  }
  if (hasNumber) {
    return 70;
  }
  return 20;
}

function getTextQuality(value) {
  const text = String(value || '').trim();
  if (!text) {
    return 0;
  }
  return Math.min(100, text.length);
}

function selectBestField(hits, fieldKey, qualityFn) {
  let bestHit = null;
  let bestValue = '';
  let bestQuality = -1;
  let bestScore = -1;

  // Pick field value by quality first, then by match score as tie-breaker.
  for (const hit of hits) {
    const raw = hit[fieldKey];
    const value = String(raw || '').trim();
    if (!value) {
      continue;
    }

    const quality = qualityFn(value);
    const score = Number(hit.match_score) || 0;
    if (quality > bestQuality || (quality === bestQuality && score > bestScore)) {
      bestHit = hit;
      bestValue = value;
      bestQuality = quality;
      bestScore = score;
    }
  }

  return {
    hit: bestHit,
    value: bestValue
  };
}

function selectBestLayoutField(hits) {
  let bestHit = null;
  let bestValue = '';
  let bestEvidenceRank = -1;
  let bestQuality = -1;
  let bestScore = -1;

  // Layout prefers stronger evidence type, then quality, then overall match score.
  for (const hit of hits) {
    const value = String(hit.layout || '').trim();
    if (!value) {
      continue;
    }

    const evidenceRank = getLayoutEvidenceRank(hit.layoutEvidence);
    const quality = getLayoutQuality(value);
    const score = Number(hit.match_score) || 0;

    const isBetter =
      evidenceRank > bestEvidenceRank ||
      (evidenceRank === bestEvidenceRank && quality > bestQuality) ||
      (evidenceRank === bestEvidenceRank && quality === bestQuality && score > bestScore);

    if (isBetter) {
      bestHit = hit;
      bestValue = value;
      bestEvidenceRank = evidenceRank;
      bestQuality = quality;
      bestScore = score;
    }
  }

  return {
    hit: bestHit,
    value: bestValue
  };
}

function selectBestBetwaysField(hits) {
  let bestHit = null;
  let bestValue = '';
  let bestEvidenceRank = -1;
  let bestQuality = -1;
  let bestScore = -1;

  for (const hit of hits) {
    const value = String(hit.betways || '').trim();
    if (!value) {
      continue;
    }

    const evidenceRank = getLayoutEvidenceRank(hit.layoutEvidence);
    const quality = getBetwaysQuality(value);
    const score = Number(hit.match_score) || 0;

    const isBetter =
      evidenceRank > bestEvidenceRank ||
      (evidenceRank === bestEvidenceRank && quality > bestQuality) ||
      (evidenceRank === bestEvidenceRank && quality === bestQuality && score > bestScore);

    if (isBetter) {
      bestHit = hit;
      bestValue = value;
      bestEvidenceRank = evidenceRank;
      bestQuality = quality;
      bestScore = score;
    }
  }

  return {
    hit: bestHit,
    value: bestValue
  };
}

function selectBuyFeature(hits) {
  let yesHit = null;
  let yesScore = -1;

  // Domain rule: if any candidate confidently reports buy feature, keep "yes".
  for (const hit of hits) {
    const value = String(hit.buy_feature || '').trim().toLowerCase();
    const score = Number(hit.match_score) || 0;
    if ((value === 'yes' || value === 'true') && score > yesScore) {
      yesHit = hit;
      yesScore = score;
    }
  }

  if (yesHit) {
    return {
      value: 'yes',
      hit: yesHit
    };
  }

  const fallback = hits[0] || null;
  return {
    value: fallback ? String(fallback.buy_feature || 'No') : 'No',
    hit: fallback
  };
}

function groupBestById(ids, rows) {
  const byId = new Map();

  for (const row of rows) {
    if (!row.id) {
      continue;
    }

    if (!byId.has(row.id)) {
      byId.set(row.id, []);
    }
    byId.get(row.id).push(row);
  }

  return ids.map((id) => {
    const candidates = (byId.get(id) || []).sort((a, b) => Number(b.match_score || 0) - Number(a.match_score || 0));
    
    if (candidates.length === 0) {
      return {
        id,
        source: '',
        title: 'No games found.',
        layout: '',
        betways: '',
        buy_feature: '',
        theme: '',
        features: '',
        url: '',
        match_score: 0
      };
    }

    const anchor = candidates[0];
    // "anchor" keeps identity/url/score; other fields are selected independently for completeness.
    const bestLayout = selectBestLayoutField(candidates);
    const bestBetways = selectBestBetwaysField(candidates);
    const bestTheme = selectBestField(candidates, 'theme', getTextQuality);
    const bestFeatures = selectBestField(candidates, 'features', getTextQuality);
    const buyFeature = selectBuyFeature(candidates);

    const contributingSources = Array.from(new Set([
      anchor && anchor.source,
      bestLayout.hit && bestLayout.hit.source,
      bestBetways.hit && bestBetways.hit.source,
      bestTheme.hit && bestTheme.hit.source,
      bestFeatures.hit && bestFeatures.hit.source,
      buyFeature.hit && buyFeature.hit.source
    ].filter(Boolean)));

    return {
      id,
      source: contributingSources.join('|'),
      title: anchor.title || '',
      layout: formatLayoutForCsv(bestLayout.value),
      betways: bestBetways.value,
      buy_feature: buyFeature.value,
      theme: bestTheme.value,
      features: bestFeatures.value,
      url: anchor.url || '',
      match_score: anchor.match_score || 0
    };
  });
}

async function runSearch(input, options = {}) {
  const ids = validateIds(input.ids);
  const format = validateFormat(input.format || options.format || 'json');
  const startTime = Date.now();
  const reportProgress = typeof options.onProgress === 'function'
    ? (progress) => options.onProgress({
      ...progress,
      elapsedMs: Date.now() - startTime
    })
    : () => {};

  const context = {
    requestId: options.requestId || null,
    now: new Date().toISOString(),
    sourceTimeoutMs: options.sourceTimeoutMs || process.env.CASINO_SOURCE_TIMEOUT_MS,
    sourceRetries: options.sourceRetries || process.env.CASINO_SOURCE_RETRIES
  };

  // Request flow: validate -> collect sources -> apply services -> rank/merge best row per id.
  reportProgress({ phase: 'validating-input', message: 'Validating input' });
  const collected = await collectFromSources(ids, context, reportProgress);
  reportProgress({ phase: 'applying-services', message: 'Applying services' });
  const processed = await applyServices(collected, context, reportProgress);
  reportProgress({ phase: 'ranking-results', message: 'Selecting best results' });
  const rows = groupBestById(ids, processed);
  reportProgress({ phase: 'done', message: 'Search completed', rowCount: rows.length });

  return {
    format,
    rows,
    meta: {
      requestId: context.requestId,
      requestedCount: ids.length,
      returnedCount: rows.length,
      sourceCount: sourcePlugins.length,
      serviceCount: servicePlugins.length,
      generatedAt: context.now
    }
  };
}

module.exports = {
  runSearch
};
