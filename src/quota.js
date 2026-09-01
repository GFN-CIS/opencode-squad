// Surface how much of a provider's rate-limit quota is already burnt, so the
// orchestrator can route around a saturated provider instead of discovering it
// by getting a 429.
//
// The data exists on EVERY successful response and is thrown away: verified
// live (2026-09-01) that `POST api.anthropic.com/v1/messages` → 200 carries the
// full `anthropic-ratelimit-unified-*` block and
// `POST chatgpt.com/backend-api/codex/responses` → 200 carries `x-codex-*`
// (richer on success than on a 429, in fact). opencode persists neither: a
// stored assistant message holds only tokens/cost/time/finish, and every
// header hit across 119MB of logs is on an ERROR line. Its own header parser
// matches `anthropic-ratelimit-(.+)-(limit|remaining|reset)`, which of the
// unified family catches only `*-reset` — `utilization` and `status` don't
// match at all.
//
// Note what these report: not "remaining" but "used". Anthropic gives a
// fraction (0.07), codex a percent (51). Remaining is 1 - used.
//
// z.ai returns nothing of the sort on success (checked: alt-svc, ga-traceid,
// x-log-id and plumbing only), which is why absent data must stay absent — see
// parseQuotaHeaders returning null.

/**
 * Name a quota window by its length rather than by the provider's own
 * primary/secondary labelling.
 *
 * Those labels are NOT stable: codex re-ranks them by whichever window is
 * closest to its limit. In August's 429s `primary` was the weekly window at
 * 100%; on 2026-09-01 `primary` was the 5h window at 51% with weekly demoted to
 * `secondary`. Keying on the label would make bands jump when the provider
 * re-ranks; keying on the length doesn't.
 *
 * @param {number} minutes
 * @returns {string}
 */
export function windowLabel(minutes) {
  if (!(minutes > 0)) return "?";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  return `${Math.round(minutes / 60)}h`;
}

const num = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Normalize a provider's rate-limit response headers into a quota snapshot.
 *
 * Returns null when the response carries nothing usable — a provider that
 * reports no quota must produce no claim about its quota.
 *
 * @param {Record<string, string>} headers  response headers, lowercase keys
 * @returns {{windows: Array<{label:string, used:number, resetAt?:number}>, binding?: string, plan?: string, creditsExhausted?: boolean, blocked?: boolean}|null}
 */
export function parseQuotaHeaders(headers) {
  if (!headers || typeof headers !== "object") return null;
  const h = (k) => headers[k];

  /** @type {Array<{label:string, used:number, resetAt?:number}>} */
  const windows = [];
  let binding;
  let plan;
  let creditsExhausted;
  let blocked;

  // --- Anthropic: unified (subscription) family, fractions 0..1 -------------
  for (const [key, label] of [
    ["5h", "5h"],
    ["7d", "7d"],
  ]) {
    const used = num(h(`anthropic-ratelimit-unified-${key}-utilization`));
    if (used === undefined) continue;
    windows.push({ label, used, resetAt: num(h(`anthropic-ratelimit-unified-${key}-reset`)) });
    if (h(`anthropic-ratelimit-unified-${key}-status`) === "rejected") blocked = true;
  }
  if (windows.length) {
    // The provider names its own binding window; trust it over our arithmetic.
    const claim = h("anthropic-ratelimit-unified-representative-claim");
    binding = { five_hour: "5h", seven_day: "7d" }[claim];
    if (h("anthropic-ratelimit-unified-status") === "rejected") blocked = true;
  }

  // --- OpenAI / codex: percentages, windows named by length ----------------
  for (const slot of ["primary", "secondary"]) {
    const pct = num(h(`x-codex-${slot}-used-percent`));
    const mins = num(h(`x-codex-${slot}-window-minutes`));
    if (pct === undefined || !(mins > 0)) continue; // a zeroed slot is unused
    windows.push({
      label: windowLabel(mins),
      used: pct / 100,
      resetAt: num(h(`x-codex-${slot}-reset-at`)),
    });
  }
  if (h("x-codex-plan-type")) plan = h("x-codex-plan-type");
  if (h("x-codex-credits-has-credits") === "False") creditsExhausted = true;

  if (!windows.length) return null;
  // Fall back to the most-consumed window when the provider doesn't say which
  // one binds (codex never does — see windowLabel).
  if (!binding) binding = windows.reduce((a, b) => (b.used > a.used ? b : a)).label;
  return { windows, binding, plan, creditsExhausted, blocked };
}

// Reporting bands. Below the first, the orchestrator does not need to know:
// quota that is 30% burnt changes no decision, and repeating it on every task
// result is exactly the context pollution this is meant to avoid.
export const QUOTA_BANDS = [0.6, 0.8, 0.95];

/**
 * Which band a utilization falls in: null below the first threshold, otherwise
 * 0-based index into QUOTA_BANDS.
 *
 * @param {number} used  fraction 0..1
 * @returns {number|null}
 */
export function bandOf(used) {
  if (!(used >= QUOTA_BANDS[0])) return null;
  let band = 0;
  for (let i = 1; i < QUOTA_BANDS.length; i++) if (used >= QUOTA_BANDS[i]) band = i;
  return band;
}

/**
 * Should this snapshot be reported to the orchestrator?
 *
 * Only on a band CHANGE, or while in the top band. A flat threshold would fire
 * on every task result for the rest of the session once crossed — dozens of
 * repetitions of a figure that moves a percent per call. Transitions carry the
 * same information at a fraction of the tokens; the top band keeps repeating
 * because there the exact number does change the decision.
 *
 * @param {number|null} previousBand
 * @param {number|null} band
 * @returns {boolean}
 */
export function shouldReport(previousBand, band) {
  if (band === null) return false;
  if (band === QUOTA_BANDS.length - 1) return true;
  return band !== previousBand;
}

const pct = (used) => `${Math.round(used * 100)}%`;

/**
 * Render the quota clause appended to a finished task's result. Empty string
 * when there is nothing worth saying.
 *
 * Covers only the provider of the task that just finished: it is the one
 * snapshot that is current. Reporting every provider would multiply tokens and
 * quote hour-old numbers for providers not called since.
 *
 * @param {string} providerID
 * @param {ReturnType<typeof parseQuotaHeaders>} snapshot
 * @param {{previousBand?: number|null, now?: number}} [opts]
 * @returns {string}
 */
export function formatQuotaClause(providerID, snapshot, opts = {}) {
  if (!snapshot?.windows?.length) return "";
  const bindingWindow =
    snapshot.windows.find((w) => w.label === snapshot.binding) ?? snapshot.windows[0];
  const band = bandOf(bindingWindow.used);
  if (!shouldReport(opts.previousBand ?? null, band)) return "";

  const now = opts.now ?? 0;
  const parts = snapshot.windows.map(
    (w) => `${w.label} ${pct(w.used)}${w.label === snapshot.binding ? " (binding)" : ""}`,
  );
  let clause = `[QUOTA] ${providerID}: ${parts.join(", ")} used.`;

  if (bindingWindow.resetAt && now) {
    const mins = Math.round((bindingWindow.resetAt * 1000 - now) / 60000);
    if (mins > 0) {
      const when = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
      clause += ` The ${bindingWindow.label} window resets in ${when}.`;
    }
  }
  if (snapshot.creditsExhausted) clause += " Credits are exhausted on this plan.";
  if (snapshot.blocked) clause += " The provider is currently REJECTING requests.";
  if (band === QUOTA_BANDS.length - 1) {
    clause += " Route further work to a different provider unless it must run here.";
  }
  return clause;
}
