// Conservative duplicate detection: preserve provider order and distinct meanings.
export function normalizeSuggestion(value = "") {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/&/g, " and ").replace(/[’']/g, "")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

export function completionKey(value = "") {
  return normalizeSuggestion(value).split(" ").map((word) => {
    if (word.length > 4 && /ies$/.test(word)) return word.slice(0, -3) + "y";
    if (word.length > 4 && /(ches|shes|xes|zes)$/.test(word)) return word.slice(0, -2);
    if (word.length > 3 && /s$/.test(word) && !/(ss|us|is|news|series|species)$/.test(word)) return word.slice(0, -1);
    return word;
  }).join(" ");
}

export function cleanSuggestionsForQuery(query, items = [], limit = 7) {
  const prefix = normalizeSuggestion(query);
  if (!prefix) return [];
  const seen = new Set();
  const accepted = [];
  for (const item of items) {
    const value = typeof item === "string" ? item : item?.value;
    if (typeof value !== "string") continue;
    const normalized = normalizeSuggestion(value);
    if (!normalized.startsWith(prefix + " ")) continue;
    const key = completionKey(normalized.slice(prefix.length).trim());
    if (!key || seen.has(key)) continue;
    seen.add(key);
    accepted.push(value.trim().replace(/\s+/g, " "));
    if (accepted.length >= limit) break;
  }
  return accepted;
}
