// /control — one calm Personal Control Center (§48). Wide screens: a quiet section index at the inline-start and
// the section on paper next to it. Phones: the index is its own screen; each section has a way back.
import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { ArrowUpLeft } from 'lucide-react';
import type { ControlOverviewResponse } from '@medlevo/shared';
import { cx } from '../../design';
import { controlApi } from './api';
import { SECTIONS } from './model';
import type { ControlOutletContext } from './shared';
import './control.css';

export function ControlLayout() {
  const { pathname } = useLocation();
  const isIndex = /^\/control\/?$/.test(pathname);
  const [overview, setOverview] = useState<ControlOverviewResponse | null>(null);
  const [tick, setTick] = useState(0);
  const reloadOverview = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let cancelled = false;
    controlApi
      .overview()
      .then((o) => {
        if (!cancelled) setOverview(o);
      })
      .catch(() => {
        /* the index explains offline / errors itself; the nav needs no numbers */
      });
    return () => {
      cancelled = true;
    };
  }, [tick, pathname]);
  const ctx: ControlOutletContext = { overview, reloadOverview };
  return (
    <div className="ml-page cc-page">
      <div className={cx('cc-layout', isIndex && 'cc-layout--index')}>
        <nav className="cc-nav" aria-label="أقسام مركز التحكم">
          <p className="cc-nav__title">مركز التحكم</p>
          <ul role="list">
            {SECTIONS.map((s) => (
              <li key={s.key}>
                <NavLink to={s.href} className={({ isActive }) => cx('cc-nav__link', isActive && 'cc-nav__link--active')} end={s.key !== 'review'}>
                  <span>{s.label}</span>
                  {s.key === 'review' && overview && overview.review.open > 0 && (
                    <span className="cc-nav__count" aria-label={`${overview.review.open} بانتظار مراجعتك`}>
                      {overview.review.open}
                    </span>
                  )}
                  {s.external && <ArrowUpLeft size={14} aria-label="شاشة أخرى" className="cc-nav__ext" />}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="cc-main">
          <Outlet context={ctx} />
        </div>
      </div>
    </div>
  );
}
