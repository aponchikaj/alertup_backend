/**
 * Instruction phrasing — the en/ka sentence templates and the renderer.
 * ----------------------------------------------------------------------------
 * Split out from `instructions.js` on purpose: the geometry decides *what*
 * happened ("a 90° right, 14 m in, past the Coffee Bar"), this file decides
 * how to say it, and the two change for completely different reasons.
 *
 * Phone-screen rules that shape every string below:
 *  - The stepper already prints the distance-and-ETA line and, when a landmark
 *    has a side, "Coffee Bar on your right" underneath the headline. So turns
 *    stay SHORT — "Turn right at the Coffee Bar" — and only the two lines that
 *    have no other source of distance (the departure and a straight-ahead
 *    confirmation) spell out metres.
 *  - The unit lives in the template, not in `formatDistance`, so Georgian can
 *    say "30 მ" without the builder knowing anything about either language.
 *
 * GEORGIAN: informal second person throughout ("იარე", "შეუხვიე"), matching
 * the frontend's existing `wayfinding.*` strings. Every template is listed
 * verbatim in the task report for native review.
 */

/** Locales every instruction is rendered into. `en` is the fallback. */
export const LOCALES = Object.freeze(['en', 'ka']);

const EN = Object.freeze({
  // Departure. `depart` is the no-heading (or already-facing-the-right-way)
  // case; `depart_heading` is used when the device compass told us which way
  // the visitor is actually pointing.
  depart: 'Go straight ahead for {distance} m',
  depart_heading: 'Turn {side}, then go {distance} m',

  // Mid-route. `straight` is a confirmation, not a maneuver — see the
  // `STRAIGHT_MIN_LEG_M` rule in `instructions.js`.
  straight: 'Continue straight for {distance} m',
  slight: 'Bear {side}',
  turn: 'Turn {side}',
  sharp: 'Turn sharp {side}',
  uturn: 'Turn around',

  // Floor changes. `transit_same` covers two floor records at the same
  // vertical order — a split level, or a bridge into the next block — where
  // "up to floor 2" would simply be false.
  transit_up: 'Take the {transit} up to floor {floor}',
  transit_down: 'Take the {transit} down to floor {floor}',
  transit_same: 'Take the {transit} across to floor {floor}',
  transit_STAIRS: 'stairs',
  transit_ELEVATOR: 'elevator',
  transit_ESCALATOR: 'escalator',
  // A cross-floor WALKWAY is a legacy row that exists in production data, and
  // nothing keeps one off a wheelchair route (blocking is by transit type). It
  // must read as the neutral level crossing it is — never as stairs.
  transit_WALKWAY: 'walkway',

  // Arrival.
  arrive: 'You have arrived',
  arrive_side: 'You have arrived — {name} is on your {side}',

  // Landmark clauses, appended to a maneuver: "Turn right at the Coffee Bar".
  rel_before: 'just before {name}',
  rel_after: 'just past {name}',
  rel_at: 'at {name}',

  side_left: 'left',
  side_right: 'right',
});

const KA = Object.freeze({
  depart: 'იარე პირდაპირ {distance} მ',
  depart_heading: 'შეუხვიე {side} და გაიარე {distance} მ',

  straight: 'განაგრძე პირდაპირ {distance} მ',
  slight: 'ოდნავ შეუხვიე {side}',
  turn: 'შეუხვიე {side}',
  sharp: 'მკვეთრად შეუხვიე {side}',
  uturn: 'შემობრუნდი უკან',

  // The transit nouns are already in the instrumental case ("კიბით", not
  // "კიბე"), so the sentence needs no suffix glue — "ისარგებლე კიბით".
  transit_up: 'ისარგებლე {transit} და ავიდე {floor} სართულზე',
  transit_down: 'ისარგებლე {transit} და ჩახვიდე {floor} სართულზე',
  transit_same: 'ისარგებლე {transit} და გადადი {floor} სართულზე',
  transit_STAIRS: 'კიბით',
  transit_ELEVATOR: 'ლიფტით',
  transit_ESCALATOR: 'ესკალატორით',
  transit_WALKWAY: 'გადასასვლელით',

  arrive: 'მიაღწიე დანიშნულებას',
  arrive_side: 'მიაღწიე დანიშნულებას — {name} {side}',

  rel_before: '{name}-მდე',
  rel_after: '{name}-ის შემდეგ',
  rel_at: '{name}-თან',

  side_left: 'მარცხნივ',
  side_right: 'მარჯვნივ',
});

/** Every sentence the builder can produce, per locale. */
export const TEMPLATES = Object.freeze({ en: EN, ka: KA });

const PLACEHOLDER = /\s*\{(\w+)\}/g;

/**
 * Render one template.
 *
 * A placeholder with no value is dropped along with the space in front of it,
 * rather than leaking "{name}" onto a visitor's screen — a landmark name that
 * failed to resolve should degrade to "Turn right", never to "Turn right at
 * {name}".
 *
 * @param {string} locale 'en' | 'ka'; anything else falls back to 'en'
 * @param {string} key a TEMPLATES key
 * @param {object} vars
 * @returns {string|null} null when the key does not exist
 */
export function render(locale, key, vars = {}) {
  const table = TEMPLATES[locale] ?? TEMPLATES.en;
  const template = table[key] ?? TEMPLATES.en[key];
  if (typeof template !== 'string') return null;

  return template
    .replace(PLACEHOLDER, (match, name) => {
      const value = vars?.[name];
      if (value === undefined || value === null || value === '') return '';
      return `${match.startsWith(' ') ? ' ' : ''}${value}`;
    })
    .trim();
}

/**
 * Metres, rounded the way a person estimates them: single metres while the
 * number is small enough to pace out, nearest five once it is not. Returns the
 * NUMBER only — the unit belongs to the locale's template.
 *
 * @param {number} m
 * @returns {string}
 */
export function formatDistance(m) {
  if (!Number.isFinite(m) || m <= 0) return '0';
  if (m < 10) return String(Math.round(m));
  return String(Math.round(m / 5) * 5);
}
