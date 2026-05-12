const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { runSearch } = require('../core/engine');
const { sourcePlugins, servicePlugins } = require('../plugins/registry');
const { formatJson } = require('../formatters/jsonFormatter');
const { formatCsv } = require('../formatters/csvFormatter');
const { formatTable } = require('../formatters/tableFormatter');
const { formatExcel } = require('../formatters/excelFormatter');
const { createJob, getJob, getJobArtifacts, markJobDone, markJobError, markJobRunning, updateJobProgress, setJobArtifacts, subscribeJob, clearJobListeners } = require('./jobs');

function buildResponseBody(result) {
  // Sync response formatter selected by requested output format.
  if (result.format === 'csv') {
    return { contentType: 'text/csv; charset=utf-8', body: formatCsv(result) };
  }

  if (result.format === 'table') {
    return { contentType: 'text/plain; charset=utf-8', body: formatTable(result) };
  }

  return { contentType: 'application/json; charset=utf-8', body: formatJson(result) };
}

function buildDownloadResponseBody(result, format) {
  return {
    contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
    body: format === 'csv' ? formatCsv(result) : formatJson(result),
    extension: format
  };
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildDownloadFilename(job, extension) {
  const createdAt = new Date(job.createdAt || Date.now());
  const datePart = Number.isNaN(createdAt.getTime())
    ? 'unknown-date'
    : createdAt.toISOString().replace(/[:.]/g, '-');
  const idCount = Array.isArray(job.payload && job.payload.ids) ? job.payload.ids.length : 0;
  const countPart = `${idCount || 0}ids`;
  const baseJob = sanitizeFilenamePart(job.id) || 'job';
  return `${baseJob}-${datePart}-${countPart}.${extension}`;
}

function logProgress(requestLabel, progress) {
  const elapsedSeconds = typeof progress.elapsedMs === 'number'
    ? ` (${Math.round(progress.elapsedMs / 1000)}s)`
    : '';
  const message = progress.message || progress.phase || 'working';
  const sourceInfo = progress.source ? ` [${progress.source}]` : '';
  console.log(`[${requestLabel}] ${progress.phase || 'progress'}${sourceInfo}${elapsedSeconds} ${message}`);
}

function createRequestLabel(req) {
  return req.headers['x-request-id'] || crypto.randomUUID();
}

function createApiRateLimiter() {
  const windowMs = Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60000);
  const max = Number(process.env.API_RATE_LIMIT_MAX || 60);

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'Too many requests, please retry later.'
    }
  });
}

function attachRequestContext(req, res, next) {
  const requestId = createRequestLabel(req);
  const startedAt = Date.now();

  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    console.log(`[request:${requestId}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs}ms)`);
  });

  next();
}

function renderSseDemoPage() {
  // Manual QA page for async jobs: submit ids, watch SSE progress, download artifacts.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Casino Games SSE Demo</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #08111f;
      --panel: #101b2f;
      --panel-2: #0d1628;
      --text: #e7eefc;
      --muted: #8ea0c0;
      --accent: #68d391;
      --accent-2: #63b3ed;
      --border: rgba(255, 255, 255, 0.10);
      --shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(99, 179, 237, 0.16), transparent 30%),
        radial-gradient(circle at bottom right, rgba(104, 211, 145, 0.12), transparent 30%),
        var(--bg);
    }

    .wrap {
      max-width: 1100px;
      margin: 0 auto;
      padding: 32px;
    }

    .hero {
      padding: 28px;
      border: 1px solid var(--border);
      border-radius: 24px;
      background: linear-gradient(180deg, rgba(16, 27, 47, 0.94), rgba(13, 22, 40, 0.92));
      box-shadow: var(--shadow);
      display: grid;
      gap: 18px;
    }

    h1 {
      margin: 0;
      font-size: clamp(2rem, 4vw, 3.5rem);
      line-height: 1;
      letter-spacing: -0.04em;
    }

    p {
      margin: 0;
      color: var(--muted);
      max-width: 70ch;
      line-height: 1.6;
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
    }

    button {
      appearance: none;
      border: 0;
      border-radius: 14px;
      padding: 14px 18px;
      color: #04111a;
      background: linear-gradient(135deg, var(--accent), #90cdf4);
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 16px 30px rgba(104, 211, 145, 0.18);
    }

    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    button.secondary {
      color: #c9d8f0;
      background: rgba(255, 255, 255, 0.08);
      box-shadow: none;
      border: 1px solid var(--border);
    }

    input {
      flex: 1 1 320px;
      min-width: 240px;
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px 16px;
      background: rgba(255, 255, 255, 0.03);
      color: var(--text);
      outline: none;
    }

    textarea {
      width: 100%;
      min-height: 120px;
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 12px 14px;
      background: rgba(255, 255, 255, 0.03);
      color: var(--text);
      resize: vertical;
      font-family: inherit;
      outline: none;
      line-height: 1.4;
    }

    .grid {
      margin-top: 24px;
      display: grid;
      grid-template-columns: 1.2fr 0.8fr;
      gap: 18px;
    }

    .card {
      border: 1px solid var(--border);
      border-radius: 20px;
      background: rgba(255, 255, 255, 0.03);
      padding: 18px;
      min-height: 240px;
    }

    .card h2 {
      margin: 0 0 12px;
      font-size: 1rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .progress-wrap {
      display: grid;
      gap: 12px;
    }

    .progress-track {
      width: 100%;
      height: 20px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.10);
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      width: 0%;
      border-radius: 999px;
      background: linear-gradient(90deg, #68d391, #63b3ed);
      transition: width 200ms ease;
    }

    .progress-meta {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: 0.95rem;
    }

    .pill {
      display: inline-block;
      margin-left: 8px;
      padding: 3px 10px;
      border-radius: 999px;
      background: rgba(99, 179, 237, 0.15);
      color: #b8dcff;
      font-size: 0.8rem;
      vertical-align: middle;
    }

    .meta {
      display: grid;
      gap: 10px;
    }

    .meta-row {
      padding: 12px 14px;
      border-radius: 14px;
      background: rgba(8, 17, 31, 0.48);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }

    .muted { color: var(--muted); }

    @media (max-width: 860px) {
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div>
        <h1>Casino Games SSE Demo</h1>
        <p>Pokreni async job i gledaj kako server vraća faze kroz <strong>SSE</strong>: queued, running, collecting-sources, applying-services, ranking-results i done.</p>
      </div>

      <div class="controls">
        <textarea id="gameIds" placeholder="Zalijepi ID-eve (jedan po redu ili copy/paste iz tablice)">Heartbreakers</textarea>
        <button id="startBtn">Start job</button>
        <button id="downloadJsonBtn" class="secondary" disabled>Download JSON</button>
        <button id="downloadCsvBtn" class="secondary" disabled>Download CSV</button>
        <button id="downloadExcelBtn" class="secondary" disabled>Download Excel</button>
        <span id="idCount" class="muted">IDs: 1</span>
      </div>

      <div class="grid">
        <div class="card">
          <h2>Progress</h2>
          <div class="progress-wrap">
            <div class="progress-track"><div id="progressFill" class="progress-fill"></div></div>
            <div class="progress-meta">
              <span id="progressLabel">Obrađeno: 0/0 ID-eva</span>
              <span id="progressPercent">0%</span>
            </div>
            <div id="progressPhase" class="muted">Čeka start...</div>
          </div>
        </div>

        <div class="card">
          <h2>Job info</h2>
          <div class="meta">
            <div class="meta-row"><strong>Status:</strong> <span id="status">idle</span></div>
            <div class="meta-row"><strong>Phase:</strong> <span id="phase">-</span></div>
            <div class="meta-row"><strong>Elapsed:</strong> <span id="elapsed">-</span></div>
            <div class="meta-row"><strong>Job ID:</strong> <span id="jobId">-</span></div>
            <div class="meta-row"><strong>Result:</strong> <pre id="result" class="muted" style="white-space: pre-wrap; margin: 8px 0 0;">-</pre></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const statusEl = document.getElementById('status');
    const phaseEl = document.getElementById('phase');
    const elapsedEl = document.getElementById('elapsed');
    const jobIdEl = document.getElementById('jobId');
    const resultEl = document.getElementById('result');
    const progressFillEl = document.getElementById('progressFill');
    const progressLabelEl = document.getElementById('progressLabel');
    const progressPercentEl = document.getElementById('progressPercent');
    const progressPhaseEl = document.getElementById('progressPhase');
    const startBtn = document.getElementById('startBtn');
    const downloadJsonBtn = document.getElementById('downloadJsonBtn');
    const downloadCsvBtn = document.getElementById('downloadCsvBtn');
    const downloadExcelBtn = document.getElementById('downloadExcelBtn');
    const gameIdsEl = document.getElementById('gameIds');
    const idCountEl = document.getElementById('idCount');

    let source = null;
    let currentJobId = null;
    let requestedIdsCount = 0;

    function parseIdsFromInput(raw) {
      const text = String(raw || '').trim();
      if (!text) {
        return [];
      }

      const lines = text.split(/\\r?\\n/);
      const ids = [];
      const seen = new Set();

      for (const line of lines) {
        const normalizedLine = line.trim();
        if (!normalizedLine) {
          continue;
        }

        const cells = normalizedLine
          .split(/\\t|;|,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/)
          .map((part) => part.replace(/^\"|\"$/g, '').trim())
          .filter(Boolean);

        const value = cells[0] || normalizedLine;
        const key = value.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          ids.push(value);
        }
      }

      return ids;
    }

    function refreshIdCount() {
      const ids = parseIdsFromInput(gameIdsEl.value);
      idCountEl.textContent = 'IDs: ' + ids.length;
      return ids;
    }

    function updateProgressView(processed, total, percent, message) {
      const safeTotal = Math.max(0, Number(total || 0));
      const safeProcessed = Math.max(0, Math.min(safeTotal, Number(processed || 0)));
      const safePercent = Math.max(0, Math.min(100, Number(percent || 0)));

      progressFillEl.style.width = safePercent + '%';
      progressLabelEl.textContent = 'Obrađeno: ' + safeProcessed + '/' + safeTotal + ' ID-eva';
      progressPercentEl.textContent = Math.round(safePercent) + '%';
      progressPhaseEl.textContent = message || 'U tijeku...';
    }

    function estimateProgress(job) {
      const progress = job && job.progress ? job.progress : {};
      const phase = String((job && job.phase) || progress.phase || '').toLowerCase();
      const total = requestedIdsCount;

      if (total <= 0) {
        return { processed: 0, total: 0, percent: 0, message: 'Čeka start...' };
      }

      if (phase === 'done') {
        return { processed: total, total, percent: 100, message: 'Gotovo' };
      }

      const message = progress.message || phase || 'U tijeku...';
      const totalSources = Number(progress.totalSources || 0);
      const sourceIndex = Number(progress.sourceIndex || 0);
      const isSourceFinished = String(message).toLowerCase().startsWith('finished');

      if (phase === 'collecting-sources' && totalSources > 0) {
        const completedSources = isSourceFinished
          ? Math.min(totalSources, sourceIndex)
          : Math.max(0, Math.min(totalSources, sourceIndex - 1));
        const fraction = completedSources / totalSources;
        const processed = Math.round(fraction * total);
        const percent = 10 + (fraction * 75);
        return { processed, total, percent, message };
      }

      if (phase === 'applying-services') {
        return { processed: total, total, percent: 90, message };
      }

      if (phase === 'ranking-results') {
        return { processed: total, total, percent: 97, message };
      }

      if (phase === 'running' || phase === 'validating-input' || phase === 'queued') {
        return { processed: 0, total, percent: 5, message };
      }

      return { processed: 0, total, percent: 0, message };
    }

    function setInfo(job) {
      const elapsedMs = typeof job.elapsedMs === 'number'
        ? job.elapsedMs
        : typeof job?.progress?.elapsedMs === 'number'
          ? job.progress.elapsedMs
          : typeof job.completedAt === 'string' && typeof job.createdAt === 'string'
            ? Math.max(0, new Date(job.completedAt).getTime() - new Date(job.createdAt).getTime())
            : null;

      statusEl.textContent = job.status || '-';
      phaseEl.textContent = job.phase || '-';
      elapsedEl.textContent = typeof elapsedMs === 'number' ? Math.round(elapsedMs / 1000) + 's' : '-';
      jobIdEl.textContent = job.id || '-';
      resultEl.textContent = job.result ? JSON.stringify(job.result, null, 2) : '-';

      const progressState = estimateProgress(job || {});
      updateProgressView(progressState.processed, progressState.total, progressState.percent, progressState.message);
    }

    function setDownloadState(enabled) {
      downloadJsonBtn.disabled = !enabled;
      downloadCsvBtn.disabled = !enabled;
      downloadExcelBtn.disabled = !enabled;
    }

    function resetForNextIntake() {
      if (source) {
        source.close();
        source = null;
      }

      statusEl.textContent = 'idle';
      phaseEl.textContent = '-';
      elapsedEl.textContent = '-';
      jobIdEl.textContent = '-';
      resultEl.textContent = '-';
      currentJobId = null;
      setDownloadState(false);
      startBtn.disabled = false;
      requestedIdsCount = 0;
      updateProgressView(0, 0, 0, 'Čeka start...');
      refreshIdCount();
    }

    async function triggerDownload(format) {
      if (!currentJobId) {
        return;
      }

      const url = '/v1/jobs/' + encodeURIComponent(currentJobId) + '/download?format=' + encodeURIComponent(format);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Download nije uspio');
      }

      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') || '';
      const fileNameMatch = disposition.match(/filename="([^"]+)"/i);
      const fallbackName = 'results.' + (format === 'csv' ? 'csv' : 'json');
      const fileName = fileNameMatch ? fileNameMatch[1] : fallbackName;

      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(objectUrl);
    }

    async function startJob() {
      if (source) {
        source.close();
        source = null;
      }

      resultEl.textContent = '-';
      currentJobId = null;
      setDownloadState(false);
      startBtn.disabled = true;
      const ids = refreshIdCount();
      requestedIdsCount = ids.length;
      updateProgressView(0, requestedIdsCount, 5, 'Job kreiran...');
      if (ids.length === 0) {
        throw new Error('Unesi barem jedan ID');
      }

      const response = await fetch('/v1/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, format: 'json', async: true })
      });

      const initial = await response.json();
      currentJobId = initial.jobId || null;

      source = new EventSource(initial.streamUrl);
      source.addEventListener('snapshot', (event) => {
        const data = JSON.parse(event.data);
        setInfo(data);
      });
      source.addEventListener('progress', (event) => {
        const data = JSON.parse(event.data);
        setInfo(data.job || data);
      });
      source.addEventListener('done', (event) => {
        const data = JSON.parse(event.data);
        setInfo(data);
        currentJobId = data.id || currentJobId;
        setDownloadState(true);
        source.close();
        source = null;
        startBtn.disabled = false;
      });
      source.addEventListener('error', (event) => {
        updateProgressView(0, requestedIdsCount, 0, event.data || 'SSE error');
        if (source) {
          source.close();
          source = null;
        }
        startBtn.disabled = false;
      });
    }

    startBtn.addEventListener('click', () => {
      startJob().catch((error) => {
        updateProgressView(0, requestedIdsCount, 0, error.message || String(error));
        startBtn.disabled = false;
      });
    });

    gameIdsEl.addEventListener('input', refreshIdCount);
    downloadJsonBtn.addEventListener('click', () => {
      triggerDownload('json').catch((error) => pushLog('download-error', error.message || String(error)));
    });
    downloadCsvBtn.addEventListener('click', () => {
      triggerDownload('csv').catch((error) => pushLog('download-error', error.message || String(error)));
    });
    downloadExcelBtn.addEventListener('click', () => {
      triggerDownload('xlsx').catch((error) => updateProgressView(0, requestedIdsCount, 0, error.message || String(error)));
    });
    updateProgressView(0, 0, 0, 'Čeka start...');
    refreshIdCount();
  </script>
</body>
</html>`;
}

function writeSse(res, event, data) {
  // Serialize SSE frame with optional event name and multi-line data payload.
  if (event) {
    res.write(`event: ${event}\n`);
  }

  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const line of String(payload).split(/\r?\n/)) {
    res.write(`data: ${line}\n`);
  }
  res.write('\n');
}

function jobSnapshot(job) {
  if (!job) {
    return null;
  }

  const referenceTime = job.completedAt || new Date().toISOString();
  const elapsedMs = Math.max(0, new Date(referenceTime).getTime() - new Date(job.createdAt).getTime());

  // Client-facing projection of internal job state used by polling and SSE snapshot.
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    elapsedMs,
    error: job.error,
    progress: job.progress,
    downloads: {
      json: `/v1/jobs/${job.id}/download?format=json`,
      csv: `/v1/jobs/${job.id}/download?format=csv`
    },
    availableFormats: ['json', 'csv'],
    result: job.result
  };
}

function startApiServer(options = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: false
  }));
  app.use(attachRequestContext);
  app.use(express.json({ limit: '2mb' }));
  app.use('/v1', createApiRateLimiter());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'casino-games-api' });
  });

  app.get('/ready', (_req, res) => {
    const sourceCount = sourcePlugins.length;
    const serviceCount = servicePlugins.length;
    const ok = sourceCount > 0;

    const payload = {
      ok,
      service: 'casino-games-api',
      sourceCount,
      serviceCount,
      env: process.env.NODE_ENV || 'development'
    };

    if (!ok) {
      res.status(503).json(payload);
      return;
    }

    res.json(payload);
  });

  app.get('/demo/sse', (_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(renderSseDemoPage());
  });

  app.post('/v1/search', async (req, res) => {
    const asyncMode = Boolean(req.body && req.body.async);
    if (asyncMode) {
      // Async mode returns job id immediately; heavy scraping runs in background.
      const jobId = createJob({
        ids: req.body && req.body.ids,
        format: req.body && req.body.format
      });

      const reportProgress = (progress) => {
        updateJobProgress(jobId, progress);
        logProgress(jobId, progress);
      };

      setImmediate(async () => {
        markJobRunning(jobId);
        try {
          // Engine emits phase updates through callback; we persist and stream them.
          const result = await runSearch({
            ids: req.body && req.body.ids,
            format: req.body && req.body.format
          }, {
            requestId: req.requestId || jobId,
            onProgress: reportProgress
          });
          setJobArtifacts(jobId, {
            json: formatJson(result),
            csv: formatCsv(result)
          });
          markJobDone(jobId, result);
        } catch (error) {
          markJobError(jobId, error);
        }
      });

      res.status(202).json({
        jobId,
        status: 'queued',
        statusUrl: `/v1/jobs/${jobId}`,
        streamUrl: `/v1/jobs/${jobId}/events`
      });
      return;
    }

    try {
      const requestLabel = req.requestId || `sync-${Date.now()}`;
      const result = await runSearch({
        ids: req.body && req.body.ids,
        format: req.body && req.body.format
      }, {
        requestId: req.requestId || null,
        onProgress: (progress) => logProgress(requestLabel, progress)
      });

      const response = buildResponseBody(result);
      res.setHeader('content-type', response.contentType);
      res.send(response.body);
    } catch (error) {
      res.status(400).json({
        error: error.message || 'Bad request'
      });
    }
  });

  app.get('/v1/jobs/:jobId', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    res.json(jobSnapshot(job));
  });

  app.get('/v1/jobs/:jobId/download', async (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    if (job.status !== 'done' || !job.result) {
      res.status(409).json({ error: 'Job result is not ready yet' });
      return;
    }

    const format = String(req.query.format || 'csv').toLowerCase();
    if (format !== 'csv' && format !== 'json' && format !== 'xlsx') {
      res.status(400).json({ error: 'Unsupported format. Use csv, json, or xlsx.' });
      return;
    }

    try {
      let contentType;
      let body;
      let fileName;

      if (format === 'xlsx') {
        contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        body = await formatExcel(job.result);
        fileName = buildDownloadFilename(job, 'xlsx');
      } else {
        const artifacts = getJobArtifacts(job.id);
        if (!artifacts || typeof artifacts[format] !== 'string') {
          res.status(409).json({ error: 'Download artifact is not available for this job' });
          return;
        }
        contentType = format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8';
        body = artifacts[format];
        fileName = buildDownloadFilename(job, format);
      }

      res.setHeader('content-type', contentType);
      res.setHeader('content-disposition', `attachment; filename="${fileName}"`);
      res.send(body);
    } catch (error) {
      console.error('Download error:', error);
      res.status(500).json({ error: 'Download failed' });
    }
  });

  app.get('/v1/jobs/:jobId/events', (req, res) => {
    const jobId = req.params.jobId;
    const job = getJob(jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.flushHeaders?.();

    // Push current state immediately so client can render without waiting for next event.
    writeSse(res, 'snapshot', jobSnapshot(job));

    const unsubscribe = subscribeJob(jobId, ({ event, payload }) => {
      writeSse(res, event, payload);

      if (event === 'done' || event === 'error') {
        cleanup();
      }
    });

    const keepAlive = setInterval(() => {
      res.write(': ping\n\n');
    }, 15000);

    const cleanup = () => {
      clearInterval(keepAlive);
      unsubscribe();
      clearJobListeners(jobId);
      res.end();
    };

    req.on('close', cleanup);
  });

  app.use((error, _req, res, _next) => {
    console.error('[server-error]', error);
    if (res.headersSent) {
      return;
    }

    res.status(500).json({
      error: 'Internal server error'
    });
  });

  const port = Number(options.port || process.env.PORT || 3030);
  const host = options.host || process.env.HOST || '0.0.0.0';

  if (sourcePlugins.length === 0) {
    console.warn('[startup] No source plugins resolved. Check CASINO_SOURCES configuration.');
  }
  console.log(`[startup] Sources: ${sourcePlugins.map((source) => source.name).join(', ') || 'none'}`);
  console.log(`[startup] Services: ${servicePlugins.map((service) => service.name).join(', ') || 'none'}`);

  return app.listen(port, host, () => {
    console.log(`casino-games API running on http://${host}:${port}`);
  });
}

module.exports = {
  startApiServer
};

if (require.main === module) {
  startApiServer();
}
