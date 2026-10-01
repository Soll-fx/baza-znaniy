export type TopicKind = 'branch' | 'leaf';
export type ArticleStatus = 'draft' | 'review' | 'published' | 'archived';

export interface TopicNode {
  id: string;
  parentId: string | null;
  slug: string;
  title: string;
  summary: string | null;
  kind: TopicKind;
  depth: number;
  path: string[];
  pathText: string;
  sortOrder: number;
  isPublished: boolean;
  directArticles: number;
  subtreeArticles: number;
}

export interface ArticleStub {
  id: string;
  topicId: string;
  slug: string;
  title: string;
  status: ArticleStatus;
}

export interface TreeResponse {
  nodes: TopicNode[];
  articles: ArticleStub[];
  total: number;
}

export interface TocItem {
  id: string;
  label: string;
  level: number;
}

export interface ArticleAsset {
  id: string;
  kind: 'image' | 'document' | 'spreadsheet' | 'archive' | 'other';
  filename: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  alt: string | null;
  caption: string | null;
  sourceUrl: string | null;
  role: 'cover' | 'inline' | 'attachment' | 'diagram';
  position: number;
  blockAnchor: string | null;
}

export interface ArticleLink {
  kind: 'internal' | 'external' | 'anchor';
  rawTarget: string;
  toId: string | null;
  resolvedSlug: string | null;
  toTitle: string | null;
  toSlug: string | null;
}

export interface Breadcrumb {
  id: string;
  slug: string;
  title: string;
  depth: number;
}

export interface Progress {
  status: 'new' | 'learning' | 'known' | 'relearning';
  confidence: number;
  reps: number;
  nextReviewAt: string;
}

export interface Article {
  id: string;
  topicId: string;
  topicPath: string[];
  topicTitle: string;
  topicSlug: string;
  slug: string;
  title: string;
  summary: string | null;
  bodyMd: string;
  bodyHtml: string;
  toc: TocItem[];
  status: ArticleStatus;
  version: number;
  readingMinutes: number | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
  assets: ArticleAsset[];
  links: ArticleLink[];
  brokenLinks: ArticleLink[];
  breadcrumbs: Breadcrumb[];
  progress: Progress | null;
}

export interface Topic {
  id: string;
  parentId: string | null;
  slug: string;
  title: string;
  summary: string | null;
  kind: TopicKind;
  depth: number;
  path: string[];
  pathText: string;
  isPublished: boolean;
  sourceUrl: string | null;
  directArticles: number;
  subtreeArticles: number;
  children: { id: string; slug: string; title: string; kind: TopicKind; depth: number; subtreeArticles: number }[];
  articles: {
    id: string;
    slug: string;
    title: string;
    summary: string | null;
    status: ArticleStatus;
    version: number;
    readingMinutes: number | null;
    updatedAt: string;
    assetsCount: number;
  }[];
  breadcrumbs: Breadcrumb[];
}

export interface SearchHit {
  id: string;
  topicId: string;
  slug: string;
  title: string;
  summary: string | null;
  readingMinutes: number | null;
  status: ArticleStatus;
  topicPath: string[];
  topicTitle: string;
  excerpt: string;
  score: number;
}

export interface SearchResponse {
  query: string;
  results: SearchHit[];
  tookMs: number;
}

export interface Stats {
  topics: number;
  articles: number;
  words: number;
  assets: number;
  brokenLinks: number;
}

export interface ReviewQueueItem {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  readingMinutes: number | null;
  topicPath: string[];
  topicTitle: string;
  status: Progress['status'];
  confidence: number;
  reps: number;
  nextReviewAt: string;
}
