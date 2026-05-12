const { EventEmitter } = require('events');

const jobs = new Map();
const jobEvents = new Map();
const jobArtifacts = new Map();

function createJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function getJobEmitter(id) {
  if (!jobEvents.has(id)) {
    jobEvents.set(id, new EventEmitter());
  }

  return jobEvents.get(id);
}

function emitJobEvent(id, event, payload) {
  const emitter = jobEvents.get(id);
  if (!emitter) {
    return;
  }

  emitter.emit(event, payload);
  emitter.emit('*', { event, payload });
}

function createJob(payload) {
  const id = createJobId();
  const now = new Date().toISOString();

  // Every request becomes a job so API can stream progress and download results later.
  jobs.set(id, {
    id,
    status: 'queued',
    phase: 'queued',
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    payload,
    progress: {
      phase: 'queued',
      message: 'Queued'
    },
    result: null,
    error: null
  });

  return id;
}

function markJobRunning(id) {
  const job = jobs.get(id);
  if (!job) {
    return;
  }

  job.status = 'running';
  job.phase = 'running';
  job.startedAt = job.startedAt || new Date().toISOString();
  job.progress = {
    ...(job.progress || {}),
    phase: 'running',
    message: 'Running'
  };
  job.updatedAt = new Date().toISOString();
  emitJobEvent(id, 'job', getJob(id));
}

function updateJobProgress(id, progress = {}) {
  const job = jobs.get(id);
  if (!job) {
    return;
  }

  // Keep the latest phase snapshot on the job and emit incremental SSE updates.
  job.phase = progress.phase || job.phase || 'running';
  job.progress = {
    ...(job.progress || {}),
    ...progress,
    phase: progress.phase || job.phase || 'running'
  };
  job.updatedAt = new Date().toISOString();
  emitJobEvent(id, 'progress', { job: getJob(id), progress: job.progress });
}

function markJobDone(id, result) {
  const job = jobs.get(id);
  if (!job) {
    return;
  }

  // Final terminal state with materialized result payload used for API response/downloads.
  job.status = 'done';
  job.phase = 'done';
  job.result = result;
  job.completedAt = new Date().toISOString();
  job.progress = {
    ...(job.progress || {}),
    phase: 'done',
    message: 'Completed'
  };
  job.updatedAt = new Date().toISOString();
  emitJobEvent(id, 'done', getJob(id));
}

function markJobError(id, error) {
  const job = jobs.get(id);
  if (!job) {
    return;
  }

  job.status = 'error';
  job.phase = 'error';
  job.completedAt = new Date().toISOString();
  job.progress = {
    ...(job.progress || {}),
    phase: 'error',
    message: String(error && error.message ? error.message : error || 'Unknown error')
  };
  job.error = String(error && error.message ? error.message : error || 'Unknown error');
  job.updatedAt = new Date().toISOString();
  emitJobEvent(id, 'error', getJob(id));
}

function getJob(id) {
  return jobs.get(id) || null;
}

function setJobArtifacts(id, artifacts) {
  if (!jobs.has(id)) {
    return;
  }

  // Store pre-rendered download payloads (json/csv) per job id.
  jobArtifacts.set(id, artifacts || null);
}

function getJobArtifacts(id) {
  return jobArtifacts.get(id) || null;
}

function subscribeJob(id, listener) {
  const emitter = getJobEmitter(id);
  // Wildcard subscription lets SSE stream all job events via one callback.
  emitter.on('*', listener);

  return () => {
    emitter.off('*', listener);
  };
}

function clearJobListeners(id) {
  const emitter = jobEvents.get(id);
  if (!emitter) {
    return;
  }

  emitter.removeAllListeners();
  jobEvents.delete(id);
}

function clearJobArtifacts(id) {
  jobArtifacts.delete(id);
}

module.exports = {
  createJob,
  getJob,
  getJobArtifacts,
  markJobDone,
  markJobError,
  markJobRunning,
  updateJobProgress,
  setJobArtifacts,
  subscribeJob,
  clearJobListeners,
  clearJobArtifacts
};
