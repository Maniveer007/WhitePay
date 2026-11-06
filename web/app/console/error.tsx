"use client";

export default function ConsoleError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div style={{ maxWidth: 520 }}>
      <h1>Something went wrong</h1>
      <p className="mut">This page couldn't load. Your data is safe. Try again, and if it keeps happening, check that the WhitePay API is running.</p>
      <button className="btn" onClick={reset}>Try again</button>
    </div>
  );
}
