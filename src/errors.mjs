export class AppError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message); this.name = 'AppError'; this.status = status; this.code = code;
  }
}
export function requireUser(userId) {
  if (typeof userId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(userId)) {
    throw new AppError('Geçersiz kullanıcı kimliği.');
  }
  return userId;
}
export function requireSource(source) {
  if (!['github', 'x', 'manual'].includes(source)) throw new AppError('Kaynak github, x veya manual olmalı.');
  return source;
}
