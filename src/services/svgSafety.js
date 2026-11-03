/**
 * FX-040: uploaded SVGs are refused when they carry anything that can run
 * script. Floor plans and shop logos are stored on the public asset host;
 * an SVG opened directly from there executes its scripts on that origin.
 *
 * This fails CLOSED on purpose: it refuses rather than "cleaning" with
 * regexes, because a regex sanitizer can be bypassed but a refusal cannot
 * produce dangerous output. Real floor plans and logos never need any of
 * these constructs. The frontend still runs DOMPurify before inlining.
 */
const UNSAFE = [
  [/<\s*script[\s>/]/i, 'a <script> element'],
  [/\son[a-z]+\s*=/i, 'an event-handler attribute (on…=)'],
  [/javascript\s*:/i, 'a javascript: URL'],
  [/<\s*foreignObject[\s>/]/i, 'a <foreignObject> element'],
  [/<\s*(iframe|embed|object)[\s>/]/i, 'an embedded document'],
  [/data\s*:\s*text\/html/i, 'an HTML data: URL'],
  [/<!ENTITY/i, 'an XML entity declaration'],
];

/** @returns {string|null} why the SVG is unsafe, or null when it is fine */
export function findUnsafeSvgContent(svgText) {
  const text = String(svgText ?? '');
  for (const [pattern, reason] of UNSAFE) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

/** Express middleware for multer single-file routes: 422 on an unsafe SVG. */
export function rejectUnsafeSvg(req, res, next) {
  const file = req.file;
  if (!file || file.mimetype !== 'image/svg+xml') return next();
  const reason = findUnsafeSvgContent(file.buffer?.toString('utf8'));
  if (!reason) return next();
  return res.status(422).json({
    success: false,
    message: `This SVG contains ${reason}, which is not allowed in uploaded images.`,
  });
}
