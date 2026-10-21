import { act, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { KioskErrorBoundary } from '../ui/KioskErrorBoundary.tsx';

function Bomb({ explode }: { readonly explode: boolean }): ReactElement {
  if (explode) throw new Error('screen exploded');
  return <div data-testid="screen-ok" />;
}

describe('KioskErrorBoundary', () => {
  it('reports a render error, shows the out-of-service panel and recovers on resetKey change', () => {
    const errors: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender } = render(
      <KioskErrorBoundary resetKey="s1|play" onError={(e) => errors.push(e)}>
        <Bomb explode />
      </KioskErrorBoundary>,
    );
    expect(screen.getByTestId('kiosk-error-boundary')).toBeTruthy();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('screen exploded');
    // Same key: stays failed.
    rerender(
      <KioskErrorBoundary resetKey="s1|play" onError={(e) => errors.push(e)}>
        <Bomb explode={false} />
      </KioskErrorBoundary>,
    );
    expect(screen.queryByTestId('screen-ok')).toBeNull();
    // The session moved on (CRASH -> wipe): render again.
    act(() => {
      rerender(
        <KioskErrorBoundary resetKey="s1|wipe" onError={(e) => errors.push(e)}>
          <Bomb explode={false} />
        </KioskErrorBoundary>,
      );
    });
    expect(screen.getByTestId('screen-ok')).toBeTruthy();
    expect(errors).toHaveLength(1);
    consoleError.mockRestore();
  });

  it('a throwing onError handler never escapes the boundary', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <KioskErrorBoundary
        onError={() => {
          throw new Error('handler');
        }}
        fallback={<div data-testid="custom-fallback" />}
      >
        <Bomb explode />
      </KioskErrorBoundary>,
    );
    expect(screen.getByTestId('custom-fallback')).toBeTruthy();
    consoleError.mockRestore();
  });
});
