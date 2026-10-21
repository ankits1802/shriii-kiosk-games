import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginPanel } from './login-panel';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <Suspense fallback={null}>
        <LoginPanel />
      </Suspense>
    </div>
  );
}
