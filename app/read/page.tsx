'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import Link from 'next/link';
import { Reader } from '@/components/reader/Reader';

function ReadInner() {
  const id = useSearchParams().get('book');
  if (!id) {
    return (
      <main className="page empty" id="main">
        <h1 className="serif">No book selected</h1>
        <Link className="btn btn-primary" href="/">
          Go to your library
        </Link>
      </main>
    );
  }
  return <Reader key={id} bookId={id} />;
}

export default function ReadPage() {
  return (
    <Suspense fallback={null}>
      <ReadInner />
    </Suspense>
  );
}
