function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function nowInSeoulIso(date = new Date()): string {
  const seoul = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return [
    seoul.getUTCFullYear(),
    '-',
    pad(seoul.getUTCMonth() + 1),
    '-',
    pad(seoul.getUTCDate()),
    'T',
    pad(seoul.getUTCHours()),
    ':',
    pad(seoul.getUTCMinutes()),
    ':',
    pad(seoul.getUTCSeconds()),
    '+09:00',
  ].join('');
}
