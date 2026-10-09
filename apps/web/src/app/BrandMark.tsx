/** The MedLevo mark: an open book (right-hand page first, as in an Arabic book) with a ribbon. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" focusable="false" className="ml-brand-mark">
      <rect width="512" height="512" rx="116" fill="var(--ml-color-accent)" />
      <path d="M256 158c-38-27-90-37-148-30a8 8 0 0 0-7 8v222a8 8 0 0 0 9 8c55-6 104 3 146 28z" fill="#E4E1D8" />
      <path d="M256 158c38-27 90-37 148-30a8 8 0 0 1 7 8v222a8 8 0 0 1-9 8c-55-6-104 3-146 28z" fill="#FFFDF8" />
      <path d="M134 120h52v128l-26-19-26 19z" fill="#E8BA55" />
    </svg>
  );
}
