const endpoints = ['/health', '/ready'];

function getBaseUrl() {
  const fromEnv = process.env.SMOKE_BASE_URL || process.argv[2];
  return String(fromEnv || 'http://localhost:3030').replace(/\/$/, '');
}

async function checkEndpoint(baseUrl, path) {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    headers: {
      accept: 'application/json'
    }
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch (_) {
    payload = null;
  }

  return {
    url,
    ok: response.ok,
    status: response.status,
    payload,
    text
  };
}

async function run() {
  const baseUrl = getBaseUrl();
  console.log(`[smoke] Base URL: ${baseUrl}`);

  for (const path of endpoints) {
    const result = await checkEndpoint(baseUrl, path);
    console.log(`[smoke] ${path} -> ${result.status}`);

    if (!result.ok) {
      throw new Error(`Smoke check failed for ${result.url} with status ${result.status}`);
    }

    if (!result.payload || result.payload.ok !== true) {
      throw new Error(`Smoke check failed for ${result.url}: expected JSON { ok: true }`);
    }
  }

  console.log('[smoke] Health and readiness checks passed.');
}

run().catch((error) => {
  console.error('[smoke] Failure:', error.message || error);
  process.exitCode = 1;
});