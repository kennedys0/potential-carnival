export function formatWIBTime(date: Date | string = new Date()): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
}

export function formatWIBDate(date: Date | string = new Date()): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
}
