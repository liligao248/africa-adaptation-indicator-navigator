const RESULT_LIMIT = 8;
const DATA_VERSION = "20260923-africa-agenda2063-v1";

const frameworkOrder = [
  "African Union Agenda 2063",
  "SDG Indicator Framework",
  "Sendai Framework Monitor",
  "Kunming-Montreal Global Biodiversity Framework",
];

const frameworkLabels = {
  "African Union Agenda 2063": "African Union Agenda 2063",
  "SDG Indicator Framework": "SDG Indicator Framework",
  "Sendai Framework Monitor": "Sendai Framework Monitor",
  "Kunming-Montreal Global Biodiversity Framework": "Kunming-Montreal Global Biodiversity Framework",
};

const chartLabels = {
  "African Union Agenda 2063": "Agenda 2063",
  "SDG Indicator Framework": "SDG",
  "Sendai Framework Monitor": "Sendai",
  "Kunming-Montreal Global Biodiversity Framework": "KMGBF",
};

const scopeLabels = {
  continental_africa: "Continental Africa",
  global_reference: "Global reference",
};

const state = {
  records: [],
  vectors: [],
  embedder: null,
  embedderPromise: null,
  lastQuery: "",
  ready: false,
};

const elements = {
  form: document.querySelector("#search-form"),
  query: document.querySelector("#query"),
  button: document.querySelector("#search-button"),
  status: document.querySelector("#status"),
  scopeFilters: document.querySelector("#scope-filters"),
  frameworkFilters: document.querySelector("#framework-filters"),
  themeFilters: document.querySelector("#theme-filters"),
  clearFilters: document.querySelector("#clear-filters"),
  results: document.querySelector("#results"),
  empty: document.querySelector("#empty-state"),
  count: document.querySelector("#result-count"),
  corpusCount: document.querySelector("#corpus-count"),
  overviewTotal: document.querySelector("#overview-total"),
  scopeSummary: document.querySelector("#scope-summary"),
  frameworkChart: document.querySelector("#framework-chart"),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(message, type = "") {
  elements.status.textContent = message;
  elements.status.className = `status${type ? ` is-${type}` : ""}`;
}

function setBusy(isBusy) {
  elements.button.disabled = isBusy;
  elements.button.textContent = isBusy ? "Searching..." : "Search indicators";
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function filterMarkup(group, value, label) {
  const id = `${group}-${value.replaceAll(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`;
  return `<label class="filter-option" for="${id}">
    <input id="${id}" data-filter-group="${group}" type="checkbox" value="${escapeHtml(value)}" checked />
    <span>${escapeHtml(label)}</span>
  </label>`;
}

function selectedValues(group) {
  return new Set(
    [...document.querySelectorAll(`input[data-filter-group="${group}"]:checked`)].map((input) => input.value),
  );
}

function visibleFrameworks() {
  return frameworkOrder.filter((framework) => state.records.some((record) => record.framework === framework));
}

function renderFilters() {
  const scopes = Object.keys(scopeLabels).filter((scope) => state.records.some((record) => record.scope === scope));
  const themes = uniqueSorted(state.records.map((record) => record.theme));
  elements.scopeFilters.innerHTML = scopes.map((scope) => filterMarkup("scope", scope, scopeLabels[scope])).join("");
  elements.frameworkFilters.innerHTML = visibleFrameworks()
    .map((framework) => filterMarkup("framework", framework, frameworkLabels[framework] || framework))
    .join("");
  elements.themeFilters.innerHTML = themes.map((theme) => filterMarkup("theme", theme, theme)).join("");
}

function eligibleRecords() {
  const scopes = selectedValues("scope");
  const frameworks = selectedValues("framework");
  const themes = selectedValues("theme");
  return state.records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => scopes.has(record.scope) && frameworks.has(record.framework) && themes.has(record.theme));
}

function renderOverview() {
  const selected = eligibleRecords().map(({ record }) => record);
  const counts = new Map();
  visibleFrameworks().forEach((framework) => counts.set(framework, 0));
  selected.forEach((record) => counts.set(record.framework, (counts.get(record.framework) || 0) + 1));
  const max = Math.max(1, ...counts.values());
  const africaCount = selected.filter((record) => record.scope === "continental_africa").length;
  const globalCount = selected.filter((record) => record.scope === "global_reference").length;

  elements.overviewTotal.textContent = `${selected.length}`;
  elements.scopeSummary.innerHTML = `<div class="scope-chip scope-chip-africa"><span>Continental Africa</span><strong>${africaCount}</strong></div>
    <div class="scope-chip"><span>Global reference</span><strong>${globalCount}</strong></div>`;
  elements.frameworkChart.innerHTML = selected.length
    ? visibleFrameworks()
        .map((framework) => {
          const count = counts.get(framework) || 0;
          const width = `${Math.max(count ? 7 : 0, Math.round((count / max) * 100))}%`;
          return `<div class="chart-row">
            <div class="chart-label"><span>${escapeHtml(chartLabels[framework] || framework)}</span><span>${count}</span></div>
            <div class="chart-track"><div class="chart-fill" style="--chart-width: ${width}"></div></div>
          </div>`;
        })
        .join("")
    : '<p class="chart-empty">No records are selected.</p>';
}

function dotProduct(left, right) {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += left[index] * right[index];
  return total;
}

function diversify(entries) {
  const firstByFramework = [];
  const remaining = [];
  const seenFrameworks = new Set();
  entries.forEach((entry) => {
    if (!seenFrameworks.has(entry.record.framework)) {
      firstByFramework.push(entry);
      seenFrameworks.add(entry.record.framework);
    } else {
      remaining.push(entry);
    }
  });
  return [...firstByFramework, ...remaining].slice(0, RESULT_LIMIT).map(({ record }) => record);
}

function rankByEmbedding(queryVector) {
  const ranked = eligibleRecords()
    .map(({ record, index }) => ({ record, score: dotProduct(state.vectors[index], queryVector) }))
    .sort((left, right) => right.score - left.score);
  return diversify(ranked);
}

function terms(value) {
  return value.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
}

function rankByKeywords(query) {
  const queryTerms = uniqueSorted(terms(query));
  const ranked = eligibleRecords()
    .map(({ record }) => {
      const haystack = `${record.text} ${record.framework} ${record.theme}`.toLowerCase();
      const score = queryTerms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { record, score };
    })
    .sort((left, right) => right.score - left.score || left.record.text.localeCompare(right.record.text));
  return diversify(ranked);
}

function scopeBadge(record) {
  const isAfrica = record.scope === "continental_africa";
  return `<span class="scope-badge${isAfrica ? " is-africa" : ""}">${escapeHtml(scopeLabels[record.scope] || record.scope)}</span>`;
}

function renderResults(records, message = "") {
  elements.results.innerHTML = records
    .map(
      (record) => `<article class="result-card">
        <div class="result-topline">
          <span class="code-badge">${escapeHtml(record.code)}</span>
          ${scopeBadge(record)}
          <span class="framework-name">${escapeHtml(record.framework)}</span>
        </div>
        <h3>${escapeHtml(record.text)}</h3>
        <p class="result-topic"><strong>Adaptation theme</strong> ${escapeHtml(record.theme)}</p>
        <a class="source-link" href="${escapeHtml(record.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(record.sourceLabel)}</a>
      </article>`,
    )
    .join("");

  elements.empty.hidden = records.length > 0;
  elements.count.textContent = message || (records.length ? `${records.length} related definitions` : "No matched indicators");
  if (!records.length) {
    elements.empty.innerHTML = "<p>No indicators match the selected filters. Adjust the filters or try a different policy question.</p>";
  }
}

async function getEmbedder() {
  if (state.embedder) return state.embedder;
  if (!state.embedderPromise) {
    state.embedderPromise = (async () => {
      const { pipeline, env } = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1");
      env.allowLocalModels = false;
      return pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    })();
  }
  state.embedder = await state.embedderPromise;
  return state.embedder;
}

async function runSearch(query) {
  if (!state.ready) return;
  state.lastQuery = query;
  setBusy(true);
  setStatus("Preparing semantic search...");
  try {
    const embedder = await getEmbedder();
    const output = await embedder(query, { pooling: "mean", normalize: true });
    renderResults(rankByEmbedding(Array.from(output.data)));
    setStatus("");
  } catch (error) {
    renderResults(rankByKeywords(query));
    setStatus("Semantic search is unavailable. Keyword results are shown instead.", "error");
  } finally {
    setBusy(false);
  }
}

function selectAllFilters() {
  document.querySelectorAll("input[data-filter-group]").forEach((input) => {
    input.checked = true;
  });
  renderOverview();
  if (state.lastQuery) runSearch(state.lastQuery);
}

async function loadData() {
  setStatus("Loading collection...");
  try {
    const [recordsResponse, embeddingsResponse] = await Promise.all([
      fetch(`./data/indicators.json?v=${DATA_VERSION}`),
      fetch(`./data/embeddings.json?v=${DATA_VERSION}`),
    ]);
    if (!recordsResponse.ok || !embeddingsResponse.ok) throw new Error("Data files are unavailable.");
    const recordsPayload = await recordsResponse.json();
    const embeddingsPayload = await embeddingsResponse.json();
    if (
      recordsPayload.corpusFingerprint !== embeddingsPayload.corpusFingerprint ||
      recordsPayload.records.length !== embeddingsPayload.vectors.length
    ) {
      throw new Error("Indicator records and vectors are not aligned.");
    }
    state.records = recordsPayload.records.map((record) => ({ ...record, scope: record.scope || "global_reference" }));
    state.vectors = embeddingsPayload.vectors;
    state.ready = true;
    renderFilters();
    renderOverview();
    elements.corpusCount.textContent = `${recordsPayload.recordCount} source-linked definitions`;
    setStatus("");
  } catch (error) {
    setStatus("The indicator collection is temporarily unavailable. Please reload the page.", "error");
    elements.button.disabled = true;
  }
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = elements.query.value.trim();
  if (!query) {
    setStatus("Describe an indicator or policy question to search.", "error");
    elements.query.focus();
    return;
  }
  runSearch(query);
});

document.addEventListener("change", (event) => {
  if (!event.target.matches("input[data-filter-group]")) return;
  renderOverview();
  if (state.lastQuery) runSearch(state.lastQuery);
});

elements.clearFilters.addEventListener("click", selectAllFilters);

loadData();