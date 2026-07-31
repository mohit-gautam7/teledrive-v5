/** TeleDrive mark — a cloud with a downward arrow, in the accent gradient. */
export function Logo({ size = 32, rounded = true }: { size?: number; rounded?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "grid",
        placeItems: "center",
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: rounded ? size * 0.3 : 0,
        background: "var(--accent-grad)"
      }}
    >
      <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} fill="none">
        <path
          d="M12 3C9.24 3 7 5.24 7 8c0 .18.01.36.03.54A5.5 5.5 0 0 0 2 14a5.5 5.5 0 0 0 5.5 5.5h9A4.5 4.5 0 0 0 21 15a4.5 4.5 0 0 0-4.16-4.49A5.002 5.002 0 0 0 12 3Z"
          fill="#04070c"
          opacity="0.28"
        />
        <path
          d="M12 15.5V9.5m0 6-2.5-2.5M12 15.5l2.5-2.5"
          stroke="#04070c"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
