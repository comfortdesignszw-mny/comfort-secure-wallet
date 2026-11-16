import rateLimit from 'express-rate-limit';

export const authRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts. Try again shortly.' } },
});

export const otpRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'OTP_RATE_LIMITED', message: 'Too many OTP requests. Please wait before retrying.' } },
});

export const pinRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'PIN_RATE_LIMITED', message: 'Too many PIN verification requests.' } },
});

export const moneyRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'MONEY_RATE_LIMITED', message: 'Transaction velocity rate limit exceeded.' } },
});
