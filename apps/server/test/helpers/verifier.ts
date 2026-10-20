// Test helper for scripted independent verifiers (verify_support). The verifier contract (claims.ts VERIFY_SYSTEM)
// asks for `based_on`: the aliases of the excerpts a verdict rests on. Since H1 a verdict that omits it is trusted
// only for a claim with ONE cited excerpt, so scripted verifiers that model a correct verifier name the excerpts
// they were shown for that claim (a test of a partial / missing `based_on` scripts it explicitly).

/** Aliases («E3») of the excerpts shown for claim `index` in a verify_support prompt. */
export function excerptsForClaim(prompt: string, index: number): string[] {
  const start = prompt.indexOf(`CLAIM [${index}]:`);
  if (start < 0) return [];
  const next = prompt.indexOf('CLAIM [', start + 1);
  const block = prompt.slice(start, next < 0 ? undefined : next);
  return [...new Set([...block.matchAll(/^EVIDENCE (E\d+) \(/gm)].map((m) => m[1]!))];
}
