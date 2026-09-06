import { APP_CONFIG, isLiveSuggestionsConfigured } from "../config.js";

import { cleanSuggestionsForQuery } from "./suggestion-quality.js";
export { cleanSuggestionsForQuery } from "./suggestion-quality.js";

export async function fetchLiveSuggestions(query) {
  if (!isLiveSuggestionsConfigured()) {
    throw new Error("A live suggestion provider has not been configured.");
  }

  const endpoint = new URL(APP_CONFIG.suggestionEndpoint);
  endpoint.searchParams.set("q", query);

  const response = await fetch(endpoint, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    throw new Error(`Suggestion provider returned ${response.status}.`);
  }

  const data = await response.json();
  const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
  const cleaned = cleanSuggestionsForQuery(query, suggestions);

  if (cleaned.length < 7) {
    throw new Error("The provider returned fewer than seven usable suggestions.");
  }

  return {
    suggestions: cleaned,
    source: data.source || "Live autocomplete provider",
    fetchedAt: data.fetchedAt || Date.now()
  };
}
