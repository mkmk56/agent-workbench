// Token estimation and summary truncation shared by the message protocol, the
// chat context builder and the approval cards. Kept in its own module so the
// context builder can use it without importing MessageService (and creating a
// needless cycle).

function isCjk(code) {
  return code >= 0x2e80;
}

// Conservative, tokenizer-free upper bound: one token per CJK character and
// one token per four remaining characters. It over-counts rather than under-
// counts, so a summary accepted here stays within the configured budget.
export function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of String(text ?? '')) {
    if (isCjk(ch.codePointAt(0))) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export function truncateSummary(text, maxTokens) {
  const raw = String(text ?? '');
  const tokens = estimateTokens(raw);
  if (tokens <= maxTokens) return { text: raw, tokens, truncated: false };
  let used = 0;
  let out = '';
  for (const ch of raw) {
    const add = isCjk(ch.codePointAt(0)) ? 1 : 0.25;
    if (used + add > maxTokens) break;
    used += add;
    out += ch;
  }
  out = out.trimEnd();
  return { text: out, tokens: estimateTokens(out), truncated: true };
}

// Keep the newest messages that fit the budget. Input and output stay in
// ascending order; the oldest messages are dropped first.
export function fitMessagesToTokenBudget(messages, tokenBudget) {
  const budget = Math.max(64, Number(tokenBudget) || 6000);
  const picked = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    const cost = estimateTokens(item.body ?? item.summary ?? '') + 12;
    if (used + cost > budget && picked.length > 0) break;
    used += cost;
    picked.push(item);
  }
  picked.reverse();
  return { messages: picked, tokens: used, truncated: picked.length < messages.length };
}