import path from 'path';

/**
 * Resolve a user-supplied filename inside a fixed directory, refusing anything
 * that tries to escape it.
 *
 * Express percent-decodes route params, so a request for `..%2f..%2fserver.js`
 * arrives here as `../../server.js`. Rejecting the obvious separators is not
 * enough on its own, so the resolved path is also checked to be a real
 * descendant of the base directory.
 *
 * @param {string} baseDir - absolute directory the file must live in
 * @param {string} filename - untrusted filename from the request
 * @returns {string|null} absolute path, or null if the input is unsafe
 */
export const resolveSafePath = (baseDir, filename) => {
  if (!filename || typeof filename !== 'string') return null;

  // Reject traversal and separators outright — these are filenames, not paths.
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return null;
  }

  // Reject NUL bytes and absolute/drive-letter forms.
  if (filename.includes('\0') || path.isAbsolute(filename)) return null;

  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, filename);

  // Defence in depth: confirm the result really is inside the base directory.
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
    return null;
  }

  return resolved;
};

/**
 * Express middleware factory. Validates `req.params.filename` against baseDir
 * and stashes the safe absolute path on `req.safePath` for the handler.
 *
 * @param {string} baseDir - absolute directory the file must live in
 */
export const safeFilename = (baseDir) => (req, res, next) => {
  const safePath = resolveSafePath(baseDir, req.params.filename);

  if (!safePath) {
    return res.status(400).json({ success: false, message: 'Invalid filename' });
  }

  req.safePath = safePath;
  next();
};

export default safeFilename;
