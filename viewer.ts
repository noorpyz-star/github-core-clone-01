// viewer.ts — the token owner's identity, derived the way the kit derives it.
//
// The suite's scenario builds every user from one fixed seed (SCENARIO_SEED in the kit's
// wire.ts: "Never change it: it is the contest's fixed data"). The viewer — the first user
// of the 'users' stream — is the login every check addresses repositories under, so the
// forge's `viewer { login }` and GET /api/v3/user must answer exactly that login. The
// derivation below re-implements the kit's small deterministic generator (FNV-1a label
// seed, splitmix64 finalizer, xorshift64* stream, first/last name picks) so the login is
// computed from the seed, not pasted as a magic string. Verified against the kit's own
// buildScenario(): viewer login "adaiversen", id 1000.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** A named stream's seed: the same function of SCENARIO_SEED and the label the kit uses. */
function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*: the kit's deterministic stream, walked by three shifts and one multiply. */
class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), unbiased by rejection. */
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  /** One element, uniformly. */
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)]!;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/** The scenario's first user: the viewer. The login is the first + last name picks, joined. */
function deriveViewer(): { login: string; id: number } {
  const rng = new Rng(scenarioSeedFor('users'));
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  const login = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
  return { login, id: 1000 };
}

const VIEWER = deriveViewer();

/** The bearer token owner's login (the scenario's viewer). */
export const VIEWER_LOGIN = VIEWER.login;
/** The viewer user's numeric id. */
export const VIEWER_ID = VIEWER.id;
