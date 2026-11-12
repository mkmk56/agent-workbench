export const PROCESS_STATE = Object.freeze({
  CREATED: 'created',
  STARTING: 'starting',
  RUNNING: 'running',
  EXITING: 'exiting',
  EXITED_SUCCESS: 'exited_success',
  EXITED_FAILURE: 'exited_failure',
  CANCELLED: 'cancelled'
});

export const TURN_STATE = Object.freeze({
  NONE: 'none',
  STARTING: 'starting',
  WORKING: 'working',
  IDLE: 'idle',
  BLOCKED: 'blocked',
  FAILED: 'failed'
});

export const BLOCKER = Object.freeze({
  AUTH: 'auth',
  ONBOARDING: 'onboarding',
  PERMISSION: 'permission',
  CONTEXT_LIMIT: 'context_limit',
  NO_ACTIVE_THREAD: 'no_active_thread',
  PREFLIGHT: 'preflight',
  TOOLING: 'tooling',
  UNKNOWN: 'unknown'
});

export const ORCH_STATE = Object.freeze({
  PENDING: 'PENDING',
  STARTING: 'STARTING',
  WORKING: 'WORKING',
  WAITING: 'WAITING',
  BLOCKED: 'BLOCKED',
  STALE: 'STALE',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
});

export const TERMINAL_STATES = new Set([
  ORCH_STATE.COMPLETED,
  ORCH_STATE.FAILED,
  ORCH_STATE.CANCELLED
]);

export function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

function isStale(task, now) {
  const last = Date.parse(task.last_activity_at || task.updated_at || task.created_at || '');
  if (!Number.isFinite(last)) return false;
  return now - last > Number(task.stale_after_ms || 0);
}

export function deriveState(task, now = Date.now()) {
  if (task.state === ORCH_STATE.CANCELLED) return ORCH_STATE.CANCELLED;
  if (task.process_state === PROCESS_STATE.EXITED_SUCCESS) return ORCH_STATE.COMPLETED;
  if (task.process_state === PROCESS_STATE.EXITED_FAILURE) return ORCH_STATE.FAILED;
  if (task.process_state === PROCESS_STATE.CANCELLED) return ORCH_STATE.CANCELLED;
  if (task.process_state === PROCESS_STATE.CREATED) return ORCH_STATE.PENDING;
  if (task.process_state === PROCESS_STATE.STARTING) return ORCH_STATE.STARTING;

  if (task.turn_state === TURN_STATE.BLOCKED) {
    return isStale(task, now) ? ORCH_STATE.STALE : ORCH_STATE.BLOCKED;
  }
  if (task.turn_state === TURN_STATE.IDLE) {
    return isStale(task, now) ? ORCH_STATE.STALE : ORCH_STATE.WAITING;
  }
  if (
    task.turn_state === TURN_STATE.WORKING ||
    task.turn_state === TURN_STATE.STARTING ||
    task.process_state === PROCESS_STATE.RUNNING ||
    task.process_state === PROCESS_STATE.EXITING
  ) {
    return isStale(task, now) ? ORCH_STATE.STALE : ORCH_STATE.WORKING;
  }
  return ORCH_STATE.PENDING;
}