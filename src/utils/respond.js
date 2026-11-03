// Standard response envelope: { success, message, data? }.
// Replaces the mixed {Success, Message} / {success, message} shapes.

// `extra` keeps a few legacy top-level fields (e.g. `buildingID`) that
// existing clients read, so moving a route onto this helper is wire-compatible.
export function ok(res, { message = 'OK', data, status = 200, extra } = {}) {
  const body = { success: true, message };
  if (data !== undefined) body.data = data;
  if (extra) Object.assign(body, extra);
  return res.status(status).json(body);
}

export function fail(res, status, message, extra) {
  const body = { success: false, message };
  if (extra) Object.assign(body, extra);
  return res.status(status).json(body);
}
