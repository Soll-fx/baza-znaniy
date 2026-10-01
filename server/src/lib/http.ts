import type { NextFunction, Request, Response } from 'express';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} не найден(а)`);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);

/**
 * Безопасное чтение параметра маршрута.
 * С noUncheckedIndexedAccess req.params.id имеет тип string | undefined,
 * а типизация @types/express 5 не гарантирует наличие ключа.
 */
export function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | undefined>)[name];
  if (value === undefined || value === '') {
    throw badRequest(`Отсутствует обязательный параметр маршрута :${name}`);
  }
  return value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Параметр, который уходит в колонку uuid. Без проверки Postgres отвечает
 * 22P02 (invalid_text_representation) и клиент получает 500 вместо 400.
 */
export function uuidParam(req: Request, name: string): string {
  const value = param(req, name);
  if (!UUID_RE.test(value)) {
    throw badRequest(`Параметр :${name} должен быть UUID, получено «${value}»`);
  }
  return value;
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details ?? null });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  // Код 23503/23514/23505 — ожидаемые ошибки целостности, отдаём текст пользователю
  const pgCode = (err as { code?: string })?.code;
  if (pgCode === '23503') {
    res.status(409).json({ error: 'Нарушение связности: ' + message });
    return;
  }
  if (pgCode === '23505') {
    res.status(409).json({ error: 'Дубликат: ' + message });
    return;
  }
  if (pgCode === '23514' || pgCode === '23502') {
    res.status(422).json({ error: 'Нарушение ограничения: ' + message });
    return;
  }
  // Некорректный формат значения (например, не-UUID в колонку uuid)
  if (pgCode === '22P02' || pgCode === '22007' || pgCode === '22018') {
    res.status(400).json({ error: 'Некорректное значение параметра: ' + message });
    return;
  }

  console.error('[api] необработанная ошибка:', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
}

export function asyncRoute<T extends Request = Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req as T, res, next).catch(next);
  };
}
