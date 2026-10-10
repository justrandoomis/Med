// Critic round regression (a11y, WCAG 1.3.1 / 2.4.6): the «هذه الصفحة غير موجودة» screen had no level-1 heading —
// its title was an <h2> under no <h1>, so a screen-reader user landing on a dead link heard no page title heading.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { NotFoundScreen } from '../src/app/layouts';

// the PWA prompt imports a Vite virtual module that only exists in a build; it is not part of this screen
vi.mock('../src/app/PwaUpdatePrompt', () => ({ PwaUpdatePrompt: () => null }));

describe('not found screen', () => {
  it('has one level-1 heading and links back to Home and the Library', async () => {
    const router = createMemoryRouter([{ path: '*', element: <NotFoundScreen /> }], { initialEntries: ['/no-such-screen'] });
    render(<RouterProvider router={router} />);
    const h1 = await screen.findByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('هذه الصفحة غير موجودة');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'الرئيسية' }).getAttribute('href')).toBe('/');
    expect(screen.getByRole('link', { name: 'المكتبة' }).getAttribute('href')).toBe('/library');
  });
});
