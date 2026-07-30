export function BrandMark({ className = 'ops-brand-mark' }: { className?: string }) {
  return (
    <span className={className} aria-hidden="true">
      <svg viewBox="0 0 32 32" focusable="false">
        <path d="M8 9.5h16L8 22.5h16" />
      </svg>
    </span>
  );
}
