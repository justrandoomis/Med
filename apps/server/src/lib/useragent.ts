// Human-readable Arabic device label from a User-Agent (for the sessions/devices list).
// Heuristic only; the owner may rename the device label at login.

export function deviceLabelFromUserAgent(ua: string | undefined | null): string {
  if (!ua) return 'جهاز غير معروف';
  const s = ua;
  let device = 'جهاز';
  if (/iPad/.test(s) || (/Macintosh/.test(s) && /Mobile\//.test(s))) device = 'iPad';
  else if (/iPhone/.test(s)) device = 'iPhone';
  else if (/Android/.test(s)) device = /Mobile/.test(s) ? 'هاتف Android' : 'جهاز Android لوحي';
  else if (/Macintosh|Mac OS X/.test(s)) device = 'Mac';
  else if (/Windows/.test(s)) device = 'Windows';
  else if (/CrOS/.test(s)) device = 'Chromebook';
  else if (/Linux/.test(s)) device = 'Linux';

  let browser = '';
  if (/Edg\//.test(s)) browser = 'Edge';
  else if (/OPR\//.test(s)) browser = 'Opera';
  else if (/Firefox\/|FxiOS\//.test(s)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s)) browser = 'Safari';

  return browser ? `${browser} على ${device}` : device;
}
