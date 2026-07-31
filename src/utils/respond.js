// Standard response envelope: { success, message, data? }.
// Replaces the mixed {Success, Message} / {success, message} shapes.

export function ok(res, { message = 'OK', data, status = 200 } = {}) {
  const body = { success: true, message };
  if (data !== undefined) body.data = data;
  return res.status(status).json(body);
}

export function fail(res, status, message, extra) {
  const body = { success: false, message };
  if (extra) Object.assign(body, extra);
  return res.status(status).json(body);
}
