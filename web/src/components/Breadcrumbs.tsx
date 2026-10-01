import { Link } from 'react-router-dom';

export interface Crumb {
  id: string;
  slug: string;
  title: string;
  depth: number;
  /** для рубрик — путь от корня, для статьи — id рубрики */
  path?: string[];
  articleId?: string;
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  if (items.length === 0) return null;

  return (
    <nav aria-label="Хлебные крошки" className="min-w-0">
      <ol className="kb-scroll flex items-center gap-1 overflow-x-auto text-[13px] whitespace-nowrap text-slate-500 dark:text-slate-400">
        <li className="shrink-0">
          <Link to="/" className="rounded px-1.5 py-1 hover:text-slate-900 hover:underline dark:hover:text-slate-100">
            База
          </Link>
        </li>
        {items.map((item, i) => {
          const last = i === items.length - 1;
          const to = item.articleId
            ? `/a/${item.articleId}`
            : `/t/${(item.path ?? [item.slug]).join('/')}`;
          return (
            <li key={item.id + (item.articleId ?? '')} className="flex min-w-0 items-center gap-1">
              <Separator />
              {last ? (
                <span
                  aria-current="page"
                  className="truncate px-1.5 py-1 font-medium text-slate-800 dark:text-slate-100"
                >
                  {item.title}
                </span>
              ) : (
                <Link
                  to={to}
                  className="truncate rounded px-1.5 py-1 hover:text-slate-900 hover:underline dark:hover:text-slate-100"
                >
                  {item.title}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const Separator = () => (
  <span aria-hidden className="shrink-0 text-slate-300 dark:text-slate-600">
    /
  </span>
);
