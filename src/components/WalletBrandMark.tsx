import React, { useId } from 'react';

export const WalletBrandMark: React.FC<{ className?: string }> = ({ className = 'w-7 h-7' }) => {
  const uid = useId().replace(/:/g, '');
  const bgId = `csw-bg-${uid}`;
  const shieldId = `csw-sh-${uid}`;
  const cId = `csw-c-${uid}`;
  const keyId = `csw-k-${uid}`;

  return (
    <svg viewBox="0 0 64 64" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={bgId} x1="6" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#09152E" />
          <stop offset="50%" stopColor="#0D2249" />
          <stop offset="100%" stopColor="#143870" />
        </linearGradient>
        <linearGradient id={shieldId} x1="18" y1="10" x2="46" y2="54" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#76F9C5" />
          <stop offset="50%" stopColor="#23C58D" />
          <stop offset="100%" stopColor="#0E885F" />
        </linearGradient>
        <linearGradient id={cId} x1="22" y1="19" x2="39" y2="45" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#86FFD0" />
          <stop offset="45%" stopColor="#3BE4A4" />
          <stop offset="100%" stopColor="#0E8B60" />
        </linearGradient>
        <linearGradient id={keyId} x1="32" y1="28" x2="32" y2="39" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#F0FFF8" />
          <stop offset="100%" stopColor="#9AF5CF" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="15" fill={`url(#${bgId})`} />
      <rect x="2.75" y="2.75" width="58.5" height="58.5" rx="14.25" stroke="#60A5FA" strokeOpacity="0.25" strokeWidth="1.5" />
      <path
        d="M32 10.5L49 16.8V30C49 41.2 41.7 49.7 32 53.5C22.3 49.7 15 41.2 15 30V16.8L32 10.5Z"
        fill="#0D2248"
        stroke={`url(#${shieldId})`}
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <path
        d="M38.5 25C36.7 22.4 33.8 21 30.3 21C24 21 19.4 25.7 19.4 32.1C19.4 38.5 24 43.2 30.3 43.2C33.8 43.2 36.8 41.8 38.6 39.1"
        stroke="#084D37"
        strokeWidth="6.4"
        strokeLinecap="round"
        transform="translate(0 1.4)"
      />
      <path
        d="M38.5 24.4C36.7 21.8 33.8 20.4 30.3 20.4C24 20.4 19.4 25.1 19.4 31.5C19.4 37.9 24 42.6 30.3 42.6C33.8 42.6 36.8 41.2 38.6 38.5"
        stroke={`url(#${cId})`}
        strokeWidth="6"
        strokeLinecap="round"
      />
      <circle cx="32" cy="29.6" r="2.3" fill={`url(#${keyId})`} />
      <path d="M30.5 31H33.5L34.4 37H29.6L30.5 31Z" fill={`url(#${keyId})`} />
    </svg>
  );
};
