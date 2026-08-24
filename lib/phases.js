/**
 * Phase name -> GTD / FCFS / PUBLIC mapping layer.
 *
 * Projects invent their own vocabulary ("OG", "WL", "Priority", "Presale").
 * We normalize, but we ALWAYS keep the original name and report how confident
 * the mapping is, so nothing here can silently misrepresent a phase.
 */

export const GTD = 'GTD';
export const FCFS = 'FCFS';
export const PUBLIC = 'PUBLIC';
export const UNKNOWN = 'UNKNOWN';

// Matched as whole words against a lowercased, punctuation-stripped name.
// Tier 1 words are unambiguous and always win, so "FCFS - token holders" is
// FCFS even though "holders" is a tier-2 GTD signal.
const TIERS = [
  [
    { cat: GTD, words: ['gtd', 'guaranteed', 'guarantee'] },
    { cat: FCFS, words: ['fcfs', 'firstcome', 'waitlist', 'waitlisted', 'raffle', 'lottery', 'overflow', 'backup', 'oversubscribed'] },
    { cat: PUBLIC, words: ['public', 'publicsale', 'openedition'] },
  ],
  [
    { cat: GTD, words: ['og', 'oglist', 'vip', 'priority', 'founders', 'founder', 'holders', 'holder', 'team', 'tier1', 'diamond'] },
    { cat: FCFS, words: ['tier2'] },
    { cat: PUBLIC, words: ['open'] },
  ],
];

const AMBIGUOUS = ['wl', 'whitelist', 'allowlist', 'allow', 'presale', 'pre', 'early', 'earlyaccess', 'ea', 'private', 'mintlist'];

const tokens = name => String(name || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .split(' ')
  .filter(Boolean);

/** Classify one name in isolation. */
export function classifyPhaseName(name) {
  const t = tokens(name);
  const joined = t.join('');
  for (const tier of TIERS) {
    for (const { cat, words } of tier) {
      for (const w of words) {
        if (t.includes(w) || (w.length >= 5 && joined.includes(w))) {
          return { normalized: cat, confidence: 'mapped', matched: w };
        }
      }
    }
  }
  const amb = t.find(x => AMBIGUOUS.includes(x));
  if (amb) return { normalized: UNKNOWN, confidence: 'ambiguous', matched: amb };
  return { normalized: UNKNOWN, confidence: 'unknown', matched: null };
}

/**
 * Classify a whole phase list. Ambiguous names ("Allowlist", "Presale") are
 * resolved using their position relative to phases we *did* recognise:
 * the earliest ambiguous phase is treated as guaranteed, later ones as FCFS.
 * Those get confidence "inferred" so the UI can flag them.
 */
export function normalizePhases(phases) {
  const ordered = [...phases].sort((a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity));
  const out = ordered.map(p => {
    if (p.normalized && [GTD, FCFS, PUBLIC].includes(p.normalized)) {
      return { ...p, normalized: p.normalized, phaseConfidence: p.phaseConfidence || 'declared', mappingNote: p.mappingNote || 'Phase type declared by the data source.' };
    }
    const c = classifyPhaseName(p.name);
    return {
      ...p,
      normalized: c.normalized,
      phaseConfidence: c.confidence,
      mappingNote: c.matched ? `Matched keyword "${c.matched}" in phase name.` : 'Phase name did not match any known GTD/FCFS vocabulary.',
    };
  });

  const ambiguous = out.filter(p => p.phaseConfidence === 'ambiguous');
  if (ambiguous.length) {
    const hasGtd = out.some(p => p.normalized === GTD && p.phaseConfidence !== 'inferred');
    ambiguous.forEach((p, i) => {
      const guess = !hasGtd && i === 0 ? GTD : FCFS;
      p.normalized = guess;
      p.phaseConfidence = 'inferred';
      p.mappingNote = `"${p.name}" does not state whether allocation is guaranteed. Inferred ${guess} from phase ordering${hasGtd ? ' (a separate guaranteed phase exists)' : ''}. Verify against the project's own announcement.`;
    });
  }
  return out;
}
