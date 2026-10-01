import type {
  Article,
  SearchResponse,
  Stats,
  Topic,
  TreeResponse,
  ReviewQueueItem,
} from './types';

const BASE = '/api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ответ без JSON */
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const asQuery = (params: Record<string, string | number | boolean | undefined | null>) => {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    sp.set(key, String(value));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};

export const api = {
  tree: (all = false) => request<TreeResponse>(`/topics/tree${asQuery({ all })}`),
  topic: (id: string) => request<Topic>(`/topics/${id}`),
  topicByPath: (path: string[]) => request<Topic>(`/topics/by-path${asQuery({ path: path.join('/') })}`),
  article: (id: string) => request<Article>(`/articles/${id}`),
  search: (q: string, limit = 20) => request<SearchResponse>(`/search${asQuery({ q, limit })}`),
  stats: () => request<Stats>('/stats'),
  reviewQueue: (user = 'local', due = true) =>
    request<{ queue: ReviewQueueItem[]; stats: { total: number; known: number; learning: number; due: number } }>(
      `/progress${asQuery({ user, due: due ? 1 : 0, limit: 20 })}`,
    ),
  review: (articleId: string, correct: boolean, user = 'local') =>
    request<{ status: string; confidence: number; nextReviewAt: string }>(`/progress/${articleId}`, {
      method: 'POST',
      body: JSON.stringify({ user, correct }),
    }),
  setProgress: (articleId: string, status: 'new' | 'learning' | 'known' | 'relearning', user = 'local') =>
    request<{ articleId: string; status: string; confidence: number; nextReviewAt: string }>(`/progress/${articleId}`, {
      method: 'PUT',
      body: JSON.stringify({ user, status }),
    }),
};

export const assetUrl = (id: string) => `${BASE}/assets/${id}`;

/** Человекочитаемый размер файла. */
export function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' }).format(new Date(iso));
}
