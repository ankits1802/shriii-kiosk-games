// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider } from '@/lib/auth/auth-context';
import { DataTable, dataColumnHelper } from './data-table';

interface Row {
  readonly id: string;
  readonly name: string;
  readonly n: number;
}

const helper = dataColumnHelper<Row>();
const columns = helper.columns([
  helper.accessor('name', { header: 'Name' }),
  helper.accessor('n', { header: 'N', meta: { align: 'end' } }),
]);

const rows: Row[] = Array.from({ length: 30 }, (_, i) => ({
  id: `r${i}`,
  name: i % 2 ? `odd-${i}` : `even-${i}`,
  n: 100 - i,
}));

function wrap(ui: ReactNode) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <TooltipProvider>{ui}</TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe('DataTable', () => {
  it('paginates, sorts and filters', () => {
    wrap(<DataTable data={rows} columns={columns} getRowId={(r) => r.id} pageSize={10} />);
    const body = () => screen.getAllByRole('row').slice(1);
    expect(body()).toHaveLength(10);
    expect(screen.getByText('1–10 of 30')).toBeTruthy();

    const sortN = screen.getByRole('button', { name: 'N' });
    fireEvent.click(sortN); // numeric columns sort descending first
    expect(sortN.closest('th')?.getAttribute('aria-sort')).toBe('descending');
    expect(within(body()[0] as HTMLElement).getByText('100')).toBeTruthy();
    fireEvent.click(sortN);
    expect(sortN.closest('th')?.getAttribute('aria-sort')).toBe('ascending');
    expect(within(body()[0] as HTMLElement).getByText('71')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search table'), { target: { value: 'odd' } });
    expect(screen.getByText(/of 15 \(filtered from 30\)/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Next page'));
    expect(screen.getByText('11–15 of 15 (filtered from 30)')).toBeTruthy();
  });

  it('shows loading, error and empty states', () => {
    const { rerender } = wrap(
      <DataTable data={undefined} isLoading columns={columns} getRowId={(r) => r.id} />,
    );
    expect(screen.getByRole('status')).toBeTruthy();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider>
          <DataTable data={[]} columns={columns} getRowId={(r) => r.id} />
        </AuthProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText('No records yet')).toBeTruthy();
  });
});
